import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type AppContext } from '../server/app.js';
import { parsePublicUrl, stripProxyPrefix } from '../server/access.js';

const contexts: AppContext[] = [];
const directories: string[] = [];
const publicUrl = 'https://workbench.example.com/proxy/4327/';
async function setup(proxy = true) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-proxy-'));
  directories.push(dir);
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>Agent Ops</title></head><body>workspace</body></html>');
  writeFileSync(join(dir, 'test.js'), 'export const ok = true;');
  const context = await createApp({ dataDir: dir, demo: true, autoSync: false, staticDir: dir, publicUrl: proxy ? publicUrl : undefined });
  contexts.push(context);
  return context;
}
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.app.close()));
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
describe('authenticated local reverse proxy configuration', () => {
  it('normalizes a public HTTPS base and rejects unsafe configuration', () => {
    expect(parsePublicUrl('https://workbench.example.com/proxy/4327')).toMatchObject({
      origin: 'https://workbench.example.com', host: 'workbench.example.com', basePath: '/proxy/4327/',
    });
    for (const url of ['http://workbench.example.com/', 'https://user:password@workbench.example.com/', 'https://workbench.example.com/?key=x', 'https://workbench.example.com/#x', 'https://workbench.example.com//other/']) {
      expect(() => parsePublicUrl(url)).toThrow();
    }
  });
  it('strips only the configured prefix and preserves query strings', () => {
    const config = parsePublicUrl(publicUrl)!;
    expect(stripProxyPrefix('/proxy/4327/api/sessions?q=abc', config)).toBe('/api/sessions?q=abc');
    expect(stripProxyPrefix('/proxy/4327?x=1', config)).toBe('/?x=1');
    expect(stripProxyPrefix('/api/health', config)).toBe('/api/health');
    expect(stripProxyPrefix('/proxy/43270/api/health', config)).toBe('/proxy/43270/api/health');
  });
  it('handles stripped and preserved prefixes and injects the trusted document base', async () => {
    const { app } = await setup();
    const headers = { host: 'workbench.example.com' };
    for (const path of ['/api/health', '/proxy/4327/api/health']) {
      const response = await app.inject({ url: path, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json().demo).toBe(true);
    }
    for (const path of ['/', '/proxy/4327/', '/proxy/4327', '/index.html']) {
      const response = await app.inject({ url: path, headers });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<base href="/proxy/4327/">');
      expect(response.headers['content-security-policy']).toContain("base-uri 'self'");
    }
    expect((await app.inject({ url: '/proxy/4327/test.js', headers })).body).toContain('export const ok');
  });
  it('accepts the configured browser origin while keeping mutation and origin guards', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'PATCH', url: '/api/settings',
      headers: { host: 'workbench.example.com', origin: 'https://workbench.example.com', 'x-agent-ops': '1' },
      payload: { concurrency: 3 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().concurrency).toBe(3);
    expect((await app.inject({
      method: 'PATCH', url: '/api/settings', headers: { host: 'workbench.example.com', origin: 'https://workbench.example.com' },
      payload: { concurrency: 2 },
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: 'PATCH', url: '/api/settings',
      headers: { host: 'workbench.example.com', origin: 'https://evil.example', 'x-agent-ops': '1' },
      payload: { concurrency: 8 },
    })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/health', headers: { host: 'evil.example', 'x-forwarded-host': 'workbench.example.com' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/health', remoteAddress: '10.0.1.2', headers: { host: 'workbench.example.com' } })).statusCode).toBe(403);
  });
  it('keeps local mode private and permits a local proxy target address only when configured', async () => {
    const local = await setup(false);
    expect((await local.app.inject({ url: '/api/health', headers: { host: 'workbench.example.com' } })).statusCode).toBe(403);
    expect((await local.app.inject({ url: '/api/health', headers: { host: '0.0.0.0:4327' } })).statusCode).toBe(403);
    const proxy = await setup();
    expect((await proxy.app.inject({ url: '/api/health', headers: { host: '0.0.0.0:4327', origin: 'https://workbench.example.com' } })).statusCode).toBe(200);
  });
});
