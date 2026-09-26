import { afterEach, expect, test, vi } from 'vitest';
import { createHarnessHookResource } from './hooks-resource';
import { binding, harnessProject, hookPreview } from './testFixtures';

afterEach(() => { vi.unstubAllGlobals(); });

test('an external hook cannot be removed, including through a direct controller call', async () => {
  const resource = createHarnessHookResource(harnessProject.id);
  resource.start();
  let calls = 0;
  vi.stubGlobal('fetch', async () => { calls++; return new Response('{}'); });
  await resource.preview({ projectId: harnessProject.id, client: 'codex', action: 'remove' }, false);
  expect(calls).toBe(0);
  expect(resource.getSnapshot().error).not.toBeNull();
  resource.stop();
});

test('a stale apply retains redacted files and context but requires a new explicit preview before another apply', async () => {
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  const calls: Array<{ path: string; body: unknown }> = [];
  let previews = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: JSON.parse(String(init.body)) });
    if (path.endsWith('/preview')) return new Response(JSON.stringify(hookPreview({ id: `preview-${++previews}` })));
    return previews === 1
      ? new Response(JSON.stringify({ error: 'Hook preview expired or configuration changed. Create a new preview.' }), { status: 409 })
      : new Response(JSON.stringify(binding({ state: 'configured', managed: true })));
  });
  const resource = createHarnessHookResource(harnessProject.id);
  resource.start();
  const request = { projectId: harnessProject.id, client: 'codex' as const, action: 'install' as const, policyId: 'policy', revision: 'rev-1' };
  await resource.preview(request, false);
  expect(await resource.apply()).toBeNull();
  expect(resource.getSnapshot()).toMatchObject({
    request, needsPreview: true, preview: { id: 'preview-1', files: [{ before: 'token = "[REDACTED]"' }] },
    error: { status: 409 }, applied: null,
  });
  expect(await resource.apply()).toBeNull();
  expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(1);
  await resource.preview(request, false);
  expect(await resource.apply()).toMatchObject({ state: 'configured' });
  expect(calls.filter(call => call.path.endsWith('/apply'))).toEqual([
    { path: '/api/harness/hooks/apply', body: { previewId: 'preview-1', projectId: harnessProject.id } },
    { path: '/api/harness/hooks/apply', body: { previewId: 'preview-2', projectId: harnessProject.id } },
  ]);
  resource.stop();
});

test('an expired preview is rejected locally without sending apply and without losing the context', async () => {
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  const paths: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    paths.push(new URL(url).pathname);
    return new Response(JSON.stringify(hookPreview({ expiresAt: '2020-01-01T00:00:00Z' })));
  });
  const resource = createHarnessHookResource(harnessProject.id);
  resource.start();
  await resource.preview({ projectId: harnessProject.id, client: 'codex', action: 'install' }, false);
  expect(await resource.apply()).toBeNull();
  expect(resource.getSnapshot()).toMatchObject({ preview: { id: 'preview-synthetic' }, needsPreview: true });
  expect(paths).toEqual(['/api/harness/hooks/preview']);
  resource.stop();
});
