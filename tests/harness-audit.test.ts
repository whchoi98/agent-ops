import { execFile } from 'node:child_process';
import { appendFile, link, mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, truncate, utimes, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessAuditReader } from '../server/harness/audit.js';
import type { HarnessAuditFile } from '../server/harness/types.js';

const temporary: string[] = [];
const now = Date.parse('2026-09-26T12:00:00.000Z');
const record = (extra: Record<string, unknown> = {}) => ({
  timestamp: '2026-09-26T11:00:00.000Z',
  session_id: 'session-fixture',
  event_type: 'tool_blocked',
  tool_name: 'Bash',
  tool_input_hash: 'a'.repeat(64),
  risk: { level: 'high', classifier: 'rules', matched_rule: 'destructive', reason: 'Destructive command', confidence: 1 },
  hooks_pre: [], hooks_post: [],
  permission: { action: 'deny', reason: 'Destructive operation', source: 'constitution' },
  execution: { status: 'blocked', duration_ms: 2.5, output_size: 0, sanitized: false },
  ...extra,
});
const line = (extra: Record<string, unknown> = {}) => JSON.stringify(record(extra)) + '\n';
async function put(path: string, content: string | Buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
async function fixture(options: ConstructorParameters<typeof HarnessAuditReader>[0] = {}, managed = false) {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-harness-audit-'));
  temporary.push(root);
  const source: HarnessAuditFile = {
    id: 'source-fixture', root, path: join(root, '.autoharness/audit.jsonl'), projectId: 'project-fixture', managed,
  };
  return { root, source, reader: new HarnessAuditReader(options) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('retained audit projection', () => {
  it('projects actual upstream records and hides the private owner root and raw payloads', async () => {
    const { source, reader } = await fixture();
    const original = line({ tool_input: { command: 'never-execute-fixture' }, tool_output: 'private-output-fixture' });
    await put(source.path, original);
    const page = await reader.read([source]);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      sourceId: source.id, timestamp: '2026-09-26T11:00:00.000Z', client: null,
      projectId: 'project-fixture', sessionId: 'session-fixture', runId: null,
      toolName: 'Bash', action: 'deny', risk: 'high', reason: 'Destructive operation',
      eventType: 'tool_blocked', origin: 'autoharness', status: 'blocked', durationMs: 2.5,
    });
    expect(page).toMatchObject({ total: 1, offset: 0, counts: { allow: 0, ask: 0, deny: 1, error: 0 } });
    expect(page.storage).toMatchObject({
      cachedRecords: 1, cacheLimit: 2000, retentionDays: 30,
      bytesRead: Buffer.byteLength(original), sourceBytes: Buffer.byteLength(original), invalidLines: 0, truncated: false,
    });
    expect(page.sources).toEqual([{
      id: source.id, path: source.path, projectId: source.projectId, managed: false,
    }]);
    expect(JSON.stringify(page)).not.toMatch(/never-execute-fixture|private-output-fixture|tool_input_hash/);
    expect(await readFile(source.path, 'utf8')).toBe(original);
  });

  it('preserves bridge check and hook provenance, clients and snake_case identifiers', async () => {
    const { source, reader } = await fixture({}, true);
    await put(source.path, [
      line({ origin: 'agent-ops-test', event_type: 'check', client: 'codex', run_id: 'run-one', project_id: source.projectId }),
      line({ origin: 'agent-ops-hook', event_type: 'PreToolUse', client: 'claude-code', run_id: 'run-two' }),
      line({ origin: 'agent-ops-hook', event_type: 'PostToolUse', client: 'kiro-cli' }),
      line({ origin: 'agent-ops-hook', event_type: 'PostToolUseFailure', client: 'kiro-ide',
        permission: { action: 'error', reason: 'Engine unavailable' }, execution: { status: 'error', duration_ms: null } }),
    ].join(''));
    const page = await reader.read([source]);
    expect(page.total).toBe(4);
    expect(page.items.map(item => [item.origin, item.eventType, item.client])).toEqual(expect.arrayContaining([
      ['agent-ops-test', 'check', 'codex'], ['agent-ops-hook', 'PreToolUse', 'claude-code'],
      ['agent-ops-hook', 'PostToolUse', 'kiro-cli'], ['agent-ops-hook', 'PostToolUseFailure', 'kiro-ide'],
    ]));
    expect(page.items.find(item => item.eventType === 'check')?.runId).toBe('run-one');
    expect(page.counts).toEqual({ allow: 0, ask: 0, deny: 3, error: 1 });
    expect(page.items.find(item => item.action === 'error')?.durationMs).toBeNull();
  });

  it('keeps shared Kiro hook records ambiguous and filters them separately from IDE and CLI', async () => {
    const { source, reader } = await fixture({}, true);
    await put(source.path, [
      line({ origin: 'agent-ops-hook', event_type: 'PreToolUse', client: 'kiro' }),
      line({ origin: 'agent-ops-test', event_type: 'check', client: 'kiro-cli' }),
      line({ origin: 'agent-ops-test', event_type: 'check', client: 'kiro-ide' }),
    ].join(''));
    const page = await reader.read([source], { client: 'kiro' });
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ client: 'kiro', eventType: 'PreToolUse', origin: 'agent-ops-hook' });
    expect((await reader.read([source], { client: 'kiro-cli' })).total).toBe(1);
    expect((await reader.read([source], { client: 'kiro-ide' })).total).toBe(1);
  });

  it('never trusts hook or test provenance claimed by an external audit file', async () => {
    const { source, reader } = await fixture();
    await put(source.path, [
      line({ origin: 'agent-ops-hook', event_type: 'PreToolUse', client: 'kiro' }),
      line({ origin: 'agent-ops-test', event_type: 'check', client: 'codex' }),
      line({ origin: 'external-writer', event_type: 'tool_call', client: 'claude-code' }),
    ].join(''));
    const page = await reader.read([source]);
    expect(page.items).toHaveLength(3);
    expect(page.items.every(item => item.origin === 'autoharness')).toBe(true);
    expect(page.observed).toEqual({});
    expect(reader.observations()).toEqual({});
  });

  it('redacts secret echoes before clipping reasons and identifiers and strips control sequences', async () => {
    const { source, reader } = await fixture();
    const secret = 'fixture-echo-secret/one';
    await put(source.path, line({
      session_id: `session-${secret}\u001b[31m`, run_id: `run-${secret}`,
      tool_name: `Bash-${secret}`, event_type: `PreToolUse-${secret}`,
      tool_input: { env: { PLAIN: secret } },
      execution: { status: 'blocked', duration_ms: -1, output: 'fixture-private-output' },
      permission: { action: 'deny', reason: `credential ${secret} fixture-echo-secret%2Fone password=other-fixture-secret\n${'x'.repeat(5000)}` },
    }));
    const page = await reader.read([source]);
    expect(page.total).toBe(1);
    expect(JSON.stringify(page)).not.toMatch(/fixture-echo-secret|other-fixture-secret|fixture-private-output|\\u001b/);
    expect(page.items[0].reason).toContain('[REDACTED]');
    expect(page.items[0].reason.length).toBeLessThanOrEqual(2048);
    expect(page.items[0].durationMs).toBeNull();
  });

  it('never converts malformed or missing permissions into an allowed decision', async () => {
    const { source, reader } = await fixture();
    await put(source.path, [
      line({ permission: {} }), line({ permission: { action: 'execute' } }),
      line({ permission: null }), line({ tool_name: '' }),
      line({ project_id: 'other-project' }), line(),
    ].join(''));
    const page = await reader.read([source]);
    expect(page.total).toBe(1);
    expect(page.counts.allow).toBe(0);
    expect(page.storage.invalidLines).toBe(5);
  });

  it('counts only matching retained records and paginates in newest-first order', async () => {
    const { source, reader } = await fixture();
    await put(source.path, [
      line({ timestamp: '2026-09-26T08:00:00Z', client: 'codex', tool_name: 'Read',
        permission: { action: 'allow', reason: 'Read source' } }),
      line({ timestamp: '2026-09-26T09:00:00Z', client: 'codex', session_id: 'chosen',
        permission: { action: 'ask', reason: 'Review git PUSH' } }),
      line({ timestamp: '2026-09-26T10:00:00Z', client: 'codex', session_id: 'chosen',
        permission: { action: 'ask', reason: 'Review git push' } }),
      line({ timestamp: '2026-09-26T11:00:00Z', client: 'claude-code' }),
    ].join(''));
    await reader.read([source]);
    const page = await reader.read([source], {
      projectId: source.projectId!, client: 'codex', action: 'ask', sessionId: 'chosen', q: 'GIT push', offset: 1, limit: 1,
    });
    expect(page).toMatchObject({ total: 2, offset: 1, limit: 1, counts: { allow: 0, ask: 2, deny: 0, error: 0 } });
    expect(page.items.map(item => item.timestamp)).toEqual(['2026-09-26T09:00:00.000Z']);
    expect(page.storage.cachedRecords).toBe(4);
    expect(page.storage.bytesRead).toBe(0);
    expect((await reader.read([source], { projectId: 'another' })).total).toBe(0);
    const bounded = await reader.read([source], { limit: Infinity, offset: -5 });
    expect(bounded.offset).toBe(0);
    expect(bounded.limit).toBeGreaterThan(0);
    expect(bounded.limit).toBeLessThanOrEqual(200);
  });

  it('applies a global record cap across sources and prunes as settings and the clock change', async () => {
    const { source, reader } = await fixture({ maxCacheRecords: 3 });
    const second = { ...source, id: 'second', path: join(source.root, 'second.jsonl') };
    await put(source.path, [
      line({ timestamp: '2026-08-20T11:00:00Z' }),
      line({ timestamp: '2026-09-24T11:00:00Z', tool_name: 'older' }),
      line({ timestamp: '2026-09-26T08:00:00Z', tool_name: 'one' }),
    ].join(''));
    await put(second.path, [
      line({ timestamp: '2026-09-26T09:00:00Z', tool_name: 'two' }),
      line({ timestamp: '2026-09-26T10:00:00Z', tool_name: 'three' }),
    ].join(''));
    const original = await readFile(source.path, 'utf8');
    const page = await reader.read([source, second]);
    expect(page.total).toBe(3);
    expect(page.items.map(item => item.toolName)).toEqual(['three', 'two', 'one']);
    expect(page.storage.cachedRecords).toBe(3);
    expect(page.storage.truncated).toBe(true);
    const smaller = await reader.read([source, second], {}, { maxCacheRecords: 2, retentionDays: 1 });
    expect(smaller.total).toBe(2);
    expect(smaller.storage).toMatchObject({ cachedRecords: 2, cacheLimit: 2, retentionDays: 1 });
    vi.spyOn(Date, 'now').mockReturnValue(now + 2 * 86400000);
    expect((await reader.read([source, second], {}, { maxCacheRecords: 2, retentionDays: 1 })).total).toBe(0);
    expect(await readFile(source.path, 'utf8')).toBe(original);
  });

  it('rejects invalid calendar dates, missing timezones, non-objects, deep JSON and malformed lines', async () => {
    const { source, reader } = await fixture();
    const invalid = [
      '{"password":"fixture-parser-secret", broken}\n', '[]\n', 'null\n',
      line({ timestamp: '2026-02-30T10:00:00Z' }), line({ timestamp: 'not-a-date' }),
      line({ timestamp: '2026-09-26T10:00:00' }), line({ timestamp: '2126-09-26T10:00:00Z' }),
      line({ timestamp: '2026-09-26T24:00:00Z' }), line({ timestamp: '2026-09-26T10:00:00+25:00' }),
      `{"nested":${'['.repeat(80)}0${']'.repeat(80)}}\n`,
    ];
    await put(source.path, invalid.join('') + '\n' + line({ timestamp: '2026-09-26T11:00:00.123456+01:00' }));
    const page = await reader.read([source]);
    expect(page.total).toBe(1);
    expect(page.items[0].timestamp).toBe('2026-09-26T10:00:00.123Z');
    expect(page.storage.invalidLines).toBe(invalid.length);
    expect(JSON.stringify(page)).not.toContain('fixture-parser-secret');
    expect((await reader.read([source])).storage.invalidLines).toBe(invalid.length);
  });

  it('exposes hook observations for the completed scope before action/client/search/page filters', async () => {
    const { source, reader } = await fixture({}, true);
    const global = { ...source, projectId: null };
    await put(source.path, [
      line({ timestamp: '2026-09-26T09:00:00Z', client: 'kiro', project_id: 'chosen',
        origin: 'agent-ops-hook', event_type: 'PreToolUse' }),
      line({ timestamp: '2026-09-26T10:00:00Z', client: 'codex', project_id: 'chosen',
        origin: 'agent-ops-hook', event_type: 'PreToolUse' }),
      line({ timestamp: '2026-09-26T11:00:00Z', client: 'codex', project_id: 'other',
        origin: 'agent-ops-hook', event_type: 'PostToolUse' }),
      line({ timestamp: '2026-09-26T11:30:00Z', client: 'kiro', project_id: 'chosen',
        origin: 'agent-ops-test', event_type: 'check' }),
      line({ timestamp: '2026-09-26T11:30:00Z', client: 'claude-code', project_id: 'chosen' }),
    ].join(''));
    const page = await reader.read([global], { projectId: 'chosen', client: 'codex', action: 'allow', q: 'absent', offset: 20, limit: 1 });
    expect(page.total).toBe(0);
    expect(page.observed).toEqual({ kiro: '2026-09-26T09:00:00.000Z', codex: '2026-09-26T10:00:00.000Z' });
    expect(reader.observations()).toEqual({ kiro: '2026-09-26T09:00:00.000Z', codex: '2026-09-26T10:00:00.000Z' });
    const observation = reader.observations();
    observation.kiro = 'mutated';
    expect(reader.observations().kiro).toBe('2026-09-26T09:00:00.000Z');
    await reader.read([global], { projectId: 'other', limit: 1 });
    expect(reader.observations()).toEqual({ codex: '2026-09-26T11:00:00.000Z' });
  });

  it('returns independent observation snapshots for overlapping reads of different project scopes', async () => {
    const { source, reader } = await fixture({}, true);
    const other = { ...source, id: 'other-scope', path: join(source.root, 'other.jsonl'), projectId: 'other-project' };
    await put(source.path, line({
      timestamp: '2026-09-26T09:00:00Z', origin: 'agent-ops-hook', event_type: 'PreToolUse', client: 'kiro',
    }));
    await put(other.path, line({
      timestamp: '2026-09-26T11:00:00Z', origin: 'agent-ops-hook', event_type: 'PostToolUse', client: 'codex',
    }));
    const [first, second] = await Promise.all([
      reader.read([source], { projectId: source.projectId!, limit: 1 }),
      reader.read([other], { projectId: other.projectId, limit: 1 }),
    ]);
    expect(first.observed).toEqual({ kiro: '2026-09-26T09:00:00.000Z' });
    expect(second.observed).toEqual({ codex: '2026-09-26T11:00:00.000Z' });
    expect(reader.observations()).toEqual({ codex: '2026-09-26T11:00:00.000Z' });
    second.observed!.codex = 'caller-mutated';
    expect(reader.observations()).toEqual({ codex: '2026-09-26T11:00:00.000Z' });
    expect(first.observed).toEqual({ kiro: '2026-09-26T09:00:00.000Z' });
    reader.clear();
    expect(first.observed).toEqual({ kiro: '2026-09-26T09:00:00.000Z' });
    expect(reader.observations()).toEqual({});
  });

  it('removes hook observation evidence when its retained records are evicted or cleared', async () => {
    const { source, reader } = await fixture({}, true);
    await put(source.path, line({ timestamp: '2026-09-26T09:00:00Z', origin: 'agent-ops-hook', client: 'kiro', event_type: 'PreToolUse' }));
    await reader.read([source]);
    expect(reader.observations().kiro).toBe('2026-09-26T09:00:00.000Z');
    await appendFile(source.path, line({ origin: 'agent-ops-test', client: 'codex', event_type: 'check' }));
    await reader.read([source], {}, { maxCacheRecords: 1, retentionDays: 30 });
    expect(reader.observations()).toEqual({});
    reader.clear();
    expect(reader.observations()).toEqual({});
  });
});

describe('bounded incremental JSONL ingestion', () => {
  it('verifies retained and pending bytes before completing appended UTF-8 partial lines once', async () => {
    const { source, reader } = await fixture();
    const first = line({ tool_name: 'first' });
    const pending = Buffer.from(line({ tool_name: '한글-second' }));
    const boundary = pending.indexOf(Buffer.from('한')) + 1;
    await put(source.path, Buffer.concat([Buffer.from(first), pending.subarray(0, boundary)]));
    const initial = await reader.read([source]);
    expect(initial.total).toBe(1);
    expect(initial.storage.invalidLines).toBe(0);
    expect((await reader.read([source])).storage.bytesRead).toBe(0);
    const appended = Buffer.concat([pending.subarray(boundary), Buffer.from(line({ tool_name: 'third' }))]);
    await appendFile(source.path, appended);
    const next = await reader.read([source]);
    expect(next.total).toBe(3);
    expect(new Set(next.items.map(item => item.id)).size).toBe(3);
    expect(next.items.some(item => item.toolName === '한글-second')).toBe(true);
    expect(next.storage.bytesRead).toBeGreaterThanOrEqual(initial.storage.sourceBytes + appended.length);
    expect(next.storage.bytesRead).toBeLessThanOrEqual(initial.storage.sourceBytes + appended.length + 4);
    expect(next.storage.invalidLines).toBe(0);
    expect((await reader.read([source])).total).toBe(3);
  });

  it('tails a large initial source within 1 MiB and never reports unobserved file totals', async () => {
    const { source, reader } = await fixture();
    const old = line({ tool_name: 'unobserved', padding: 'x'.repeat(15000) });
    const tail = line({ tool_name: 'latest-observed' });
    await put(source.path, old.repeat(200) + tail);
    const size = (await stat(source.path)).size;
    const page = await reader.read([source]);
    expect(page.storage.sourceBytes).toBe(size);
    expect(page.storage.bytesRead).toBeLessThanOrEqual(1024 * 1024);
    expect(page.storage.truncated).toBe(true);
    expect(page.total).toBeLessThan(201);
    expect(page.total).toBe(page.storage.cachedRecords);
    expect(page.items.some(item => item.toolName === 'latest-observed')).toBe(true);
    expect(page.storage.invalidLines).toBe(0);
    expect((await reader.read([source])).storage.bytesRead).toBe(0);
  });

  it('reports actual positioned-read bytes including retained-range verification within the global budget', async () => {
    const { source, reader } = await fixture({ maxReadBytes: 8192 });
    await put(source.path, line({ padding: 'x'.repeat(4000) }).repeat(300) + line());
    const probe = await open(source.path, 'r');
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const spy = vi.spyOn(prototype, 'read');
    const first = await reader.read([source]);
    const calls: unknown[][] = spy.mock.calls;
    const results = await Promise.all(spy.mock.results.map(result => result.value));
    expect(first.storage.bytesRead).toBe(results.reduce((sum, result) => sum + result.bytesRead, 0));
    expect(first.storage.bytesRead).toBeLessThanOrEqual(8192);
    expect(calls.every(args => Number(args[3]) >= first.storage.sourceBytes - 8192)).toBe(true);
    spy.mockClear();
    await appendFile(source.path, line({ tool_name: 'appended' }));
    const appended = await reader.read([source]);
    const incremental = await Promise.all(spy.mock.results.map(result => result.value));
    expect(appended.storage.bytesRead).toBe(incremental.reduce((sum, result) => sum + result.bytesRead, 0));
    expect(appended.storage.bytesRead).toBeLessThanOrEqual(8192);
    const verificationCalls: unknown[][] = spy.mock.calls;
    expect(verificationCalls.some(args => Number(args[3]) < first.storage.sourceBytes && Number(args[2]) > 1000)).toBe(true);
    expect(verificationCalls.every(args => Number(args[3]) >= first.storage.sourceBytes - 8193)).toBe(true);
    expect(appended.items.some(item => item.toolName === 'appended')).toBe(true);
  });

  it('shares the read budget across sources and makes progress on deferred files', async () => {
    const { source, reader } = await fixture({ maxReadBytes: 4096 });
    const second = { ...source, id: 'second', path: join(source.root, 'second.jsonl') };
    await put(source.path, line({ tool_name: 'first-source' }).repeat(40));
    await put(second.path, line({ tool_name: 'second-source' }).repeat(40));
    let page = await reader.read([source, second]);
    expect(page.storage.bytesRead).toBeLessThanOrEqual(4096);
    expect(page.storage.sourceBytes).toBe((await stat(source.path)).size + (await stat(second.path)).size);
    for (let count = 0; count < 3 && !page.items.some(item => item.toolName === 'second-source'); count++) {
      page = await reader.read([source, second]);
      expect(page.storage.bytesRead).toBeLessThanOrEqual(4096);
    }
    expect(page.items.some(item => item.toolName === 'second-source')).toBe(true);
    expect(page.storage.truncated).toBe(true);
  });

  it('does not starve another source when the first source is continuously appended', async () => {
    const { source, reader } = await fixture({ maxReadBytes: 2048 });
    const second = { ...source, id: 'second', path: join(source.root, 'second.jsonl') };
    const busy = line({ tool_name: 'busy-source' }).repeat(20);
    await put(source.path, busy);
    await put(second.path, line({ tool_name: 'quiet-source' }));
    await reader.read([source, second]);
    await appendFile(source.path, busy);
    const next = await reader.read([source, second]);
    expect(next.items.some(item => item.toolName === 'quiet-source')).toBe(true);
    expect(next.storage.bytesRead).toBeLessThanOrEqual(2048);
  });

  it('keeps append cursors advancing when the configured budget cannot verify a retained record', async () => {
    const { source, reader } = await fixture({ maxReadBytes: 128 });
    await put(source.path, '');
    await reader.read([source]);
    for (const name of ['first-small-budget', 'second-small-budget']) {
      await appendFile(source.path, line({ tool_name: name }));
      let page = await reader.read([source]);
      for (let count = 0; count < 8 && !page.items.some(item => item.toolName === name); count++) {
        expect(page.storage.bytesRead).toBeLessThanOrEqual(128);
        page = await reader.read([source]);
      }
      expect(page.items.some(item => item.toolName === name)).toBe(true);
      expect(page.storage.bytesRead).toBeLessThanOrEqual(128);
    }
  });

  it('drains bounded appended chunks and discards a huge line once without retaining its content', async () => {
    const { source, reader } = await fixture({ maxReadBytes: 16000 });
    await put(source.path, line({ tool_name: 'first' }));
    await reader.read([source]);
    const large = JSON.stringify(record({ permission: { action: 'deny', reason: 'private-huge-value'.repeat(8000) } }));
    await appendFile(source.path, large + '\n' + line({ tool_name: 'after-huge' }));
    let page = await reader.read([source]);
    for (let count = 0; count < 15 && !page.items.some(item => item.toolName === 'after-huge'); count++) {
      expect(page.storage.bytesRead).toBeLessThanOrEqual(16000);
      page = await reader.read([source]);
    }
    expect(page.items.map(item => item.toolName)).toEqual(expect.arrayContaining(['first', 'after-huge']));
    expect(page.storage.invalidLines).toBe(1);
    expect(page.storage.truncated).toBe(true);
    expect(JSON.stringify(page)).not.toContain('private-huge-value');
  });

  it('resets stale records after inode rotation, truncation and same-size rewrites', async () => {
    const { source, reader } = await fixture();
    await put(source.path, line({ tool_name: 'before' }));
    await reader.read([source]);
    await rename(source.path, `${source.path}.1`);
    await put(source.path, line({ tool_name: 'rotate' }));
    expect((await reader.read([source])).items.map(item => item.toolName)).toEqual(['rotate']);
    await truncate(source.path, 0);
    expect((await reader.read([source])).total).toBe(0);
    await appendFile(source.path, line({ tool_name: 'before' }));
    await reader.read([source]);
    const previous = await stat(source.path);
    await writeFile(source.path, line({ tool_name: 'rework' }));
    await utimes(source.path, previous.atime, new Date(previous.mtimeMs + 5000));
    expect((await reader.read([source])).items.map(item => item.toolName)).toEqual(['rework']);
    expect(await readFile(`${source.path}.1`, 'utf8')).toBe(line({ tool_name: 'before' }));
  });

  it('detects rewriting a larger file instead of treating it as a plain append', async () => {
    const { source, reader } = await fixture();
    await put(source.path, line({ tool_name: 'before' }));
    await reader.read([source]);
    await writeFile(source.path, line({ tool_name: 'replaced' }) + line({ tool_name: 'new' }));
    const page = await reader.read([source]);
    expect(page.items.map(item => item.toolName)).toEqual(expect.arrayContaining(['replaced', 'new']));
    expect(page.items.some(item => item.toolName === 'before')).toBe(false);
    expect(page.total).toBe(2);
  });

  it('removes an equal-length middle rewrite even when the inode and sampled ends are unchanged', async () => {
    const { source, reader } = await fixture();
    const head = line({ tool_name: 'unchanged-head', padding: 'a'.repeat(800) });
    const middle = line({ tool_name: 'OLD-MIDDLE' });
    const replacement = line({ tool_name: 'NEW-MIDDLE' });
    const tail = line({ tool_name: 'unchanged-tail', padding: 'z'.repeat(800) });
    expect(Buffer.byteLength(middle)).toBe(Buffer.byteLength(replacement));
    await put(source.path, head + middle + tail);
    const first = await reader.read([source]);
    expect(first.total).toBe(3);
    const before = await stat(source.path);
    await writeFile(source.path, head + replacement + tail + line({ tool_name: 'appended' }));
    expect((await stat(source.path)).ino).toBe(before.ino);
    const page = await reader.read([source]);
    expect(page.items.some(item => item.toolName === 'OLD-MIDDLE')).toBe(false);
    expect(page.items.map(item => item.toolName)).toEqual(expect.arrayContaining(['NEW-MIDDLE', 'appended']));
    expect(page.total).toBe(4);
    expect(page.storage.bytesRead).toBeLessThanOrEqual(1024 * 1024);
    expect((await reader.read([source])).items.some(item => item.toolName === 'OLD-MIDDLE')).toBe(false);
  });

  it('excludes unverified middle records when a grown source exceeds the verification budget', async () => {
    const { source, reader } = await fixture({ maxReadBytes: 2048 });
    await put(source.path, '');
    await reader.read([source]);
    const head = line({ tool_name: 'unchanged-head', padding: 'a'.repeat(1000) });
    const middle = line({ tool_name: 'OLD-MIDDLE', padding: 'm'.repeat(4000) });
    const replacement = line({ tool_name: 'NEW-MIDDLE', padding: 'm'.repeat(4000) });
    const tail = line({ tool_name: 'unchanged-tail', padding: 'z'.repeat(1000) });
    await appendFile(source.path, head + middle + tail);
    for (let count = 0; count < 5; count++) await reader.read([source]);
    expect((await reader.read([source])).items.some(item => item.toolName === 'OLD-MIDDLE')).toBe(true);
    await writeFile(source.path, head + replacement + tail + line({ tool_name: 'appended' }));
    for (let count = 0; count < 5; count++) {
      const page = await reader.read([source]);
      expect(page.items.some(item => item.toolName === 'OLD-MIDDLE')).toBe(false);
      expect(page.storage.bytesRead).toBeLessThanOrEqual(2048);
      expect(page.storage.truncated).toBe(true);
      expect(page.storage.cachedRecords).toBe(page.total);
    }
  });

  it('does not join a stale partial line to appended bytes after the partial line is rewritten', async () => {
    const { source, reader } = await fixture();
    const head = line({ tool_name: 'unchanged-head', padding: 'a'.repeat(1000) });
    const old = line({ tool_name: 'OLD-PENDING' });
    const replacement = line({ tool_name: 'NEW-PENDING' });
    await put(source.path, head + old.slice(0, -30));
    expect((await reader.read([source])).total).toBe(1);
    await writeFile(source.path, head + replacement);
    const page = await reader.read([source]);
    expect(page.items.map(item => item.toolName)).toEqual(expect.arrayContaining(['unchanged-head', 'NEW-PENDING']));
    expect(page.items.some(item => item.toolName === 'OLD-PENDING')).toBe(false);
    expect(page.storage.invalidLines).toBe(0);
  });

  it('verifies the newline before a retained record even when its preceding record was evicted', async () => {
    const { source, reader } = await fixture({ maxCacheRecords: 1 });
    const head = line({ timestamp: '2026-09-26T08:00:00Z', padding: 'a'.repeat(1000) });
    const tail = line({ timestamp: '2026-09-26T11:00:00Z', tool_name: 'no-longer-a-line' });
    await put(source.path, head + tail);
    expect((await reader.read([source])).items[0].toolName).toBe('no-longer-a-line');
    await writeFile(source.path, head.slice(0, -1) + ' ' + tail + line({
      timestamp: '2026-09-26T09:00:00Z', tool_name: 'only-valid-record',
    }));
    const page = await reader.read([source]);
    expect(page.items.map(item => item.toolName)).toEqual(['only-valid-record']);
    expect(page.storage.invalidLines).toBe(1);
  });

  it('drops unavailable or unselected sources, re-reads restored files, and clears owned memory', async () => {
    const { source, reader } = await fixture();
    await put(source.path, line());
    await reader.read([source]);
    await rm(source.path);
    const missing = await reader.read([source]);
    expect(missing.total).toBe(0);
    expect(missing.storage).toMatchObject({ cachedRecords: 0, sourceBytes: 0, bytesRead: 0 });
    await put(source.path, line({ tool_name: 'restored' }));
    expect((await reader.read([source])).total).toBe(1);
    const empty = await reader.read([]);
    expect(empty.storage.cachedRecords).toBe(0);
    expect(empty.sources).toEqual([]);
    await reader.read([source]);
    reader.clear();
    const afterClear = await reader.read([source]);
    expect(afterClear.total).toBe(1);
    expect(afterClear.storage.bytesRead).toBe(Buffer.byteLength(line({ tool_name: 'restored' })));
  });

  it('serializes overlapping reads so appends do not duplicate cached records', async () => {
    const { source, reader } = await fixture();
    await put(source.path, line());
    await Promise.all([reader.read([source]), reader.read([source])]);
    await appendFile(source.path, line({ tool_name: 'second' }));
    const pages = await Promise.all([reader.read([source]), reader.read([source]), reader.read([source])]);
    expect(pages.every(page => page.total === 2 && page.storage.cachedRecords === 2)).toBe(true);
    expect(new Set(pages.at(-1)!.items.map(item => item.id)).size).toBe(2);
  });

  it('invalidates reads enqueued before clear without restoring their evidence or settings', async () => {
    const { source, reader } = await fixture({}, true);
    await put(source.path, [
      line({ origin: 'agent-ops-hook', client: 'kiro', event_type: 'PreToolUse', timestamp: '2026-09-20T10:00:00Z' }),
      line({ origin: 'agent-ops-test', client: 'codex', event_type: 'check' }),
    ].join(''));
    const first = reader.read([source], {}, { maxCacheRecords: 100, retentionDays: 30 });
    const queued = reader.read([source], {}, { maxCacheRecords: 100, retentionDays: 30 });
    reader.clear();
    const invalidated = await Promise.allSettled([first, queued]);
    expect(invalidated.map(result => result.status)).toEqual(['rejected', 'rejected']);
    for (const result of invalidated) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ statusCode: 409 });
    }
    expect(reader.observations()).toEqual({});
    const fresh = await reader.read([source], {}, { maxCacheRecords: 1, retentionDays: 1 });
    expect(fresh.total).toBe(1);
    expect(fresh.storage).toMatchObject({ cachedRecords: 1, cacheLimit: 1, retentionDays: 1 });
    expect(fresh.storage.bytesRead).toBe((await stat(source.path)).size);
    expect(fresh.observed).toEqual({});
  });

  it('cancels active and queued old epochs while allowing a newly enqueued settings scope', async () => {
    const { source, reader } = await fixture({}, true);
    await put(source.path, [
      line({ origin: 'agent-ops-hook', client: 'kiro', event_type: 'PreToolUse', timestamp: '2026-09-20T10:00:00Z' }),
      line({ origin: 'agent-ops-test', client: 'codex', event_type: 'check' }),
    ].join(''));
    const probe = await open(source.path, 'r');
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    const originalRead = prototype.read;
    await probe.close();
    let signal!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { signal = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(prototype, 'read').mockImplementationOnce(async function(this: FileHandle, ...args) {
      signal();
      await paused;
      return Reflect.apply(originalRead, this, args);
    });
    const active = reader.read([source], {}, { maxCacheRecords: 100, retentionDays: 30 });
    await started;
    const queued = reader.read([source], {}, { maxCacheRecords: 100, retentionDays: 30 });
    reader.clear();
    const fresh = reader.read([source], {}, { maxCacheRecords: 1, retentionDays: 1 });
    release();
    const results = await Promise.allSettled([active, queued, fresh]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
    for (const result of results.slice(0, 2)) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ statusCode: 409 });
    }
    const page = (results[2] as PromiseFulfilledResult<Awaited<typeof fresh>>).value;
    expect(page.storage).toMatchObject({ cachedRecords: 1, cacheLimit: 1, retentionDays: 1 });
    expect(page.storage.bytesRead).toBe((await stat(source.path)).size);
    expect(page.observed).toEqual({});
    expect(reader.observations()).toEqual({});
  });

  it('does not expose mutable references into the retained cache', async () => {
    const { source, reader } = await fixture();
    await put(source.path, line());
    const page = await reader.read([source]);
    page.items[0].reason = 'client-mutated';
    page.sources[0].path = 'client-mutated';
    const next = await reader.read([source]);
    expect(next.items[0].reason).toBe('Destructive operation');
    expect(next.sources[0].path).toBe(source.path);
  });
});

describe('audit file owner boundaries', () => {
  it.each(['lexical', 'file-symlink', 'parent-symlink', 'hardlink', 'directory', 'fifo', 'sensitive', 'deep'])(
    'rejects %s paths without reading or returning file data', async kind => {
      const { source, reader, root } = await fixture();
      const other = await mkdtemp(join(tmpdir(), 'agent-ops-harness-outside-'));
      temporary.push(other);
      const outside = join(other, 'outside.jsonl');
      await put(outside, line({ tool_name: 'outside-private-fixture' }));
      await mkdir(dirname(source.path), { recursive: true });
      let candidate = source;
      if (kind === 'lexical') candidate = { ...source, path: outside };
      if (kind === 'file-symlink') await symlink(outside, source.path);
      if (kind === 'parent-symlink') {
        await rm(dirname(source.path), { recursive: true });
        await symlink(other, dirname(source.path));
        await put(join(other, 'audit.jsonl'), line({ tool_name: 'outside-private-fixture' }));
      }
      if (kind === 'hardlink') await link(outside, source.path);
      if (kind === 'directory') await mkdir(source.path);
      if (kind === 'fifo') await promisify(execFile)('mkfifo', [source.path]);
      if (kind === 'sensitive') {
        candidate = { ...source, path: join(root, '.env') };
        await put(candidate.path, line({ tool_name: 'outside-private-fixture' }));
      }
      if (kind === 'deep') {
        candidate = { ...source, path: join(root, 'a/'.repeat(20), 'audit.jsonl') };
        await put(candidate.path, line({ tool_name: 'outside-private-fixture' }));
      }
      const page = await reader.read([candidate]);
      expect(page.total).toBe(0);
      expect(page.storage.bytesRead).toBe(0);
      expect(page.storage.sourceBytes).toBe(0);
      expect(page.warnings.length).toBeGreaterThan(0);
      expect(JSON.stringify(page)).not.toContain('outside-private-fixture');
      expect(await readFile(outside, 'utf8')).toBe(line({ tool_name: 'outside-private-fixture' }));
    },
  );

  it('does not trust a symlink into another supplied owner or an ID rebound to an unsafe file', async () => {
    const { source, reader } = await fixture();
    const secondRoot = await mkdtemp(join(tmpdir(), 'agent-ops-harness-other-owner-'));
    temporary.push(secondRoot);
    const second = { ...source, root: secondRoot, path: join(secondRoot, 'audit.jsonl'), id: 'second' };
    await put(second.path, line({ tool_name: 'other-owner' }));
    await mkdir(dirname(source.path), { recursive: true });
    await symlink(second.path, source.path);
    const page = await reader.read([source, second]);
    expect(page.items.map(item => item.sourceId)).toEqual(['second']);
    expect((await reader.read([{ ...second, path: join(secondRoot, '.env') }])).total).toBe(0);
  });
});
