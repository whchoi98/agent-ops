import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { SavedViewService, registerSavedViewRoutes } from '../server/productivity/saved-views.js';
import { problem } from '../server/productivity/common.js';
import { enforceAccess, parsePublicUrl, stripProxyPrefix } from '../server/access.js';
import { Store } from '../server/store.js';
import { retryWrite } from '../server/write-retry.js';

const fixtures: Array<{ app: FastifyInstance; store: Store }> = [];
const base = '/api/productivity/saved-views';
const headers = { 'x-agent-ops': '1' };
function setup(options: { publicUrl?: string; rejectWrite?: boolean } = {}) {
  const address = parsePublicUrl(options.publicUrl);
  const store = new Store(':memory:');
  const service = new SavedViewService(store);
  const notices: Array<{ inTransaction: boolean; names: string[] }> = [];
  const app = Fastify({
    bodyLimit: 256 * 1024,
    rewriteUrl: request => stripProxyPrefix(request.url ?? '/', address),
  });
  app.addHook('onRequest', async request => {
    enforceAccess(request.headers, request.raw.socket.remoteAddress, address);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-agent-ops'] !== '1') {
      throw problem(403, 'X-Agent-Ops: 1 header required.');
    }
  });
  app.setErrorHandler((cause, _request, reply) => {
    const error = cause as Error & { statusCode?: number };
    return reply.code(cause instanceof ZodError ? 400 : error.statusCode ?? 500).send({ error: error.message });
  });
  registerSavedViewRoutes(app, service, {
    write: action => options.rejectWrite ? Promise.reject(problem(503, 'Synthetic write unavailable.')) : retryWrite(store, action),
    onChange: () => notices.push({ inTransaction: store.db.inTransaction, names: service.list().map(view => view.name) }),
  });
  fixtures.push({ app, store });
  return { app, store, service, notices };
}
afterEach(async () => {
  for (const { app, store } of fixtures.splice(0)) { await app.close(); store.close(); }
});

describe('saved view routes', () => {
  it('exposes bounded metadata CRUD and publishes one change only after each committed write', async () => {
    const { app, notices } = setup();
    const empty = await app.inject(base);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ items: [] });
    expect(notices).toEqual([]);
    const createdResponse = await app.inject({
      method: 'POST', url: base, headers,
      payload: { name: '설정 & [literal]', query: { agent: 'kiro', q: '[x]?*', limit: 40 }, period: 'last7' },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json();
    expect(created).toMatchObject({
      name: '설정 & [literal]', query: { agent: 'kiro', q: '[x]?*', limit: 40 }, period: 'last7', version: 1, pinned: false,
    });
    const pinned = await app.inject({
      method: 'PATCH', url: `${base}/${created.id}`, headers, payload: { version: 1, pinned: true },
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json()).toMatchObject({ id: created.id, version: 2, pinned: true });
    expect((await app.inject(base)).json()).toEqual({ items: [pinned.json()] });
    const removed = await app.inject({
      method: 'DELETE', url: `${base}/${created.id}`, headers, payload: { version: 2 },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true });
    expect((await app.inject(base)).json()).toEqual({ items: [] });
    expect(notices).toEqual([
      { inTransaction: false, names: ['설정 & [literal]'] },
      { inTransaction: false, names: ['설정 & [literal]'] },
      { inTransaction: false, names: [] },
    ]);
  });

  it('allows only one competing versioned update and never emits a change for stale edits or deletes', async () => {
    const { app, service, notices } = setup();
    const view = service.create({ name: 'Before', query: {} });
    const responses = await Promise.all(['First', 'Second'].map(name => app.inject({
      method: 'PATCH', url: `${base}/${view.id}`, headers, payload: { version: 1, name },
    })));
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const accepted = responses.find(response => response.statusCode === 200)!.json();
    expect(service.get(view.id)).toEqual(accepted);
    expect((await app.inject({
      method: 'DELETE', url: `${base}/${view.id}`, headers, payload: { version: 1 },
    })).statusCode).toBe(409);
    expect(service.get(view.id)).toEqual(accepted);
    expect(notices).toHaveLength(1);
  });

  it.each(['POST', 'PATCH', 'DELETE'] as const)('keeps %s changes and notifications inside the shared write hook', async method => {
    const { app, service, notices } = setup({ rejectWrite: true });
    const original = service.create({ name: 'Retained', query: {} });
    const url = method === 'POST' ? base : `${base}/${original.id}`;
    const payload = method === 'POST' ? { name: 'Rejected', query: {} }
      : method === 'PATCH' ? { version: 1, name: 'Rejected' } : { version: 1 };
    const response = await app.inject({ method, url, headers, payload });
    expect(response.statusCode).toBe(503);
    expect(service.list()).toEqual([original]);
    expect(notices).toEqual([]);
  });

  it('inherits the existing proxy, Host, Origin, peer and mutation-header guards', async () => {
    const { app, service, notices } = setup({ publicUrl: 'https://workspace.example/proxy/4327/' });
    const url = `/proxy/4327${base}`;
    const trusted = { ...headers, host: 'workspace.example', origin: 'https://workspace.example' };
    expect((await app.inject({ url, headers: trusted })).statusCode).toBe(200);
    const payload = { name: 'Mounted', query: {} };
    expect((await app.inject({ method: 'POST', url, headers: trusted, payload })).statusCode).toBe(201);
    for (const forbiddenHeaders of [
      { host: 'workspace.example' },
      { ...trusted, host: 'attacker.example' },
      { ...trusted, origin: 'https://attacker.example' },
    ]) {
      expect((await app.inject({ method: 'POST', url, headers: forbiddenHeaders, payload })).statusCode).toBe(403);
    }
    expect(service.list()).toHaveLength(1);
    expect(notices).toHaveLength(1);
    const local = setup();
    expect((await local.app.inject({ url: base, remoteAddress: '192.0.2.25' })).statusCode).toBe(403);
  });

  it.each(['?q=foo', '?limit=1', '?offset=0', '?pinned=true', '?version=1', '?q=a&q=b', '?__proto__[q]=a'])(
    'rejects unrecognized listing query parameters: %s', async query => {
      const { app, notices } = setup();
      expect((await app.inject(`${base}${query}`)).statusCode).toBe(400);
      expect(notices).toEqual([]);
    },
  );

  it.each(['POST', 'PATCH', 'DELETE'] as const)('rejects unknown %s query parameters before any change', async method => {
    const { app, service, notices } = setup();
    const view = service.create({ name: 'Retained', query: {} });
    const payload = method === 'POST' ? { name: 'Rejected', query: {} }
      : method === 'PATCH' ? { version: 1, name: 'Rejected' } : { version: 1 };
    const url = `${method === 'POST' ? base : `${base}/${view.id}`}?unexpected=1`;
    expect((await app.inject({ method, url, headers, payload })).statusCode).toBe(400);
    expect(service.list()).toEqual([view]);
    expect(notices).toEqual([]);
  });

  it.each([
    { name: 'x'.repeat(121), query: {} },
    { name: 'Bad', query: { q: ['one', 'two'] } },
    { name: 'Bad', query: { offset: 0 } },
    { name: 'Bad', query: { search: 'not q' } },
    { name: 'Bad', query: { q: '\0' } },
    { name: 'Bad', query: { limit: '40' } },
    { name: 'Bad', query: { limit: 201 } },
    { name: 'Bad', query: { project: 'x'.repeat(4097) } },
    { name: 'Bad', query: { tag: 'x'.repeat(61) } },
    { name: 'Bad', query: { bookmarked: 'true' } },
    { name: 'Bad', query: {}, pinned: 1 },
    { name: 'Bad', period: 'custom', query: { since: '2026-02-29' } },
    { name: 'Bad', period: 'custom', query: { since: '2026-09-27', until: '2026-09-26' } },
    { name: 'Bad', period: 'today', query: { until: '2026-09-26' } },
    { name: 'Bad', query: {}, version: 1 },
    { name: 'Bad', query: {}, command: 'echo nope' },
    {},
  ])('rejects invalid POST payloads without partial persistence, case %#', async payload => {
    const { app, service, notices } = setup();
    const response = await app.inject({ method: 'POST', url: base, headers, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty('error');
    expect(service.list()).toEqual([]);
    expect(notices).toEqual([]);
  });

  it.each(['PATCH', 'DELETE'] as const)('requires a strict positive version in the %s body', async method => {
    const { app, service, notices } = setup();
    const view = service.create({ name: 'Retained', query: {} });
    for (const payload of [{}, { version: '1' }, { version: 0 }, { version: 1.5 }, { version: 1, unexpected: true }]) {
      expect((await app.inject({ method, url: `${base}/${view.id}`, headers, payload })).statusCode).toBe(400);
    }
    expect(service.list()).toEqual([view]);
    expect(notices).toEqual([]);
  });

  it('returns 404 for a valid absent ID and 400 for malformed identifiers', async () => {
    const { app } = setup();
    const missing = 'saved-view-00000000-0000-4000-8000-000000000000';
    for (const method of ['PATCH', 'DELETE'] as const) {
      const payload = method === 'PATCH' ? { version: 1, pinned: true } : { version: 1 };
      expect((await app.inject({ method, url: `${base}/${missing}`, headers, payload })).statusCode).toBe(404);
      expect((await app.inject({ method, url: `${base}/not-an-id`, headers, payload })).statusCode).toBe(400);
    }
  });

  it.each(['POST', 'PATCH', 'DELETE'] as const)('enforces a small %s body limit before parsing', async method => {
    const { app, service, notices } = setup();
    const view = service.create({ name: 'Retained', query: {} });
    const url = method === 'POST' ? base : `${base}/${view.id}`;
    const payload = `${' '.repeat(method === 'DELETE' ? 257 : 32769)}{"version":1}`;
    expect((await app.inject({
      method, url, headers: { ...headers, 'content-type': 'application/json' }, payload,
    })).statusCode).toBe(413);
    expect(service.list()).toEqual([view]);
    expect(notices).toEqual([]);
  });

  it('returns only fifty filter records at the cap and rejects the fifty-first insertion', async () => {
    const { app, service, notices } = setup();
    for (let i = 0; i < 50; i++) service.create({ name: `View ${i}`, query: { q: '[x]?*' } });
    const list = await app.inject(base);
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(50);
    expect(list.json().items.every((view: object) => !('count' in view) && !('sessions' in view))).toBe(true);
    expect((await app.inject({ method: 'POST', url: base, headers, payload: { name: 'Full', query: {} } })).statusCode).toBe(400);
    expect(notices).toEqual([]);
    expect(service.list()).toHaveLength(50);
  });
});
