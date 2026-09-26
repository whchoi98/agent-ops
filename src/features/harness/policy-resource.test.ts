import { afterEach, expect, test, vi } from 'vitest';
import type { HarnessPolicyDetail } from '../../../shared/harness';
import { createHarnessPolicyResource } from './policy-resource';
import { deferred, harnessProject, policy } from './testFixtures';

afterEach(() => { vi.unstubAllGlobals(); });

function setup(initial = policy()) {
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  let saved = initial;
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ method, path, body });
    if (method === 'PUT') {
      if (body?.expectedRevision !== saved.revision) return new Response(JSON.stringify({ error: 'Harness policy changed. Reload before saving.' }), { status: 409 });
      saved = { ...saved, content: String(body.content), revision: 'revision-3' };
    }
    if (path.endsWith('/validate')) return new Response(JSON.stringify({
      valid: true, engineValidated: false, mode: 'standard', ruleCount: 0, errors: [], warnings: [],
    }));
    return new Response(JSON.stringify(saved));
  });
  const resource = createHarnessPolicyResource(harnessProject.id);
  resource.start();
  return { resource, calls, changeRemote: (value: HarnessPolicyDetail) => { saved = value; } };
}

test('catalog refreshes and a rejected versioned save preserve the original draft and revision', async () => {
  const { resource, calls, changeRemote } = setup();
  await resource.select('policy:managed');
  resource.edit('rules: []\n# 내 초안');
  changeRemote(policy({ revision: 'revision-2', content: '# Other tab\nrules: []\n' }));
  resource.setPolicies([policy({ revision: 'revision-2' })]);
  expect(await resource.save()).toBeNull();
  expect(resource.getSnapshot()).toMatchObject({
    draft: { content: 'rules: []\n# 내 초안', expectedRevision: 'revision-1' }, error: { status: 409 },
  });
  expect(calls.filter(call => call.method === 'PUT')).toEqual([{
    method: 'PUT', path: '/api/harness/policies/managed',
    body: { projectId: harnessProject.id, content: 'rules: []\n# 내 초안', expectedRevision: 'revision-1' },
  }]);
  expect(calls.filter(call => call.method === 'GET')).toHaveLength(1);
  resource.stop();
});

test('reading the latest source preserves a conflicting draft until an explicit revision adoption', async () => {
  const { resource, changeRemote } = setup();
  await resource.select('policy:managed');
  resource.edit('# local draft');
  changeRemote(policy({ revision: 'revision-2', content: '# remote source' }));
  await resource.reload();
  expect(resource.getSnapshot()).toMatchObject({
    detail: { revision: 'revision-2', content: '# remote source' },
    draft: { content: '# local draft', expectedRevision: 'revision-1' },
  });
  resource.adoptRevision();
  expect(resource.getSnapshot().draft).toMatchObject({ content: '# local draft', expectedRevision: 'revision-2' });
  expect(await resource.save()).toMatchObject({ content: '# local draft', revision: 'revision-3' });
  resource.stop();
});

test('policy switches and failed reads cannot erase an app-managed draft', async () => {
  const { resource } = setup();
  await resource.select('policy:managed');
  resource.edit('local: literal');
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'Policy unavailable.' }), { status: 404 }));
  await resource.select('other');
  await resource.select('policy:managed');
  expect(resource.getSnapshot()).toMatchObject({ draft: { content: 'local: literal', expectedRevision: 'revision-1' }, error: { status: 404 } });
  resource.stop();
});

test('native and redacted sources stay read-only while their saved revision can be structurally validated', async () => {
  const { resource, calls } = setup(policy({ scope: 'user', editable: false, redacted: true }));
  await resource.select('policy:managed');
  resource.edit('must not overwrite redacted source');
  expect(await resource.save()).toBeNull();
  await resource.validate();
  expect(resource.getSnapshot().draft).toBeNull();
  expect(calls.filter(call => call.method === 'PUT')).toHaveLength(0);
  expect(calls.find(call => call.path.endsWith('/validate'))?.body).toEqual({
    projectId: harnessProject.id, policyId: 'policy:managed', revision: 'revision-1',
  });
  expect(resource.getSnapshot().validation).toMatchObject({ valid: true, engineValidated: false });
  resource.stop();
});

test('draft validation sends literal content without saved-policy fields or model execution', async () => {
  const { resource, calls } = setup();
  resource.newPolicy();
  resource.edit('# 한글 원문\nrules: []');
  await resource.validate();
  expect(calls).toEqual([{
    method: 'POST', path: '/api/harness/policies/validate',
    body: { projectId: harnessProject.id, content: '# 한글 원문\nrules: []' },
  }]);
  resource.stop();
});

test('a late policy detail cannot replace the new selection or a draft after stop', async () => {
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  const pending = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => { signal = init.signal; return pending.promise; });
  const resource = createHarnessPolicyResource(harnessProject.id);
  resource.start();
  const loading = resource.select('slow');
  resource.newPolicy();
  resource.edit('# still here');
  expect(signal?.aborted).toBe(true);
  pending.resolve(new Response(JSON.stringify(policy({ id: 'slow' }))));
  await loading;
  expect(resource.getSnapshot()).toMatchObject({ selectedId: 'new', draft: { content: '# still here', expectedRevision: null } });
  resource.stop();
});
