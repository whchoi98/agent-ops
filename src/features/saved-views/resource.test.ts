import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createSavedViewsResource } from './resource';
import { deferred, savedView } from './testFixtures';

beforeEach(() => vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/mounted/' }));
afterEach(() => vi.unstubAllGlobals());

test('loading metadata never runs stored searches or calculates their session counts', async () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ items: [savedView()] }));
  });
  const resource = createSavedViewsResource();
  resource.start();
  try {
    await resource.reload();
    expect(resource.getSnapshot()).toMatchObject({ views: [savedView()], loading: false, error: null });
    expect(urls).toEqual(['https://workbench.invalid/mounted/api/productivity/saved-views']);
  } finally { resource.stop(); }
});

test('a later revision aborts the previous load and ignores its late response', async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const signals: Array<AbortSignal | null | undefined> = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    signals.push(init.signal);
    return signals.length === 1 ? first.promise : second.promise;
  });
  const resource = createSavedViewsResource();
  resource.start();
  try {
    const initial = resource.reload();
    const latest = resource.reload();
    expect(signals[0]?.aborted).toBe(true);
    second.resolve(new Response(JSON.stringify({ items: [savedView({ version: 2, name: 'Current' })] })));
    await latest;
    first.resolve(new Response(JSON.stringify({ items: [savedView({ name: 'Old' })] })));
    await initial;
    expect(resource.getSnapshot()).toMatchObject({
      views: [savedView({ version: 2, name: 'Current' })], loading: false, error: null,
    });
  } finally { resource.stop(); }
});

test('stopping a consumer aborts loads and suppresses late results and error notifications', async () => {
  const pending = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => { signal = init.signal; return pending.promise; });
  const resource = createSavedViewsResource();
  resource.start();
  let notifications = 0;
  const unsubscribe = resource.subscribe(() => { notifications++; });
  const loading = resource.reload();
  resource.stop();
  const count = notifications;
  expect(signal?.aborted).toBe(true);
  pending.resolve(new Response(JSON.stringify({ items: [savedView()] })));
  await loading;
  expect(resource.getSnapshot().views).toEqual([]);
  expect(resource.getSnapshot().error).toBeNull();
  expect(notifications).toBe(count);
  unsubscribe();
});

test('load failures retain the last list and an explicit retry can recover', async () => {
  let request = 0;
  vi.stubGlobal('fetch', async () => {
    request++;
    return request === 2
      ? new Response(JSON.stringify({ error: 'Synthetic load unavailable' }), { status: 503 })
      : new Response(JSON.stringify({ items: [savedView({ version: request })] }));
  });
  const resource = createSavedViewsResource();
  resource.start();
  try {
    await resource.reload();
    await resource.reload();
    expect(resource.getSnapshot()).toMatchObject({
      views: [savedView()], loading: false, error: 'Synthetic load unavailable',
    });
    await resource.reload();
    expect(resource.getSnapshot()).toMatchObject({ error: null, views: [savedView({ version: 3 })] });
  } finally { resource.stop(); }
});

test('a saved mutation updates local metadata even if the following reload fails', async () => {
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => init.method === 'POST'
    ? new Response(JSON.stringify(savedView()), { status: 201 })
    : new Response(JSON.stringify({ error: 'Synthetic reload unavailable' }), { status: 503 }));
  const resource = createSavedViewsResource();
  resource.start();
  try {
    const result = await resource.create({ name: '설정 [x]?* & review', query: { q: '[x]?*' }, period: 'last7', pinned: true });
    expect(result).toEqual(savedView());
    await vi.waitFor(() => expect(resource.getSnapshot().loading).toBe(false));
    expect(resource.getSnapshot()).toMatchObject({
      views: [savedView()], saving: false, writeError: null, error: 'Synthetic reload unavailable',
    });
  } finally { resource.stop(); }
});

test('concurrent mutation submissions send once and defer revision reloads until the write finishes', async () => {
  const pending = deferred<Response>();
  const methods: string[] = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    methods.push(init.method ?? 'GET');
    return init.method === 'PATCH' ? pending.promise
      : Promise.resolve(new Response(JSON.stringify({ items: [savedView({ version: 2, pinned: false })] })));
  });
  const resource = createSavedViewsResource();
  resource.start();
  try {
    const first = resource.update(savedView().id, { version: 1, pinned: false });
    expect(resource.getSnapshot().saving).toBe(true);
    expect(await resource.update(savedView().id, { version: 1, pinned: false })).toBeNull();
    await resource.reload();
    await resource.reload();
    expect(methods).toEqual(['PATCH']);
    pending.resolve(new Response(JSON.stringify(savedView({ version: 2, pinned: false }))));
    expect(await first).toEqual(savedView({ version: 2, pinned: false }));
    await vi.waitFor(() => expect(resource.getSnapshot().loading).toBe(false));
    expect(resource.getSnapshot().saving).toBe(false);
    expect(methods).toEqual(['PATCH', 'GET']);
  } finally { resource.stop(); }
});

test('a stale edit surfaces the error, reloads current versions and never replays user changes', async () => {
  const methods: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    methods.push(init.method ?? 'GET');
    return init.method === 'PATCH'
      ? new Response(JSON.stringify({ error: '저장 검색이 변경되었습니다. 새로고침 후 다시 시도하세요.' }), { status: 409 })
      : new Response(JSON.stringify({ items: [savedView({ version: 3, name: 'Other tab' })] }));
  });
  const resource = createSavedViewsResource();
  resource.start();
  try {
    expect(await resource.update(savedView().id, { version: 1, name: 'Rejected draft' })).toBeNull();
    await vi.waitFor(() => expect(resource.getSnapshot().loading).toBe(false));
    expect(resource.getSnapshot()).toMatchObject({
      views: [savedView({ version: 3, name: 'Other tab' })], saving: false,
      writeError: '저장 검색이 변경되었습니다. 새로고침 후 다시 시도하세요.',
    });
    expect(methods).toEqual(['PATCH', 'GET']);
  } finally { resource.stop(); }
});

test('unmounting during a write aborts its request without updating or refetching after completion', async () => {
  const pending = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  const methods: string[] = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    signal = init.signal;
    methods.push(init.method ?? 'GET');
    return pending.promise;
  });
  const resource = createSavedViewsResource();
  resource.start();
  const writing = resource.create({ name: 'Later', query: {} });
  resource.stop();
  expect(signal?.aborted).toBe(true);
  pending.resolve(new Response(JSON.stringify(savedView())));
  expect(await writing).toBeNull();
  expect(resource.getSnapshot().views).toEqual([]);
  expect(resource.getSnapshot().writeError).toBeNull();
  expect(methods).toEqual(['POST']);
});

test('deletion sends the selected version and removes only the accepted record', async () => {
  const other = savedView({ id: 'saved-view-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Keep' });
  let deleted = false;
  let removedBody: unknown;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    if (init.method === 'DELETE') {
      deleted = true;
      removedBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response(JSON.stringify({ items: deleted ? [other] : [savedView(), other] }));
  });
  const resource = createSavedViewsResource();
  resource.start();
  try {
    await resource.reload();
    expect(await resource.remove(savedView().id, 1)).toBe(true);
    expect(removedBody).toEqual({ version: 1 });
    expect(resource.getSnapshot().views.map(view => view.name)).toEqual(['Keep']);
  } finally { resource.stop(); }
});

test('a strict-mode start after cleanup can reload without reviving an aborted write', async () => {
  const old = deferred<Response>();
  let request = 0;
  vi.stubGlobal('fetch', async () => ++request === 1 ? old.promise
    : new Response(JSON.stringify({ items: [savedView({ version: 2 })] })));
  const resource = createSavedViewsResource();
  resource.start();
  const writing = resource.create({ name: 'Old write', query: {} });
  resource.stop();
  resource.start();
  try {
    await resource.reload();
    old.resolve(new Response(JSON.stringify(savedView())));
    expect(await writing).toBeNull();
    expect(resource.getSnapshot()).toMatchObject({ views: [savedView({ version: 2 })], saving: false, error: null });
  } finally { resource.stop(); }
});
