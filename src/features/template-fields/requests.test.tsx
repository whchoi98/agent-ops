import { afterEach, expect, it, vi } from 'vitest';
import { templateFieldsApi } from './api';

afterEach(() => vi.unstubAllGlobals());

it('sends guarded feature requests under the proxy mount and keeps revision and values intact', async () => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/mounted/' });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({}));
  });
  const controller = new AbortController();
  const id = 'template & original';
  await templateFieldsApi.create({
    name: '원문', description: '취소', category: 'custom', agent: 'any', policy: 'read-only', prompt: '  {{target}}\n',
    variables: [{ name: 'target', label: '새 실행', type: 'text', required: true }],
  }, controller.signal);
  await templateFieldsApi.update(id, { prompt: '  unchanged whitespace\n', variables: [], expectedRevision: 7 }, controller.signal);
  await templateFieldsApi.history(id, controller.signal);
  await templateFieldsApi.restore(id, 2, 8, controller.signal);
  await templateFieldsApi.render(id, { target: '{{other}} $& $(literal)' }, controller.signal);
  expect(calls.map(call => new URL(call.url).pathname)).toEqual([
    '/mounted/api/templates',
    '/mounted/api/templates/template%20%26%20original',
    '/mounted/api/templates/template%20%26%20original/history',
    '/mounted/api/templates/template%20%26%20original/restore',
    '/mounted/api/templates/template%20%26%20original/render',
  ]);
  expect(calls.map(call => call.init.method ?? 'GET')).toEqual(['POST', 'PATCH', 'GET', 'POST', 'POST']);
  expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
    name: '원문', description: '취소', prompt: '  {{target}}\n',
    variables: [{ name: 'target', label: '새 실행', type: 'text', required: true }],
  });
  expect(JSON.parse(String(calls[1].init.body))).toEqual({
    prompt: '  unchanged whitespace\n', variables: [], expectedRevision: 7,
  });
  expect(JSON.parse(String(calls[3].init.body))).toEqual({ revision: 2, expectedRevision: 8 });
  expect(JSON.parse(String(calls[4].init.body))).toEqual({ values: { target: '{{other}} $& $(literal)' } });
  for (const { init } of calls) {
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers).get('X-Agent-Ops')).toBe('1');
    expect(init.signal).toBe(controller.signal);
  }
});

it('allows old PATCH clients to omit expectedRevision while retaining all provided fields', async () => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/' });
  let sent: unknown;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ revision: 2, name: '원문' }));
  });
  await templateFieldsApi.update('template-1', { name: '원문' });
  expect(sent).toEqual({ name: '원문' });
});

it('surfaces a revision conflict without retrying a mutation or changing the submitted draft', async () => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/' });
  let requests = 0;
  vi.stubGlobal('fetch', async () => {
    requests++;
    return new Response(JSON.stringify({ error: '템플릿이 변경되었습니다. 최신 내용을 다시 불러온 뒤 시도하세요.' }), { status: 409 });
  });
  const patch = { prompt: '  내 초안\n', expectedRevision: 4 };
  await expect(templateFieldsApi.update('template-1', patch)).rejects.toMatchObject({ status: 409 });
  expect(patch).toEqual({ prompt: '  내 초안\n', expectedRevision: 4 });
  expect(requests).toBe(1);
});

it('allows an unmounted history caller to abort an outstanding request', async () => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/' });
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const controller = new AbortController();
  const pending = templateFieldsApi.history('template-1', controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
});
