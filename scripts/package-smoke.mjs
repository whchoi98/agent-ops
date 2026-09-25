import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, devNull } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const archive = resolve(process.argv[2] || `artifacts/agent-ops-local-${version}.tgz`);
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'agent-ops-package-'));
let server;
let exit;
let diagnostics = '';
let phase = 'install';
const heartbeat = setInterval(() => console.error(`Package verification: ${phase}…`), 15000);
heartbeat.unref();
try {
  console.error('Installing the local archive with production dependencies only…');
  await run('npm', [
    'install', '--prefix', directory, '--omit=dev', '--no-audit', '--no-fund',
    '--cache', join(tmpdir(), 'agent-ops-npm-cache'),
    '--registry=https://registry.npmjs.org', '--userconfig', devNull, archive,
  ], { cwd: directory, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
  const entry = join(directory, 'node_modules/agent-ops-local/dist/server/index.js');
  phase = 'CLI help';
  const help = await run(process.execPath, [entry, '--help'], { timeout: 10000 });
  assert.match(help.stdout, /Agent Ops/);
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  const emptyBin = join(directory, 'empty-bin');
  await mkdir(emptyBin);
  const state = join(directory, 'state');
  const environment = { ...process.env, PATH: emptyBin };
  server = spawn(process.execPath, [entry, 'demo', '--port', String(port), '--data-dir', state], {
    cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  exit = once(server, 'exit');
  server.stdout.on('data', (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-12000); });
  server.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-12000); });
  const base = `http://127.0.0.1:${port}`;
  phase = 'local server checks';
  async function request(path, body) {
    const response = await fetch(base + path, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Ops': '1' }, body: JSON.stringify(body),
    });
    return response;
  }
  let health;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Package server exited: ${diagnostics}`);
    try { health = await (await request('/api/health')).json(); if (health.ok) break; } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(health?.demo, true, diagnostics);
  const html = await (await request('/')).text();
  assert.match(html, /Agent Ops/);
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => new URL(match[1], `${base}/`).pathname)
    .filter((path) => /^\/(?:assets\/|theme-init\.js$|favicon\.svg$)/.test(path));
  assert.ok(assets.length >= 4, 'HTML must reference the built scripts, stylesheet and favicon.');
  for (const path of assets) assert.equal((await request(path)).status, 200, path);
  const notices = await (await request('/THIRD_PARTY_NOTICES.txt')).text();
  assert.match(notices, /react 19/);
  assert.equal((await request('/fonts/NanumSquareR.woff')).status, 200);
  assert.equal((await request('/fonts/NanumSquareB.woff')).status, 200);
  const data = await (await request('/api/bootstrap')).json();
  assert.equal(data.demo, true);
  assert.equal(data.connectors.every((connector) => !connector.installed), true);
  assert.ok(data.sessionTotal > 80);
  const search = await (await request('/api/sessions?q=' + encodeURIComponent('후반부 점검 결과'))).json();
  assert.equal(search.total, 1);
  const messages = await (await request('/api/sessions/demo-kiro-long/messages?offset=150')).json();
  assert.equal(messages.items.length, 30);
  const exported = await (await request('/api/sessions/demo-kiro-long/export?format=json')).json();
  assert.equal(exported.messages.length, 180);
  const doctor = await run(process.execPath, [entry, 'doctor', '--demo', '--data-dir', state], { env: environment, timeout: 10000 });
  assert.equal(JSON.parse(doctor.stdout).sessions, data.sessionTotal);
  const listed = await run(process.execPath, [entry, 'list', '--demo', '--data-dir', state, '--query', '후반부 점검 결과', '--json'], { env: environment, timeout: 10000 });
  assert.equal(JSON.parse(listed.stdout).total, 1);
  const exportPath = join(directory, 'session-export.json');
  await run(process.execPath, [entry, 'export', 'demo-kiro-long', '--demo', '--data-dir', state, '--format', 'json', '--out', exportPath], { env: environment, timeout: 10000 });
  assert.equal(JSON.parse(await readFile(exportPath, 'utf8')).messages.length, 180);
  for (const agent of ['codex', 'claude', 'kiro']) {
    const input = { agent, projectId: data.projects[0].id, prompt: 'Read-only sample task', policy: 'read-only' };
    const preview = await request('/api/runs/preview', input);
    assert.equal(preview.status, 200, `Preview without installed ${agent}`);
    assert.match((await preview.json()).displayCommand, new RegExp(agent === 'kiro' ? 'kiro-cli' : agent));
    assert.equal((await request('/api/runs', input)).status, 403);
  }
  server.kill('SIGTERM');
  phase = 'shutdown';
  const termination = await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('Package shutdown timed out')), 5000).unref())]);
  assert.equal(termination[0], 0);
  const report = {
    archive: archive.split('/').at(-1), node: process.version, platform: process.platform, arch: process.arch,
    productionInstall: true, cliHelp: true, cliDoctor: true, cliSearch: true, cliExport: true,
    staticAssets: assets.length, dependencyNotices: true, localKoreanFonts: true,
    demoSessions: data.sessionTotal, cliAbsent: true, allThreePreviews: true,
    executionBlocked: true, fullExport: true, pagedHistory: true, gracefulShutdown: true,
  };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/package-smoke.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearInterval(heartbeat);
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await Promise.race([exit, new Promise((done) => setTimeout(done, 2000))]);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL');
      await exit;
    }
  }
  await rm(directory, { recursive: true, force: true });
}
