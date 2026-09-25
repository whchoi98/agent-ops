import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AppUpdateService, registerAppUpdateRoutes, type AppUpdateServiceOptions } from '../server/app-update.js';
import { enforceAccess, parsePublicUrl, stripProxyPrefix } from '../server/access.js';

const servers: FastifyInstance[] = [];
const services: AppUpdateService[] = [];
const checkedAt = '2026-09-25T12:00:00.000Z';

function setup(options: Partial<AppUpdateServiceOptions> = {}) {
  let requests = 0;
  const service = new AppUpdateService({
    currentVersion: '1.2.1', now: () => Date.parse(checkedAt),
    fetcher: async () => {
      requests++;
      return Response.json({
        tag_name: 'v1.3.0', draft: false, prerelease: false,
        html_url: 'https://github.com/whchoi98/agent-ops/releases/tag/v1.3.0',
        published_at: '2026-09-24T00:00:00Z', assets: [],
      });
    },
    ...options,
  });
  services.push(service);
  const address = parsePublicUrl('https://workbench.example.com/proxy/4327/');
  const app = Fastify({
    logger: false,
    rewriteUrl: request => stripProxyPrefix(request.url || '/', address),
  });
  servers.push(app);
  // The registrar inherits the parent's real guards. Tests open no listening socket.
  app.addHook('onRequest', async request => {
    enforceAccess(request.headers, request.raw.socket.remoteAddress, address);
  });
  registerAppUpdateRoutes(app, service);
  return { app, service, requests: () => requests };
}

afterEach(async () => {
  services.splice(0).forEach(service => service.close());
  await Promise.all(servers.splice(0).map(app => app.close()));
});

describe('workbench update routes', () => {
  it('GET reads cache only and an explicit guarded POST checks once', async () => {
    const { app, requests } = setup();
    await app.ready();
    expect(requests()).toBe(0);
    const initial = await app.inject('/api/app-update');
    expect(initial.statusCode).toBe(200);
    expect(initial.headers['cache-control']).toBe('no-store');
    expect(initial.json()).toMatchObject({
      currentVersion: '1.2.1', status: 'not-checked', checking: false,
      latest: null, checkedAt: null, nextCheckAt: null,
    });
    expect((await app.inject('/api/app-update')).json()).toEqual(initial.json());
    expect(requests()).toBe(0);
    const checked = await app.inject({
      method: 'POST', url: '/api/app-update/check', headers: { 'x-agent-ops': '1' }, payload: {},
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.headers['cache-control']).toBe('no-store');
    expect(checked.json()).toMatchObject({ status: 'update-available', checkedAt });
    expect((await app.inject('/api/app-update')).json()).toEqual(checked.json());
    expect((await app.inject({
      method: 'POST', url: '/api/app-update/check', headers: { 'x-agent-ops': '1' },
    })).json()).toEqual(checked.json());
    expect(requests()).toBe(1);
  });

  it('returns the checking snapshot immediately without joining the outstanding external request', async () => {
    let finish!: (response: Response) => void;
    const { app, service } = setup({
      fetcher: async () => new Promise<Response>(resolve => { finish = resolve; }),
    });
    await app.ready();
    const pending = service.check();
    const cached = await app.inject('/api/app-update');
    expect(cached.statusCode).toBe(200);
    expect(cached.json()).toMatchObject({ checking: true, latest: null, checkedAt: null });
    finish(new Response(null, { status: 503 }));
    await pending;
    expect((await app.inject('/api/app-update')).json()).toMatchObject({
      status: 'unavailable', checking: false, error: 'request-failed',
    });
  });

  it.each([{}, { 'x-agent-ops': '0' }, { 'x-agent-ops': '1,1' }, { 'x-agent-ops': 'true' }])(
    'requires the exact mutation header before doing any work',
    async headers => {
      const { app, requests } = setup();
      expect((await app.inject({
        method: 'POST', url: '/api/app-update/check', headers, payload: {},
      })).statusCode).toBe(403);
      expect(requests()).toBe(0);
    },
  );

  it.each([
    '?url=https://attacker.invalid', '?version=1.3.0', '?force=true', '?token=fixture',
    '?repository=other/repo', '?__proto__=input', '?constructor=input',
  ])('rejects caller-supplied query input on both routes: %s', async query => {
    const { app, requests } = setup();
    expect((await app.inject(`/api/app-update${query}`)).statusCode).toBe(400);
    expect((await app.inject({
      method: 'POST', url: `/api/app-update/check${query}`, headers: { 'x-agent-ops': '1' }, payload: {},
    })).statusCode).toBe(400);
    expect(requests()).toBe(0);
  });

  it.each([
    '{"url":"https://attacker.invalid"}', '{"version":"1.3.0"}', '{"force":true}', '{"token":"fixture"}',
    '{"__proto__":{"polluted":true}}', 'null', '[]', '""', 'false', '0', '{broken',
  ])('rejects nonempty, non-object or malformed JSON bodies: %s', async payload => {
    const { app, requests } = setup();
    const result = await app.inject({
      method: 'POST', url: '/api/app-update/check',
      headers: { 'x-agent-ops': '1', 'content-type': 'application/json' }, payload,
    });
    expect(result.statusCode).toBe(400);
    expect(requests()).toBe(0);
  });

  it('bounds POST bodies and rejects bodies on the cache-only GET', async () => {
    const { app, requests } = setup();
    expect((await app.inject({
      method: 'POST', url: '/api/app-update/check', headers: { 'x-agent-ops': '1' },
      payload: { data: 'x'.repeat(2048) },
    })).statusCode).toBe(413);
    expect((await app.inject({ method: 'GET', url: '/api/app-update', payload: {} })).statusCode).toBe(400);
    expect(requests()).toBe(0);
  });

  it('retains the parent Host, Origin, local-peer and cross-site checks for both routes', async () => {
    const { app, requests } = setup();
    for (const [url, method] of [['/api/app-update', 'GET'], ['/api/app-update/check', 'POST']] as const) {
      for (const headers of [
        { host: 'attacker.invalid' },
        { host: 'localhost', origin: 'https://attacker.invalid' },
        { host: 'localhost', 'sec-fetch-site': 'cross-site' },
      ]) {
        expect((await app.inject({
          method, url, headers: { ...headers, 'x-agent-ops': '1' },
        })).statusCode).toBe(403);
      }
      expect((await app.inject({
        method, url, headers: { 'x-agent-ops': '1' }, remoteAddress: '203.0.113.9',
      })).statusCode).toBe(403);
    }
    expect(requests()).toBe(0);
  });

  it('works below the parent proxy prefix and keeps demo reports network-free', async () => {
    const { app, requests } = setup({ demo: true });
    const headers = {
      host: 'workbench.example.com', origin: 'https://workbench.example.com', 'x-agent-ops': '1',
    };
    const initial = await app.inject({ url: '/proxy/4327/api/app-update', headers });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      currentVersion: '1.2.1', status: 'demo', demo: true, latest: null,
      commands: { npm: null, git: null }, checkedAt: null,
    });
    const checked = await app.inject({
      method: 'POST', url: '/proxy/4327/api/app-update/check', headers, payload: {},
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toEqual(initial.json());
    expect(requests()).toBe(0);
  });

  it('closing the registered app aborts the owned request before waiting for request draining', async () => {
    let signal: AbortSignal | null | undefined;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const { app } = setup({
      fetcher: async (_url, init) => {
        signal = init?.signal;
        began();
        return new Promise<Response>(() => {});
      },
    });
    await app.ready();
    const request = app.inject({
      method: 'POST', url: '/api/app-update/check', headers: { 'x-agent-ops': '1' }, payload: {},
    }).then(result => result);
    await started;
    await app.close();
    expect(signal?.aborted).toBe(true);
    const result = await request;
    expect(result.json()).toMatchObject({ status: 'unavailable', error: 'closed', checking: false });
  });
});
