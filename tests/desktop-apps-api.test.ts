import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopAppService, registerDesktopAppRoutes } from '../server/desktop-apps.js';
import { enforceAccess, parsePublicUrl } from '../server/access.js';

const servers: FastifyInstance[] = [];
const temporary: string[] = [];

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'agent-ops-desktop-api-'));
  temporary.push(base);
  const applicationsDir = join(base, 'Applications');
  await mkdir(join(applicationsDir, 'Codex.app', 'Contents'), { recursive: true });
  await writeFile(join(applicationsDir, 'Codex.app', 'Contents', 'Info.plist'), 'fixture-plist');
  let conversions = 0;
  const service = new DesktopAppService({
    platform: 'darwin', applicationsDir, homeDir: join(base, 'user'),
    converter: async () => {
      conversions++;
      return '{"CFBundleShortVersionString":"1.2.3","CFBundleVersion":"0009","CFBundleIdentifier":"test.fixture.codex"}';
    },
  });
  const app = Fastify({ logger: false });
  servers.push(app);
  // Integration inherits these production access guards; no listening socket is opened.
  app.addHook('onRequest', async request => {
    enforceAccess(request.headers, request.raw.socket.remoteAddress, parsePublicUrl('https://workbench.example.com/'));
  });
  registerDesktopAppRoutes(app, service);
  return { app, conversions: () => conversions };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(app => app.close()));
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('desktop app routes', () => {
  it('serves the cached typed report and supports an explicit guarded empty refresh', async () => {
    const { app, conversions } = await setup();
    const first = await app.inject('/api/desktop-apps');
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.json().items[0].installations[0]).toMatchObject({ version: '1.2.3', build: '0009' });
    expect((await app.inject('/api/desktop-apps')).json()).toEqual(first.json());
    expect(conversions()).toBe(1);
    const refreshed = await app.inject({
      method: 'POST', url: '/api/desktop-apps/refresh', headers: { 'x-agent-ops': '1' }, payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.headers['cache-control']).toBe('no-store');
    expect(conversions()).toBe(2);
    expect((await app.inject({
      method: 'POST', url: '/api/desktop-apps/refresh', headers: { 'x-agent-ops': '1' },
    })).statusCode).toBe(200);
  });

  it.each([{}, { 'x-agent-ops': '0' }, { 'x-agent-ops': '1,1' }])('requires the exact mutation header before discovering files', async headers => {
    const { app, conversions } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/desktop-apps/refresh', headers, payload: {} })).statusCode).toBe(403);
    expect(conversions()).toBe(0);
  });

  it.each([
    '?path=/Applications', '?home=/Users/other', '?platform=darwin', '?refresh=true',
    '?command=anything', '?url=https://example.com', '?__proto__=anything',
  ])('rejects query input %s on both routes before discovery', async query => {
    const { app, conversions } = await setup();
    expect((await app.inject(`/api/desktop-apps${query}`)).statusCode).toBe(400);
    expect((await app.inject({
      method: 'POST', url: `/api/desktop-apps/refresh${query}`, headers: { 'x-agent-ops': '1' }, payload: {},
    })).statusCode).toBe(400);
    expect(conversions()).toBe(0);
  });

  it.each([
    '{"path":"/private/fixture"}', '{"platform":"darwin"}', '{"refresh":true}',
    '{"__proto__":{"polluted":true}}', 'null', '[]', '""', 'false', '0', '{broken',
  ])('rejects nonempty or non-object refresh bodies: %s', async payload => {
    const { app, conversions } = await setup();
    const response = await app.inject({
      method: 'POST', url: '/api/desktop-apps/refresh',
      headers: { 'x-agent-ops': '1', 'content-type': 'application/json' }, payload,
    });
    expect(response.statusCode).toBe(400);
    expect(conversions()).toBe(0);
  });

  it('limits refresh input size and rejects GET request bodies', async () => {
    const { app, conversions } = await setup();
    expect((await app.inject({
      method: 'POST', url: '/api/desktop-apps/refresh', headers: { 'x-agent-ops': '1' },
      payload: { input: 'x'.repeat(2048) },
    })).statusCode).toBe(413);
    expect((await app.inject({ method: 'GET', url: '/api/desktop-apps', payload: {} })).statusCode).toBe(400);
    expect(conversions()).toBe(0);
  });

  it('preserves Host, Origin and cross-site protections when mounted under the normal guards', async () => {
    const { app, conversions } = await setup();
    for (const headers of [
      { host: 'attacker.example.com' },
      { host: 'localhost', origin: 'https://attacker.example.com' },
      { host: 'localhost', 'sec-fetch-site': 'cross-site' },
    ]) {
      expect((await app.inject({ url: '/api/desktop-apps', headers })).statusCode).toBe(403);
    }
    expect(conversions()).toBe(0);
    expect((await app.inject({
      url: '/api/desktop-apps', headers: { host: 'workbench.example.com', origin: 'https://workbench.example.com' },
    })).statusCode).toBe(200);
  });
});
