import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock } from '../server/lock.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { force: true, recursive: true })));
it('prevents two servers from owning the same execution queue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-lock-'));
  dirs.push(dir);
  const release = acquireLock(dir);
  expect(() => acquireLock(dir)).toThrow(/already running/);
  release();
  const next = acquireLock(dir);
  next();
});
it('never removes a replacement lock during release', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-lock-'));
  dirs.push(dir);
  const release = acquireLock(dir);
  release();
  const next = acquireLock(dir);
  const owner = readFileSync(join(dir, 'server.lock'), 'utf8');
  release();
  expect(readFileSync(join(dir, 'server.lock'), 'utf8')).toBe(owner);
  expect(() => acquireLock(dir)).toThrow(/already running/);
  next();
});
it('recovers stale diagnostic metadata even if its PID was reused by another process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-lock-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'server.lock'), JSON.stringify({ pid: process.pid, nonce: 'stale' }));
  const release = acquireLock(dir);
  expect(() => acquireLock(dir)).toThrow(/already running/);
  release();
});
