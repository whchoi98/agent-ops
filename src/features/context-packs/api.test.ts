import { afterEach, expect, test, vi } from 'vitest';
import { contextPacksApi } from './api';

afterEach(() => { vi.unstubAllGlobals(); });

test('feature requests preserve proxy mounting, mutation headers, body versions and abort signals', async () => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/mounted/' });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }));
  });
  const signal = new AbortController().signal;
  await contextPacksApi.list({ q: '원문 & ?', projectId: 'project-fixture', offset: 25, limit: 25 }, signal);
  await contextPacksApi.get('pack-fixture', signal);
  await contextPacksApi.create({ name: 'Original user name' }, signal);
  await contextPacksApi.update('pack-fixture', { version: 1, instructions: '  original\ninstructions  ' }, signal);
  await contextPacksApi.addItem('pack-fixture', {
    version: 2, kind: 'message', sessionId: 'codex:fixture', messageId: 'message-fixture', offset: 3, length: 5,
  }, signal);
  await contextPacksApi.updateItem('pack-fixture', 'pack-item-one', { version: 3, title: 'Label' }, signal);
  await contextPacksApi.reorder('pack-fixture', { version: 4, itemIds: ['pack-item-one'] }, signal);
  await contextPacksApi.removeItem('pack-fixture', 'pack-item-one', { version: 5 }, signal);
  await contextPacksApi.compile('pack-fixture', signal);
  await contextPacksApi.remove('pack-fixture', { version: 6 }, signal);
  expect(calls.map(call => new URL(call.url).pathname)).toEqual([
    '/mounted/api/productivity/context-packs', '/mounted/api/productivity/context-packs/pack-fixture',
    '/mounted/api/productivity/context-packs', '/mounted/api/productivity/context-packs/pack-fixture',
    '/mounted/api/productivity/context-packs/pack-fixture/items',
    '/mounted/api/productivity/context-packs/pack-fixture/items/pack-item-one',
    '/mounted/api/productivity/context-packs/pack-fixture/reorder',
    '/mounted/api/productivity/context-packs/pack-fixture/items/pack-item-one',
    '/mounted/api/productivity/context-packs/pack-fixture/compile',
    '/mounted/api/productivity/context-packs/pack-fixture',
  ]);
  expect(new URL(calls[0].url).searchParams.get('q')).toBe('원문 & ?');
  expect(calls.map(call => call.init.method ?? 'GET')).toEqual([
    'GET', 'GET', 'POST', 'PATCH', 'POST', 'PATCH', 'POST', 'DELETE', 'POST', 'DELETE',
  ]);
  expect(JSON.parse(String(calls[3].init.body))).toEqual({ version: 1, instructions: '  original\ninstructions  ' });
  expect(JSON.parse(String(calls[4].init.body))).toEqual({
    version: 2, kind: 'message', sessionId: 'codex:fixture', messageId: 'message-fixture', offset: 3, length: 5,
  });
  expect(JSON.parse(String(calls[7].init.body))).toEqual({ version: 5 });
  expect(JSON.parse(String(calls[9].init.body))).toEqual({ version: 6 });
  for (const { init } of calls) {
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers).get('X-Agent-Ops')).toBe('1');
    expect(init.signal).toBe(signal);
  }
});

test('export returns the complete downloaded body and a safe local filename', async () => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/mounted/' });
  let requestUrl = '';
  let requestInit: RequestInit = {};
  const complete = 'source\n'.repeat(6000) + 'EXPORT-END';
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requestUrl = url; requestInit = init;
    return new Response(complete, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
  });
  const signal = new AbortController().signal;
  const result = await contextPacksApi.export('pack-fixture', 'md', signal);
  expect(new URL(requestUrl).pathname).toBe('/mounted/api/productivity/context-packs/pack-fixture/export');
  expect(new URL(requestUrl).searchParams.get('format')).toBe('md');
  expect(requestInit.credentials).toBe('same-origin');
  expect(new Headers(requestInit.headers).get('X-Agent-Ops')).toBe('1');
  expect(requestInit.signal).toBe(signal);
  expect(result).toEqual({
    body: complete, type: 'text/markdown; charset=utf-8', extension: 'md', filename: 'agent-ops-pack-fixture.md',
  });
});

test('conflicts and failed exports surface without automatically retrying or downloading errors', async () => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/' });
  let requests = 0;
  vi.stubGlobal('fetch', async () => {
    requests++;
    return new Response(JSON.stringify({ error: 'This context pack changed. Reload it before editing.' }), { status: 409 });
  });
  await expect(contextPacksApi.update('pack-fixture', { version: 1, name: 'Stale' })).rejects.toMatchObject({ status: 409 });
  expect(requests).toBe(1);
  await expect(contextPacksApi.export('pack-fixture', 'json')).rejects.toMatchObject({ status: 409 });
  expect(requests).toBe(2);
});

test('aborting a capture request preserves the abort cause for dialog cleanup', async () => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/' });
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const controller = new AbortController();
  const promise = contextPacksApi.addItem('pack-fixture', { version: 1, kind: 'note', title: 'Note', text: 'Text' }, controller.signal);
  const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await assertion;
});
