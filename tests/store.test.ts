import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { redact, exportSession, buildHandoff } from '../server/privacy.js';
import { computeAnalytics } from '../server/analytics.js';
import { emptyUsage, type ImportedSession } from '../shared/types.js';

const dirs: string[] = [];
const stores: Store[] = [];
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-test-'));
  dirs.push(dir);
  const store = new Store(join(dir, 'test.sqlite'));
  stores.push(store);
  return store;
}
const sample = (id = 'codex:one'): ImportedSession => ({
  id, nativeId: id.split(':')[1], agent: 'codex', title: 'Trace cache invalidation',
  projectPath: '/tmp/example', projectName: 'example', model: 'configured-model',
  startedAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:03:00.000Z',
  status: 'completed', messageCount: 2, toolCallCount: 1, sourcePath: '/tmp/native.jsonl',
  usage: { ...emptyUsage(), inputTokens: 1200, outputTokens: 300 },
  messages: [
    { id: 'u1', role: 'user', content: '배포 실패 원인을 조사해 주세요', timestamp: '2026-09-20T10:00:00.000Z' },
    { id: 'a1', role: 'assistant', toolName: 'read_file', content: 'Cache namespace is missing', timestamp: '2026-09-20T10:01:00.000Z' },
  ],
});
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe('durable history', () => {
  it('refreshes changed messages without duplicating sessions or losing notes', () => {
    const store = database();
    store.upsertSession(sample());
    store.patchSession('codex:one', { bookmarked: true, tags: ['release'], note: 'follow up', title: 'Cache incident' });
    const updated = sample();
    updated.messages.push({ id: 'a2', role: 'assistant', content: 'Root cause fixed', timestamp: '2026-09-20T10:03:00.000Z' });
    updated.messageCount = 3;
    store.upsertSession(updated);
    const result = store.getSession('codex:one')!;
    expect(result).toMatchObject({ title: 'Cache incident', bookmarked: true, tags: ['release'], note: 'follow up' });
    expect(result.messages).toHaveLength(3);
    expect(store.listSessions({}).total).toBe(1);
    expect(store.listProjects()[0].executionEnabled).toBe(false);
  });
  it('searches transcript substrings in Korean and English with combined filters', () => {
    const store = database();
    store.upsertSession(sample());
    store.upsertSession({ ...sample('claude:two'), agent: 'claude', title: 'Other', messages: [] });
    store.patchSession('codex:one', { bookmarked: true, tags: ['release'] });
    expect(store.listSessions({ q: '실패 원인', agent: 'codex', bookmarked: true, tag: 'release' }).items.map((s) => s.id)).toEqual(['codex:one']);
    expect(store.listSessions({ q: 'namespace', limit: 1 }).total).toBe(1);
    expect(store.listSessions({ q: "' OR 1=1 --" }).total).toBe(0);
    expect(store.listSessions({ q: '%' }).total).toBe(0);
    expect(store.listSessions({ since: '2026-09-21' }).total).toBe(0);
  });
  it('searches literal punctuation and short Korean fragments without treating them as operators', () => {
    const store = database();
    const session = sample();
    session.messages[0].content = 'Keep foo_bar "OR" 🙂한글수정 at 100% and literal [x]?*';
    store.upsertSession(session);
    for (const q of ['FOO_BAR', '"OR"', '🙂한글', '글수', '100%', '%', '[x]', '?', '*']) {
      expect(store.listSessions({ q }).items.map((item) => item.id)).toEqual(['codex:one']);
    }
    expect(store.listSessions({ q: 'foo OR nope' }).total).toBe(0);
    expect(store.listSessions({ q: '\0' }).total).toBe(0);
  });
  it('paginates without changing total and retains state after reopen', () => {
    const store = database();
    store.upsertSession(sample());
    store.upsertSession({ ...sample('codex:two'), updatedAt: '2026-09-21T10:00:00.000Z' });
    expect(store.listSessions({ limit: 1, offset: 1 }).items[0].id).toBe('codex:one');
    expect(store.listSessions({ limit: 1, offset: 1 }).total).toBe(2);
    const file = store.filename;
    store.close();
    const reopened = new Store(file);
    stores.push(reopened);
    expect(reopened.getSession('codex:one')!.messages[0].content).toContain('배포');
  });
  it('treats equivalent UTC offsets and timestamp precisions as the same filter boundary', () => {
    const store = database();
    store.upsertSession(sample());
    expect(store.listSessions({ since: '2026-09-20T10:03:00Z' }).total).toBe(1);
    expect(store.listSessions({ since: '2026-09-20T19:03:00+09:00' }).total).toBe(1);
    expect(store.listSessions({ until: '2026-09-20T12:00:00+02:00' }).total).toBe(1);
  });
  it('rebuilds old search entries before refreshing one session in a migrated database', () => {
    const store = database();
    store.upsertSession(sample());
    const other = sample('claude:two');
    other.title = 'Uniquely identifiable second session';
    other.messages = [];
    store.upsertSession(other);
    // Version 1 assigned FTS row IDs independently from session rows.
    store.db.exec('UPDATE session_search SET rowid=rowid+100; PRAGMA user_version=1;');
    const file = store.filename;
    store.close();
    const migrated = new Store(file);
    stores.push(migrated);
    migrated.patchSession('codex:one', { note: 'after upgrade' });
    expect(migrated.listSessions({ q: 'Uniquely identifiable' }).items.map((item) => item.id)).toEqual(['claude:two']);
    expect(migrated.listSessions({ q: 'after upgrade' }).items.map((item) => item.id)).toEqual(['codex:one']);
  });
  it('rejects a future schema before changing the existing database', () => {
    const store = database();
    store.upsertSession(sample());
    store.db.pragma('journal_mode = DELETE');
    store.db.pragma('user_version = 999');
    const file = store.filename;
    store.close();
    const digest = () => createHash('sha256').update(readFileSync(file)).digest('hex');
    const before = digest();
    expect(() => new Store(file)).toThrow(/newer/);
    expect(digest()).toBe(before);
  });
  it('analytics counts known usage separately from missing values', () => {
    const store = database();
    store.upsertSession(sample());
    store.upsertSession({ ...sample('kiro:two'), agent: 'kiro', usage: emptyUsage() });
    const result = computeAnalytics(store.allSessions(), [], store.toolCounts(), new Date('2026-09-24T12:00:00Z'));
    expect(result).toMatchObject({ totalSessions: 2, totalTokens: 1500, knownTokenSessions: 1, recordedCostUsd: 0, knownCostSessions: 0 });
    expect(result.agents.find((agent) => agent.agent === 'kiro')).toMatchObject({ sessions: 1, tokens: 0, knownTokenSessions: 0 });
    expect(result.agents.find((agent) => agent.agent === 'codex')).toMatchObject({ sessions: 1, tokens: 1500, knownTokenSessions: 1 });
    expect(result.tools).toContainEqual({ name: 'read_file', count: 2 });
    expect(result.daily.find((d) => d.date === '2026-09-20')).toMatchObject({ sessions: 2, codex: 1, kiro: 1, tokens: 1500 });
  });
  it('counts a tool call once when the result repeats the tool name', () => {
    const store = database();
    const session = sample();
    session.messages.push({ id: 'result1', role: 'tool', toolName: 'read_file', content: 'file contents', timestamp: '2026-09-20T10:01:30.000Z' });
    store.upsertSession(session);
    expect(store.toolCounts()).toEqual([{ name: 'read_file', count: 1 }]);
  });
  it('pages large conversations, finds text beyond previews, and loads a full message on demand', () => {
    const store = database();
    const session = sample();
    session.messages = Array.from({ length: 123 }, (_, i) => ({
      id: `m${i}`, role: i % 2 ? 'assistant' as const : 'user' as const,
      content: `Recorded message ${i}`, timestamp: session.startedAt,
    }));
    session.messages[75].content = 'prefix '.repeat(6000) + 'needle-match' + ' suffix'.repeat(4000);
    store.upsertSession(session);
    expect(store.getSession(session.id, false)?.messages).toEqual([]);
    expect(store.getSession(session.id)?.messages).toHaveLength(123);
    const page = store.listMessages(session.id, { offset: 100, limit: 50 });
    expect(page.items).toHaveLength(23);
    expect(page.items[0].id).toBe('m100');
    expect(page.total).toBe(123);
    expect(page.roleCounts).toEqual({ all: 123, user: 62, assistant: 61, tool: 0, system: 0 });
    const found = store.listMessages(session.id, { q: 'needle-match', role: 'assistant' });
    expect(found.total).toBe(1);
    expect(found.items[0]).toMatchObject({ id: 'm75', truncated: true });
    expect(found.items[0].content.length).toBeLessThanOrEqual(16000);
    expect(found.items[0].content).toContain('needle-match');
    expect(store.getMessage(session.id, 'm75')!.content).toBe(session.messages[75].content);
    expect(store.getMessage('other-session', 'm75')).toBeNull();
  });
});

describe('safe sharing', () => {
  it('redacts key assignments, authorization values and private key blocks', () => {
    const text = 'OPENAI_API_KEY=sk-testabcdefghijklmnop\nAuthorization: Bearer abc.def.secret\naws_secret_access_key = superSecretValue123\npassword: "dont-share"\n-----BEGIN PRIVATE KEY-----\naGVsbG8=\n-----END PRIVATE KEY-----';
    const output = redact(text);
    expect(output).not.toMatch(/sk-test|abc\.def|superSecret|dont-share|aGVsbG8/);
    expect(output).toContain('[REDACTED]');
  });
  it('escapes exported HTML and builds editable redacted handoffs without running anything', () => {
    const store = database();
    const session = sample();
    session.messages[0].content = '<script>alert(1)</script> token=private-token-value';
    store.upsertSession(session);
    const detail = store.getSession(session.id)!;
    const exported = exportSession(detail, 'html');
    expect(exported.body).not.toContain('<script>');
    expect(exported.body).toContain('&lt;script&gt;');
    expect(exported.body).not.toContain('private-token-value');
    const handoff = buildHandoff(detail, 'kiro', 'Check the fix');
    expect(handoff).toMatchObject({ targetAgent: 'kiro', sourceSessionId: session.id });
    expect(handoff.prompt).toContain('Check the fix');
    expect(handoff.prompt).not.toContain('private-token-value');
  });
  it('redacts before shortening a handoff and also redacts its returned title', () => {
    const store = database();
    const session = sample();
    session.title = 'token=private-title-secret';
    session.messages[0].content = 'context '.repeat(490) + '\n-----BEGIN PRIVATE KEY-----\n' + 'PRIVATE_KEY_MATERIAL'.repeat(200) + '\n-----END PRIVATE KEY-----';
    store.upsertSession(session);
    const handoff = buildHandoff(store.getSession(session.id)!, 'kiro');
    expect(handoff.prompt).not.toContain('PRIVATE_KEY_MATERIAL');
    expect(handoff.sessionTitle).not.toContain('private-title-secret');
  });
});
