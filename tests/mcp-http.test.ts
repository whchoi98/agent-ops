import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { finished, mcpFixture, waitFor, type McpFixture } from './fixtures/mcp-test-helpers.js';

const fixtures: McpFixture[] = [];
const servers: Server[] = [];
type Entry = { method: string; url: string; headers: Record<string, unknown>; body: Record<string, any> | null };
async function fakeHttp(mode = 'json', options: {
  env?: NodeJS.ProcessEnv; headers?: Record<string, string>;
  envHeaders?: Record<string, string>; echo?: string;
} = {}) {
  const requests: Entry[] = [];
  const sockets = new Set<import('node:net').Socket>();
  let sse: import('node:http').ServerResponse | null = null;
  const send = (response: import('node:http').ServerResponse, value: object, event?: string) => {
    if (event) response.write(`${event === 'message' ? '' : `event: ${event}\n`}data: ${JSON.stringify(value)}\n\n`);
    else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); }
  };
  const server = createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += chunk.toString();
    const body = data ? JSON.parse(data) : null;
    requests.push({ method: request.method!, url: request.url!, headers: { ...request.headers }, body });
    if (mode === 'redirect') {
      response.writeHead(307, { Location: 'http://127.0.0.1:1/not-configured' }); response.end(); return;
    }
    if (mode === 'auth') { response.writeHead(401); response.end('never-publish-auth-secret'); return; }
    if (mode === 'hang') return;
    if (request.method === 'DELETE') { response.writeHead(mode === 'no-delete' ? 405 : 200); response.end(); return; }
    if (mode.startsWith('legacy') && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      sse = response;
      const endpoint = mode === 'legacy-foreign' ? 'http://127.0.0.1:1/not-configured' : '/messages?session=synthetic-session-secret';
      response.write(`event: endpoint\ndata: ${endpoint}\n\n`);
      return;
    }
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    if (!body?.method || body.id === undefined) { response.writeHead(202); response.end(); return; }
    let result: object;
    switch (body.method) {
      case 'initialize':
        if (!mode.startsWith('legacy')) response.setHeader('Mcp-Session-Id', 'synthetic-session-secret');
        result = { protocolVersion: body.params.protocolVersion, serverInfo: { name: 'synthetic-http', version: '1.0.0' }, capabilities: { tools: {}, resources: {}, prompts: {} } };
        break;
      case 'tools/list':
        result = body.params.cursor === 'next'
          ? { tools: [{ name: 'second' }] }
          : { tools: [{ name: 'first', description: options.echo ?? 'synthetic-bearer-secret' }], nextCursor: 'next' };
        break;
      case 'resources/list': result = { resources: [] }; break;
      case 'prompts/list': result = { prompts: [{ name: 'review' }] }; break;
      default: response.writeHead(400); response.end(); return;
    }
    const message = { jsonrpc: '2.0', id: body.id, result };
    if (mode.startsWith('legacy')) {
      response.writeHead(202); response.end();
      send(sse!, message, 'message');
    } else if (mode === 'sse' || mode === 'fragmented-sse') {
      response.setHeader('content-type', 'text/event-stream');
      if (mode === 'fragmented-sse') {
        const frame = `: heartbeat\r\n\r\nevent: message\r\ndata: ${JSON.stringify(message)}\r\n\r\n`;
        response.write(frame.slice(0, 19));
        setImmediate(() => response.end(frame.slice(19)));
      } else {
        send(response, { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }, 'message');
        send(response, message, 'message');
        // Deliberately keep it open: the client must close after its corresponding response.
      }
    } else if (mode === 'oversized') {
      response.setHeader('content-type', 'application/json'); response.end('x'.repeat(100000));
    } else if (mode === 'bad-json') {
      response.setHeader('content-type', 'application/json'); response.end('{synthetic-malformed-secret');
    } else send(response, message);
  });
  servers.push(server);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fixture = await mcpFixture({ maxMessageBytes: 16 * 1024, maxProbeBytes: 64 * 1024, env: options.env ?? {} });
  fixtures.push(fixture);
  const url = `${origin}/${mode.startsWith('legacy') ? 'sse' : 'mcp'}?key=synthetic-url-secret`;
  await fixture.config({ remote: { type: mode.startsWith('legacy') ? 'sse' : 'http', url,
    headers: options.headers ?? { Authorization: 'Bearer synthetic-bearer-secret' }, env_http_headers: options.envHeaders } });
  const item = (await fixture.service.list()).items[0];
  return { ...fixture, item, origin, requests, sockets };
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose()));
  await Promise.all(servers.splice(0).map(async server => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }));
});

describe('MCP HTTP and SSE metadata checks', () => {
  it.each<NonNullable<Parameters<typeof fakeHttp>[1]> & { name: string; echo: string }>([
    {
      name: 'expanded Bearer header', env: { MCP_AUTH: 'Bearer fixtureOpaqueCredential753' },
      headers: { Authorization: '${MCP_AUTH}' }, echo: 'fixtureOpaqueCredential753',
    },
    {
      name: 'expanded Basic header', env: { MCP_AUTH: `Basic ${Buffer.from('fixture-user-993:fixtureBasicPassword990').toString('base64')}` },
      headers: { Authorization: '${MCP_AUTH}' }, echo: 'fixtureBasicPassword990',
    },
    {
      name: 'environment header', env: { MCP_AUTH: 'Bearer fixtureHeaderCredential882' },
      envHeaders: { Authorization: 'MCP_AUTH' }, echo: 'fixtureHeaderCredential882',
    },
    {
      name: 'expanded cookie components', env: { MCP_COOKIE: 'one=fixtureCookieFirst992;two=fixtureCookieSecond993' },
      headers: { Cookie: '${MCP_COOKIE}' }, echo: 'fixtureCookieSecond993',
    },
  ])('redacts credential components after resolving $name', async options => {
    const { service, item } = await fakeHttp('json', options);
    const preview = await service.preview(item.id);
    expect(preview.canCheck).toBe(true);
    const result = await finished(service, (await service.check(item.id, preview.previewId)).id);
    expect(result.status).toBe('reachable');
    expect(result.tools.items[0].description).toContain('[redacted]');
    expect(JSON.stringify(result)).not.toContain(options.echo);
  });

  it.each(['json', 'sse', 'fragmented-sse'])('initializes %s responses and closes only its own HTTP session', async mode => {
    const { service, item, requests } = await fakeHttp(mode);
    const preview = await service.preview(item.id);
    expect(preview.startsProcess).toBe(false);
    expect(JSON.stringify(preview)).not.toMatch(/synthetic-url-secret|synthetic-bearer-secret/);
    expect(requests).toEqual([]);
    const check = await service.check(item.id, preview.previewId);
    const result = await finished(service, check.id);
    expect(result.status).toBe('reachable');
    expect(result.tools.count).toBe(2);
    expect(result.prompts.count).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-url-secret|synthetic-bearer-secret|synthetic-session-secret/);
    const messages = requests.filter(request => request.method === 'POST');
    expect(messages.map(request => request.body?.method)).toEqual([
      'initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'resources/list', 'prompts/list',
    ]);
    expect(messages[0].headers['mcp-session-id']).toBeUndefined();
    expect(messages[0].headers.accept).toContain('application/json');
    expect(messages[0].headers.accept).toContain('text/event-stream');
    expect(messages.slice(1).every(message => message.headers['mcp-session-id'] === 'synthetic-session-secret'
      && message.headers['mcp-protocol-version'] === result.protocolVersion)).toBe(true);
    expect(requests.every(request => request.headers.authorization === 'Bearer synthetic-bearer-secret')).toBe(true);
    expect(requests.filter(request => request.method === 'DELETE')).toHaveLength(1);
    expect(service.resourceRoots).toEqual([]);
  });

  it('supports legacy SSE endpoint negotiation, metadata POSTs and stream-only cleanup', async () => {
    const { service, item, requests } = await fakeHttp('legacy');
    const preview = await service.preview(item.id);
    const result = await finished(service, (await service.check(item.id, preview.previewId)).id);
    expect(result.status).toBe('reachable');
    expect(result.tools.count).toBe(2);
    expect(requests[0].method).toBe('GET');
    expect(requests.slice(1).every(request => request.method === 'POST' && request.url === '/messages?session=synthetic-session-secret')).toBe(true);
    expect(requests.some(request => request.method === 'DELETE')).toBe(false);
  });

  it.each([
    ['redirect', 'redirect-blocked'],
    ['auth', 'authentication-required'],
    ['legacy-foreign', 'unsafe-endpoint'],
    ['bad-json', 'invalid-json'],
    ['oversized', 'buffer-limit'],
  ])('rejects %s without exposing transport bodies or probing another target', async (mode, code) => {
    const { service, item, requests } = await fakeHttp(mode);
    const preview = await service.preview(item.id);
    const result = await finished(service, (await service.check(item.id, preview.previewId)).id);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe(code);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-(?:malformed|auth|url|bearer|session)-secret/);
    expect(requests.filter(request => request.method !== 'DELETE')).toHaveLength(1);
  });

  it('cancels a stalled HTTP exchange without attempting to delete a session it never created', async () => {
    const { service, item, requests } = await fakeHttp('hang');
    const preview = await service.preview(item.id);
    const check = await service.check(item.id, preview.previewId);
    await waitFor(() => requests, entries => entries.length > 0);
    const result = await service.cancel(check.id);
    expect(result.status).toBe('cancelled');
    expect(requests.some(request => request.method === 'DELETE')).toBe(false);
  });

  it('accepts a server that explicitly does not implement session DELETE', async () => {
    const { service, item } = await fakeHttp('no-delete');
    const preview = await service.preview(item.id);
    expect((await finished(service, (await service.check(item.id, preview.previewId)).id)).status).toBe('reachable');
  });
});
