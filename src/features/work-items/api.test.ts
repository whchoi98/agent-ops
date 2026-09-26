import { afterEach, expect, test, vi } from 'vitest';
import { workItemsApi } from './api';
import { createWorkItemDraft, workItemInput } from './model';
import { workDetail, workPage } from './testFixtures';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('work-item requests stay in the proxy mount and preserve guarded methods and original versions', async () => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/mounted/' });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(init.method === 'DELETE' ? { ok: true } : init.method ? workDetail() : workPage()));
  });
  const signal = new AbortController().signal;
  await workItemsApi.list({ q: '설정 [x]?* %_ &', status: 'open', limit: 5 }, signal);
  await workItemsApi.get('work:a & 한글', signal);
  const draft = createWorkItemDraft();
  draft.fields.title = '설정 [x]';
  await workItemsApi.create(workItemInput(draft), signal);
  await workItemsApi.update(workDetail().id, { version: 3, nextAction: 'Literal $(echo nope) `pwd`' }, signal);
  await workItemsApi.remove(workDetail().id, 4, signal);
  await workItemsApi.prepare(workDetail().id, 5, 'kiro', signal);
  expect(calls.map(call => call.init.method ?? 'GET')).toEqual(['GET', 'GET', 'POST', 'PATCH', 'DELETE', 'POST']);
  expect(calls.map(call => new URL(call.url).pathname)).toEqual([
    '/mounted/api/productivity/work-items', '/mounted/api/productivity/work-items/work%3Aa%20%26%20%ED%95%9C%EA%B8%80',
    '/mounted/api/productivity/work-items', `/mounted/api/productivity/work-items/${workDetail().id}`,
    `/mounted/api/productivity/work-items/${workDetail().id}`, `/mounted/api/productivity/work-items/${workDetail().id}/prepare`,
  ]);
  expect(new URL(calls[0].url).searchParams.get('q')).toBe('설정 [x]?* %_ &');
  expect(new URL(calls[0].url).searchParams.get('limit')).toBe('5');
  expect(JSON.parse(String(calls[3].init.body))).toEqual({ version: 3, nextAction: 'Literal $(echo nope) `pwd`' });
  expect(JSON.parse(String(calls[4].init.body))).toEqual({ version: 4 });
  expect(JSON.parse(String(calls[5].init.body))).toEqual({ version: 5, agent: 'kiro' });
  for (const call of calls) {
    expect(call.init.credentials).toBe('same-origin');
    expect(new Headers(call.init.headers).get('X-Agent-Ops')).toBe('1');
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  }
});

test('the Overview request is bounded to five open summaries and never requests detail or bootstrap', async () => {
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  const urls: URL[] = [];
  vi.stubGlobal('fetch', async (url: string) => { urls.push(new URL(url)); return new Response(JSON.stringify(workPage())); });
  await workItemsApi.open('project-synthetic');
  expect(urls.map(url => url.pathname)).toEqual(['/api/productivity/work-items']);
  expect(Object.fromEntries(urls[0].searchParams)).toMatchObject({ status: 'open', limit: '5', offset: '0', projectId: 'project-synthetic' });
});

test('a 409 is surfaced without retrying a mutation', async () => {
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  let calls = 0;
  vi.stubGlobal('fetch', async () => {
    calls++;
    return new Response(JSON.stringify({ error: 'This work item changed. Reload it before continuing.' }), { status: 409 });
  });
  await expect(workItemsApi.update(workDetail().id, { version: 1, title: 'stale' })).rejects.toMatchObject({ status: 409 });
  expect(calls).toBe(1);
});

test('a stalled work-item request can be aborted and its timeout is cleared', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    signal = init.signal;
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const controller = new AbortController();
  const pending = workItemsApi.prepare(workDetail().id, 1, undefined, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
