import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { WorkItemService } from '../server/productivity/work-items.js';
import { emptyUsage, type Run } from '../shared/types.js';

const stores: Store[] = [];
const directories: string[] = [];
function fixture(filename = ':memory:') {
  const store = new Store(filename);
  stores.push(store);
  const project = store.ensureProject('/synthetic/workspace', 'Workspace');
  const service = new WorkItemService(store);
  return { store, service, project };
}
function imported(store: Store) {
  store.upsertSession({
    id: 'source-session', nativeId: 'native-example', agent: 'claude', title: 'Investigate login',
    projectPath: '/synthetic/workspace', projectName: 'Workspace', model: 'fixture',
    startedAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:01Z', status: 'completed',
    messageCount: 1, toolCallCount: 0, usage: emptyUsage(), sourcePath: '/synthetic/source.jsonl',
    messages: [{ id: 'message', role: 'user', content: 'private transcript stays here', timestamp: '2026-09-25T00:00:00Z' }],
  });
  store.patchSession('source-session', { note: 'operator note', tags: ['keep'], bookmarked: true });
  store.setFingerprint('/synthetic/source.jsonl', 'format-v3:unchanged');
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('work-item persistence and operator intent', () => {
  it('preserves work details and versions across reopening the same app database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-ops-work-item-'));
    directories.push(directory);
    const file = join(directory, 'app.sqlite');
    const first = fixture(file);
    const created = first.service.create({ title: '로그인 수정', description: 'Keep the current scope', nextAction: 'Add a regression check' });
    const changed = first.service.update(created.id, { version: created.version, priority: 'high', dueDate: '2026-10-01' });
    first.store.close();
    const reopened = fixture(file);
    expect(reopened.service.get(created.id)).toEqual(changed);
    expect(changed).toMatchObject({ version: 2, status: 'todo', description: 'Keep the current scope', nextAction: 'Add a regression check' });
    expect(reopened.store.db.pragma('user_version', { simple: true })).toBe(4);
  });

  it('keeps original history, search and operator annotations when adding, archiving and deleting a work item', () => {
    const { store, service, project } = fixture();
    imported(store);
    const before = store.getSession('source-session');
    const task = service.create({ title: 'Follow up', projectId: project.id, sessionIds: ['source-session'] });
    const archived = service.update(task.id, { version: task.version, archived: true });
    expect(service.list({}).items).toHaveLength(0);
    expect(service.list({ archived: true }).items[0].id).toBe(task.id);
    service.remove(task.id, archived.version);
    expect(service.get(task.id)).toBeNull();
    expect(store.getSession('source-session')).toEqual(before);
    expect(store.getFingerprint('/synthetic/source.jsonl')).toBe('format-v3:unchanged');
    expect(store.listSessions({ q: 'private transcript' }).total).toBe(1);
  });

  it('rejects stale edits, archive and delete requests without partial writes', () => {
    const { service } = fixture();
    const task = service.create({ title: 'First' });
    const updated = service.update(task.id, { version: task.version, title: 'Second', status: 'blocked' });
    expect(() => service.update(task.id, { version: task.version, title: 'stale', archived: true }))
      .toThrow(/changed|version/i);
    expect(() => service.remove(task.id, task.version)).toThrow(/changed|version/i);
    expect(service.get(task.id)).toEqual(updated);
  });

  it.each([
    { title: '' }, { title: 'x'.repeat(201) }, { title: 'test', description: 'x'.repeat(8001) },
    { title: 'test', nextAction: 'x'.repeat(8001) }, { title: 'test', dueDate: '2026-02-30' },
    { title: 'test', dueDate: '2026-1-1' }, { title: 'test', dueDate: '2026-01-01T00:00:00Z' },
    { title: 'test', status: 'unknown' }, { title: 'test', priority: 'critical' },
    { title: 'test', projectId: 'missing' }, { title: 'test', sessionIds: ['missing'] },
    { title: 'test', contextPackIds: ['missing'] }, { title: 'test', lastRunId: 'forged' },
  ])('rejects invalid operator data %#', input => {
    const { service } = fixture();
    expect(() => service.create(input)).toThrow();
    expect(service.list({}).total).toBe(0);
  });

  it('rejects too many or repeated source references before storing a work item', () => {
    const { store, service } = fixture();
    imported(store);
    expect(() => service.create({ title: 'test', sessionIds: ['source-session', 'source-session'] })).toThrow();
    expect(() => service.create({ title: 'test', sessionIds: Array.from({ length: 21 }, (_, i) => `source-${i}`) })).toThrow();
    expect(() => service.create({ title: 'test', contextPackIds: Array.from({ length: 6 }, (_, i) => `pack-${i}`) })).toThrow();
    expect(service.list({}).total).toBe(0);
  });

  it('keeps an already attached reference if the source later becomes unavailable', () => {
    const { store, service } = fixture();
    imported(store);
    const task = service.create({ title: 'Follow up', sessionIds: ['source-session'] });
    store.db.prepare('DELETE FROM sessions WHERE id=?').run('source-session');
    const updated = service.update(task.id, { version: task.version, nextAction: 'Recheck source availability' });
    expect(updated.sessionIds).toEqual(['source-session']);
    expect(service.prepare(task.id, { version: updated.version }).draft.prompt).toContain('Recheck source availability');
  });

  it('filters literal search text, status, project and local-calendar due dates with bounded summaries', () => {
    const { service, project } = fixture();
    const first = service.create({ title: 'Fix 100%_case', projectId: project.id, status: 'blocked', priority: 'high',
      description: 'details '.repeat(1000), nextAction: 'next '.repeat(1000), dueDate: '2026-09-25' });
    service.create({ title: 'Fix other case', projectId: project.id, dueDate: '2026-09-26' });
    service.create({ title: 'Different project', dueDate: '2026-10-02' });
    expect(service.list({ q: '100%_' }).items.map(item => item.id)).toEqual([first.id]);
    expect(service.list({ due: 'overdue', today: '2026-09-26' }).items.map(item => item.id)).toEqual([first.id]);
    expect(service.list({ due: 'today', today: '2026-09-26' }).total).toBe(1);
    expect(service.list({ due: 'week', today: '2026-09-26' }).total).toBe(2);
    const page = service.list({ projectId: project.id, status: 'blocked', limit: 1 });
    expect(page).toMatchObject({ total: 1, limit: 1, offset: 0, counts: { todo: 1, blocked: 1, in_progress: 0, done: 0 } });
    expect(page.items[0].descriptionPreview.length).toBeLessThanOrEqual(240);
    expect(page.items[0]).not.toHaveProperty('description');
    expect(() => service.list({ limit: 101 })).toThrow();
    expect(() => service.list({ due: 'today' })).toThrow();
    expect(() => service.list({ offset: -1 })).toThrow();
  });

  it('bounds stored work items including archived records and permits updates at capacity', () => {
    const { store, service } = fixture();
    const first = service.create({ title: 'Capacity example' });
    const row = store.db.prepare('SELECT * FROM productivity_work_items WHERE id=?').get(first.id) as Record<string, unknown>;
    const columns = Object.keys(row);
    const insert = store.db.prepare(`INSERT INTO productivity_work_items(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    store.db.transaction(() => {
      for (let i = 1; i < 10_000; i++) insert.run(...columns.map(key => key === 'id' ? `capacity-${i}` : row[key]));
    })();
    expect(() => service.create({ title: 'Beyond capacity' })).toThrow(/limit/i);
    const updated = service.update(first.id, { version: first.version, archived: true });
    expect(updated.archivedAt).not.toBeNull();
    expect(() => service.create({ title: 'Archived still counts' })).toThrow(/limit/i);
    service.remove(first.id, updated.version);
    expect(service.create({ title: 'Available slot' }).title).toBe('Available slot');
  });
});

describe('work-item run preparation and linking', () => {
  function run(id: string, projectId: string, workItemId: string, workItemVersion: number): Run {
    return {
      id, agent: 'codex', projectId, prompt: 'Only the reviewed prompt', policy: 'read-only',
      title: 'Fixture run', status: 'queued', projectName: 'Workspace', projectPath: '/synthetic/workspace',
      createdAt: '2026-09-26T00:00:00Z', startedAt: null, finishedAt: null, exitCode: null,
      error: null, nativeSessionId: null, usage: emptyUsage(), command: 'controlled fixture',
      workItemId, workItemVersion,
    };
  }

  it('prepares an editable read-only run without importing transcript bodies or marking work complete', () => {
    const { store, service, project } = fixture();
    imported(store);
    const task = service.create({ title: 'Follow up', projectId: project.id, description: 'Keep the goal',
      nextAction: 'Add checks', sessionIds: ['source-session'] });
    const prepared = service.prepare(task.id, { version: task.version });
    expect(prepared.draft).toMatchObject({ policy: 'read-only', agent: 'claude', projectId: project.id,
      workItemId: task.id, workItemVersion: task.version });
    expect(prepared.draft.prompt).toContain('Add checks');
    expect(prepared.draft.prompt).not.toContain('private transcript stays here');
    expect(store.listRuns()).toHaveLength(0);
    expect(service.get(task.id)?.status).toBe('todo');
  });

  it('rolls back a competing run insert when the work-item version has already been consumed', () => {
    const { store, service, project } = fixture();
    const task = service.create({ title: 'Run once', projectId: project.id });
    const first = run('run-first', project.id, task.id, task.version);
    const second = run('run-second', project.id, task.id, task.version);
    const createLinked = (candidate: Run) => store.db.transaction(() => {
      store.insertRun(candidate);
      return service.linkRun(candidate);
    })();
    expect(createLinked(first)).toMatchObject({ lastRunId: first.id, status: 'in_progress', version: 2 });
    expect(() => createLinked(second)).toThrow(/changed|version/i);
    expect(store.getRun(second.id)).toBeNull();
    store.updateRun(first.id, { status: 'completed' });
    expect(service.get(task.id)?.status).toBe('in_progress');
    expect(service.list({}).items[0].lastRunStatus).toBe('completed');
  });

  it('rejects completed, archived, missing and wrong-project work before linking a run', () => {
    const { store, service, project } = fixture();
    const other = store.ensureProject('/synthetic/other', 'Other');
    const active = service.create({ title: 'Active', projectId: project.id });
    const done = service.create({ title: 'Done', status: 'done' });
    const archived = service.create({ title: 'Archived' });
    const changed = service.update(archived.id, { version: archived.version, archived: true });
    const candidates = [
      run('wrong-project', other.id, active.id, active.version),
      run('done-run', project.id, done.id, done.version),
      run('archived-run', project.id, changed.id, changed.version),
      run('missing-run', project.id, 'missing', 1),
    ];
    for (const candidate of candidates) {
      expect(() => store.db.transaction(() => { store.insertRun(candidate); service.linkRun(candidate); })()).toThrow();
      expect(store.getRun(candidate.id)).toBeNull();
    }
    expect(service.get(active.id)?.lastRunId).toBeNull();
  });
});
