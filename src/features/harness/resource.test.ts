import { afterEach, expect, test, vi } from 'vitest';
import { harnessApi } from './api';
import { createHarnessActionResource, createHarnessReadResource } from './resource';
import { catalog, deferred } from './testFixtures';
import type { HarnessCatalog } from '../../../shared/harness';

afterEach(() => { vi.unstubAllGlobals(); });

test('switching project aborts the earlier read and discards late data even if the transport ignores abort', async () => {
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  const first = deferred<Response>();
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    signals.push(init.signal as AbortSignal);
    return new URL(url).searchParams.get('projectId') === 'first' ? first.promise
      : Promise.resolve(new Response(JSON.stringify(catalog({ projectId: 'second' }))));
  });
  const resource = createHarnessReadResource<HarnessCatalog>();
  resource.start();
  const pending = resource.load('first', signal => harnessApi.catalog('first', signal));
  await resource.load('second', signal => harnessApi.catalog('second', signal));
  expect(signals[0].aborted).toBe(true);
  first.resolve(new Response(JSON.stringify(catalog({ projectId: 'first' }))));
  await pending;
  expect(resource.getSnapshot()).toMatchObject({ key: 'second', loading: false, data: { projectId: 'second' }, error: null });
  resource.stop();
});

test('a failed local refresh keeps the current view and accepts a later explicit retry without bootstrap', async () => {
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  let failing = false;
  const paths: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    paths.push(new URL(url).pathname);
    return failing ? new Response(JSON.stringify({ error: 'Failed to read harness catalog.' }), { status: 500 })
      : new Response(JSON.stringify(catalog()));
  });
  const resource = createHarnessReadResource<HarnessCatalog>();
  resource.start();
  const load = () => resource.load('project', signal => harnessApi.catalog('project', signal));
  await load();
  failing = true;
  await load();
  expect(resource.getSnapshot()).toMatchObject({ data: { policies: [{ id: 'policy:managed' }] }, error: { status: 500 } });
  failing = false;
  await load();
  expect(resource.getSnapshot().error).toBeNull();
  expect(paths).toEqual(['/api/harness', '/api/harness', '/api/harness']);
  resource.stop();
});

test('stopping a mutation reports an unknown outcome and never accepts a late success or duplicate click', async () => {
  const result = deferred<string>();
  let signal: AbortSignal | undefined;
  let starts = 0;
  const action = createHarnessActionResource();
  action.start();
  const pending = action.run(async value => { signal = value; starts++; return result.promise; });
  expect(await action.run(async () => { starts++; return 'duplicate'; })).toBeUndefined();
  action.stop();
  expect(signal?.aborted).toBe(true);
  expect(action.getSnapshot()).toMatchObject({ busy: false, error: { unknown: true } });
  result.resolve('late success');
  expect(await pending).toBeUndefined();
  expect(starts).toBe(1);
});
