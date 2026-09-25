import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { SyncReport } from '../shared/types.js';
import { BackgroundSync } from '../server/background-sync.js';

const fixture = fileURLToPath(new URL('./fixtures/background-sync.mjs', import.meta.url));
const expectedReport: SyncReport = {
  startedAt: '2026-09-25T00:00:00.000Z',
  finishedAt: '2026-09-25T00:00:01.000Z',
  imported: 3, filesScanned: 4, skipped: 1, warnings: ['Synthetic import warning.'],
};
interface Ready { pid: number; executable: string; args: string[]; execArgv: string[]; stdin: string }
const directories: string[] = [];
const workers: BackgroundSync[] = [];

async function directory(config: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-background-sync-'));
  directories.push(root);
  const path = join(root, "state with spaces ; literal '$value'");
  await mkdir(path);
  await writeFile(join(path, 'fixture.json'), JSON.stringify(config));
  return path;
}

function worker(dataDir: string, extra: Partial<ConstructorParameters<typeof BackgroundSync>[0]> = {}) {
  const sync = new BackgroundSync({ dataDir, entry: fixture, ...extra });
  workers.push(sync);
  return sync;
}

async function ready(dataDir: string): Promise<Ready> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(join(dataDir, 'ready.json'), 'utf8')) as Ready; }
    catch { await delay(10); }
  }
  throw new Error('Controlled background-sync fixture did not become ready.');
}

afterEach(async () => {
  const owned = workers.splice(0);
  owned.forEach(sync => sync.cancel());
  await Promise.all(owned.map(sync => sync.wait()));
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
}, 10_000);

describe('BackgroundSync command and report boundary', () => {
  it('coalesces a single owned Node sync command and makes its lifecycle observable', async () => {
    const dataDir = await directory({ delayMs: 75 });
    const completed: SyncReport[] = [];
    const sync = worker(dataDir, { onComplete: report => { completed.push(report); } });
    expect(sync.active).toBe(false);
    const first = sync.run();
    const second = sync.run();
    expect(sync.active).toBe(true);
    expect(second).toBe(first);
    expect(await first).toEqual(expectedReport);
    await sync.wait();
    expect(sync.active).toBe(false);
    expect(completed).toEqual([expectedReport]);
    const started = JSON.parse((await readFile(join(dataDir, 'starts.jsonl'), 'utf8')).trim()) as Ready;
    expect(started).toMatchObject({
      executable: process.execPath, args: ['sync', '--data-dir', dataDir], execArgv: [], stdin: '',
    });
    expect(started.pid).not.toBe(process.pid);
  });

  it('can run again after completion and does not expose successful stderr or extra report fields', async () => {
    const dataDir = await directory({
      stderr: 'fixture-private-stderr',
      report: { ...expectedReport, internalLog: 'fixture-private-extra' },
    });
    const sync = worker(dataDir);
    expect(await sync.run()).toEqual(expectedReport);
    expect(await sync.run()).toEqual(expectedReport);
    expect((await readFile(join(dataDir, 'starts.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);
    expect(sync.active).toBe(false);
  });

  it.each([
    null,
    [],
    { ...expectedReport, imported: -1 },
    { ...expectedReport, filesScanned: 1.5 },
    { ...expectedReport, skipped: '1' },
    { ...expectedReport, imported: Number.MAX_SAFE_INTEGER + 1 },
    { ...expectedReport, startedAt: 'not-a-date' },
    { ...expectedReport, finishedAt: '2026-09-24T00:00:00.000Z' },
    { ...expectedReport, warnings: 'fixture-private-invalid-warning' },
    { ...expectedReport, warnings: [42] },
  ])('rejects an invalid final SyncReport with a generic error', async report => {
    const dataDir = await directory({ report });
    const completed: SyncReport[] = [];
    const sync = worker(dataDir, { onComplete: value => { completed.push(value); } });
    await expect(sync.run()).rejects.toThrow(/invalid report/i);
    await expect(sync.wait()).resolves.toBeUndefined();
    expect(sync.active).toBe(false);
    expect(completed).toEqual([]);
  });

  it.each([
    'fixture-private-log\n{"imported":3}',
    '{"startedAt":"fixture-private-truncated',
    JSON.stringify(expectedReport) + '\nfixture-private-tail',
    JSON.stringify(expectedReport) + '\n' + JSON.stringify(expectedReport),
  ])('does not treat malformed or mixed stdout as a successful final report', async raw => {
    const sync = worker(await directory({ raw }));
    const error = await sync.run().catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/invalid report/i);
    expect(error.message).not.toContain('fixture-private');
    await expect(sync.wait()).resolves.toBeUndefined();
  });

  it('reports a failed child generically and permits the next scheduled attempt', async () => {
    const dataDir = await directory({ mode: 'failure' });
    const sync = worker(dataDir);
    const error = await sync.run().catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/failed/i);
    expect(error.message).not.toContain('fixture-private');
    await expect(sync.wait()).resolves.toBeUndefined();
    await writeFile(join(dataDir, 'fixture.json'), '{}');
    expect(await sync.run()).toEqual(expectedReport);
  });

  it('keeps callback exceptions separate from a completed sync', async () => {
    const sync = worker(await directory(), { onComplete: () => { throw new Error('fixture-private-callback'); } });
    expect(await sync.run()).toEqual(expectedReport);
    expect(sync.active).toBe(false);
    await expect(sync.wait()).resolves.toBeUndefined();
  });

  it.each(['stdout-limit', 'stderr-limit'])('bounds %s and never returns captured output in errors', async mode => {
    const sync = worker(await directory({ mode }));
    const error = await sync.run().catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/output.*limit/i);
    expect(error.message.length).toBeLessThan(200);
    await expect(sync.wait()).resolves.toBeUndefined();
    expect(sync.active).toBe(false);
  });

  it('rejects an entry failure without exposing runtime diagnostics', async () => {
    const dataDir = await directory();
    const sync = worker(dataDir, { entry: join(dataDir, 'fixture-private-missing-entry.mjs') });
    const error = await sync.run().catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/failed/i);
    expect(error.message).not.toContain('fixture-private');
    await expect(sync.wait()).resolves.toBeUndefined();
    expect(sync.active).toBe(false);
  });

  it('loads TypeScript entries through the source/dev runtime', async () => {
    const dataDir = await directory();
    const entry = join(dataDir, 'entry.ts');
    await writeFile(entry, [
      "import { writeFileSync } from 'node:fs';",
      'const typed: number = 1;',
      `writeFileSync(${JSON.stringify(join(dataDir, 'source-argv.json'))}, JSON.stringify({ args: process.argv.slice(2), execArgv: process.execArgv, typed }));`,
      `console.log(${JSON.stringify(JSON.stringify(expectedReport))});`,
    ].join('\n'));
    const sync = worker(dataDir, { entry });
    expect(await sync.run()).toEqual(expectedReport);
    expect(JSON.parse(await readFile(join(dataDir, 'source-argv.json'), 'utf8'))).toEqual({
      args: ['sync', '--data-dir', dataDir], execArgv: ['--import', 'tsx'], typed: 1,
    });
  });
});

describe('BackgroundSync lifecycle and responsiveness', () => {
  it('cancels the owned child with SIGTERM, rejects run, and resolves cleanup', async () => {
    const dataDir = await directory({ mode: 'hold' });
    const completed: SyncReport[] = [];
    const sync = worker(dataDir, { onComplete: report => { completed.push(report); } });
    const outcome = sync.run().catch(error => error);
    expect(sync.active).toBe(true);
    const child = await ready(dataDir);
    sync.cancel();
    sync.cancel();
    await expect(sync.wait()).resolves.toBeUndefined();
    expect(await outcome).toMatchObject({ name: 'AbortError', message: expect.stringMatching(/cancel/i) });
    expect(await readFile(join(dataDir, 'terminated'), 'utf8')).toBe('SIGTERM');
    expect(() => process.kill(child.pid, 0)).toThrow();
    expect(sync.active).toBe(false);
    expect(completed).toEqual([]);
    await expect(sync.run()).rejects.toThrow(/stopping|cancel/i);
  });

  it('escalates to SIGKILL when its own child ignores SIGTERM without cancelling another worker', async () => {
    const dataDir = await directory({ mode: 'ignore-term' });
    const otherDir = await directory({ mode: 'hold' });
    const sync = worker(dataDir);
    const other = worker(otherDir);
    const outcome = sync.run().catch(error => error);
    const otherOutcome = other.run().catch(error => error);
    expect(sync.active).toBe(true);
    expect(other.active).toBe(true);
    const [child, unrelated] = await Promise.all([ready(dataDir), ready(otherDir)]);
    const started = Date.now();
    sync.cancel();
    await sync.wait();
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(await readFile(join(dataDir, 'terminated'), 'utf8')).toBe('SIGTERM');
    expect(() => process.kill(child.pid, 0)).toThrow();
    expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
    expect(other.active).toBe(true);
    other.cancel();
    await other.wait();
    expect(await otherOutcome).toMatchObject({ name: 'AbortError' });
  }, 10_000);

  it('can stop before any run and wait while idle', async () => {
    const sync = worker(await directory());
    await expect(sync.wait()).resolves.toBeUndefined();
    sync.cancel();
    await expect(sync.run()).rejects.toThrow(/stopping|cancel/i);
    await expect(sync.wait()).resolves.toBeUndefined();
    expect(sync.active).toBe(false);
  });

  it('keeps timers on the parent event loop responsive while the child performs CPU work', async () => {
    const dataDir = await directory({ mode: 'cpu' });
    const sync = worker(dataDir);
    const pending = sync.run();
    expect(sync.active).toBe(true);
    await ready(dataDir);
    let ticks = 0;
    const heartbeat = setInterval(() => { if (sync.active) ticks++; }, 5);
    try {
      await writeFile(join(dataDir, 'go'), '');
      expect(await pending).toEqual(expectedReport);
      expect(ticks).toBeGreaterThan(0);
    } finally { clearInterval(heartbeat); }
  });

  it('emits modest optional progress only while active and isolates callback errors', async () => {
    const dataDir = await directory({ mode: 'hold' });
    const progress: boolean[] = [];
    const completed: SyncReport[] = [];
    const sync = worker(dataDir, {
      onComplete: report => { completed.push(report); },
      onProgress: () => { progress.push(sync.active); throw new Error('fixture-private-progress'); },
    });
    const outcome = sync.run().catch(error => error);
    expect(sync.active).toBe(true);
    await ready(dataDir);
    await delay(2100);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.length).toBeLessThanOrEqual(3);
    expect(progress.every(Boolean)).toBe(true);
    sync.cancel();
    await sync.wait();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    const before = progress.length;
    await delay(2100);
    expect(progress).toHaveLength(before);
    expect(completed).toEqual([]);
  }, 10_000);

  it('bounds a stuck job lifetime using a real child and a controlled parent clock', async () => {
    const dataDir = await directory({ mode: 'hold' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const sync = worker(dataDir);
    const outcome = sync.run().catch(error => error);
    expect(sync.active).toBe(true);
    await ready(dataDir);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await sync.wait();
    expect(await outcome).toMatchObject({ message: expect.stringMatching(/time limit|timed out/i) });
    expect(sync.active).toBe(false);
  });

  it('bounds inherited-pipe cleanup after the leader exits without killing the pipe holder', async () => {
    const dataDir = await directory({ mode: 'held-pipes' });
    const sync = worker(dataDir);
    try {
      const started = Date.now();
      const error = await sync.run().catch(value => value);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/output|pipe|close/i);
      expect(Date.now() - started).toBeLessThan(4000);
      const holder = Number(await readFile(join(dataDir, 'pipe-owner'), 'utf8'));
      expect(() => process.kill(holder, 0)).not.toThrow();
      await expect(sync.wait()).resolves.toBeUndefined();
      expect(sync.active).toBe(false);
    } finally {
      // Only this test fixture creates and records this otherwise unrelated pipe holder.
      try { process.kill(Number(await readFile(join(dataDir, 'pipe-owner'), 'utf8')), 'SIGKILL'); }
      catch { /* No holder was created, or its bounded lifetime already ended. */ }
    }
  });
});

describe('BackgroundSync with the existing CLI', () => {
  it('imports synthetic native history into the same SQLite store without changing sources or user metadata', async () => {
    const { Store } = await import('../server/store.js');
    const dataDir = await directory();
    const source = join(dataDir, 'rollout-background.jsonl');
    const first = [
      { type: 'session_meta', payload: { id: 'background-native-fixture', cwd: '/fixture/project', timestamp: '2026-09-25T00:00:00.000Z' } },
      { type: 'response_item', timestamp: '2026-09-25T00:00:01.000Z', payload: {
        type: 'message', id: 'native-user', role: 'user', content: [{ type: 'input_text', text: 'Read bgsyntheticneedle without changing native files.' }],
      } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n';
    await writeFile(source, first);
    const store = new Store(join(dataDir, 'agent-ops.sqlite'));
    const sync = worker(dataDir, { entry: fileURLToPath(new URL('../server/index.ts', import.meta.url)) });
    try {
      store.saveSettings({ sourceRoots: { codex: [source], claude: [], kiro: [] } });
      const initial = await sync.run();
      expect(initial).toMatchObject({ imported: 1, filesScanned: 1, skipped: 0, warnings: [] });
      expect(store.lastSync()).toEqual(initial);
      expect(store.listSessions({ q: 'bgsyntheticneedle' }).total).toBe(1);
      expect(await readFile(source, 'utf8')).toBe(first);
      store.patchSession('codex:background-native-fixture', { note: 'Preserve my note', bookmarked: true, tags: ['keep'] });
      const updated = first + JSON.stringify({
        type: 'response_item', timestamp: '2026-09-25T00:00:02.000Z', payload: {
          type: 'message', id: 'native-assistant', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic completed review.' }],
        },
      }) + '\n';
      await writeFile(source, updated);
      expect(await sync.run()).toMatchObject({ imported: 1, filesScanned: 1, skipped: 0, warnings: [] });
      expect(store.getSession('codex:background-native-fixture')).toMatchObject({
        nativeId: 'background-native-fixture', messageCount: 2,
        note: 'Preserve my note', bookmarked: true, tags: ['keep'],
        usage: { inputTokens: null, outputTokens: null, costUsd: null },
      });
      expect(await readFile(source, 'utf8')).toBe(updated);
      expect(await sync.run()).toMatchObject({ imported: 0, filesScanned: 1, skipped: 1, warnings: [] });
    } finally {
      sync.cancel();
      await sync.wait();
      store.close();
    }
  }, 15_000);
});
