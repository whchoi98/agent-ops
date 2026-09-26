import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../server/store.js';
import { retryWrite } from '../server/write-retry.js';
import { TemplateService, registerTemplateFieldRoutes } from '../server/productivity/templates.js';
import { problem, type ProductivityRouteHooks } from '../server/productivity/common.js';

const apps: FastifyInstance[] = [];
const stores: Store[] = [];
function setup(write?: ProductivityRouteHooks['write']) {
  const store = new Store(':memory:');
  stores.push(store);
  const service = new TemplateService(store);
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  apps.push(app);
  const changes: string[] = [];
  const hooks: ProductivityRouteHooks = {
    write: write ?? (action => retryWrite(store, action, () => false)),
    onChange: () => { changes.push('templates'); },
  };
  registerTemplateFieldRoutes(app, service, hooks);
  const template = service.create({
    name: '입력 원문', description: '도움말 원문', category: 'custom', agent: 'kiro', policy: 'read-only',
    prompt: 'Review {{target}}', variables: [{ name: 'target', label: '미리보기', type: 'text', required: true }],
  });
  return { app, store, service, template, changes };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  stores.splice(0).forEach(store => store.close());
});

describe('template field routes', () => {
  it('serves bounded history and a literal rendered prompt without writing or publishing a change', async () => {
    const { app, store, template, changes } = setup();
    const before = store.db.prepare('SELECT total_changes() AS count').get();
    const history = await app.inject({ url: `/api/templates/${template.id}/history` });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual([template]);
    const rendered = await app.inject({
      method: 'POST', url: `/api/templates/${template.id}/render`,
      payload: { values: { target: '{{other}} $& `literal` $(literal)' } },
    });
    expect(rendered.statusCode).toBe(200);
    expect(rendered.json()).toEqual({ prompt: 'Review {{other}} $& `literal` $(literal)' });
    expect(store.db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
    expect(changes).toEqual([]);
    expect(store.listRuns()).toEqual([]);
  });

  it('restores through the shared writer, then publishes one change for the new revision', async () => {
    const { app, store, service, template, changes } = setup();
    service.update(template.id, { name: 'Second', expectedRevision: 1 });
    const response = await app.inject({
      method: 'POST', url: `/api/templates/${template.id}/restore`,
      payload: { revision: 1, expectedRevision: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: '입력 원문', revision: 3 });
    expect(service.history(template.id).map(item => item.revision)).toEqual([3, 2, 1]);
    expect(changes).toEqual(['templates']);
    expect(store.listRuns()).toEqual([]);
  });

  it('does not mutate or announce a revision if the shared writer rejects the operation', async () => {
    const { app, store, template, changes } = setup(async () => { throw problem(503, 'Fixture writer unavailable'); });
    const before = store.db.prepare('SELECT total_changes() AS count').get();
    const response = await app.inject({
      method: 'POST', url: `/api/templates/${template.id}/restore`,
      payload: { revision: 1, expectedRevision: 1 },
    });
    expect(response.statusCode).toBe(503);
    expect(store.db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
    expect(changes).toEqual([]);
  });

  it('accepts only one of two restores based on the same current revision', async () => {
    const { app, service, template, changes } = setup();
    service.update(template.id, { name: 'Second' });
    const responses = await Promise.all([1, 1].map(revision => app.inject({
      method: 'POST', url: `/api/templates/${template.id}/restore`,
      payload: { revision, expectedRevision: 2 },
    })));
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    expect(service.history(template.id).map(item => item.revision)).toEqual([3, 2, 1]);
    expect(changes).toEqual(['templates']);
  });

  it.each([
    {}, { values: null }, { values: [] }, { values: { target: '' } },
    { values: { target: 2 } }, { values: { target: 'x'.repeat(8_001) } },
    { values: { target: 'ok', unknown: 'extra' } }, { values: { target: 'ok' }, execute: true },
  ])('rejects invalid render bodies without any side effects: %#', async payload => {
    const { app, store, template, changes } = setup();
    const response = await app.inject({ method: 'POST', url: `/api/templates/${template.id}/render`, payload });
    expect(response.statusCode).toBe(400);
    expect(store.listTemplates()).toEqual([template]);
    expect(changes).toEqual([]);
  });

  it.each([
    {}, { revision: 1 }, { revision: 0, expectedRevision: 1 },
    { revision: 1, expectedRevision: '1' }, { revision: 1, expectedRevision: 0 },
    { revision: 1, expectedRevision: 1, name: 'Forged snapshot' },
  ])('rejects invalid restore bodies without recording history: %#', async payload => {
    const { app, service, template, changes } = setup();
    const response = await app.inject({ method: 'POST', url: `/api/templates/${template.id}/restore`, payload });
    expect(response.statusCode).toBe(400);
    expect(service.history(template.id)).toEqual([template]);
    expect(changes).toEqual([]);
  });

  it('returns missing and stale statuses without emitting a refresh', async () => {
    const { app, template, changes } = setup();
    expect((await app.inject('/api/templates/template-missing/history')).statusCode).toBe(404);
    expect((await app.inject({
      method: 'POST', url: '/api/templates/template-missing/render', payload: { values: {} },
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: 'POST', url: `/api/templates/${template.id}/restore`, payload: { revision: 1, expectedRevision: 2 },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: 'POST', url: `/api/templates/${template.id}/restore`, payload: { revision: 2, expectedRevision: 1 },
    })).statusCode).toBe(404);
    expect(changes).toEqual([]);
  });
});
