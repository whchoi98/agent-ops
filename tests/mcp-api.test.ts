import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enforceAccess } from '../server/access.js';
import { registerMcpRoutes } from '../server/mcp/routes.js';
import { mcpFixture, waitFor, type McpFixture } from './fixtures/mcp-test-helpers.js';

const fixtures: McpFixture[] = [];
const apps: FastifyInstance[] = [];
const headers = { 'x-agent-ops': '1' };
async function setup(demo = false) {
  const fixture = await mcpFixture({ demo });
  fixtures.push(fixture);
  const log = join(fixture.base, 'api-synthetic-mcp.jsonl');
  const script = fileURLToPath(new URL('./fixtures/mcp-stdio.cjs', import.meta.url));
  await fixture.config({ fixture: { command: process.execPath, args: [script, log], env: { FIXTURE_TOKEN: 'synthetic-api-private-941' } } });
  const app = Fastify({ logger: false });
  apps.push(app);
  // The embedding application owns its configured Host/Origin/proxy boundary.
  app.addHook('onRequest', async request => enforceAccess(request.headers, request.raw.socket.remoteAddress, null));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'Invalid MCP request.' });
    const failure = error as Error & { statusCode?: number };
    return reply.code(failure.statusCode ?? 500).send({ error: failure.message });
  });
  registerMcpRoutes(app, fixture.service);
  return { ...fixture, app, log };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose()));
});

describe('independent MCP routes', () => {
  it('serves only redacted catalog/detail and preview data and does not probe on GET or refresh', async () => {
    const { app, log } = await setup();
    const catalog = await app.inject('/api/mcp?agent=claude&limit=1');
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().total).toBe(1);
    expect(catalog.body).not.toContain('synthetic-api-private-941');
    const id = catalog.json().items[0].id;
    const detail = await app.inject(`/api/mcp/${id}`);
    expect(detail.json().lastResult).toBeNull();
    expect(detail.body).not.toContain('synthetic-api-private-941');
    expect((await app.inject({ method: 'POST', url: '/api/mcp/refresh', headers, payload: {} })).json()).toEqual({ ok: true });
    const preview = await app.inject({ method: 'POST', url: `/api/mcp/${id}/preview`, headers, payload: {} });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().startsProcess).toBe(true);
    expect(preview.body).not.toContain('synthetic-api-private-941');
    expect(await readFile(log, 'utf8').catch(() => '')).toBe('');
  });

  it('requires the mutation header on every refresh, preview, check and cancellation', async () => {
    const { app, service, log } = await setup();
    const id = (await service.list()).items[0].id;
    const preview = await service.preview(id);
    for (const [url, payload] of [
      ['/api/mcp/refresh', {}],
      [`/api/mcp/${id}/preview`, {}],
      [`/api/mcp/${id}/check`, { previewId: preview.previewId }],
      ['/api/mcp/checks/mcp-check-00000000-0000-4000-8000-000000000000/cancel', {}],
    ] as const) {
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(403);
    }
    expect(await readFile(log, 'utf8').catch(() => '')).toBe('');
  });

  it('keeps existing host/origin access guards effective', async () => {
    const { app } = await setup();
    expect((await app.inject({ url: '/api/mcp', headers: { host: 'unconfigured.invalid' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/mcp', headers: { origin: 'https://unconfigured.invalid' } })).statusCode).toBe(403);
  });

  it('rejects arbitrary targets/paths and unexpected keys across API entrypoints', async () => {
    const { app, service } = await setup();
    const id = (await service.list()).items[0].id;
    const preview = await service.preview(id);
    for (const url of [
      '/api/mcp?path=/etc', '/api/mcp?agent=unknown', '/api/mcp?limit=10000',
      `/api/mcp/${id}?root=/etc`, '/api/mcp?projectId=unregistered',
    ]) {
      expect([400, 404]).toContain((await app.inject(url)).statusCode);
    }
    for (const url of [`/api/mcp/${id}/preview`, `/api/mcp/${id}/check`, '/api/mcp/refresh']) {
      const response = await app.inject({
        method: 'POST', url, headers,
        payload: { previewId: preview.previewId, command: 'never-execute', url: 'https://private-api-value.invalid', path: '/etc' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('private-api-value');
    }
  });

  it('returns an accepted probe then a timestamped result through the polling route', async () => {
    const { app, service } = await setup();
    const id = (await service.list()).items[0].id;
    const preview = (await app.inject({ method: 'POST', url: `/api/mcp/${id}/preview`, headers, payload: {} })).json();
    const check = await app.inject({
      method: 'POST', url: `/api/mcp/${id}/check`, headers, payload: { previewId: preview.previewId },
    });
    expect(check.statusCode).toBe(202);
    expect(check.json().status).toBe('running');
    const result = await waitFor(async () => (await app.inject(`/api/mcp/checks/${check.json().id}`)).json(), value => value.status !== 'running');
    expect(result.status).toBe('reachable');
    expect(result.finishedAt).toBeTruthy();
    expect(result.tools.count).toBe(2);
    expect(JSON.stringify(result)).not.toContain('synthetic-api-private-941');
    expect((await app.inject(`/api/mcp/${id}`)).json().lastCheck.id).toBe(result.id);
    expect((await app.inject({ method: 'POST', url: `/api/mcp/checks/${result.id}/cancel`, headers, payload: {} })).json().status).toBe('reachable');
  });

  it('does not permit demo probes even with a genuine synthetic preview ID', async () => {
    const { app } = await setup(true);
    const catalog = (await app.inject('/api/mcp')).json();
    expect(catalog.demo).toBe(true);
    const id = catalog.items[0].id;
    const preview = (await app.inject({ method: 'POST', url: `/api/mcp/${id}/preview`, headers, payload: {} })).json();
    expect(preview.canCheck).toBe(false);
    expect(preview.demo).toBe(true);
    const check = await app.inject({ method: 'POST', url: `/api/mcp/${id}/check`, headers, payload: { previewId: preview.previewId } });
    expect(check.statusCode).toBe(403);
  });

  it('cancels an owned probe when the embedding Fastify application closes', async () => {
    const { app, service, config, base } = await setup();
    const script = fileURLToPath(new URL('./fixtures/mcp-stdio.cjs', import.meta.url));
    await config({ fixture: { command: process.execPath, args: [script, join(base, 'closing.jsonl'), 'hang'] } });
    service.refresh();
    const id = (await service.list()).items[0].id;
    const preview = await service.preview(id);
    const result = await service.check(id, preview.previewId);
    await app.close();
    expect(service.getCheck(result.id).status).toBe('cancelled');
    expect(service.resourceRoots).toEqual([]);
  });
});
