import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeSession } from '../server/providers/claude.js';
import { parseCodexSession } from '../server/providers/codex.js';
import { parseKiroSession } from '../server/providers/kiro.js';
import type { ParseResult } from '../server/providers/common.js';
import { migrateCompressedSearch } from '../server/search-index.js';
import { Store } from '../server/store.js';
import type { Agent, ImportedSession } from '../shared/types.js';

const directories: string[] = [];
const stores: Store[] = [];
const time = '2026-09-25T00:00:00.000Z';

function database(legacy = false) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-ops-store-unicode-'));
  directories.push(directory);
  const store = new Store(join(directory, 'test.sqlite'));
  stores.push(store);
  if (legacy) {
    // Recreate only the empty search cache to model a pre-optimization v3 file.
    store.db.exec(`
      DROP TABLE session_search;
      DROP VIEW session_search_source;
      DROP TABLE session_search_documents;
      CREATE VIRTUAL TABLE session_search
        USING fts5(session_id UNINDEXED,body,tokenize='trigram',detail=none);
      PRAGMA user_version=3;
    `);
  }
  return store;
}

function parse(agent: Agent, prompt: string, explicitTitle?: string): ImportedSession {
  const context = {
    sourcePath: `/synthetic/${agent}/not-opened.jsonl`,
    nativeId: `unicode-${agent}`, projectPath: '/synthetic/project', fallbackTimestamp: time,
  };
  let result: ParseResult;
  if (agent === 'claude') {
    result = parseClaudeSession([
      { type: 'user', uuid: 'u1', sessionId: context.nativeId, timestamp: time,
        message: { role: 'user', content: prompt } },
      ...(explicitTitle ? [{ type: 'custom-title', sessionId: context.nativeId, customTitle: explicitTitle }] : []),
    ], context);
  } else if (agent === 'codex') {
    result = parseCodexSession([
      { type: 'session_meta', timestamp: time, payload: { id: context.nativeId, cwd: context.projectPath } },
      { type: 'response_item', timestamp: time, payload: {
        type: 'message', id: 'u1', role: 'user', content: [{ type: 'input_text', text: prompt }],
      } },
    ], context);
  } else {
    result = parseKiroSession({
      conversation_id: context.nativeId,
      history: [{ user: { content: { Prompt: { prompt } }, timestamp: time } }],
    }, context);
  }
  expect(result.session).not.toBeNull();
  return result.session!;
}

function searchIds(store: Store, query: string) {
  return store.listSessions({ q: query }).items.map(session => session.id);
}

function canonicalJson(store: Store, id: string) {
  return {
    session: (store.db.prepare('SELECT data FROM sessions WHERE id=?').get(id) as { data: string }).data,
    messages: store.db.prepare('SELECT data FROM messages WHERE session_id=? ORDER BY ordinal').all(id),
  };
}

afterEach(() => {
  stores.splice(0).forEach(store => store.close());
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

describe('Unicode titles through native parsers and Store', () => {
  it.each(['claude', 'codex', 'kiro'] as const)('imports a %s prompt with 159 ASCII characters followed by an emoji', agent => {
    const prompt = 'A'.repeat(159) + '🙂';
    const session = parse(agent, prompt);
    expect(session.title).toBe(prompt);
    expect(Buffer.from(session.title, 'utf8').toString('utf8')).toBe(session.title);
    const store = database();
    store.upsertSession(session);
    expect(store.getSession(session.id)).toMatchObject({
      title: prompt, messages: [expect.objectContaining({ content: prompt })],
    });
    expect(searchIds(store, '🙂')).toEqual([session.id]);
  });

  it('limits titles to 160 Unicode code points while preserving the full message', () => {
    const prompt = '🙂'.repeat(161) + ' beyond-title-only-needle';
    const session = parse('claude', prompt);
    expect(session.title).toBe('🙂'.repeat(160));
    const store = database();
    store.upsertSession(session);
    expect(store.getSession(session.id)?.messages[0].content).toBe(prompt);
    expect(searchIds(store, 'beyond-title-only-needle')).toEqual([session.id]);
  });

  it('retains the ASCII title limit and whitespace normalization', () => {
    const prompt = '  ' + 'A'.repeat(160) + '\n remaining original text  ';
    const session = parse('claude', prompt);
    expect(session.title).toBe('A'.repeat(160));
    const store = database();
    store.upsertSession(session);
    expect(store.getSession(session.id)?.messages[0].content).toBe(prompt);
    expect(searchIds(store, 'remaining original text')).toEqual([session.id]);
  });

  it('also truncates an explicit native title without splitting its emoji', () => {
    const title = 'B'.repeat(159) + '🙂';
    const session = parse('claude', 'Recorded request remains intact.', title + ' omitted title suffix');
    expect(session.title).toBe(title);
    const store = database();
    store.upsertSession(session);
    expect(store.getSession(session.id)?.messages[0].content).toBe('Recorded request remains intact.');
    expect(searchIds(store, '🙂')).toEqual([session.id]);
    expect(searchIds(store, 'omitted title suffix')).toEqual([]);
  });

  it('preserves legacy malformed canonical JSON through compression, annotations, and reopening', () => {
    const store = database(true);
    const prompt = 'A'.repeat(159) + '🙂 original-message-needle';
    const session = parse('claude', prompt);
    // A previous UTF-16 slice split the title; native JSON still preserves that code unit.
    const legacyTitle = 'A'.repeat(159) + '\uD83D';
    session.title = legacyTitle;
    session.messages.push({
      id: 'legacy-raw-message', role: 'assistant', timestamp: time,
      content: 'kept-high-\uD800 kept-low-\uDC00 valid-🙂',
    });
    store.upsertSession(session);
    const original = canonicalJson(store, session.id);
    const queries = ['a'.repeat(159) + '\uFFFD', 'original-message-needle', 'kept-high-\uFFFD', 'kept-low-\uFFFD', '🙂'];
    for (const query of queries) expect(searchIds(store, query)).toEqual([session.id]);

    // Exercise only the temporary database's search conversion, not offline maintenance.
    store.db.transaction(() => {
      migrateCompressedSearch(store.db);
      store.db.pragma('user_version=4');
    })();
    expect(canonicalJson(store, session.id)).toEqual(original);
    const annotated = store.patchSession(session.id, {
      note: 'annotation-note-🙂', tags: ['unicode-tag'], bookmarked: true,
    });
    expect(annotated).toMatchObject({
      title: legacyTitle, note: 'annotation-note-🙂', tags: ['unicode-tag'],
      bookmarked: true, messages: session.messages,
    });
    expect(canonicalJson(store, session.id)).toEqual(original);
    for (const query of [...queries, 'annotation-note-🙂', 'unicode-tag']) {
      expect(searchIds(store, query)).toEqual([session.id]);
    }

    store.close();
    const reopened = new Store(store.filename);
    stores.push(reopened);
    reopened.patchSession(session.id, { note: 'updated-note-🙂' });
    expect(canonicalJson(reopened, session.id)).toEqual(original);
    expect(reopened.getSession(session.id)).toMatchObject({
      title: legacyTitle, note: 'updated-note-🙂', tags: ['unicode-tag'], bookmarked: true,
      messages: session.messages,
    });
    expect(searchIds(reopened, 'annotation-note-🙂')).toEqual([]);
    expect(searchIds(reopened, 'updated-note-🙂')).toEqual([session.id]);
    for (const query of queries) expect(searchIds(reopened, query)).toEqual([session.id]);
  });
});
