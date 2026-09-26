import { afterEach, expect, test, vi } from 'vitest';
import { applySavedView, buildSavedViewInput, createSavedViewDraft, replaceSavedViewQuery } from './editor';
import { savedView } from './testFixtures';
import type { SessionQuery } from '../../../shared/types';

afterEach(() => vi.unstubAllEnvs());

test('a new view captures current filters but never stores the current page offset', () => {
  const draft = createSavedViewDraft({
    q: ' 설정 & [x]?* `pwd` $(echo nope) ', agent: 'claude', tag: '[x]',
    bookmarked: false, sort: 'tokens', limit: 60, offset: 120,
    since: '2026-09-26T00:00:00+09:00', until: '2026-09-26T23:59:59.999+09:00',
  });
  expect(draft.period).toBe('custom');
  expect(buildSavedViewInput({ ...draft, name: '설정' })).toEqual({
    name: '설정', pinned: false, period: 'custom',
    query: {
      q: ' 설정 & [x]?* `pwd` $(echo nope) ', agent: 'claude', tag: '[x]', bookmarked: false, sort: 'tokens', limit: 60,
      since: '2026-09-26T00:00:00+09:00', until: '2026-09-26T23:59:59.999+09:00',
    },
  });
});

test('editing a name preserves saved filters and exact custom instants instead of silently taking the active query', () => {
  const view = savedView({
    period: 'custom',
    query: { q: 'Saved search', since: '2026-09-26T12:34:56+09:00', until: '2026-09-26T05:01:02Z' },
  });
  const draft = createSavedViewDraft({ q: 'Unrelated active query', offset: 100 }, view);
  expect(buildSavedViewInput({ ...draft, name: 'Renamed' })).toEqual({
    name: 'Renamed', period: 'custom', pinned: true,
    query: { q: 'Saved search', since: '2026-09-26T12:34:56+09:00', until: '2026-09-26T05:01:02Z' },
  });
  expect(view.name).toBe('설정 [x]?* & review');
});

test('switching to a relative period discards fixed dates only in the submitted metadata', () => {
  const draft = createSavedViewDraft({ q: 'review', since: '2026-09-01', until: '2026-09-10', offset: 60 });
  expect(buildSavedViewInput({ ...draft, name: 'Weekly', period: 'last7' })).toEqual({
    name: 'Weekly', query: { q: 'review' }, period: 'last7', pinned: false,
  });
  expect(draft.query.since).toBe('2026-09-01');
});

test('importing current date filters changes an all-time editor to custom instead of silently dropping dates', () => {
  const draft = createSavedViewDraft({}, savedView({ name: 'Keep name', period: 'all-time', query: {} }));
  const imported = replaceSavedViewQuery(draft, {
    q: 'Current search', since: '2026-09-01T04:00:00Z', until: '2026-09-02T03:59:59.999Z', offset: 80,
  });
  expect(buildSavedViewInput(imported)).toEqual({
    name: 'Keep name', pinned: true, period: 'custom',
    query: { q: 'Current search', since: '2026-09-01T04:00:00Z', until: '2026-09-02T03:59:59.999Z' },
  });
  expect(draft.period).toBe('all-time');
});

test('importing an all-time current query clears old custom dates without leaving an invalid period', () => {
  const draft = createSavedViewDraft({}, savedView({ period: 'custom', query: { since: '2026-09-01' } }));
  expect(buildSavedViewInput(replaceSavedViewQuery(draft, { q: 'No dates', offset: 40 }))).toEqual({
    name: '설정 [x]?* & review', pinned: true, period: 'all-time', query: { q: 'No dates' },
  });
});

test.each([
  { name: '' }, { name: ' \t ' }, { name: 'x'.repeat(121) }, { name: 'bad\0name' },
  { name: '\nName' }, { name: 'Name\t' },
  { period: 'custom' as const, query: {} },
  { period: 'custom' as const, query: { since: '2026-02-29' } },
  { period: 'custom' as const, query: { since: '2026-09-27', until: '2026-09-26' } },
])('an invalid editor draft cannot create a save payload, case %#', patch => {
  expect(() => buildSavedViewInput({ ...createSavedViewDraft({}), name: 'Valid', ...patch })).toThrow();
});

test('opening invokes onApply with a replacement query at offset zero, recalculated at that moment', () => {
  vi.stubEnv('TZ', 'America/New_York');
  const applied: SessionQuery[] = [];
  const view = savedView({ query: { q: '[x]?*', sort: 'credits', limit: 40 } });
  applySavedView(view, query => applied.push(query), new Date('2026-03-10T16:00:00Z'));
  expect(applied).toEqual([{
    q: '[x]?*', sort: 'credits', limit: 40, offset: 0,
    since: '2026-03-04T05:00:00.000Z', until: '2026-03-11T03:59:59.999Z',
  }]);
  expect(view.query).toEqual({ q: '[x]?*', sort: 'credits', limit: 40 });
});

test('an invalid view fails before invoking onApply', () => {
  const applied: SessionQuery[] = [];
  expect(() => applySavedView(savedView({ period: 'custom', query: { until: '2026-02-29' } }), query => applied.push(query)))
    .toThrow();
  expect(applied).toEqual([]);
});
