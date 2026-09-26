import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../server/store.js';
import { retryWrite } from '../server/write-retry.js';
import { enforceAccess, parsePublicUrl, stripProxyPrefix } from '../server/access.js';
import { redact } from '../server/privacy.js';
import { ContextPackService } from '../server/productivity/context-packs.js';
import { registerContextPackRoutes } from '../server/productivity/context-pack-routes.js';
import type { ContextPack } from '../shared/context-packs.js';

const applications: FastifyInstance[] = [];
const stores: Store[] = [];
const base = '/api/productivity/context-packs';
const headers = { 'x-agent-ops': '1' };
async function setup(proxy = false) {
  const store = new Store(':memory:');
  stores.push(store);
  const service = new ContextPackService(store);
  const address = parsePublicUrl(proxy ? 'https://workbench.invalid/mounted/' : undefined);
  const app = Fastify({
    bodyLimit: 256 * 1024,
    rewriteUrl: request => stripProxyPrefix(request.url ?? '/', address),
  });
  applications.push(app);
  app.addHook('onRequest', async request => {
    enforceAccess(request.headers, request.raw.socket.remoteAddress, address);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-agent-ops'] !== '1') {
      throw Object.assign(new Error('X-Agent-Ops: 1 header required.'), { statusCode: 403 });
    }
  });
  app.setErrorHandler((cause, _request, reply) => {
    const error = cause as Error & { statusCode?: number };
    return reply.code(error.statusCode ?? 500).send({ error: redact(error.message) });
  });
  let changes = 0;
  let writes = 0;
  registerContextPackRoutes(app, service, {
    write: action => { writes++; return retryWrite(store, action); },
    onChange: () => {
      expect(store.db.inTransaction).toBe(false);
      changes++;
    },
  });
  await app.ready();
  return { app, service, store, counts: () => ({ changes, writes }) };
}
afterEach(async () => {
  await Promise.all(applications.splice(0).map(app => app.close()));
  stores.splice(0).forEach(store => store.close());
});

it('registers versioned CRUD/item routes and emits only after successful atomic writes', async () => {
  const { app, counts } = await setup();
  const created = await app.inject({ method: 'POST', url: base, headers, payload: { name: 'HTTP pack' } });
  expect(created.statusCode).toBe(201);
  let pack = created.json<ContextPack>();
  const add = await app.inject({
    method: 'POST', url: `${base}/${pack.id}/items`, headers,
    payload: { version: pack.version, kind: 'note', title: 'Note', text: 'Operator text' },
  });
  expect(add.statusCode).toBe(200);
  pack = add.json<ContextPack>();
  const itemId = pack.items[0].id;
  const edit = await app.inject({
    method: 'PATCH', url: `${base}/${pack.id}/items/${itemId}`, headers,
    payload: { version: pack.version, text: 'Changed operator note' },
  });
  expect(edit.statusCode).toBe(200);
  pack = edit.json<ContextPack>();
  const reorder = await app.inject({
    method: 'POST', url: `${base}/${pack.id}/reorder`, headers,
    payload: { version: pack.version, itemIds: [itemId] },
  });
  expect(reorder.statusCode).toBe(200);
  pack = reorder.json<ContextPack>();
  const stale = await app.inject({
    method: 'PATCH', url: `${base}/${pack.id}`, headers,
    payload: { version: 1, name: 'Stale rename' },
  });
  expect(stale.statusCode).toBe(409);
  expect((await app.inject(`${base}/${pack.id}`)).json()).toEqual(pack);
  expect(counts().changes).toBe(4);
  const update = await app.inject({
    method: 'PATCH', url: `${base}/${pack.id}`, headers,
    payload: { version: pack.version, name: 'Current rename' },
  });
  expect(update.statusCode).toBe(200);
  pack = update.json<ContextPack>();
  const removedItem = await app.inject({
    method: 'DELETE', url: `${base}/${pack.id}/items/${itemId}`, headers,
    payload: { version: pack.version },
  });
  expect(removedItem.statusCode).toBe(200);
  pack = removedItem.json<ContextPack>();
  expect(pack.items).toEqual([]);
  expect((await app.inject({
    method: 'DELETE', url: `${base}/${pack.id}`, headers, payload: { version: pack.version },
  })).json()).toEqual({ ok: true });
  expect((await app.inject(`${base}/${pack.id}`)).statusCode).toBe(404);
  expect(counts()).toEqual({ changes: 7, writes: 8 });
});

it('returns bounded summaries and redacted local compilation/downloads without write events', async () => {
  const { app, service, counts } = await setup();
  let pack = service.create({ name: 'Export pack', instructions: 'Follow operator instructions' });
  pack = service.addItem(pack.id, {
    version: pack.version, kind: 'note', title: 'Operator note', text: 'token=fixture-secret',
  });
  const page = await app.inject(`${base}?limit=1&offset=0&q=Export`);
  expect(page.statusCode).toBe(200);
  expect(page.json()).toMatchObject({ total: 1, limit: 1, offset: 0 });
  expect(page.json().items[0]).not.toHaveProperty('items');
  expect(page.json().items[0]).not.toHaveProperty('instructions');
  const compiled = await app.inject({ method: 'POST', url: `${base}/${pack.id}/compile`, headers, payload: {} });
  expect(compiled.statusCode).toBe(200);
  expect(compiled.json().prompt).toContain('token=[REDACTED]');
  expect(compiled.body).not.toContain('fixture-secret');
  const markdown = await app.inject(`${base}/${pack.id}/export?format=md`);
  expect(markdown.statusCode).toBe(200);
  expect(markdown.headers['content-type']).toContain('text/markdown');
  expect(markdown.headers['content-disposition']).toContain('attachment; filename="agent-ops-pack-');
  expect(markdown.body).toBe(compiled.json().prompt);
  const json = await app.inject(`${base}/${pack.id}/export?format=json`);
  expect(json.headers['content-type']).toContain('application/json');
  expect(json.json().pack.items[0].text).toBe('token=[REDACTED]');
  expect(counts()).toEqual({ changes: 0, writes: 0 });
});

it('rejects unknown fields, unversioned mutations, malformed IDs and invalid pagination', async () => {
  const { app, service, counts } = await setup();
  const pack = service.create({ name: 'Validation' });
  for (const request of [
    { method: 'PATCH', url: `${base}/${pack.id}`, payload: { name: 'Unversioned' } },
    { method: 'DELETE', url: `${base}/${pack.id}`, payload: {} },
    { method: 'POST', url: `${base}/${pack.id}/items`, payload: { version: 1, kind: 'message', sessionId: 's', messageId: 'm', offset: 0, length: 1, text: 'forged' } },
    { method: 'POST', url: `${base}/${pack.id}/compile`, payload: { prompt: 'client forged output' } },
  ] as const) {
    expect((await app.inject({ ...request, headers })).statusCode).toBe(400);
  }
  for (const query of ['limit=101', 'limit=', 'limit=0', 'offset=-1', 'unexpected=yes', 'limit=2&limit=3']) {
    expect((await app.inject(`${base}?${query}`)).statusCode).toBe(400);
  }
  expect((await app.inject(`${base}/bad%0Aid`)).statusCode).toBe(400);
  expect((await app.inject(`${base}/${pack.id}/export?format=html`)).statusCode).toBe(400);
  expect((await app.inject(`${base}/${pack.id}/export?format=md&extra=x`)).statusCode).toBe(400);
  expect(counts().changes).toBe(0);
  expect(service.get(pack.id)).toEqual(pack);
});

it('allows only one of two mutations submitted from the same pack version', async () => {
  const { app, service, counts } = await setup();
  const pack = service.create({ name: 'Concurrent HTTP clients' });
  const results = await Promise.all(['one', 'two'].map(text => app.inject({
    method: 'POST', url: `${base}/${pack.id}/items`, headers,
    payload: { version: pack.version, kind: 'note', title: text, text },
  })));
  expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
  expect(service.get(pack.id).items).toHaveLength(1);
  expect(counts().changes).toBe(1);
});

it('inherits loopback/proxy/origin/mutation guards on every new route', async () => {
  const { app, service } = await setup(true);
  const pack = service.create({ name: 'Proxy pack' });
  const mounted = `/mounted${base}/${pack.id}/compile`;
  const request = { method: 'POST' as const, url: mounted, payload: {} };
  expect((await app.inject(request)).statusCode).toBe(403);
  expect((await app.inject({ ...request, headers: { ...headers, host: 'evil.invalid' } })).statusCode).toBe(403);
  expect((await app.inject({ ...request, headers: { ...headers, origin: 'https://evil.invalid' } })).statusCode).toBe(403);
  expect((await app.inject({ ...request, headers, remoteAddress: '192.0.2.1' })).statusCode).toBe(403);
  const allowed = await app.inject({
    ...request, headers: { ...headers, host: 'workbench.invalid', origin: 'https://workbench.invalid' },
  });
  expect(allowed.statusCode).toBe(200);
  expect(allowed.json().packId).toBe(pack.id);
});
