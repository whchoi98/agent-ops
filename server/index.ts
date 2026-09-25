#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createApp } from './app.js';
import { dataDirectory, VERSION } from './config.js';
import { Store } from './store.js';
import { SyncService } from './sync.js';
import { detectConnectors } from './connectors.js';
import { exportSession } from './privacy.js';
import { acquireLock } from './lock.js';
import { AGENTS, type Agent } from '../shared/types.js';

const help = `Agent Ops ${VERSION} — local workbench for Codex, Claude Code & Kiro

Usage:
  agent-ops [serve] [--port 4317] [--data-dir PATH] [--public-url HTTPS_URL]
  agent-ops demo [--port 4318] [--data-dir PATH]
  agent-ops sync [--data-dir PATH]
  agent-ops optimize [--data-dir PATH]
  agent-ops doctor [--data-dir PATH]
  agent-ops list [--query TEXT] [--agent codex|claude|kiro] [--limit 20] [--json]
  agent-ops export SESSION_ID [--format md|json|html] [--out FILE]

Options:
  --demo       Use isolated sample data (execution disabled).
  --data-dir   Base directory for local state; demo adds a /demo subdirectory.
  --port       Loopback HTTP port (default 4317).
  --public-url External HTTPS URL behind an authenticated local reverse proxy.
  --help       Show this help.
  --version    Show version.

The server only listens on 127.0.0.1, including reverse-proxy mode.
Agent credentials stay with each installed CLI.
AGENT_OPS_DATA_DIR sets the default data directory. No telemetry.
Optimize requires the server to be stopped and keeps a compressed backup.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' }, 'data-dir': { type: 'string' },
      'public-url': { type: 'string' },
      demo: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' }, query: { type: 'string' },
      agent: { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean' },
      format: { type: 'string' }, out: { type: 'string' },
    },
  });
  if (values.help) { console.log(help); return; }
  if (values.version) { console.log(VERSION); return; }
  const command = positionals[0] || 'serve';
  if (command === 'help') { console.log(help); return; }
  if (!['serve', 'demo', 'sync', 'optimize', 'doctor', 'list', 'export'].includes(command)) throw new Error(`Unknown command: ${command}. Use --help.`);
  const demo = command === 'demo' || Boolean(values.demo);
  const base = values['data-dir'] ? resolve(values['data-dir']) : dataDirectory(false);
  const directory = demo ? join(base, 'demo') : base;
  if (command === 'serve' || command === 'demo') {
    const port = Number(values.port || process.env.AGENT_OPS_PORT || 4317);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
    const release = acquireLock(directory);
    let context: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      context = await createApp({ dataDir: directory, demo, publicUrl: values['public-url'] || process.env.AGENT_OPS_PUBLIC_URL });
      await context.app.listen({ port, host: '127.0.0.1' });
      console.log(`\n  Agent Ops ${VERSION}${demo ? ' · DEMO (execution disabled)' : ''}`);
      console.log(`  http://127.0.0.1:${port}`);
      if (values['public-url'] || process.env.AGENT_OPS_PUBLIC_URL) console.log(`  Public URL: ${values['public-url'] || process.env.AGENT_OPS_PUBLIC_URL}`);
      console.log(`  Data: ${directory}\n`);
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        try { await context!.app.close(); }
        finally { release(); }
      };
      process.once('SIGINT', () => { void stop().catch((err: Error) => { console.error(err.message); process.exitCode = 1; }); });
      process.once('SIGTERM', () => { void stop().catch((err: Error) => { console.error(err.message); process.exitCode = 1; }); });
      process.once('exit', release);
    } catch (err) {
      await context?.app.close();
      release();
      throw err;
    }
    return;
  }
  if (command === 'optimize') {
    const { optimizeStorage } = await import('./maintenance.js');
    const report = await optimizeStorage(directory, message => console.error(message));
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command === 'sync' && demo) throw new Error('Demo mode does not import native history.');
  const releaseSync = command === 'sync' ? acquireLock(join(directory, 'sync-lock')) : undefined;
  let store: Store;
  try { store = new Store(join(directory, 'agent-ops.sqlite')); }
  catch (error) { releaseSync?.(); throw error; }
  try {
    const mode = store.getMeta<string>('mode');
    if (mode && mode !== (demo ? 'demo' : 'live')) throw new Error('This data directory belongs to a different mode.');
    if (command === 'sync') {
      store.setMeta('mode', 'live');
      const report = await new SyncService(store).run();
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (command === 'doctor') {
      const sessions = store.allSessions();
      const counts = Object.fromEntries(AGENTS.map((agent) => [agent, sessions.filter((s) => s.agent === agent).length]));
      const connectors = await detectConnectors(store.getSettings(), counts);
      console.log(JSON.stringify({
        version: VERSION, node: process.version, platform: process.platform, dataDirectory: directory,
        demo, sessions: sessions.length, connectors, lastSync: store.lastSync(),
        authentication: 'Not probed. Each CLI uses its own login and environment.',
      }, null, 2));
      return;
    }
    if (command === 'list') {
      if (values.agent && !AGENTS.includes(values.agent as Agent)) throw new Error('Agent must be codex, claude, or kiro.');
      const limit = Number(values.limit || 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Limit must be between 1 and 200.');
      const result = store.listSessions({ q: values.query, agent: values.agent as Agent | undefined, limit });
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else {
        for (const s of result.items) console.log(`${s.id}\n  ${s.agent} · ${s.projectName} · ${s.updatedAt}\n  ${s.title}\n`);
        console.log(`${result.total} sessions matched.`);
      }
      return;
    }
    const id = positionals[1];
    if (!id) throw new Error('Provide a session ID. Use agent-ops list to find it.');
    const format = values.format || 'md';
    if (!['md', 'json', 'html'].includes(format)) throw new Error('Format must be md, json, or html.');
    const session = store.getSession(id);
    if (!session) throw new Error('Session not found.');
    const exported = exportSession(session, format as 'md' | 'json' | 'html');
    if (values.out) {
      const output = resolve(values.out);
      // Avoid overwriting a preexisting file without an explicit separate action.
      writeFileSync(output, exported.body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      console.log(`Exported ${output}`);
    } else process.stdout.write(exported.body + '\n');
  } finally { store.close(); releaseSync?.(); }
}

main().catch((error: unknown) => {
  console.error(`Agent Ops: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
