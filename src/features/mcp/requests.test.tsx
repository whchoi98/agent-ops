import { afterEach, expect, test, vi } from 'vitest';
import { mcpApi } from './api';
import { fixtureCheckId, fixtureServerId, mcpPreview } from './testFixtures';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('every MCP route stays in the proxy mount and reuses guarded same-origin JSON requests', async () => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/mounted/' });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }));
  });
  const controller = new AbortController();
  await mcpApi.catalog({ projectId: 'project & one', agent: 'kiro', q: '설정 & 원문', limit: 20 }, controller.signal);
  await mcpApi.refresh('project & one', controller.signal);
  await mcpApi.detail(fixtureServerId, 'project & one', controller.signal);
  await mcpApi.preview(fixtureServerId, 'project & one', controller.signal);
  await mcpApi.check(fixtureServerId, 'project & one', mcpPreview().previewId, controller.signal);
  await mcpApi.getCheck(fixtureCheckId, controller.signal);
  await mcpApi.cancel(fixtureCheckId, controller.signal);

  expect(calls.map(call => new URL(call.url).pathname)).toEqual([
    '/mounted/api/mcp', '/mounted/api/mcp/refresh', `/mounted/api/mcp/${fixtureServerId}`,
    `/mounted/api/mcp/${fixtureServerId}/preview`, `/mounted/api/mcp/${fixtureServerId}/check`,
    `/mounted/api/mcp/checks/${fixtureCheckId}`, `/mounted/api/mcp/checks/${fixtureCheckId}/cancel`,
  ]);
  expect(new URL(calls[0].url).searchParams.get('q')).toBe('설정 & 원문');
  expect(new URL(calls[2].url).searchParams.get('projectId')).toBe('project & one');
  expect(calls.map(call => call.init.method ?? 'GET')).toEqual(['GET', 'POST', 'GET', 'POST', 'POST', 'GET', 'POST']);
  expect(JSON.parse(String(calls[4].init.body))).toEqual({
    projectId: 'project & one', previewId: 'mcp-preview-01234567-89ab-4cde-8fab-0123456789ab',
  });
  expect(JSON.parse(String(calls[6].init.body))).toEqual({});
  for (const { init } of calls) {
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers).get('X-Agent-Ops')).toBe('1');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  }
});

test('a hidden or unmounted caller can abort a mutation request without losing its signal', async () => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/' });
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    signal = init.signal;
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const controller = new AbortController();
  const pending = mcpApi.check(fixtureServerId, undefined, mcpPreview().previewId, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
  expect(signal?.aborted).toBe(true);
});

test('an unresponsive MCP request times out instead of retaining a UI request indefinitely', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/' });
  let aborted = false;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  }));
  const pending = mcpApi.getCheck(fixtureCheckId);
  const outcome = pending.then(() => null, cause => cause);
  await vi.advanceTimersByTimeAsync(15000);
  expect(await outcome).toMatchObject({ status: 408 });
  expect(aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  'Configuration or execution settings changed. Review a new preview.',
  'Another MCP probe is in progress. Cancel it or wait for cleanup to finish.',
])('a rejected start reaches the UI without retrying a POST: %s', async message => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/' });
  let posts = 0;
  vi.stubGlobal('fetch', async () => {
    posts++;
    return new Response(JSON.stringify({ error: message }), { status: 409 });
  });
  await expect(mcpApi.check(fixtureServerId, undefined, mcpPreview().previewId))
    .rejects.toMatchObject({ status: 409, message });
  expect(posts).toBe(1);
});
