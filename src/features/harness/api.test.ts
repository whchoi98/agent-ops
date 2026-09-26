import { afterEach, expect, test, vi } from 'vitest';
import { harnessApi } from './api';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('harness requests use guarded same-origin endpoints, opaque IDs and exact versioned mutation bodies', async () => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/mounted/' });
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: new URL(url), init });
    return new Response(JSON.stringify({}));
  });
  const projectId = 'project & 한글';
  const policyId = 'policy:a/b ?';
  await harnessApi.catalog(projectId);
  await harnessApi.refresh(projectId);
  await harnessApi.saveSettings({ revision: 4, pythonPath: '/opt/venv/bin/python', retentionDays: 30, maxCacheRecords: 2000 });
  await harnessApi.probe();
  await harnessApi.policy(policyId, projectId);
  await harnessApi.validate({ projectId, policyId, revision: 'source-1' });
  await harnessApi.validate({ content: 'literal: "새로고침"\n' });
  await harnessApi.savePolicy({ projectId, content: 'rules: []\n', expectedRevision: null });
  await harnessApi.evaluate({ projectId, policyId, revision: 'source-1', client: 'kiro-cli', toolName: 'execute_bash',
    toolInput: { command: 'printf "$(literal)"; `not-executed`' } });
  await harnessApi.previewHook({ projectId, client: 'kiro-ide', action: 'install', policyId, revision: 'source-1' });
  await harnessApi.applyHook('preview:opaque', projectId);
  await harnessApi.audit({ projectId, client: 'kiro', action: 'ask', sessionId: 'id & one', q: '한글 [x]? %_ &', offset: 20, limit: 20 });
  expect(calls.map(({ url }) => url.pathname)).toEqual([
    '/mounted/api/harness', '/mounted/api/harness/refresh', '/mounted/api/harness/settings',
    '/mounted/api/harness/runtime/check', '/mounted/api/harness/policies/policy%3Aa%2Fb%20%3F',
    '/mounted/api/harness/policies/validate', '/mounted/api/harness/policies/validate',
    '/mounted/api/harness/policies/managed', '/mounted/api/harness/evaluate',
    '/mounted/api/harness/hooks/preview', '/mounted/api/harness/hooks/apply', '/mounted/api/harness/audit',
  ]);
  expect(calls.map(({ init }) => init.method ?? 'GET')).toEqual([
    'GET', 'POST', 'PATCH', 'POST', 'GET', 'POST', 'POST', 'PUT', 'POST', 'POST', 'POST', 'GET',
  ]);
  expect(JSON.parse(String(calls[3].init.body))).toEqual({});
  expect(JSON.parse(String(calls[7].init.body))).toEqual({ projectId, content: 'rules: []\n', expectedRevision: null });
  expect(JSON.parse(String(calls[8].init.body))).toEqual({
    projectId, policyId, revision: 'source-1', client: 'kiro-cli', toolName: 'execute_bash',
    toolInput: { command: 'printf "$(literal)"; `not-executed`' },
  });
  expect(JSON.parse(String(calls[10].init.body))).toEqual({ previewId: 'preview:opaque', projectId });
  expect(Object.fromEntries(calls[11].url.searchParams)).toEqual({
    projectId, client: 'kiro', action: 'ask', sessionId: 'id & one', q: '한글 [x]? %_ &', offset: '20', limit: '20',
  });
  for (const { init } of calls) {
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers).get('X-Agent-Ops')).toBe('1');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  }
});

test.each(['probe', 'evaluate'] as const)('%s allows a 30-second deadline and never retries a timed-out engine request', async kind => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  let requests = 0;
  let aborted = false;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    requests++;
    init.signal?.addEventListener('abort', () => {
      aborted = true;
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  }));
  const pending = kind === 'probe' ? harnessApi.probe() : harnessApi.evaluate({
    policyId: 'policy', revision: 'rev-1', client: 'codex', toolName: 'shell', toolInput: {},
  });
  const outcome = pending.then(() => null, cause => cause);
  await vi.advanceTimersByTimeAsync(15000);
  expect(aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(15000);
  expect(await outcome).toMatchObject({ status: 408 });
  expect(aborted).toBe(true);
  expect(requests).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('caller cancellation reaches fetch and a version conflict is never replayed', async () => {
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    signal = init.signal;
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const controller = new AbortController();
  const pending = harnessApi.catalog('first', controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
  expect(signal?.aborted).toBe(true);
  let writes = 0;
  vi.stubGlobal('fetch', async () => {
    writes++;
    return new Response(JSON.stringify({ error: 'Harness policy changed. Reload before saving.' }), { status: 409 });
  });
  await expect(harnessApi.savePolicy({ content: 'draft', expectedRevision: 'old' })).rejects.toMatchObject({ status: 409 });
  expect(writes).toBe(1);
});
