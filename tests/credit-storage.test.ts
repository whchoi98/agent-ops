import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { SyncService } from '../server/sync.js';
import { exportSession } from '../server/privacy.js';
import { emptyUsage, type Agent, type ImportedSession } from '../shared/types.js';

const stores: Store[] = [];
const directories: string[] = [];
function store() {
  const value = new Store(':memory:');
  stores.push(value);
  return value;
}
function sample(id: string, credits?: number | null, agent: Agent = 'kiro'): ImportedSession {
  return {
    id, nativeId: id, agent, title: 'Native title', projectPath: '/fixture/project',
    projectName: 'Fixture project', model: 'fixture-model', startedAt: '2026-09-24T00:00:00Z',
    updatedAt: '2026-09-24T01:00:00Z', status: 'completed', messageCount: 1, toolCallCount: 0,
    sourcePath: '/fixture/history', usage: { ...emptyUsage(), credits },
    messages: [{ id: 'u1', role: 'user', content: 'searchable original body', timestamp: '2026-09-24T00:00:00Z' }],
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  stores.splice(0).forEach(value => value.close());
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('credit storage, sorting and exports', () => {
  it('sorts recorded Kiro credits numerically with zero before unknown or other-provider values', () => {
    const db = store();
    for (const value of [
      { ...sample('unknown'), updatedAt: '2026-09-25T12:00:00Z' },
      sample('zero', 0), sample('smaller', 0.125), sample('larger', 1.25),
      sample('other-provider', 99, 'codex'), sample('negative', -1),
      sample('invalid-string', '12' as unknown as number),
    ]) db.upsertSession(value);
    expect(db.listSessions({ sort: 'credits' }).items.slice(0, 3).map(value => value.id))
      .toEqual(['larger', 'smaller', 'zero']);
  });

  it('updates credit metadata without loading or rewriting the existing search document', () => {
    const db = store();
    const original = sample('metadata', 0.25);
    db.upsertSession(original);
    db.patchSession(original.id, { title: 'Pinned title', note: 'Keep this note', tags: ['keep'], bookmarked: true });
    const before = db.db.prepare('SELECT * FROM session_search_documents WHERE session_id=?').get(original.id);
    const rows = db.db.prepare('SELECT rowid,data FROM messages WHERE session_id=?').all(original.id);
    const prepare = vi.spyOn(db.db, 'prepare');
    db.upsertSession({ ...original, title: 'Changed hidden native title', usage: { ...original.usage, credits: 0.5 } });
    const searchAccess = prepare.mock.calls.filter(([sql]) => /session_search(?:_source|_documents)?\b/i.test(sql));
    prepare.mockRestore();
    expect(searchAccess).toEqual([]);
    expect(db.db.prepare('SELECT * FROM session_search_documents WHERE session_id=?').get(original.id)).toEqual(before);
    expect(db.db.prepare('SELECT rowid,data FROM messages WHERE session_id=?').all(original.id)).toEqual(rows);
    expect(db.getSession(original.id)).toMatchObject({
      title: 'Pinned title', note: 'Keep this note', tags: ['keep'], bookmarked: true, usage: { credits: 0.5 },
    });
    expect(db.db.pragma('user_version', { simple: true })).toBe(4);
  });

  it('still refreshes search when text or searchable metadata changes alongside credits', () => {
    const db = store();
    const original = sample('changed', 0.25);
    db.upsertSession(original);
    db.upsertSession({
      ...original, model: 'new-searchable-model', usage: { ...original.usage, credits: 0.5 },
      messages: [{ ...original.messages[0], content: 'replacement body marker' }],
    });
    expect(db.listSessions({ q: 'new-searchable-model' }).total).toBe(1);
    expect(db.listSessions({ q: 'replacement body marker' }).total).toBe(1);
    expect(db.listSessions({ q: 'searchable original body' }).total).toBe(0);
  });

  it.each(['json', 'md', 'html'] as const)('exports recorded credits and partial status as %s', format => {
    const db = store();
    const original = sample('export', 0.125);
    original.usage.creditsPartial = true;
    db.upsertSession(original);
    const exported = exportSession(db.getSession(original.id)!, format);
    if (format === 'json') {
      expect(JSON.parse(exported.body).usage).toMatchObject({ credits: 0.125, creditsPartial: true });
    } else {
      expect(exported.body).toContain('Recorded Kiro credits');
      expect(exported.body).toContain('0.125');
      expect(exported.body).toContain('partial');
    }
    expect(exported.body).not.toContain('/fixture/history');
  });
});

it('backfills unchanged Kiro credit metadata without reparsing unchanged Codex or Claude sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-ops-credit-backfill-'));
  directories.push(directory);
  const codex = join(directory, 'codex.jsonl');
  const claude = join(directory, 'claude.jsonl');
  const kiro = join(directory, 'kiro.json');
  const transcript = `${kiro}l`;
  const lines = (values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n');
  await writeFile(codex, lines([
    { type: 'session_meta', payload: { id: 'codex-fixture', cwd: '/fixture/project', timestamp: '2026-09-24T00:00:00Z' } },
    { type: 'response_item', timestamp: '2026-09-24T00:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex text' }] } },
  ]));
  await writeFile(claude, lines([
    { type: 'user', sessionId: 'claude-fixture', cwd: '/fixture/project', timestamp: '2026-09-24T00:00:00Z',
      message: { id: 'c1', role: 'user', content: 'Claude text' } },
  ]));
  await writeFile(kiro, JSON.stringify({
    session_id: 'kiro-fixture', cwd: '/fixture/project', session_state: { conversation_metadata: {
      user_turn_metadatas: [{ loop_id: { agent_id: 'fixture', rand: 1 }, end_timestamp: '2026-09-24T00:00:02Z',
        metering_usage: [{ unit: 'credit', value: 0.25 }] }],
    } },
  }));
  await writeFile(transcript, lines([
    { kind: 'Prompt', data: { message_id: 'k1', content: 'Kiro text' } },
    { kind: 'AssistantMessage', data: { message_id: 'k2', content: 'Kiro answer' } },
  ]));
  const sources = [codex, claude, kiro, transcript];
  const sourceBytes = await Promise.all(sources.map(path => readFile(path)));
  const db = store();
  db.saveSettings({ sourceRoots: { codex: [codex], claude: [claude], kiro: [kiro, transcript] } });
  expect((await new SyncService(db).run()).imported).toBe(3);
  const saved = db.allSessions().find(value => value.agent === 'kiro')!;
  db.patchSession(saved.id, { bookmarked: true, note: 'Keep my note', title: 'Pinned Kiro title' });
  db.db.prepare("UPDATE sessions SET data=json_remove(data,'$.usage.credits','$.usage.creditsPartial') WHERE agent='kiro'").run();
  for (const path of sources) db.setFingerprint(path, db.getFingerprint(path)!.replace(/^[^:]+:/, 'format-v3:'));
  const originalCodex = db.getFingerprint(codex);
  const originalClaude = db.getFingerprint(claude);
  const report = await new SyncService(db).run();
  expect(report).toMatchObject({ imported: 1, filesScanned: 4, skipped: 2, warnings: [] });
  expect(db.getSession(saved.id)).toMatchObject({
    title: 'Pinned Kiro title', bookmarked: true, note: 'Keep my note', usage: { credits: 0.25 },
  });
  expect(db.getFingerprint(codex)).toBe(originalCodex);
  expect(db.getFingerprint(claude)).toBe(originalClaude);
  expect((await new SyncService(db).run()).imported).toBe(0);
  expect(await Promise.all(sources.map(path => readFile(path)))).toEqual(sourceBytes);
  expect(db.db.pragma('user_version', { simple: true })).toBe(4);
});
