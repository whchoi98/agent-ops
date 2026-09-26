import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { TemplateService } from '../server/productivity/templates.js';
import { emptyUsage, type ImportedSession, type PromptTemplate } from '../shared/types.js';
import type { TemplateInput } from '../shared/template-fields.js';

const stores: Store[] = [];
const directories: string[] = [];
function setup(filename = ':memory:') {
  const store = new Store(filename);
  stores.push(store);
  return { store, service: new TemplateService(store) };
}
function input(patch: Partial<TemplateInput> = {}): TemplateInput {
  return {
    name: '검토 원문', description: '미리보기', category: 'review', agent: 'any', policy: 'read-only',
    prompt: '  Review {{target}}\r\n',
    variables: [{ name: 'target', label: '새 실행', type: 'text', required: true }],
    ...patch,
  };
}
function status(action: () => unknown, statusCode: number) {
  expect(action).toThrow(expect.objectContaining({ statusCode }));
}
afterEach(() => {
  stores.splice(0).forEach(store => store.close());
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

describe('template persistence and revisions', () => {
  it('creates synchronously, persists the first revision and keeps user text unchanged', () => {
    const { store, service } = setup();
    const created = service.create(input());
    expect(created).not.toBeInstanceOf(Promise);
    expect(created).toMatchObject({
      ...input(), revision: 1, id: expect.stringMatching(/^template-/), updatedAt: expect.any(String),
    });
    expect(store.listTemplates()).toEqual([created]);
    expect(service.history(created.id)).toEqual([created]);
    expect(service.render(created.id, { target: '$& {{other}} $(keep)' })).toBe('  Review $& {{other}} $(keep)\r\n');
    expect(store.listRuns()).toEqual([]);
  });

  it('does not rewrite legacy templates on initialization, history reads or rendering', () => {
    const { store } = setup();
    const legacy: PromptTemplate = {
      ...input({ prompt: ' \r\n{{target}} {{nested {{expression}}}}\t' }),
      id: 'template-legacy', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    delete (legacy as { variables?: unknown }).variables;
    store.saveTemplate(legacy);
    const before = store.db.prepare('SELECT * FROM templates').all();
    const changes = store.db.prepare('SELECT total_changes() AS count').get();
    const service = new TemplateService(store);
    expect(service.history(legacy.id)).toEqual([{ ...legacy, revision: 1 }]);
    expect(service.render(legacy.id, { target: 'ignored' })).toBe(legacy.prompt);
    expect(store.db.prepare('SELECT * FROM templates').all()).toEqual(before);
    expect(store.db.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
  });

  it('captures a legacy revision on first edit and continues to accept old PATCH clients', () => {
    const { store, service } = setup();
    const legacy: PromptTemplate = {
      ...input({ prompt: 'literal {{target}}', variables: undefined }),
      id: 'template-legacy', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    store.saveTemplate(legacy);
    const edited = service.update(legacy.id, { name: '첫 수정', expectedRevision: 1 });
    expect(edited).toMatchObject({ name: '첫 수정', prompt: 'literal {{target}}', revision: 2 });
    expect(service.update(legacy.id, { description: 'Old client edit' })).toMatchObject({
      name: '첫 수정', description: 'Old client edit', revision: 3,
    });
    expect(service.history(legacy.id).map(item => [item.revision, item.name]))
      .toEqual([[3, '첫 수정'], [2, '첫 수정'], [1, '검토 원문']]);
    expect(service.history(legacy.id)[2]).toEqual({ ...legacy, revision: 1 });
  });

  it('keeps both the current template and history unchanged after a stale edit', () => {
    const { store, service } = setup();
    const created = service.create(input());
    const updated = service.update(created.id, { name: 'Current title', expectedRevision: 1 });
    const history = service.history(created.id);
    status(() => service.update(created.id, { name: 'Stale title', expectedRevision: 1 }), 409);
    expect(store.listTemplates()).toEqual([updated]);
    expect(service.history(created.id)).toEqual(history);
  });

  it('restores every saved field as a new revision instead of rewinding the revision counter', () => {
    const { store, service } = setup();
    const original = service.create(input({
      variables: [{ name: 'target', label: '선택 원문', type: 'select', required: false, options: ['미리보기'], defaultValue: '미리보기' }],
    }));
    service.update(original.id, {
      name: 'Second', description: 'Second description', prompt: 'Second literal',
      variables: [], category: 'build', agent: 'claude', policy: 'workspace-write', expectedRevision: 1,
    });
    const restored = service.restore(original.id, 1, 2);
    expect(restored).toMatchObject({ ...input(), ...original, updatedAt: expect.any(String), revision: 3 });
    expect(service.render(original.id, {})).toBe('  Review 미리보기\r\n');
    expect(service.history(original.id).map(item => item.revision)).toEqual([3, 2, 1]);
    expect(service.history(original.id)[2]).toEqual(original);
    expect(store.listRuns()).toEqual([]);
  });

  it('restoring a plain legacy revision removes later definitions and keeps braces literal', () => {
    const { store, service } = setup();
    store.saveTemplate({
      ...input({ variables: undefined }), id: 'template-legacy', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    service.update('template-legacy', { variables: input().variables, expectedRevision: 1 });
    expect(service.render('template-legacy', { target: 'one' })).toBe('  Review one\r\n');
    const restored = service.restore('template-legacy', 1, 2);
    expect(restored.variables).toBeUndefined();
    expect(restored.revision).toBe(3);
    expect(service.render('template-legacy', {})).toBe('  Review {{target}}\r\n');
  });

  it('rejects stale and unavailable restores without changing either snapshot', () => {
    const { store, service } = setup();
    const created = service.create(input());
    const updated = service.update(created.id, { name: 'Second', expectedRevision: 1 });
    const history = service.history(created.id);
    status(() => service.restore(created.id, 1, 1), 409);
    status(() => service.restore(created.id, 999, 2), 404);
    expect(store.listTemplates()).toEqual([updated]);
    expect(service.history(created.id)).toEqual(history);
  });

  it('retains at most 20 revisions and makes a retained old revision restorable', () => {
    const { service } = setup();
    const created = service.create(input());
    for (let revision = 2; revision <= 26; revision++) service.update(created.id, { name: `Revision ${revision}` });
    const history = service.history(created.id);
    expect(history).toHaveLength(20);
    expect(history[0]).toMatchObject({ revision: 26, name: 'Revision 26' });
    expect(history.at(-1)).toMatchObject({ revision: 7, name: 'Revision 7' });
    status(() => service.restore(created.id, 6, 26), 404);
    expect(service.restore(created.id, 7, 26)).toMatchObject({ revision: 27, name: 'Revision 7' });
    expect(service.history(created.id)).toHaveLength(20);
  });

  it('evicts the oldest stored revisions globally without deleting current templates', () => {
    const { store, service } = setup();
    const ids: string[] = [];
    store.db.transaction(() => {
      for (let index = 0; index < 51; index++) {
        const created = service.create(input({ name: `Template ${index}` }));
        ids.push(created.id);
        for (let revision = 2; revision <= 21; revision++) service.update(created.id, { description: `Revision ${revision}` });
      }
    })();
    expect(ids.reduce((count, id) => count + service.history(id).length, 0)).toBe(1_000);
    expect(service.history(ids[0])).toEqual([]);
    expect(service.history(ids[1])).toHaveLength(20);
    expect(service.history(ids[50])[0]).toMatchObject({ revision: 21, name: 'Template 50' });
    expect(store.listTemplates()).toHaveLength(51);
    expect(service.render(ids[0], { target: 'still current' })).toBe('  Review still current\r\n');
    status(() => service.restore(ids[0], 1, 21), 404);
  });

  it('persists definitions, history and revision checks after closing and reopening the store', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-ops-template-fields-'));
    directories.push(directory);
    const filename = join(directory, 'fixture.sqlite');
    const first = setup(filename);
    const created = first.service.create(input());
    const edited = first.service.update(created.id, { name: 'Persisted', expectedRevision: 1 });
    first.store.close();
    const reopened = setup(filename);
    expect(reopened.store.listTemplates()).toEqual([edited]);
    expect(reopened.service.history(created.id).map(item => item.revision)).toEqual([2, 1]);
    expect(reopened.service.render(created.id, { target: '재시작' })).toBe('  Review 재시작\r\n');
    status(() => reopened.service.update(created.id, { name: 'Stale', expectedRevision: 1 }), 409);
    expect(reopened.service.restore(created.id, 1, 2).revision).toBe(3);
  });

  it('deletes only the selected template and its stored history', () => {
    const { store, service } = setup();
    const first = service.create(input());
    const second = service.create(input({ name: 'Keep' }));
    service.update(first.id, { name: 'Edited' });
    expect(service.remove(first.id)).toBe(true);
    expect(service.remove(first.id)).toBe(false);
    expect(store.listTemplates()).toEqual([second]);
    expect(service.history(second.id)).toEqual([second]);
    status(() => service.history(first.id), 404);
    status(() => service.restore(first.id, 1, 2), 404);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM productivity_template_revisions WHERE template_id=?').get(first.id))
      .toEqual({ count: 0 });
  });

  it('rolls back the template update when recording its revision fails', () => {
    const { store, service } = setup();
    const created = service.create(input());
    store.db.exec(`CREATE TRIGGER reject_template_revision BEFORE INSERT ON productivity_template_revisions
      WHEN NEW.revision = 2 BEGIN SELECT RAISE(ABORT, 'synthetic revision failure'); END;`);
    expect(() => service.update(created.id, { name: 'Must roll back', expectedRevision: 1 })).toThrow(/synthetic/);
    expect(store.listTemplates()).toEqual([created]);
    expect(service.history(created.id)).toEqual([created]);
  });

  it('does not touch native sessions, messages, fingerprints, annotations or schema version', () => {
    const { store } = setup();
    const session: ImportedSession = {
      id: 'codex:fixture', nativeId: 'fixture', agent: 'codex', title: 'Native fixture',
      projectPath: '/tmp/template-fixture', projectName: 'fixture', model: 'fixture',
      startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z',
      status: 'completed', messageCount: 1, toolCallCount: 0, sourcePath: '/tmp/template-fixture/history.jsonl',
      usage: emptyUsage(),
      messages: [{ id: 'message-1', role: 'user', content: '보존할 원문', timestamp: '2026-01-01T00:00:00.000Z' }],
    };
    store.upsertSession(session);
    store.patchSession(session.id, { note: '보존할 메모', bookmarked: true, tags: ['원문'] });
    store.db.prepare('INSERT INTO sources(path,fingerprint) VALUES (?,?)').run(session.sourcePath, 'untouched-fingerprint');
    const readNative = () => ({
      session: store.getSession(session.id),
      sources: store.db.prepare('SELECT * FROM sources').all(),
      schema: store.db.pragma('user_version', { simple: true }),
      runs: store.listRuns(),
    });
    const before = readNative();
    const service = new TemplateService(store);
    const created = service.create(input());
    service.update(created.id, { name: 'Revision 2' });
    service.render(created.id, { target: 'local only' });
    service.restore(created.id, 1, 2);
    service.remove(created.id);
    expect(readNative()).toEqual(before);
    expect(store.listSessions({ q: '보존할 원문' }).items.map(item => item.id)).toEqual(['codex:fixture']);
  });
});

describe('service-owned validation', () => {
  it.each([
    null, [], 'bad', {}, { ...input(), id: 'client-id' }, { ...input(), revision: 9 },
    { ...input(), name: ' ' }, { ...input(), name: 'x'.repeat(201) }, { ...input(), description: 'x'.repeat(501) },
    { ...input(), prompt: '' }, { ...input(), prompt: 'x'.repeat(32_001) },
    { ...input(), category: 'unknown' }, { ...input(), agent: 'shell' }, { ...input(), policy: 'admin' },
    { ...input(), variables: null }, { ...input(), variables: [{ name: 'constructor', label: 'bad', type: 'text', required: false }] },
  ])('rejects invalid creation input before any persistence: %#', body => {
    const { store, service } = setup();
    status(() => service.create(body), 400);
    expect(store.listTemplates()).toEqual([]);
  });

  it.each([
    null, [], 'bad', { id: 'new-id' }, { revision: 10 }, { name: ' ' },
    { expectedRevision: 0 }, { expectedRevision: -1 }, { expectedRevision: 1.5 },
    { expectedRevision: '1' }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { prompt: 'Unknown {{missing}}' }, { variables: [{ name: 'unused', label: 'Unused', type: 'text', required: false }] },
  ])('rejects invalid PATCH input without creating history: %#', patch => {
    const { store, service } = setup();
    const created = service.create(input());
    status(() => service.update(created.id, patch), 400);
    expect(store.listTemplates()).toEqual([created]);
    expect(service.history(created.id)).toEqual([created]);
  });

  it.each([0, -1, 1.5, '1', null, undefined, Number.MAX_SAFE_INTEGER + 1])('rejects invalid restore revisions: %s', revision => {
    const { service } = setup();
    const created = service.create(input());
    status(() => service.restore(created.id, revision as number, 1), 400);
    status(() => service.restore(created.id, 1, revision as number), 400);
    expect(service.history(created.id)).toEqual([created]);
  });

  it('keeps the existing 32,000-character source limit and allows a 64,000-character rendering', () => {
    const { service } = setup();
    expect(service.create(input({ prompt: 'x'.repeat(32_000), variables: undefined })).prompt).toHaveLength(32_000);
    const created = service.create(input({ prompt: '{{target}}'.repeat(8) }));
    expect(service.render(created.id, { target: 'x'.repeat(8_000) })).toHaveLength(64_000);
    status(() => service.render(created.id, { target: 'x'.repeat(8_001) }), 400);
  });

  it('validates IDs in every direct entry point and reports missing templates', () => {
    const { service } = setup();
    for (const id of ['', 'x'.repeat(201), '../escape', 'id\0']) {
      status(() => service.history(id), 400);
      status(() => service.render(id, {}), 400);
      status(() => service.update(id, {}), 400);
      status(() => service.restore(id, 1, 1), 400);
      status(() => service.remove(id), 400);
    }
    status(() => service.history('template-missing'), 404);
    status(() => service.render('template-missing', {}), 404);
    status(() => service.update('template-missing', {}), 404);
  });
});
