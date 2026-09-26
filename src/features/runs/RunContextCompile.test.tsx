import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextPackCompilation } from '../../../shared/context-packs';
import { compileRunContext } from './RunContextCompile';

afterEach(() => vi.unstubAllGlobals());

function transport(responses: Record<string, string | ContextPackCompilation | number>) {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/mounted/' });
  const calls: Array<{ id: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const match = /^\/mounted\/api\/productivity\/context-packs\/([^/]+)\/compile$/.exec(path);
    if (!match) throw new Error(`Unexpected request: ${path}`);
    const id = decodeURIComponent(match[1]);
    calls.push({ id, init });
    const fixture = responses[id];
    if (typeof fixture === 'number') return new Response(JSON.stringify({ error: 'Fixture failure' }), { status: fixture });
    const result = typeof fixture === 'string'
      ? { packId: id, version: 2, prompt: fixture, characters: fixture.length, itemCount: 1, redacted: false }
      : fixture;
    return new Response(JSON.stringify(result));
  });
  return calls;
}

describe('bounded, atomic context compilation', () => {
  it('appends new packs in selection order, preserves user text, and never evaluates their contents', async () => {
    const calls = transport({ 'pack-a': 'Context A\n{{target}} $& $(literal)', 'pack-b': 'Context B' });
    const controller = new AbortController();
    const input = { prompt: '  Operator draft\r\n', selectedIds: ['pack-a', 'pack-b'], appliedIds: [] };
    expect(await compileRunContext(input, controller.signal)).toEqual({
      prompt: '  Operator draft\r\n\n\nContext A\n{{target}} $& $(literal)\n\nContext B',
      selectedIds: ['pack-a', 'pack-b'], appliedIds: ['pack-a', 'pack-b'],
    });
    expect(calls.map(call => call.id)).toEqual(['pack-a', 'pack-b']);
    for (const { init } of calls) {
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({});
      expect(init.signal).toBe(controller.signal);
      expect(init.credentials).toBe('same-origin');
      expect(new Headers(init.headers).get('X-Agent-Ops')).toBe('1');
    }
    expect(input.prompt).toBe('  Operator draft\r\n');
    expect(input.appliedIds).toEqual([]);
  });

  it('does not compile or append IDs already represented in the draft, including removed and reselected IDs', async () => {
    const calls = transport({ 'pack-new': 'New context' });
    expect(await compileRunContext({
      prompt: 'Edited original context', selectedIds: ['pack-old', 'pack-new'], appliedIds: ['pack-old', 'pack-removed'],
    }, new AbortController().signal)).toEqual({
      prompt: 'Edited original context\n\nNew context',
      selectedIds: ['pack-old', 'pack-new'], appliedIds: ['pack-old', 'pack-removed', 'pack-new'],
    });
    expect(calls.map(call => call.id)).toEqual(['pack-new']);
  });

  it('keeps an all-applied draft unchanged without issuing a request', async () => {
    const calls = transport({});
    expect(await compileRunContext({
      prompt: 'Original', selectedIds: ['pack-old'], appliedIds: ['pack-old'],
    }, new AbortController().signal)).toEqual({
      prompt: 'Original', selectedIds: ['pack-old'], appliedIds: ['pack-old'],
    });
    expect(calls).toEqual([]);
  });

  it('accepts a final prompt of exactly 64,000 characters and rejects one additional character atomically', async () => {
    transport({ 'pack-a': 'x'.repeat(63_997) });
    const controller = new AbortController();
    expect((await compileRunContext({ prompt: 'A', selectedIds: ['pack-a'], appliedIds: [] }, controller.signal)).prompt).toHaveLength(64_000);
    await expect(compileRunContext({ prompt: 'AB', selectedIds: ['pack-a'], appliedIds: [] }, controller.signal)).rejects.toThrow();
  });

  it('does not return a partial prompt when a later pack is unavailable', async () => {
    transport({ 'pack-a': 'Context A', 'pack-missing': 404 });
    const input = { prompt: 'Original', selectedIds: ['pack-a', 'pack-missing'], appliedIds: ['pack-old'] };
    await expect(compileRunContext(input, new AbortController().signal)).rejects.toMatchObject({ status: 404 });
    expect(input).toEqual({ prompt: 'Original', selectedIds: ['pack-a', 'pack-missing'], appliedIds: ['pack-old'] });
  });

  it.each([
    { selectedIds: ['pack-a', 'pack-a'] },
    { selectedIds: Array.from({ length: 6 }, (_, i) => `pack-${i}`) },
    { selectedIds: ['../invalid'] },
  ])('rejects invalid references before sending any compilation requests: %j', async ({ selectedIds }) => {
    const calls = transport({});
    await expect(compileRunContext({ prompt: 'Original', selectedIds, appliedIds: [] }, new AbortController().signal)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it.each([
    { packId: 'pack-other', version: 2, prompt: 'Text', characters: 4, itemCount: 1, redacted: false },
    { packId: 'pack-a', version: 0, prompt: 'Text', characters: 4, itemCount: 1, redacted: false },
    { packId: 'pack-a', version: 2, prompt: 'Text', characters: 99, itemCount: 1, redacted: false },
    { packId: 'pack-a', version: 2, prompt: 'Text', characters: 4, itemCount: 21, redacted: false },
  ])('refuses mismatched or invalid compilation metadata: %#', async result => {
    transport({ 'pack-a': result });
    await expect(compileRunContext({ prompt: 'Original', selectedIds: ['pack-a'], appliedIds: [] }, new AbortController().signal))
      .rejects.toThrow();
  });

  it('refuses already-aborted work without making a request', async () => {
    const calls = transport({});
    const controller = new AbortController();
    controller.abort();
    await expect(compileRunContext({ prompt: 'Original', selectedIds: ['pack-a'], appliedIds: [] }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual([]);
  });

  it('ignores a response that arrives after cancellation even if the transport ignored abort', async () => {
    vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/' });
    let complete!: (response: Response) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>(resolve => { complete = resolve; }));
    const controller = new AbortController();
    const input = { prompt: 'Original', selectedIds: ['pack-a'], appliedIds: [] };
    const pending = compileRunContext(input, controller.signal);
    controller.abort();
    complete(new Response(JSON.stringify({ packId: 'pack-a', version: 1, prompt: 'Late', characters: 4, itemCount: 1, redacted: false })));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(input).toEqual({ prompt: 'Original', selectedIds: ['pack-a'], appliedIds: [] });
  });
});
