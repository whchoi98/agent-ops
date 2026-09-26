import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createRequire } from 'node:module';
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
  assert.match(help.stdout, /agent-ops optimize/);
  const installedVersion = await run(process.execPath, [entry, '--version'], { timeout: 10000 });
  assert.equal(installedVersion.stdout.trim(), version);
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
    const response = await fetch(base + path, {
      signal: AbortSignal.timeout(10000),
      ...(body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Ops': '1' }, body: JSON.stringify(body),
      }),
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
  assert.equal(health.version, version);
  const html = await (await request('/')).text();
  assert.match(html, /<title>my-agent-ops<\/title>/);
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => new URL(match[1], `${base}/`).pathname)
    .filter((path) => /^\/(?:assets\/|theme-init\.js$|favicon\.svg$)/.test(path));
  assert.ok(assets.length >= 4, 'HTML must reference the built scripts, stylesheet and favicon.');
  for (const path of assets) assert.equal((await request(path)).status, 200, path);
  const notices = await (await request('/THIRD_PARTY_NOTICES.txt')).text();
  assert.match(notices, /react 19/);
  assert.equal((await request('/fonts/NanumSquareR.woff')).status, 200);
  assert.equal((await request('/fonts/NanumSquareB.woff')).status, 200);
  for (const path of ['/icons/codex.png', '/icons/kiro.svg']) {
    const icon = await request(path);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get('content-type') || '', /^image\//);
  }
  const data = await (await request('/api/bootstrap')).json();
  assert.equal(data.demo, true);
  assert.equal(data.connectors.every((connector) => !connector.installed), true);
  assert.ok(data.sessionTotal > 80);
  assert.ok(data.analytics.recordedCredits > 0);
  assert.ok(data.sessions.some(session => session.agent === 'kiro' && session.usage.credits > 0));
  const syncStatus = await (await request('/api/sync/status')).json();
  assert.equal(syncStatus.demo, true);
  assert.equal(syncStatus.automaticState, 'disabled');
  assert.equal(syncStatus.activity, 'idle');
  const appUpdate = await (await request('/api/app-update')).json();
  assert.equal(appUpdate.currentVersion, version);
  assert.equal(appUpdate.status, 'demo');
  assert.equal(appUpdate.commands.npm, null);
  assert.equal(appUpdate.commands.git, null);
  const workItems = await (await request('/api/productivity/work-items?status=todo&limit=2')).json();
  assert.ok(workItems.total > 0 && workItems.items.length <= 2);
  assert.equal(Object.hasOwn(workItems.items[0], 'description'), false);
  const workDraft = await (await request(`/api/productivity/work-items/${workItems.items[0].id}/prepare`,
    { version: workItems.items[0].version })).json();
  assert.equal(workDraft.draft.policy, 'read-only');
  assert.equal((await request('/api/runs/preview', workDraft.draft)).status, 200);
  assert.equal((await request('/api/runs', workDraft.draft)).status, 403);
  const packs = await (await request('/api/productivity/context-packs?limit=2')).json();
  assert.ok(packs.total > 0 && packs.items.length <= 2);
  assert.equal(Object.hasOwn(packs.items[0], 'items'), false);
  const compiledContext = await (await request(`/api/productivity/context-packs/${packs.items[0].id}/compile`, {})).json();
  assert.equal(compiledContext.packId, packs.items[0].id);
  assert.ok(compiledContext.prompt.length > 0 && compiledContext.prompt.length <= 64_000);
  const savedViews = await (await request('/api/productivity/saved-views')).json();
  assert.ok(savedViews.items.length > 0);
  const variableTemplate = data.templates.find(template => template.variables?.length);
  assert.ok(variableTemplate);
  const renderedTemplate = await (await request(`/api/templates/${variableTemplate.id}/render`,
    { values: { target: 'source.ts', goal: 'Inspect the scope.', format: 'a checklist' } })).json();
  assert.match(renderedTemplate.prompt, /source\.ts/);
  assert.ok((await (await request(`/api/templates/${variableTemplate.id}/history`)).json()).length >= 2);
  const resources = await (await request('/api/resources')).json();
  assert.equal(resources.sampleIntervalSeconds, 5);
  assert.equal(resources.diskIntervalSeconds, 60);
  assert.equal(resources.retentionSeconds, 900);
  assert.ok(resources.current.scopes.server.rssBytes > 0);
  assert.ok(resources.history.length <= 180);
  const mcp = await (await request('/api/mcp')).json();
  assert.equal(mcp.demo, true);
  assert.ok(mcp.items.length > 0);
  const mcpPreview = await (await request(`/api/mcp/${mcp.items[0].id}/preview`, {})).json();
  assert.equal(mcpPreview.canCheck, false);
  assert.equal((await request(`/api/mcp/${mcp.items[0].id}/check`, { previewId: mcpPreview.previewId })).status, 403);
  const desktopApps = await (await request('/api/desktop-apps')).json();
  assert.equal(desktopApps.status, 'demo');
  assert.equal(desktopApps.items.every(item => item.installed === null && item.candidates.length === 0), true);
  for (const document of ['resources.md', 'mcp.md', 'desktop-apps.md', 'usage-and-sync.md', 'productivity.md']) {
    const body = await readFile(join(directory, 'node_modules/agent-ops-local/docs/reference', document), 'utf8');
    assert.ok(body.includes('## 한국어'));
  }
  const extensions = await (await request('/api/extensions?agent=codex')).json();
  assert.equal(extensions.demo, true);
  const reviewSkill = extensions.items.find((item) => item.name === '코드 리뷰');
  assert.ok(reviewSkill);
  const extension = await (await request(`/api/extensions/${reviewSkill.id}`)).json();
  assert.ok(extension.analysis.tools.includes('Read'));
  assert.match(extension.entry.content, /회귀 테스트/);
  const reference = extension.files.find((file) => file.path.endsWith('checklist.md'));
  assert.ok(reference);
  const referenceContent = await (await request(`/api/extensions/${reviewSkill.id}/files/${reference.id}`)).json();
  assert.match(referenceContent.content, /변경 범위/);
  const analysis = await (await request(`/api/extensions/${reviewSkill.id}/analyze`, {})).json();
  assert.equal(analysis.draft.policy, 'read-only');
  assert.match(analysis.draft.prompt, /코드 리뷰/);
  const versions = await (await request('/api/connector-versions')).json();
  assert.equal(versions.demo, true);
  assert.equal(versions.items.length, 3);
  assert.equal(versions.items.find((item) => item.agent === 'codex').currentVersion, '1.0.0');
  assert.equal(versions.items.find((item) => item.agent === 'codex').latestVersion, '1.1.0');
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
  phase = 'demo server shutdown';
  server.kill('SIGTERM');
  const termination = await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('Package shutdown timed out')), 5000).unref())]);
  assert.equal(termination[0], 0);
  phase = 'offline storage optimization';
  const optimized = JSON.parse((await run(process.execPath, [entry, 'optimize', '--demo', '--data-dir', state], { env: environment, timeout: 60000 })).stdout);
  assert.equal(optimized.documents, data.sessionTotal);
  assert.ok(optimized.backupBytes > 0);
  assert.ok((await readFile(optimized.backupPath)).length > 0);
  const afterOptimize = await run(process.execPath, [entry, 'list', '--demo', '--data-dir', state, '--query', '후반부 점검 결과', '--json'], { env: environment, timeout: 10000 });
  assert.equal(JSON.parse(afterOptimize.stdout).total, 1);

  phase = 'packaged background synchronization';
  const liveState = join(directory, 'synthetic-live-state');
  await mkdir(liveState);
  const source = join(directory, 'synthetic-session.jsonl');
  const transcript = [
    { type: 'session_meta', payload: { id: 'package-sync', cwd: '/synthetic/package-project', timestamp: '2026-09-25T00:00:00Z' } },
    { type: 'response_item', timestamp: '2026-09-25T00:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Packaged background sync fixture' }] } },
  ];
  await writeFile(source, transcript.map(value => JSON.stringify(value)).join('\n') + '\n');
  const requirePackage = createRequire(join(directory, 'node_modules/agent-ops-local/package.json'));
  const Database = requirePackage('better-sqlite3');
  const fixtureDb = new Database(join(liveState, 'agent-ops.sqlite'));
  fixtureDb.exec('CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  fixtureDb.prepare('INSERT INTO settings VALUES (?,?)').run('config', JSON.stringify({ sourceRoots: { codex: [source], claude: [], kiro: [] } }));
  fixtureDb.close();
  server = spawn(process.execPath, [entry, 'serve', '--port', String(port), '--data-dir', liveState], {
    cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  exit = once(server, 'exit');
  diagnostics = '';
  server.stdout.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-12000); });
  server.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-12000); });
  health = undefined;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Package server exited: ${diagnostics}`);
    try { health = await (await request('/api/health')).json(); if (health.ok && !health.demo) break; } catch {}
    await new Promise(done => setTimeout(done, 100));
  }
  assert.equal(health?.demo, false, diagnostics);
  assert.equal((await (await request('/api/productivity/work-items')).json()).total, 0);
  assert.equal((await (await request('/api/productivity/context-packs')).json()).total, 0);
  assert.deepEqual((await (await request('/api/productivity/saved-views')).json()).items, []);
  const imported = await request('/api/sync', {});
  assert.equal(imported.status, 200);
  assert.ok(Array.isArray((await imported.json()).warnings));
  const recorded = await (await request('/api/sessions?q=' + encodeURIComponent('Packaged background sync fixture'))).json();
  assert.equal(recorded.total, 1);
  transcript.push({ type: 'response_item', timestamp: '2026-09-25T00:00:02Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Changed packaged import marker' }] } });
  await writeFile(source, transcript.map(value => JSON.stringify(value)).join('\n') + '\n');
  const updated = await request('/api/sync', {});
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).imported, 1);
  assert.equal((await (await request('/api/sessions?q=' + encodeURIComponent('Changed packaged import marker'))).json()).total, 1);
  phase = 'live server shutdown';
  server.kill('SIGTERM');
  const liveTermination = await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('Package shutdown timed out')), 5000).unref())]);
  assert.equal(liveTermination[0], 0);
  const report = {
    archive: archive.split('/').at(-1), node: process.version, platform: process.platform, arch: process.arch,
    productionInstall: true, cliHelp: true, cliDoctor: true, cliSearch: true, cliExport: true,
    staticAssets: assets.length, dependencyNotices: true, localKoreanFonts: true,
    extensionCatalog: true, extensionAnalysis: true, extensionFilePreview: true, analysisDraftOnly: true,
    officialBrandIcons: true, cliVersionComparison: true, offlineOptimization: true, packagedBackgroundSync: true,
    demoSessions: data.sessionTotal, cliAbsent: true, allThreePreviews: true,
    executionBlocked: true, fullExport: true, pagedHistory: true, gracefulShutdown: true,
    installedVersion: version, workItems: true, contextPacks: true, templateInputsAndHistory: true,
    savedViews: true, productivityDemoIsolation: true,
  };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/package-smoke.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (cause) {
  console.error(`Package verification failed during ${phase}.`);
  if (diagnostics) console.error(diagnostics);
  throw cause;
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
