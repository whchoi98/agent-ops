const fs = require('node:fs');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

if (process.argv[2] === '--mcp-owned-descendant') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  const logPath = process.argv[2];
  const mode = process.argv[3] || 'normal';
  const log = entry => fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  const send = message => process.stdout.write(JSON.stringify(message) + '\n');
  let initialized = false;
  log({ event: 'started', pid: process.pid, cwd: process.cwd(),
    environment: { FIXTURE_TOKEN: process.env.FIXTURE_TOKEN, FORWARDED: process.env.FORWARDED,
      AMBIENT_SECRET: process.env.AMBIENT_SECRET, NODE_OPTIONS: process.env.NODE_OPTIONS } });
  if (mode === 'descendant' || mode === 'exit-with-child') {
    const child = spawn(process.execPath, [__filename, '--mcp-owned-descendant'], { stdio: 'inherit' });
    log({ event: 'descendant', pid: child.pid });
    process.on('SIGTERM', () => {});
    if (mode === 'exit-with-child') setTimeout(() => process.exit(0), 150);
  }
  // This case has no list round-trip after initialized. Drain stdin to EOF so
  // an already-sent notification is logged before the client's cleanup signal.
  if (mode === 'no-capabilities') process.on('SIGTERM', () => {});
  if (mode === 'stderr-limit') process.stderr.write('x'.repeat(300000));
  if (mode === 'stdout-limit') process.stdout.write('x'.repeat(300000));
  if (mode === 'malformed') process.stdout.write('invalid JSON\n');
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', line => {
    const request = JSON.parse(line);
    log(request);
    if (request.method === 'notifications/initialized') { initialized = true; return; }
    if (!request.method || request.id === undefined) return;
    if (mode === 'hang' || mode === 'descendant' || mode === 'exit-with-child') return;
    const reply = result => send({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'initialize') {
      if (mode === 'server-request') send({ jsonrpc: '2.0', id: 'server-owned-request', method: 'sampling/createMessage', params: { messages: [] } });
      if (mode === 'wrong-id') { send({ jsonrpc: '2.0', id: 99999, result: {} }); return; }
      reply({
        protocolVersion: mode === 'bad-version' ? '2099-01-01' : request.params.protocolVersion,
        serverInfo: { name: 'synthetic-mcp', version: '1.0.0' },
        capabilities: mode === 'no-capabilities' ? {} : { tools: {}, resources: {}, prompts: {} },
      });
    } else if (!initialized) {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Initialization ordering was violated.' } });
    } else if (request.method === 'tools/list') {
      if (mode === 'method-missing') { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'synthetic-private-error' } }); return; }
      if (mode === 'rpc-error') { send({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'synthetic-private-error', data: { token: 'synthetic-private-token' } } }); return; }
      if (mode === 'bad-list') { reply({ tools: 'invalid' }); return; }
      if (mode === 'many-items') { reply({ tools: Array.from({ length: 25 }, (_, index) => ({ name: `tool-${index}`, inputSchema: { type: 'object' } })) }); return; }
      if (request.params?.cursor === 'second') reply({ tools: [{ name: 'second', inputSchema: { type: 'object' } }], ...(mode === 'repeated-cursor' ? { nextCursor: 'second' } : {}) });
      else reply({ tools: [{ name: 'first', description: `Synthetic ${process.env.FIXTURE_TOKEN || 'metadata'}`, inputSchema: { type: 'object', secret: 'schema-is-never-public' } }], nextCursor: 'second' });
    } else if (request.method === 'resources/list') {
      reply({ resources: [{ name: 'readme', uri: 'file:///synthetic-private-path', description: 'Synthetic resource' }] });
    } else if (request.method === 'prompts/list') {
      reply({ prompts: [{ name: 'review', description: 'Synthetic prompt', arguments: [{ name: 'unused' }] }] });
    } else {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Not allowed in synthetic metadata probe.' } });
    }
  });
  lines.on('close', () => { if (!['descendant', 'exit-with-child'].includes(mode)) process.exit(0); });
}
