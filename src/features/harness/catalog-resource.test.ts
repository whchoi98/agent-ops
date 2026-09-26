import { afterEach, expect, test, vi } from 'vitest';
import { createHarnessCatalogResource } from './catalog-resource';
import { binding, catalog, deferred, harnessProject, policy, runtime, settings } from './testFixtures';

afterEach(() => { vi.unstubAllGlobals(); });

function setup(initial = catalog()) {
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  const replies: Array<Promise<Response>> = [Promise.resolve(new Response(JSON.stringify(initial)))];
  const calls: Array<{ path: string; method: string; signal: AbortSignal }> = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ path: new URL(url).pathname, method: init.method ?? 'GET', signal: init.signal as AbortSignal });
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected extra catalog request.');
    return reply;
  });
  const resource = createHarnessCatalogResource();
  resource.start();
  return { resource, replies, calls };
}

for (const refresh of [false, true]) {
  test.each(['policy', 'settings', 'probe', 'binding'] as const)(
    `${refresh ? 'manual' : 'automatic'} catalog results cannot replace an accepted %s mutation, even if abort is ignored`,
    async kind => {
      const initial = catalog({
        runtime: runtime({ state: 'unchecked', checkedAt: null }),
        bindings: [binding({ client: 'kiro-ide' }), binding({ client: 'kiro-cli' })],
      });
      const { resource, replies, calls } = setup(initial);
      await resource.load(harnessProject.id);
      const delayed = deferred<Response>();
      replies.push(delayed.promise);
      const reading = resource.load(harnessProject.id, refresh);
      if (kind === 'policy') resource.acceptPolicy(policy({ revision: 'revision-2', content: '# Saved R2' }));
      if (kind === 'settings') resource.acceptSettings(settings({ revision: 2, pythonPath: '/opt/new/python', retentionDays: 60 }));
      if (kind === 'probe') resource.acceptRuntime(runtime({ engineVersion: '0.1.1' }), 1);
      if (kind === 'binding') resource.acceptBinding(binding({ client: 'kiro-ide', managed: true, state: 'configured', policyRevision: 'revision-2' }));
      expect(calls[1].signal.aborted).toBe(true);
      delayed.resolve(new Response(JSON.stringify(initial)));
      expect(await reading).toBeNull();
      const state = resource.getSnapshot();
      expect(state).toMatchObject({ projectId: harnessProject.id, loading: false, error: null });
      if (kind === 'policy') expect(state.data?.policies).toMatchObject([{ revision: 'revision-2', content: '# Saved R2' }]);
      if (kind === 'settings') {
        expect(state.data?.settings).toMatchObject({ revision: 2, pythonPath: '/opt/new/python', retentionDays: 60 });
        expect(state.global?.settings.revision).toBe(2);
      }
      if (kind === 'probe') {
        expect(state.data?.runtime.state).toBe('ready');
        expect(state.global?.runtime.state).toBe('ready');
      }
      if (kind === 'binding') expect(state.data?.bindings).toMatchObject([
        { client: 'kiro-ide', managed: true, state: 'configured', policyRevision: 'revision-2' },
        { client: 'kiro-cli', managed: true, state: 'configured', policyRevision: 'revision-2' },
      ]);
      expect(calls.map(call => call.path)).toEqual(['/api/harness', refresh ? '/api/harness/refresh' : '/api/harness']);
      resource.stop();
    },
  );
}

test('a read started after a probe accepts a same-revision unchecked reset without comparing timestamps', async () => {
  const { resource, replies } = setup();
  await resource.load(harnessProject.id);
  resource.acceptRuntime(runtime({ checkedAt: '2099-01-01T00:00:00Z' }), 1);
  replies.push(Promise.resolve(new Response(JSON.stringify(catalog({
    runtime: runtime({ state: 'unchecked', checkedAt: null, engineVersion: null, pythonVersion: null }),
  })))));
  await resource.load(harnessProject.id, true);
  expect(resource.getSnapshot()).toMatchObject({
    data: { settings: { revision: 1 }, runtime: { state: 'unchecked', checkedAt: null } },
    global: { settings: { revision: 1 }, runtime: { state: 'unchecked', checkedAt: null } },
  });
  resource.stop();
});

test('successive mutations merge into the current catalog without depending on React render timing', async () => {
  const { resource } = setup();
  await resource.load(harnessProject.id);
  resource.acceptSettings(settings({ revision: 2, retentionDays: 60 }));
  resource.acceptPolicy(policy({ revision: 'revision-2' }));
  resource.acceptRuntime(runtime({ checkedAt: '2026-09-26T02:00:00Z' }), 2);
  resource.acceptBinding(binding({ managed: true, state: 'configured' }));
  expect(resource.getSnapshot()).toMatchObject({
    data: {
      settings: { revision: 2, retentionDays: 60 }, policies: [{ revision: 'revision-2' }],
      runtime: { state: 'ready', checkedAt: '2026-09-26T02:00:00Z' }, bindings: [{ managed: true, state: 'configured' }],
    },
    global: { settings: { revision: 2, retentionDays: 60 }, runtime: { state: 'ready', checkedAt: '2026-09-26T02:00:00Z' } },
  });
  resource.stop();
});

test('a project switch still cancels old reads and rejects mutations belonging to the previous scope', async () => {
  const { resource, replies, calls } = setup();
  await resource.load(harnessProject.id);
  const delayed = deferred<Response>();
  replies.push(delayed.promise);
  const first = resource.load(harnessProject.id, true);
  replies.push(Promise.resolve(new Response(JSON.stringify(catalog({ projectId: 'other', policies: [], bindings: [] })))));
  await resource.load('other');
  expect(resource.acceptPolicy(policy({ revision: 'revision-2' }))).toBe(false);
  expect(resource.acceptBinding(binding({ managed: true }))).toBe(false);
  delayed.resolve(new Response(JSON.stringify(catalog())));
  await first;
  expect(calls[1].signal.aborted).toBe(true);
  expect(resource.getSnapshot()).toMatchObject({ projectId: 'other', data: { projectId: 'other', policies: [], bindings: [] } });
  resource.stop();
});

test('a global probe during a scope read preserves its result and obtains only a fresh local GET for the missing catalog', async () => {
  const { resource, replies, calls } = setup();
  await resource.load(harnessProject.id);
  const delayed = deferred<Response>();
  replies.push(delayed.promise);
  const first = resource.load('other');
  const fresh = deferred<Response>();
  replies.push(fresh.promise);
  resource.acceptRuntime(runtime(), 1);
  expect(resource.getSnapshot().global?.runtime.state).toBe('ready');
  delayed.resolve(new Response(JSON.stringify(catalog({
    projectId: 'other', runtime: runtime({ state: 'unchecked', checkedAt: null }),
  }))));
  await first;
  expect(resource.getSnapshot().global?.runtime.state).toBe('ready');
  fresh.resolve(new Response(JSON.stringify(catalog({ projectId: 'other', runtime: runtime() }))));
  await vi.waitFor(() => expect(resource.getSnapshot()).toMatchObject({ loading: false, data: { projectId: 'other', runtime: { state: 'ready' } } }));
  expect(calls.map(call => [call.path, call.method])).toEqual([
    ['/api/harness', 'GET'], ['/api/harness', 'GET'], ['/api/harness', 'GET'],
  ]);
  resource.stop();
});

test('stale read errors cannot hide an accepted save, while a subsequent current read failure retains that save', async () => {
  const { resource, replies } = setup();
  await resource.load(harnessProject.id);
  const delayed = deferred<Response>();
  replies.push(delayed.promise);
  const first = resource.load(harnessProject.id, true);
  resource.acceptPolicy(policy({ revision: 'revision-2' }));
  delayed.resolve(new Response(JSON.stringify({ error: 'Old catalog failure.' }), { status: 500 }));
  await first;
  expect(resource.getSnapshot().error).toBeNull();
  replies.push(Promise.resolve(new Response(JSON.stringify({ error: 'Current catalog failure.' }), { status: 500 })));
  await resource.load(harnessProject.id);
  expect(resource.getSnapshot()).toMatchObject({ error: { status: 500 }, data: { policies: [{ revision: 'revision-2' }] } });
  resource.stop();
});

test('a probe for an older settings revision cannot certify the new Python configuration', async () => {
  const { resource } = setup();
  await resource.load(harnessProject.id);
  resource.acceptSettings(settings({ revision: 2, pythonPath: '/opt/other/python3' }));
  expect(resource.acceptRuntime(runtime(), 1)).toBe(false);
  expect(resource.getSnapshot()).toMatchObject({
    data: { settings: { revision: 2 }, runtime: { state: 'unchecked' } },
    global: { settings: { revision: 2 }, runtime: { state: 'unchecked' } },
  });
  resource.stop();
});
