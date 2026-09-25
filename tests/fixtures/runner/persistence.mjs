import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Runner } from '../../../server/runner.ts';
import { Store } from '../../../server/store.ts';

// Isolate deliberately broken persistence from the test host, including the old
// implementation's unhandled rejection and unresolved child lifecycle.
const [root, mode] = process.argv.slice(2);
const naturalCompletion = mode === 'completion' || mode === 'terminal-append';
const errors = [];
process.on('unhandledRejection', (error) => errors.push(String(error)));
process.on('uncaughtException', (error) => errors.push(String(error)));
const store = new Store(join(root, 'fault.sqlite'));
const workspace = join(root, 'fault-workspace');
mkdirSync(workspace);
const project = store.saveProject({ ...store.ensureProject(workspace), executionEnabled: true });
const executable = join(root, 'fault-cli.cjs');
writeFileSync(executable, `#!${process.execPath}\n${readFileSync(new URL('./process.cjs', import.meta.url), 'utf8')}`, { mode: 0o700 });
writeFileSync(`${executable}.json`, JSON.stringify({
  controlDir: root, ignoreTerm: !naturalCompletion,
  finalRecords: naturalCompletion ? [{ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }] : [],
}));
const connector = {
  agent: 'codex', installed: true, executable, version: 'fixture',
  roots: [], existingRoots: [], sessionCount: 0, error: null, supportsResume: true, supportsStreaming: true,
};
const children = [];
const notices = [];
const runner = new Runner(store, {
  connectors: async () => [connector], timeoutMs: 10000,
  onEvent: (notice) => notices.push(notice),
  spawn: (...args) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  },
});
const originalAppend = store.appendEvent.bind(store);
const originalUpdate = store.updateRun.bind(store);
const diskFull = () => Object.assign(new Error('SQLITE_FULL: disk full token=fixture-disk-secret'), { code: 'SQLITE_FULL' });
async function bound(promise, milliseconds = 2600) {
  let timer;
  try {
    return await Promise.race([
      promise.then((value) => ({ kind: 'resolved', value }), (error) => ({ kind: 'rejected', message: String(error) })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ kind: 'timeout' }), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function waitReady(id) {
  const deadline = Date.now() + 2000;
  while (!store.getEvents(id).some((event) => event.text === 'fixture ready')) {
    if (Date.now() > deadline) throw new Error('Fixture did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
let report;
try {
  const run = await runner.create({ agent: 'codex', projectId: project.id, policy: 'read-only', prompt: 'hold:A' });
  await waitReady(run.id);
  if (mode === 'close') await runner.create({ agent: 'codex', projectId: project.id, policy: 'read-only', prompt: 'queued' });
  const exit = once(children[0], 'exit');
  if (mode === 'append' || mode === 'close') store.appendEvent = () => { throw diskFull(); };
  if (mode === 'update' || mode === 'completion' || mode === 'close') {
    store.updateRun = (id, patch) => {
      if (mode !== 'completion' || patch.status) throw diskFull();
      return originalUpdate(id, patch);
    };
  }
  if (mode === 'terminal-append') {
    let terminalWrite = false;
    store.updateRun = (id, patch) => {
      if (patch.status === 'completed') terminalWrite = true;
      return originalUpdate(id, patch);
    };
    store.appendEvent = (...args) => {
      if (terminalWrite) throw diskFull();
      return originalAppend(...args);
    };
  }
  let action;
  if (naturalCompletion) {
    writeFileSync(join(root, 'A.release'), 'release');
    await exit;
    // The CLI has finished, but terminal persistence has not necessarily finished.
    action = await bound(runner.cancel(run.id));
  } else action = await bound(mode === 'close' ? runner.close() : runner.cancel(run.id));
  const alive = children.some((child) => {
    if (!child.pid) return false;
    try { process.kill(child.pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
  });
  const effective = runner.getRun(run.id);
  const listed = runner.listRuns();
  const restored = mode === 'append' || mode === 'update' || mode === 'completion';
  if (restored) {
    store.appendEvent = originalAppend;
    store.updateRun = originalUpdate;
  }
  const closed = await bound(runner.close());
  report = {
    action, alive, closed, effective, listed, restored, durable: store.getRun(run.id),
    events: store.getEvents(run.id), errors,
    completedNotices: notices.filter((notice) => notice.type === 'run-event' && /Run completed/.test(notice.event.text)),
  };
} catch (error) {
  report = { harnessError: String(error), errors };
} finally {
  store.appendEvent = originalAppend;
  store.updateRun = originalUpdate;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await bound(runner.close(), 100);
}
process.stdout.write(`${JSON.stringify(report)}\n`, () => process.exit(0));
