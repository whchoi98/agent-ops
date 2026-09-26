import Fastify from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import { ZodError } from 'zod';
import { Store } from '../../../server/store';
import { WorkItemService } from '../../../server/productivity/work-items';
import { registerWorkItemRoutes } from '../../../server/productivity/work-item-routes';
import { retryWrite } from '../../../server/write-retry';
import { createWorkItemEditorResource } from './editor-resource';
import { workItemsApi } from './api';
import { createWorkItemDraft } from './model';
import { deferred } from './testFixtures';
import type { WorkItemFields } from '../../../shared/work-items';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.unstubAllGlobals();
});

function setup(fields: Partial<WorkItemFields> = {}) {
  const store = new Store(':memory:');
  const project = store.ensureProject('/tmp/work-ui-fixture', 'Fixture project');
  const service = new WorkItemService(store, {
    contextPackInfo: id => id === 'pack-fixture' ? { name: 'Fixture context' } : null,
    compileContextPack: () => 'Literal selected context',
  });
  const item = service.create({
    title: 'Original task', description: 'Original full description', nextAction: 'Original next action',
    projectId: project.id, contextPackIds: ['pack-fixture'], ...fields,
  });
  const app = Fastify();
  app.setErrorHandler((cause, _request, reply) => {
    const error = cause as Error & { statusCode?: number };
    return reply.code(cause instanceof ZodError ? 400 : error.statusCode ?? 500).send({ error: error.message });
  });
  registerWorkItemRoutes(app, service, { write: action => retryWrite(store, action), onChange: () => {} });
  const requests: Array<{ method: string; path: string; body: unknown; status: number }> = [];
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname + new URL(url).search;
    const method = (init.method ?? 'GET') as 'GET' | 'POST' | 'PATCH' | 'DELETE';
    const response = await app.inject({
      url: path, method, headers: Object.fromEntries(new Headers(init.headers)),
      ...(init.body ? { payload: String(init.body) } : {}),
    });
    requests.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined, status: response.statusCode });
    return new Response(response.body, { status: response.statusCode });
  });
  const resource = createWorkItemEditorResource({ id: item.id });
  resource.start();
  cleanups.push(async () => { resource.stop(); await app.close(); store.close(); });
  return { item, service, resource, requests, project };
}

test('a list refresh cannot change the version or values of an open editor draft', async () => {
  const { item, service, resource, requests } = setup();
  await resource.reload();
  resource.edit({ title: 'My draft title', nextAction: 'My draft step' });
  const remote = service.update(item.id, { version: 1, title: 'Other tab', nextAction: 'Remote step' });
  const refreshed = await workItemsApi.list({ status: 'open' });
  expect(refreshed.items[0].version).toBe(2);
  expect(resource.getSnapshot().draft).toMatchObject({
    original: { version: 1 }, fields: { title: 'My draft title', nextAction: 'My draft step' },
  });
  expect(await resource.save()).toBeNull();
  expect(requests.filter(request => request.method === 'PATCH')).toEqual([{
    method: 'PATCH', path: `/api/productivity/work-items/${item.id}`, status: 409,
    body: expect.objectContaining({ version: 1, title: 'My draft title', nextAction: 'My draft step' }),
  }]);
  expect(service.get(item.id)).toEqual(remote);
  expect(resource.getSnapshot()).toMatchObject({
    errorStatus: 409, dirty: true,
    draft: { original: { version: 1 }, fields: { title: 'My draft title', nextAction: 'My draft step' } },
  });
  expect(requests.filter(request => request.method === 'GET' && request.path.endsWith(item.id))).toHaveLength(1);
});

test('only an explicit detail reload replaces a conflicting draft and advances its expected version', async () => {
  const { item, service, resource, requests } = setup();
  await resource.reload();
  resource.edit({ description: 'Keep my unsaved description' });
  service.update(item.id, { version: 1, description: 'Remote description' });
  await resource.save();
  expect(resource.getSnapshot().draft?.fields.description).toBe('Keep my unsaved description');
  expect(resource.getSnapshot().errorStatus).toBe(409);
  expect(requests.filter(request => request.method === 'GET')).toHaveLength(1);
  await resource.reload();
  expect(resource.getSnapshot()).toMatchObject({
    dirty: false, error: null, errorStatus: null,
    draft: { original: { version: 2 }, fields: { description: 'Remote description' } },
  });
});

test('accepted saves advance the draft from the mutation response without refetching or using list previews', async () => {
  const { item, resource, requests, service } = setup({ description: 'Full body '.repeat(500) });
  await resource.reload();
  expect(resource.getSnapshot().draft?.fields.description.length).toBe(5000);
  resource.edit({ title: 'Saved title' });
  expect(await resource.save()).toMatchObject({ id: item.id, version: 2, title: 'Saved title' });
  expect(resource.getSnapshot()).toMatchObject({ dirty: false, draft: { original: { version: 2 } } });
  resource.edit({ nextAction: 'Second edit' });
  await resource.save();
  expect(service.get(item.id)).toMatchObject({ title: 'Saved title', nextAction: 'Second edit', version: 3 });
  expect(requests.filter(request => request.method === 'GET')).toHaveLength(1);
});

test('a newly selected context pack accepted by the server remains openable after save', async () => {
  const { resource, requests } = setup({ contextPackIds: [] });
  await resource.reload();
  resource.edit({ contextPackIds: ['pack-fixture'] });
  await resource.save();
  expect(resource.getSnapshot().draft?.packs).toEqual([{ id: 'pack-fixture', name: 'pack-fixture', available: true }]);
  expect(resource.getSnapshot().draft?.original?.version).toBe(2);
  expect(requests.filter(request => request.method === 'GET')).toHaveLength(1);
});

test('preparing a saved work item preserves work and pack metadata without starting a run or completing work', async () => {
  const { resource, item, requests, service, project } = setup({ status: 'blocked' });
  await resource.reload();
  const prepared = await resource.prepare('kiro');
  expect(prepared).toMatchObject({
    agent: 'kiro', policy: 'read-only', projectId: project.id,
    workItemId: item.id, workItemVersion: 1, contextPackIds: ['pack-fixture'],
  });
  expect(prepared?.prompt).toContain('Original full description');
  expect(prepared?.prompt).toContain('Literal selected context');
  expect(service.get(item.id)).toMatchObject({ status: 'blocked', version: 1, lastRunId: null });
  expect(requests.map(request => request.path)).toEqual([
    `/api/productivity/work-items/${item.id}`, `/api/productivity/work-items/${item.id}/prepare`,
  ]);
});

test('unsaved changes cannot be omitted by preparing, archiving or deleting the persisted record', async () => {
  const { resource, requests } = setup();
  await resource.reload();
  resource.edit({ nextAction: 'Unsaved step' });
  expect(await resource.prepare()).toBeNull();
  expect(await resource.archive()).toBeNull();
  expect(await resource.remove()).toBe(false);
  expect(resource.getSnapshot().draft?.fields.nextAction).toBe('Unsaved step');
  expect(requests.map(request => request.method)).toEqual(['GET']);
});

test('archive, reopen and delete use successive accepted versions and never infer done from a CLI', async () => {
  const { resource, item, service, requests } = setup({ status: 'done' });
  await resource.reload();
  expect(await resource.prepare()).toBeNull();
  expect(await resource.reopen()).toMatchObject({ status: 'todo', archivedAt: null, version: 2 });
  expect(await resource.archive()).toMatchObject({ status: 'todo', version: 3 });
  expect(resource.getSnapshot().draft?.original?.archivedAt).not.toBeNull();
  expect(await resource.reopen()).toMatchObject({ status: 'todo', archivedAt: null, version: 4 });
  expect(await resource.remove()).toBe(true);
  expect(service.get(item.id)).toBeNull();
  expect(requests.filter(request => ['PATCH', 'DELETE'].includes(request.method)).map(request => request.body)).toEqual([
    { version: 1, archived: false, status: 'todo' }, { version: 2, archived: true },
    { version: 3, archived: false, status: 'todo' }, { version: 4 },
  ]);
});

test('new drafts create only bounded editable fields and retain the returned record for later preparation', async () => {
  setup();
  const draft = createWorkItemDraft();
  draft.fields.title = 'New work';
  const resource = createWorkItemEditorResource({ draft });
  resource.start();
  try {
    const created = await resource.save();
    expect(created).toMatchObject({ title: 'New work', version: 1, status: 'todo' });
    expect(resource.getSnapshot()).toMatchObject({ dirty: false, draft: { original: { id: created?.id, version: 1 } } });
  } finally { resource.stop(); }
});

test('unmounting aborts a detail fetch and discards a late response', async () => {
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  const pending = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => { signal = init.signal; return pending.promise; });
  const resource = createWorkItemEditorResource({ id: 'work-synthetic' });
  resource.start();
  const loading = resource.reload();
  resource.stop();
  expect(signal?.aborted).toBe(true);
  pending.resolve(new Response(JSON.stringify({ title: 'Late response' })));
  expect(await loading).toBe(false);
  expect(resource.getSnapshot().draft).toBeNull();
});

test('a repeated save while a request is pending cannot send a duplicate mutation', async () => {
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  const pending = deferred<Response>();
  let posts = 0;
  vi.stubGlobal('fetch', () => { posts++; return pending.promise; });
  const draft = createWorkItemDraft();
  draft.fields.title = 'Once';
  const resource = createWorkItemEditorResource({ draft });
  resource.start();
  const first = resource.save();
  expect(await resource.save()).toBeNull();
  expect(posts).toBe(1);
  resource.stop();
  pending.resolve(new Response(JSON.stringify({ title: 'Late mutation' })));
  expect(await first).toBeNull();
});
