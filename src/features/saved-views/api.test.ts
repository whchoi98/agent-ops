import { afterEach, expect, test, vi } from 'vitest';
import { savedViewsApi } from './api';
import { savedView } from './testFixtures';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('saved-view requests preserve the proxy mount, literal filters, version bodies and shared guards', async () => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/mounted/' });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(init.method === 'DELETE' ? { ok: true }
      : init.method ? savedView() : { items: [savedView()] }));
  });
  const controller = new AbortController();
  await savedViewsApi.list(controller.signal);
  await savedViewsApi.create({
    name: '설정 [x]', query: { q: '설정 & [x]?* `pwd` $(echo nope)', project: '/tmp/a & b' },
    period: 'all-time', pinned: true,
  }, controller.signal);
  await savedViewsApi.update(savedView().id, { version: 3, pinned: false }, controller.signal);
  await savedViewsApi.remove(savedView().id, 4, controller.signal);
  expect(calls.map(call => new URL(call.url).pathname)).toEqual([
    '/mounted/api/productivity/saved-views', '/mounted/api/productivity/saved-views',
    `/mounted/api/productivity/saved-views/${savedView().id}`, `/mounted/api/productivity/saved-views/${savedView().id}`,
  ]);
  expect(calls.map(call => call.init.method ?? 'GET')).toEqual(['GET', 'POST', 'PATCH', 'DELETE']);
  expect(JSON.parse(String(calls[1].init.body))).toEqual({
    name: '설정 [x]', query: { q: '설정 & [x]?* `pwd` $(echo nope)', project: '/tmp/a & b' },
    period: 'all-time', pinned: true,
  });
  expect(JSON.parse(String(calls[2].init.body))).toEqual({ version: 3, pinned: false });
  expect(JSON.parse(String(calls[3].init.body))).toEqual({ version: 4 });
  for (const call of calls) {
    expect(call.init.credentials).toBe('same-origin');
    expect(call.init.cache).toBe('no-store');
    expect(new Headers(call.init.headers).get('X-Agent-Ops')).toBe('1');
    expect(new Headers(call.init.headers).get('Content-Type')).toBe('application/json');
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  }
});

test('a stale write reaches the caller without replaying the PATCH', async () => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/' });
  let patches = 0;
  vi.stubGlobal('fetch', async () => {
    patches++;
    return new Response(JSON.stringify({ error: '저장 검색이 변경되었습니다. 새로고침 후 다시 시도하세요.' }), { status: 409 });
  });
  await expect(savedViewsApi.update(savedView().id, { version: 1, pinned: false })).rejects.toMatchObject({
    status: 409, message: '저장 검색이 변경되었습니다. 새로고침 후 다시 시도하세요.',
  });
  expect(patches).toBe(1);
});

test('unmount cancellation aborts the actual request and clears its timeout', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/' });
  let requestSignal: AbortSignal | null | undefined;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    requestSignal = init.signal;
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const controller = new AbortController();
  const pending = savedViewsApi.remove(savedView().id, 1, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
  expect(requestSignal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('a stalled metadata read is bounded and leaves no timeout behind', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/' });
  let aborted = false;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  }));
  const pending = savedViewsApi.list().catch(cause => cause);
  await vi.advanceTimersByTimeAsync(15000);
  expect(await pending).toMatchObject({ status: 408 });
  expect(aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
