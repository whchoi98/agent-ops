import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { SavedViewService } from '../server/productivity/saved-views.js';
import { Store } from '../server/store.js';
import { emptyUsage, type ImportedSession } from '../shared/types.js';

const stores: Store[] = [];
const dirs: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-saved-views-'));
  dirs.push(dir);
  const store = new Store(join(dir, 'test.sqlite'));
  stores.push(store);
  return { store, service: new SavedViewService(store) };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('saved view metadata persistence', () => {
  it('persists literal filters, pin changes and versions in the existing database across reopen', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T10:00:00Z'));
    const { store, service } = setup();
    const created = service.create({
      name: '설정 [x] & review', pinned: false, period: 'custom',
      query: {
        q: "' OR 1=1 -- [x]?* 100% `pwd` $(echo nope)", agent: 'codex',
        project: '/tmp/a & b', tag: '설정', status: 'recorded', bookmarked: true,
        sort: 'tokens', limit: 60,
        since: '2026-03-08T05:00:00.000Z', until: '2026-03-09T03:59:59.999Z',
      },
    });
    expect(created).toMatchObject({
      name: '설정 [x] & review', pinned: false, version: 1,
      createdAt: '2026-09-26T10:00:00.000Z', updatedAt: '2026-09-26T10:00:00.000Z',
    });
    vi.setSystemTime(new Date('2026-09-26T10:01:00Z'));
    const edited = service.update(created.id, { version: 1, pinned: true });
    expect(edited).toEqual({
      ...created, pinned: true, version: 2, updatedAt: '2026-09-26T10:01:00.000Z',
    });
    store.close();
    const reopened = new Store(store.filename);
    stores.push(reopened);
    expect(new SavedViewService(reopened).list()).toEqual([edited]);
    expect(reopened.db.pragma('user_version', { simple: true })).toBe(4);
  });

  it('defaults new views to all-time and unpinned, and returns detached metadata', () => {
    const { service } = setup();
    const created = service.create({ name: 'Every session', query: {} });
    expect(created).toMatchObject({ period: 'all-time', pinned: false, query: {}, version: 1 });
    created.query.q = 'local mutation';
    expect(service.get(created.id).query).toEqual({});
  });

  it('lists pinned views first and the most recently changed views within each group', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T10:00:00Z'));
    const { service } = setup();
    const pinned = service.create({ name: 'Pinned', pinned: true, query: {} });
    vi.setSystemTime(new Date('2026-09-26T10:01:00Z'));
    const first = service.create({ name: 'First', query: {} });
    vi.setSystemTime(new Date('2026-09-26T10:02:00Z'));
    const second = service.create({ name: 'Second', query: {} });
    expect(service.list().map(view => view.id)).toEqual([pinned.id, second.id, first.id]);
    vi.setSystemTime(new Date('2026-09-26T10:03:00Z'));
    service.update(first.id, { version: first.version, pinned: true });
    expect(service.list().map(view => view.id)).toEqual([first.id, pinned.id, second.id]);
  });

  it('rejects stale edits and deletes without changing any accepted fields', () => {
    const { service } = setup();
    const created = service.create({ name: 'Original', query: { q: 'original' } });
    const current = service.update(created.id, { version: 1, name: 'Accepted', query: { agent: 'kiro' } });
    expect(() => service.update(created.id, { version: 1, name: 'Stale', pinned: true }))
      .toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(() => service.remove(created.id, 1)).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(service.get(created.id)).toEqual(current);
    service.remove(created.id, 2);
    expect(service.list()).toEqual([]);
    expect(() => service.get(created.id)).toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it('caps storage at fifty views but still allows updates and frees a slot after deletion', () => {
    const { service } = setup();
    for (let i = 0; i < 50; i++) service.create({ name: `View ${i}`, query: {} });
    expect(() => service.create({ name: 'One too many', query: {} }))
      .toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(service.list()).toHaveLength(50);
    const first = service.list()[0];
    const edited = service.update(first.id, { version: first.version, pinned: true });
    service.remove(edited.id, edited.version);
    service.create({ name: 'Freed slot', query: {} });
    expect(service.list()).toHaveLength(50);
  });

  it('validates the merged period and query atomically on partial updates', () => {
    const { service } = setup();
    const first = service.create({ name: 'Relative', period: 'last7', query: { q: 'review' } });
    expect(() => service.update(first.id, { version: 1, period: 'custom' })).toThrow(ZodError);
    expect(service.get(first.id)).toEqual(first);
    const custom = service.update(first.id, { version: 1, period: 'custom', query: { until: '2024-02-29' } });
    expect(custom).toMatchObject({ period: 'custom', query: { until: '2024-02-29' }, version: 2 });
    expect(() => service.update(first.id, { version: 2, query: { until: '2026-02-29' }, name: 'Rejected' })).toThrow(ZodError);
    expect(service.get(first.id)).toEqual(custom);
    const relative = service.update(first.id, { version: 2, period: 'today', query: { q: 'new' } });
    expect(relative.query).toEqual({ q: 'new' });
  });

  it('does not read searches, rewrite history, or change fingerprints and annotations', () => {
    const { store } = setup();
    const session: ImportedSession = {
      id: 'codex:synthetic', nativeId: 'synthetic', agent: 'codex', title: 'Original title',
      projectPath: '/tmp/synthetic', projectName: 'Synthetic', model: 'fixture',
      startedAt: '2026-09-26T09:00:00Z', updatedAt: '2026-09-26T09:01:00Z', status: 'recorded',
      messageCount: 1, toolCallCount: 0, sourcePath: '/tmp/synthetic/history.jsonl', usage: emptyUsage(),
      messages: [{ id: 'message', role: 'user', timestamp: '2026-09-26T09:00:00Z', content: '원문 [x]?*' }],
    };
    store.upsertSession(session);
    store.patchSession(session.id, { title: 'Operator title', note: 'Keep this note', bookmarked: true, tags: ['retain'] });
    store.setFingerprint(session.sourcePath, 'synthetic-fingerprint');
    const tables = ['sessions', 'messages', 'sources', 'session_search_documents', 'session_search', 'settings'];
    const before = tables.map(table => store.db.prepare(`SELECT * FROM ${table}`).all());
    const search = vi.spyOn(store, 'listSessions');
    const archive = vi.spyOn(store, 'allSessions');
    const detail = vi.spyOn(store, 'getSession');
    const service = new SavedViewService(store);
    const view = service.create({ name: 'Metadata only', query: { q: '[x]?*' } });
    service.list();
    service.get(view.id);
    service.update(view.id, { version: 1, pinned: true });
    service.remove(view.id, 2);
    expect(search).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
    expect(tables.map(table => store.db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(store.db.pragma('user_version', { simple: true })).toBe(4);
  });
});

describe('strict saved view validation', () => {
  it.each([
    { name: '' }, { name: ' \t ' }, { name: 'x'.repeat(121) }, { name: 'bad\0name' },
    { name: '\nName' }, { name: 'Name\t' },
    { pinned: 'true' }, { pinned: 1 }, { pinned: null }, { period: 'week' },
    { unexpected: true }, { version: 1 },
    { query: null }, { query: [] }, { query: 'q=hello' },
    { query: { offset: 0 } }, { query: { unknown: 'value' } },
    { query: { q: 'x'.repeat(501) } }, { query: { q: ['first', 'second'] } }, { query: { q: '\0' } },
    { query: { project: 'x'.repeat(4097) } }, { query: { tag: 'x'.repeat(61) } },
    { query: { agent: 'any' } }, { query: { status: 'running' } }, { query: { sort: 'cost' } },
    { query: { bookmarked: 'false' } }, { query: { limit: '20' } },
    { query: { limit: 0 } }, { query: { limit: 201 } }, { query: { limit: 20.5 } },
    { query: { limit: Number.NaN } }, { query: { limit: Number.POSITIVE_INFINITY } },
    { period: 'today', query: { since: '2026-09-01' } },
    { period: 'custom', query: {} },
    { period: 'custom', query: { since: '2026-02-29' } },
    { period: 'custom', query: { until: '2026-09-31T00:00:00Z' } },
    { period: 'custom', query: { since: '2026-09-27', until: '2026-09-26' } },
  ])('rejects invalid input without inserting metadata, case %#', patch => {
    const { service } = setup();
    expect(() => service.create({ name: 'Valid', query: {}, ...patch })).toThrow(ZodError);
    expect(service.list()).toEqual([]);
  });

  it('rejects prototype filters instead of silently retaining or stripping them', () => {
    const { service } = setup();
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(() => service.create(JSON.parse(`{"name":"bad","query":{"${key}":{"q":"unexpected"}}}`))).toThrow(ZodError);
    }
    expect(service.list()).toEqual([]);
  });

  it('accepts the existing search API boundaries and valid leap dates', () => {
    const { service } = setup();
    const view = service.create({
      name: '이'.repeat(120), pinned: true, period: 'custom',
      query: {
        q: 'q'.repeat(500), project: 'p'.repeat(4096), tag: 't'.repeat(60),
        agent: 'kiro', status: 'failed', bookmarked: false, sort: 'credits', limit: 200,
        since: '2024-02-29T12:00:00+09:00', until: '2024-02-29T04:00:00Z',
      },
    });
    expect(view.name).toHaveLength(120);
    expect(view.query).toMatchObject({ limit: 200, bookmarked: false, since: '2024-02-29T12:00:00+09:00' });
  });

  it.each([undefined, null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1])(
    'requires a positive safe integer version for update and deletion: %j', version => {
      const { service } = setup();
      const created = service.create({ name: 'Versioned', query: {} });
      expect(() => service.update(created.id, { version, name: 'Rejected' })).toThrow(ZodError);
      expect(() => service.remove(created.id, version as number)).toThrow(ZodError);
      expect(service.get(created.id)).toEqual(created);
    },
  );

  it('rejects empty patches, immutable fields and invalid identifiers', () => {
    const { service } = setup();
    const created = service.create({ name: 'Original', query: {} });
    for (const patch of [{}, { version: 1 }, { version: 1, id: 'replacement' }, { version: 1, createdAt: 'today' }]) {
      expect(() => service.update(created.id, patch)).toThrow(ZodError);
    }
    for (const id of ['', '../file', 'x'.repeat(201), `${created.id}' OR 1=1 --`]) {
      expect(() => service.get(id)).toThrow(ZodError);
      expect(() => service.update(id, { version: 1, name: 'Rejected' })).toThrow(ZodError);
      expect(() => service.remove(id, 1)).toThrow(ZodError);
    }
    expect(service.get(created.id)).toEqual(created);
  });
});
