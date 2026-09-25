import { expect, it } from 'vitest';
import { Store } from '../server/store.js';
import { seedDemo } from '../server/seed.js';
import { creditValue } from '../shared/credits.js';

it('shows representative demo credits without assigning session totals to demo runs', () => {
  const store = new Store(':memory:');
  try {
    seedDemo(store);
    const sessions = store.allSessions().filter(session => session.agent === 'kiro');
    expect(sessions.some(session => (creditValue(session.usage) ?? 0) > 0)).toBe(true);
    expect(sessions.some(session => creditValue(session.usage) === 0)).toBe(true);
    expect(sessions.some(session => creditValue(session.usage) === null)).toBe(true);
    expect(sessions.some(session => session.usage.creditsPartial)).toBe(true);
    expect(store.listRuns().filter(run => run.agent === 'kiro').every(run => creditValue(run.usage) === null)).toBe(true);
  } finally { store.close(); }
});

it('backfills old demo metadata once while preserving annotations and search data', () => {
  const store = new Store(':memory:');
  try {
    seedDemo(store);
    const session = store.allSessions().find(value => value.agent === 'kiro')!;
    store.patchSession(session.id, { title: 'Pinned demo title', note: 'Keep demo note', bookmarked: true });
    store.db.prepare("UPDATE sessions SET data=json_remove(data,'$.usage.credits','$.usage.creditsPartial') WHERE agent='kiro'").run();
    store.db.prepare("DELETE FROM settings WHERE key='demo-credits-seeded'").run();
    const before = store.db.prepare('SELECT * FROM session_search_documents ORDER BY rowid').all();
    seedDemo(store);
    expect(store.allSessions().filter(value => value.agent === 'kiro').some(value => creditValue(value.usage) !== null)).toBe(true);
    expect(store.getSession(session.id)).toMatchObject({ title: 'Pinned demo title', note: 'Keep demo note', bookmarked: true });
    expect(store.db.prepare('SELECT * FROM session_search_documents ORDER BY rowid').all()).toEqual(before);
    const changes = store.db.prepare('SELECT total_changes() AS value').get();
    seedDemo(store);
    expect(store.db.prepare('SELECT total_changes() AS value').get()).toEqual(changes);
  } finally { store.close(); }
});
