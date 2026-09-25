import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

type OwnerMessage = {
  type: 'ready' | 'attempting' | 'acquired' | 'rejected' | 'released';
  pid: number;
  elapsedMs?: number;
  error?: string;
};
type Exit = { code: number | null; signal: NodeJS.Signals | null };
interface Owner {
  child: ChildProcess;
  waitFor: (...types: OwnerMessage['type'][]) => Promise<OwnerMessage>;
  waitForExit: () => Promise<Exit>;
  command: (type: 'acquire' | 'release') => Promise<OwnerMessage>;
  isClosed: () => boolean;
}

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/lock-owner.mjs', import.meta.url));
const owners: Owner[] = [];
const directories: string[] = [];
const readers: Database.Database[] = [];
const waitMs = 5000;

function directory() {
  const path = mkdtempSync(join(tmpdir(), 'agent-ops-lock-process-'));
  directories.push(path);
  return path;
}

function startOwner(path: string): Owner {
  if (!directories.includes(path)) throw new Error('Cannot start a lock fixture after its test cleanup has begun.');
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, path], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const messages: OwnerMessage[] = [];
  let diagnostic = '';
  let closed = false;
  child.stderr!.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-8000); });
  child.on('error', (error) => { diagnostic += error.message; });
  child.on('message', (message) => { messages.push(message as OwnerMessage); });
  const exited = new Promise<Exit>((resolve) => {
    child.once('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });

  function failure(message: string) {
    return new Error(`Lock fixture PID ${child.pid ?? 'not spawned'}: ${message}${diagnostic ? `\n${diagnostic}` : ''}`);
  }

  function waitFor(...types: OwnerMessage['type'][]): Promise<OwnerMessage> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', check);
        child.off('close', check);
      };
      const check = () => {
        const message = messages.find((item) => types.includes(item.type));
        if (message) { cleanup(); resolve(message); }
        else if (closed) { cleanup(); reject(failure(`closed before ${types.join('/')}`)); }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(failure(`timed out waiting for ${types.join('/')}`));
      }, waitMs);
      child.on('message', check);
      child.on('close', check);
      check();
    });
  }

  function waitForExit(): Promise<Exit> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(failure('timed out waiting for process close')), waitMs);
      void exited.then((exit) => { clearTimeout(timer); resolve(exit); });
    });
  }

  async function command(type: 'acquire' | 'release') {
    const response = type === 'acquire' ? waitFor('acquired', 'rejected') : waitFor('released');
    const sent = new Promise<void>((resolve, reject) => {
      child.send({ type }, (error) => error ? reject(error) : resolve());
    });
    const [, message] = await Promise.all([sent, response]);
    return message;
  }

  const owner = { child, waitFor, waitForExit, command, isClosed: () => closed };
  owners.push(owner);
  return owner;
}

async function acquire(path: string) {
  const owner = startOwner(path);
  await owner.waitFor('ready');
  expect(await owner.command('acquire')).toMatchObject({ type: 'acquired', pid: owner.child.pid });
  return owner;
}

async function release(owner: Owner) {
  expect(await owner.command('release')).toMatchObject({ type: 'released', pid: owner.child.pid });
  expect(await owner.waitForExit()).toEqual({ code: 0, signal: null });
}

afterEach(async () => {
  const paths = directories.splice(0);
  readers.splice(0).forEach((reader) => { if (reader.open) reader.close(); });
  const results = await Promise.allSettled(owners.splice(0).map(async (owner) => {
    if (!owner.isClosed()) owner.child.kill('SIGKILL');
    await owner.waitForExit();
  }));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Lock fixture cleanup failed; temporary directories retained.');
  paths.forEach((path) => rmSync(path, { recursive: true, force: true }));
}, 10000);

describe('server lock across actual Node processes', () => {
  it('quickly rejects a second process while owned, then admits it after graceful release', async () => {
    const path = directory();
    const owner = await acquire(path);
    for (const filename of ['server-lock.sqlite', 'server.lock']) {
      expect(statSync(join(path, filename)).mode & 0o777).toBe(0o600);
    }
    const contender = startOwner(path);
    await contender.waitFor('ready');
    const rejected = await contender.command('acquire');
    expect(rejected).toMatchObject({
      type: 'rejected', error: expect.stringMatching(/already running/),
    });
    // Measure the lock call inside the child, excluding Node/tsx startup time.
    expect(rejected.elapsedMs).toBeLessThan(750);
    expect(await contender.waitForExit()).toEqual({ code: 2, signal: null });
    expect(owner.isClosed()).toBe(false);

    await release(owner);
    await release(await acquire(path));
  }, 20000);

  it('acquires after a brief SQLite shared-lock conflict clears', async () => {
    const path = directory();
    const reader = new Database(join(path, 'server-lock.sqlite'));
    readers.push(reader);
    reader.exec('CREATE TABLE lock_marker(id INTEGER PRIMARY KEY); BEGIN; SELECT * FROM lock_marker;');
    const contender = startOwner(path);
    await contender.waitFor('ready');

    const [outcome] = await Promise.all([
      contender.command('acquire'),
      (async () => {
        await contender.waitFor('attempting');
        await new Promise((resolve) => setTimeout(resolve, 75));
        if (reader.open) reader.close();
      })(),
    ]);
    expect(outcome).toMatchObject({ type: 'acquired', pid: contender.child.pid });
    await release(contender);
  }, 20000);

  it('automatically releases ownership after SIGKILL without deleting stale metadata', async () => {
    const path = directory();
    const owner = await acquire(path);
    const metadataPath = join(path, 'server.lock');
    const metadata = readFileSync(metadataPath, 'utf8');

    expect(owner.child.kill('SIGKILL')).toBe(true);
    expect(await owner.waitForExit()).toEqual({ code: null, signal: 'SIGKILL' });
    expect(readFileSync(metadataPath, 'utf8')).toBe(metadata);

    // No release callback or file deletion occurs before this separate process acquires.
    await release(await acquire(path));
  }, 20000);

  it.each(Array.from({ length: 12 }, (_, index) => index + 1))('admits exactly one simultaneous starter despite stale metadata naming a live PID (round %i)', async () => {
    const path = directory();
    writeFileSync(join(path, 'server.lock'), JSON.stringify({
      pid: process.pid, nonce: 'stale-diagnostic', startedAt: '2000-01-01T00:00:00.000Z',
    }), { mode: 0o600 });
    const starters = Array.from({ length: 4 }, () => startOwner(path));
    // All imports finish before any child is permitted to attempt acquisition.
    await Promise.all(starters.map((owner) => owner.waitFor('ready')));
    const outcomes = await Promise.all(starters.map((owner) => owner.command('acquire')));
    expect(outcomes.filter((message) => message.type === 'acquired'), JSON.stringify(outcomes)).toHaveLength(1);
    expect(outcomes.filter((message) => message.type === 'rejected')).toHaveLength(3);

    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.type !== 'rejected') continue;
      expect(outcome.error).toMatch(/already running/);
      expect(await starters[index].waitForExit()).toEqual({ code: 2, signal: null });
    }
    const winner = starters[outcomes.findIndex((message) => message.type === 'acquired')];
    const metadata = JSON.parse(readFileSync(join(path, 'server.lock'), 'utf8')) as { pid: number; nonce: string };
    expect(metadata.pid).toBe(winner.child.pid);
    expect(metadata.nonce).not.toBe('stale-diagnostic');
    expect(winner.isClosed()).toBe(false);
    await release(winner);
    await release(await acquire(path));
  }, 20000);
});
