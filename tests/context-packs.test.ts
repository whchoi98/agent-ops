import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { emptyUsage, type ImportedSession } from '../shared/types.js';
import type { ContextPack, ContextPackItemInput } from '../shared/context-packs.js';
import { ContextPackService } from '../server/productivity/context-packs.js';

const stores: Store[] = [];
const directories: string[] = [];
const timestamp = '2026-09-25T10:00:00.000Z';
function fixture(content = '앞말 🙂 selected excerpt 끝말'): ImportedSession {
  return {
    id: 'codex:context-source', nativeId: 'context-source', agent: 'codex',
    title: '원본 제목 / Original title', projectPath: '/synthetic/context-project',
    projectName: 'Synthetic project', model: 'fixture-model', startedAt: timestamp,
    updatedAt: timestamp, status: 'recorded', messageCount: 1, toolCallCount: 0,
    sourcePath: '/synthetic/never-opened.jsonl', usage: emptyUsage(),
    messages: [{ id: 'message-one', role: 'assistant', content, timestamp }],
  };
}
function setup(filename = ':memory:') {
  const store = new Store(filename);
  stores.push(store);
  store.upsertSession(fixture());
  const service = new ContextPackService(store);
  return { store, service };
}
function capture(service: ContextPackService, pack: ContextPack, extra = {}) {
  return service.addItem(pack.id, {
    version: pack.version, kind: 'message', sessionId: 'codex:context-source',
    messageId: 'message-one', offset: 6, length: 16, ...extra,
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  stores.splice(0).forEach(store => store.close());
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

describe('context pack snapshots and versioned edits', () => {
  it('captures the selected server message with its original provenance', () => {
    const { service } = setup();
    const pack = service.create({ name: 'Review context' });
    expect(pack).toMatchObject({
      name: 'Review context', description: '', instructions: '', projectId: null,
      version: 1, items: [], itemCount: 0, totalChars: 0,
    });
    const captured = capture(service, pack);
    expect(captured.version).toBe(2);
    expect(captured.items[0]).toMatchObject({
      kind: 'message', text: 'selected excerpt', sourceAvailable: true,
      source: {
        sessionId: 'codex:context-source', messageId: 'message-one', agent: 'codex',
        sessionTitle: '원본 제목 / Original title', role: 'assistant',
        messageTimestamp: timestamp, offset: 6, length: 16,
      },
    });
    expect(captured.items[0].source?.capturedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(captured).toMatchObject({ itemCount: 1, totalChars: 16 });
  });

  it('retains snapshots after source changes and reports deletion without discarding text', () => {
    const { service, store } = setup();
    const original = capture(service, service.create({ name: 'Keep evidence' }));
    const snapshot = original.items[0];
    store.upsertSession({ ...fixture('completely changed'), title: 'Changed source title' });
    const renamed = service.updateItem(original.id, snapshot.id, {
      version: original.version, title: 'Editable label',
    });
    expect(renamed.items[0]).toMatchObject({
      title: 'Editable label', text: snapshot.text, source: snapshot.source, sourceAvailable: true,
    });
    store.db.prepare('DELETE FROM messages WHERE session_id=?').run('codex:context-source');
    const unavailable = service.get(original.id);
    expect(unavailable.items[0]).toMatchObject({
      text: snapshot.text, source: snapshot.source, sourceAvailable: false,
    });
    store.db.prepare('DELETE FROM sessions WHERE id=?').run('codex:context-source');
    const edited = service.update(original.id, { version: renamed.version, description: 'Still useful' });
    expect(edited.items[0].text).toBe('selected excerpt');
    expect(edited.items[0].sourceAvailable).toBe(false);
  });

  it('rejects client-forged source text and immutable source updates without writing', () => {
    const { service } = setup();
    const pack = service.create({ name: 'Honest source' });
    const forged = {
      version: pack.version, kind: 'message', sessionId: 'codex:context-source',
      messageId: 'message-one', offset: 0, length: 2, text: 'forged source',
    } as ContextPackItemInput;
    expect(() => service.addItem(pack.id, forged)).toThrow();
    expect(service.get(pack.id)).toEqual(pack);
    const captured = capture(service, pack);
    expect(() => service.updateItem(pack.id, captured.items[0].id, {
      version: captured.version, text: 'edited original',
    })).toThrow();
    expect(service.get(pack.id)).toEqual(captured);
    expect(() => service.addItem(pack.id, {
      version: captured.version, kind: 'message', sessionId: 'missing-session',
      messageId: 'message-one', offset: 0, length: 1,
    })).toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(service.get(pack.id)).toEqual(captured);
  });

  it('edits operator notes, orders all items explicitly, and removes only selected items', () => {
    const { service } = setup();
    let pack = capture(service, service.create({ name: 'Notes' }));
    const sourceId = pack.items[0].id;
    pack = service.addItem(pack.id, { version: pack.version, kind: 'note', title: 'Next step', text: 'Check the cache' });
    const noteId = pack.items[1].id;
    pack = service.updateItem(pack.id, noteId, { version: pack.version, title: 'Operator note', text: '  확인\nunchanged whitespace  ' });
    expect(pack.items[1]).toMatchObject({
      kind: 'note', title: 'Operator note', text: '  확인\nunchanged whitespace  ',
      source: null, sourceAvailable: null,
    });
    pack = service.reorder(pack.id, { version: pack.version, itemIds: [noteId, sourceId] });
    expect(pack.items.map(item => item.id)).toEqual([noteId, sourceId]);
    expect(() => service.reorder(pack.id, { version: pack.version, itemIds: [noteId, noteId] })).toThrow();
    expect(() => service.reorder(pack.id, { version: pack.version, itemIds: [noteId] })).toThrow();
    expect(service.get(pack.id)).toEqual(pack);
    pack = service.removeItem(pack.id, sourceId, { version: pack.version });
    expect(pack.items.map(item => item.id)).toEqual([noteId]);
    expect(pack.totalChars).toBe(27);
  });

  it.each(['update', 'remove', 'addItem', 'updateItem', 'removeItem', 'reorder'] as const)(
    '%s rejects a stale version with 409 and leaves the complete record intact', method => {
      const { service } = setup();
      const before = capture(service, service.create({ name: 'Concurrent edits' }));
      const current = service.update(before.id, { version: before.version, instructions: 'New instruction' });
      const stale = { version: before.version };
      const actions = {
        update: () => service.update(before.id, { ...stale, name: 'Stale rename' }),
        remove: () => service.remove(before.id, stale),
        addItem: () => service.addItem(before.id, { ...stale, kind: 'note', title: 'Stale note', text: 'no' }),
        updateItem: () => service.updateItem(before.id, before.items[0].id, { ...stale, title: 'Stale label' }),
        removeItem: () => service.removeItem(before.id, before.items[0].id, stale),
        reorder: () => service.reorder(before.id, { ...stale, itemIds: [before.items[0].id] }),
      };
      expect(actions[method]).toThrow(expect.objectContaining({ statusCode: 409 }));
      expect(service.get(before.id)).toEqual(current);
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined, '1'])(
    'requires a positive safe integer mutation version (%s)', version => {
      const { service } = setup();
      const pack = service.create({ name: 'Versions' });
      expect(() => service.update(pack.id, { version: version as number, name: 'Invalid write' })).toThrow();
      expect(service.get(pack.id)).toEqual(pack);
    },
  );

  it('persists pack ordering and original snapshots on the existing database connection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-ops-context-packs-'));
    directories.push(directory);
    const { service, store } = setup(join(directory, 'app.sqlite'));
    const pack = capture(service, service.create({
      name: 'Persistent pack', projectId: store.listProjects()[0].id, instructions: 'Use these records',
    }));
    store.close();
    const reopened = new Store(store.filename);
    stores.push(reopened);
    const reloaded = new ContextPackService(reopened);
    expect(reloaded.get(pack.id)).toEqual(pack);
    reloaded.remove(pack.id, { version: pack.version });
    expect(reloaded.list().total).toBe(0);
    expect(reopened.getMessage('codex:context-source', 'message-one')?.content).toContain('selected excerpt');
  });
});

describe('context pack resource boundaries', () => {
  it('provides name-only contextPackInfo without loading item bodies or source availability', () => {
    const { service, store } = setup();
    const pack = capture(service, service.create({ name: 'Callback metadata' }));
    const prepare = store.db.prepare.bind(store.db);
    const queries: string[] = [];
    vi.spyOn(store.db, 'prepare').mockImplementation(sql => { queries.push(sql); return prepare(sql); });
    expect(service.info(pack.id)).toEqual({ name: 'Callback metadata' });
    expect(service.info('pack-missing')).toBeNull();
    expect(queries.join('\n')).not.toMatch(/productivity_context_pack_items|\bmessages\b|\bsessions\b|SELECT\s+\*/i);
  });

  it('paginates metadata without selecting instructions, item bodies, or native history', () => {
    const { service, store } = setup();
    const projectId = store.listProjects()[0].id;
    const pack = service.create({ name: 'Literal 100% _ [x]', projectId, instructions: 'private instruction marker' });
    service.addItem(pack.id, { version: pack.version, kind: 'note', title: 'Note', text: 'private item body marker' });
    service.create({ name: 'Other pack' });
    vi.spyOn(store, 'allSessions').mockImplementation(() => { throw new Error('Do not scan history'); });
    vi.spyOn(store, 'getSession').mockImplementation(() => { throw new Error('Do not load sessions'); });
    const prepare = store.db.prepare.bind(store.db);
    const queries: string[] = [];
    vi.spyOn(store.db, 'prepare').mockImplementation(sql => { queries.push(sql); return prepare(sql); });
    const result = service.list({ projectId, q: '100% _ [x]', limit: 1 });
    expect(result).toMatchObject({ total: 1, limit: 1, offset: 0 });
    expect(result.items[0]).toMatchObject({ id: pack.id, itemCount: 1, totalChars: 24 });
    expect(result.items[0]).not.toHaveProperty('instructions');
    expect(result.items[0]).not.toHaveProperty('items');
    expect(JSON.stringify(result)).not.toContain('private item body marker');
    expect(queries.join('\n')).not.toMatch(/productivity_context_pack_items|messages|sessions|SELECT\s+\*/i);
    expect(service.list({ limit: 1, offset: 1 })).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(service.list()).toMatchObject({ limit: 25, offset: 0 });
    expect(service.list({ q: '%' }).total).toBe(1);
    expect(() => service.list({ limit: 101 })).toThrow();
    expect(() => service.list({ limit: 0 })).toThrow();
    expect(() => service.list({ offset: -1 })).toThrow();
  });

  it('enforces the 200-pack cap without evicting existing packs', () => {
    const { service } = setup();
    for (let index = 0; index < 200; index++) service.create({ name: `Pack ${index}` });
    expect(() => service.create({ name: 'Pack 201' })).toThrow();
    expect(service.list({ limit: 100 }).items).toHaveLength(100);
    expect(service.list().total).toBe(200);
  });

  it.each([
    { name: '' }, { name: ' ' }, { name: 'n'.repeat(201) },
    { name: 'valid', description: 'd'.repeat(501) },
    { name: 'valid', instructions: 'i'.repeat(8001) },
    { name: 'valid', projectId: 'missing-project' },
  ])('rejects invalid metadata before creating a pack (case %#)', input => {
    const { service } = setup();
    expect(() => service.create(input)).toThrow();
    expect(service.list().total).toBe(0);
  });

  it('accepts exact metadata limits and validates all patch fields before changing anything', () => {
    const { service } = setup();
    const pack = service.create({ name: 'n'.repeat(200), description: 'd'.repeat(500), instructions: 'i'.repeat(8000) });
    for (const patch of [
      { name: 'n'.repeat(201) }, { description: 'd'.repeat(501) },
      { instructions: 'i'.repeat(8001) }, { projectId: 'missing-project' },
    ]) {
      expect(() => service.update(pack.id, { version: pack.version, ...patch })).toThrow();
      expect(service.get(pack.id)).toEqual(pack);
    }
  });

  it('caps items at 20 without replacing or silently omitting any selected item', () => {
    const { service } = setup();
    let pack = service.create({ name: 'Twenty notes' });
    for (let index = 0; index < 20; index++) {
      pack = service.addItem(pack.id, { version: pack.version, kind: 'note', title: `Note ${index}`, text: `marker-${index}-end` });
    }
    expect(() => service.addItem(pack.id, { version: pack.version, kind: 'note', title: 'Overflow', text: 'no' })).toThrow();
    expect(service.get(pack.id)).toEqual(pack);
    const compilation = service.compile(pack.id);
    expect(compilation.itemCount).toBe(20);
    for (let index = 0; index < 20; index++) expect(compilation.prompt).toContain(`marker-${index}-end`);
  });

  it('enforces 8,000 characters per item and 48,000 total on additions and edits', () => {
    const { service } = setup();
    let pack = service.create({ name: 'Text limits' });
    expect(() => service.addItem(pack.id, { version: pack.version, kind: 'note', title: 'Too long', text: 'x'.repeat(8001) })).toThrow();
    expect(() => service.addItem(pack.id, { version: pack.version, kind: 'note', title: 't'.repeat(201), text: 'x' })).toThrow();
    expect(service.get(pack.id)).toEqual(pack);
    pack = service.addItem(pack.id, { version: pack.version, kind: 'note', title: 'Exact item limit', text: 'x'.repeat(8000) });
    pack = service.removeItem(pack.id, pack.items[0].id, { version: pack.version });
    for (let index = 0; index < 8; index++) {
      pack = service.addItem(pack.id, { version: pack.version, kind: 'note', title: `Note ${index}`, text: 'x'.repeat(6000) });
    }
    expect(pack.totalChars).toBe(48000);
    expect(() => service.addItem(pack.id, { version: pack.version, kind: 'note', title: 'Overflow', text: 'x' })).toThrow();
    expect(() => capture(service, pack)).toThrow();
    expect(() => service.updateItem(pack.id, pack.items[0].id, { version: pack.version, text: 'x'.repeat(6001) })).toThrow();
    expect(service.get(pack.id)).toEqual(pack);
    const shorter = service.updateItem(pack.id, pack.items[0].id, { version: pack.version, text: 'short' });
    expect(shorter.totalChars).toBe(42005);
  });

  it.each([
    [1, 2, '🙂'], [3, 1, '한'], [4, 2, 'e\u0301'],
  ])('captures complete Unicode at UTF-16 range %i + %i', (offset, length, expected) => {
    const { service, store } = setup();
    store.upsertSession(fixture('A🙂한e\u0301Z'));
    const pack = capture(service, service.create({ name: 'Unicode' }), { offset, length });
    expect(pack.items[0].text).toBe(expected);
  });

  it.each([[1, 1], [2, 1], [-1, 1], [0, 0], [0, 8001], [7, 1], [0.5, 1], [0, 100]])(
    'rejects split surrogates, invalid or out-of-range selections (%s + %s)', (offset, length) => {
      const { service, store } = setup();
      store.upsertSession(fixture('A🙂한e\u0301Z'));
      const pack = service.create({ name: 'Unicode' });
      expect(() => capture(service, pack, { offset, length })).toThrow();
      expect(service.get(pack.id)).toEqual(pack);
    },
  );

  it('checks serialized message bytes in SQLite before transferring an oversized JSON body to Node', () => {
    const { service, store } = setup();
    // The text itself is small; a large metadata field must still count toward 8 MiB.
    store.db.prepare("UPDATE messages SET data=json_set(data,'$.padding',replace(hex(zeroblob(?)),'0','가')) WHERE session_id=?")
      .run(2 * 1024 * 1024, 'codex:context-source');
    const pack = service.create({ name: 'Bounded capture' });
    const prepare = store.db.prepare.bind(store.db);
    const transferred: unknown[] = [];
    vi.spyOn(store.db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (/\bmessages\b/.test(sql)) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, 'get').mockImplementation((...parameters: unknown[]) => {
          const row = get(...parameters);
          transferred.push(row);
          return row;
        });
      }
      return statement;
    });
    expect(() => capture(service, pack)).toThrow(expect.objectContaining({ statusCode: 413 }));
    expect(transferred.length).toBeGreaterThan(0);
    expect(JSON.stringify(transferred).length).toBeLessThan(1000);
    expect(service.get(pack.id)).toEqual(pack);
  });

  it('accepts a message at exactly 8 MiB and reads only the selected message', () => {
    const { service, store } = setup();
    const source = { ...fixture().messages[0], padding: '' };
    source.padding = 'x'.repeat(8 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(source), 'utf8'));
    store.db.prepare('UPDATE messages SET data=? WHERE session_id=?').run(JSON.stringify(source), 'codex:context-source');
    store.db.prepare(`INSERT INTO messages(session_id,ordinal,data)
      VALUES (?,1,json_object('id','unselected-large','content',replace(hex(zeroblob(?)),'0','y')))`)
      .run('codex:context-source', 5 * 1024 * 1024);
    vi.spyOn(store, 'getMessage').mockImplementation(() => { throw new Error('The unbounded getter must not be used'); });
    vi.spyOn(store, 'getSession').mockImplementation(() => { throw new Error('Do not fetch a whole session'); });
    const pack = capture(service, service.create({ name: 'Selected message only' }));
    expect(pack.items[0].text).toBe('selected excerpt');
  });

  it('does not read any retained message body on an unrelated edit', () => {
    const { service, store } = setup();
    const pack = capture(service, service.create({ name: 'No recapture' }));
    // A source may grow past the capture cap later; saved text must stay usable.
    store.db.prepare("UPDATE messages SET data=json_set(data,'$.content',replace(hex(zeroblob(?)),'0','x')) WHERE session_id=?")
      .run(5 * 1024 * 1024, 'codex:context-source');
    const prepare = store.db.prepare.bind(store.db);
    const transferred: unknown[] = [];
    vi.spyOn(store.db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (/\bmessages\b/.test(sql)) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, 'get').mockImplementation((...parameters: unknown[]) => {
          const row = get(...parameters); transferred.push(row); return row;
        });
      }
      return statement;
    });
    expect(service.update(pack.id, { version: pack.version, name: 'Renamed only' }).items[0].text).toBe('selected excerpt');
    expect(JSON.stringify(transferred).length).toBeLessThan(1000);
  });
});

describe('local context compilation and export', () => {
  it('counts provenance overhead toward the prompt cap and refuses all output rather than dropping excerpts', () => {
    const { service, store } = setup();
    store.upsertSession(fixture('x'.repeat(2400)));
    let pack = service.create({ name: 'Provenance overhead', instructions: 'i'.repeat(8000) });
    for (let index = 0; index < 20; index++) pack = capture(service, pack, { offset: 0, length: 2400 });
    expect(() => service.compile(pack.id)).toThrow(expect.objectContaining({ statusCode: 413 }));
    expect(service.get(pack.id).items).toHaveLength(20);
    expect(service.get(pack.id)).toEqual(pack);
  });

  it('redacts every exported string while retaining provenance and immutable originals', () => {
    const { service, store } = setup();
    const secret = 'sk-abcdefghijklmnopqrstuvwx';
    store.upsertSession({ ...fixture(`source ${secret}`), title: `Source ${secret}` });
    let pack = service.create({
      name: `Name ${secret}`, description: 'password="fixture-password"',
      instructions: 'Keep the result local.\nAuthorization: Bearer fixture-bearer',
    });
    pack = capture(service, pack, { offset: 0, length: `source ${secret}`.length });
    pack = service.addItem(pack.id, {
      version: pack.version, kind: 'note', title: 'Quoted "note"',
      text: '  token="fixture-note"\n```\noperator note\n```  ',
    });
    const compiled = service.compile(pack.id);
    expect(compiled).toMatchObject({ packId: pack.id, version: pack.version, itemCount: 2, redacted: true });
    expect(compiled.characters).toBe(compiled.prompt.length);
    expect(compiled.prompt).toContain('Operator instructions');
    expect(compiled.prompt).toContain('Operator note');
    expect(compiled.prompt).toContain('codex:context-source');
    expect(compiled.prompt).toContain('message-one');
    expect(compiled.prompt).toContain('codex');
    expect(compiled.prompt).toContain(pack.items[0].source!.capturedAt);
    expect(compiled.prompt).toContain('[REDACTED]');
    for (const hidden of [secret, 'fixture-password', 'fixture-bearer', 'fixture-note']) {
      expect(compiled.prompt).not.toContain(hidden);
    }
    expect(service.compile(pack.id)).toEqual(compiled);
    const markdown = service.export(pack.id, 'md');
    expect(markdown).toMatchObject({ extension: 'md', type: 'text/markdown; charset=utf-8', body: compiled.prompt });
    const json = service.export(pack.id, 'json');
    const document = JSON.parse(json.body);
    expect(document.formatVersion).toBe(1);
    expect(document.pack.items).toHaveLength(2);
    expect(document.pack.items[0].source.sessionTitle).toBe('Source [REDACTED]');
    expect(document.pack.items[1].title).toBe('Quoted "note"');
    expect(document.pack.items[1].text).toContain('operator note');
    expect(json.body).not.toContain(secret);
    expect(service.get(pack.id)).toEqual(pack);
    expect(pack.items[0].text).toContain(secret);
  });

  it('keeps unavailable-source content in both compiled and JSON output', () => {
    const { service, store } = setup();
    const pack = capture(service, service.create({ name: 'Deleted source' }));
    store.db.prepare('DELETE FROM sessions WHERE id=?').run('codex:context-source');
    const compiled = service.compile(pack.id);
    expect(compiled.prompt).toContain('Unavailable');
    expect(compiled.prompt).toContain('selected excerpt');
    expect(JSON.parse(service.export(pack.id, 'json').body).pack.items[0]).toMatchObject({
      text: 'selected excerpt', sourceAvailable: false,
    });
  });

  it('refuses a prompt that grows past 64,000 characters during redaction without omitting items', () => {
    const { service } = setup();
    let pack = service.create({ name: 'Redaction expansion' });
    for (let index = 0; index < 6; index++) {
      pack = service.addItem(pack.id, {
        version: pack.version, kind: 'note', title: `Note ${index}`, text: 'token=abcd '.repeat(720),
      });
    }
    expect(pack.totalChars).toBe(47520);
    expect(() => service.compile(pack.id)).toThrow(expect.objectContaining({ statusCode: 413 }));
    expect(() => service.export(pack.id, 'md')).toThrow(expect.objectContaining({ statusCode: 413 }));
    expect(() => service.export(pack.id, 'json')).toThrow(expect.objectContaining({ statusCode: 413 }));
    expect(service.get(pack.id)).toEqual(pack);
  });

  it('leaves native rows, annotations, search documents and fingerprints unchanged', () => {
    const { service, store } = setup();
    store.patchSession('codex:context-source', { title: 'User title', note: 'Annotation', tags: ['keep'], bookmarked: true }, false);
    store.db.prepare('INSERT INTO sources(path,fingerprint) VALUES (?,?)').run('/synthetic/never-opened.jsonl', 'fixture-fingerprint');
    const snapshot = () => ['sessions', 'messages', 'sources', 'session_search_documents', 'projects']
      .map(table => store.db.prepare(`SELECT * FROM ${table}`).all());
    const before = snapshot();
    const pack = capture(service, service.create({ name: 'Native data remains original' }));
    service.compile(pack.id);
    service.export(pack.id, 'json');
    service.remove(pack.id, { version: pack.version });
    expect(snapshot()).toEqual(before);
    expect(store.db.pragma('user_version', { simple: true })).toBe(4);
  });
});
