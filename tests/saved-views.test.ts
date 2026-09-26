import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureSavedViewQuery, resolveSavedView, type SavedViewPeriod, type SavedViewQuery,
} from '../shared/saved-views.js';
import { toQueryString } from '../src/lib/query.js';
import { inputDate, localDateBoundary } from '../src/lib/format.js';

afterEach(() => vi.unstubAllEnvs());

describe('opening a saved session view', () => {
  it.each([
    { period: 'today', since: '2026-09-26T04:00:00.000Z' },
    { period: 'last7', since: '2026-09-20T04:00:00.000Z' },
    { period: 'last30', since: '2026-08-28T04:00:00.000Z' },
  ] as const)('recalculates $period on the day it is opened', ({ period, since }) => {
    vi.stubEnv('TZ', 'America/New_York');
    const view = { period, query: { agent: 'kiro', sort: 'credits', limit: 40 } } as const;
    const first = resolveSavedView(view, new Date('2026-09-26T16:30:00Z'));
    expect(first).toEqual({
      agent: 'kiro', sort: 'credits', limit: 40, offset: 0,
      since, until: '2026-09-27T03:59:59.999Z',
    });
    expect(resolveSavedView(view, new Date('2026-09-27T16:30:00Z')).until)
      .toBe('2026-09-28T03:59:59.999Z');
    expect(view.query).not.toHaveProperty('since');
  });

  it.each([
    ['today', '2026-03-08T16:00:00Z', '2026-03-08T05:00:00.000Z', '2026-03-09T03:59:59.999Z'],
    ['last7', '2026-03-10T16:00:00Z', '2026-03-04T05:00:00.000Z', '2026-03-11T03:59:59.999Z'],
    ['last30', '2026-03-10T16:00:00Z', '2026-02-09T05:00:00.000Z', '2026-03-11T03:59:59.999Z'],
    ['today', '2026-11-01T17:00:00Z', '2026-11-01T04:00:00.000Z', '2026-11-02T04:59:59.999Z'],
    ['last7', '2026-11-03T17:00:00Z', '2026-10-28T04:00:00.000Z', '2026-11-04T04:59:59.999Z'],
    ['last30', '2026-11-03T17:00:00Z', '2026-10-05T04:00:00.000Z', '2026-11-04T04:59:59.999Z'],
  ] as const)('uses local calendar boundaries across DST: %s at %s', (period, now, since, until) => {
    vi.stubEnv('TZ', 'America/New_York');
    expect(resolveSavedView({ period, query: {} }, new Date(now))).toEqual({ since, until, offset: 0 });
  });

  it('handles a half-hour DST transition without subtracting 24-hour days', () => {
    vi.stubEnv('TZ', 'Australia/Lord_Howe');
    expect(resolveSavedView({ period: 'last7', query: {} }, new Date('2026-10-05T06:00:00Z'))).toEqual({
      since: '2026-09-28T13:30:00.000Z', until: '2026-10-05T12:59:59.999Z', offset: 0,
    });
  });

  it('uses the browser calendar even when the UTC date is different', () => {
    vi.stubEnv('TZ', 'Asia/Seoul');
    expect(resolveSavedView({ period: 'today', query: {} }, new Date('2026-12-31T16:00:00Z'))).toEqual({
      since: '2026-12-31T15:00:00.000Z', until: '2027-01-01T14:59:59.999Z', offset: 0,
    });
  });

  it('drops offset and obsolete dates for all-time and retains literal current filters', () => {
    const query = {
      q: ' 설정 [x]?* 100% "OR" $(echo nope) & tag=other ',
      agent: 'claude', project: '/tmp/a & b/한글', status: 'failed', bookmarked: true,
      tag: '설정 [x]%', sort: 'oldest', limit: 60, offset: 120,
      since: '2026-09-01', until: '2026-09-02',
    } as const;
    const captured = captureSavedViewQuery(query, 'all-time');
    expect(captured).toEqual({
      q: ' 설정 [x]?* 100% "OR" $(echo nope) & tag=other ',
      agent: 'claude', project: '/tmp/a & b/한글', status: 'failed', bookmarked: true,
      tag: '설정 [x]%', sort: 'oldest', limit: 60,
    });
    const resolved = resolveSavedView({ period: 'all-time', query: captured });
    expect(resolved.offset).toBe(0);
    expect(resolved).not.toHaveProperty('since');
    expect(resolved).not.toHaveProperty('until');
    const params = new URLSearchParams(toQueryString(resolved));
    expect(params.get('q')).toBe(' 설정 [x]?* 100% "OR" $(echo nope) & tag=other ');
    expect(params.get('project')).toBe('/tmp/a & b/한글');
    expect(params.get('tag')).toBe('설정 [x]%');
    expect(params.get('bookmarked')).toBe('true');
    expect(params.get('limit')).toBe('60');
    expect(params.get('offset')).toBe('0');
    expect(query.offset).toBe(120);
    expect(query.since).toBe('2026-09-01');
  });

  it('keeps custom ISO boundaries and the existing Sessions date/URL contract', () => {
    vi.stubEnv('TZ', 'America/New_York');
    const query = {
      since: localDateBoundary('2026-03-08'), until: localDateBoundary('2026-03-08', true),
      sort: 'tokens', limit: 20, offset: 80,
    } as const;
    const view = { period: 'custom', query: captureSavedViewQuery(query, 'custom') } as const;
    expect(resolveSavedView(view, new Date('2026-09-26T12:00:00Z'))).toEqual({
      since: '2026-03-08T05:00:00.000Z', until: '2026-03-09T03:59:59.999Z',
      sort: 'tokens', limit: 20, offset: 0,
    });
    expect(inputDate(resolveSavedView(view).since)).toBe('2026-03-08');
  });

  it('preserves existing date-only URL filters and one-sided custom ranges', () => {
    vi.stubEnv('TZ', 'America/New_York');
    expect(resolveSavedView({ period: 'custom', query: { since: '2026-11-01', until: '2026-11-01' } }))
      .toEqual({ since: '2026-11-01', until: '2026-11-01', offset: 0 });
    expect(resolveSavedView({ period: 'custom', query: { until: '2024-02-29' } }))
      .toEqual({ until: '2024-02-29', offset: 0 });
  });

  it('never reuses an unexpected stored offset or stale absolute relative dates', () => {
    vi.stubEnv('TZ', 'UTC');
    const query = { q: 'hello', offset: 500, since: '2020-01-01', until: '2020-01-02' };
    expect(resolveSavedView({ period: 'today', query }, new Date('2026-09-26T12:00:00Z'))).toEqual({
      q: 'hello', since: '2026-09-26T00:00:00.000Z', until: '2026-09-26T23:59:59.999Z', offset: 0,
    });
  });

  it.each([
    { since: '2026-02-29' }, { until: '2026-04-31' }, { since: '2026-13-01' },
    { since: '2026-09-26T24:00:00Z' }, { since: '2026-02-30T00:00:00Z' },
    { since: '2026-09-26T10:00:00+25:00' }, { since: 'yesterday' },
    { since: '2026-09-27', until: '2026-09-26' }, {},
  ])('refuses an invalid custom range before applying it: %j', query => {
    expect(() => resolveSavedView({ period: 'custom', query })).toThrow();
  });

  it('rejects an unknown period and an invalid clock before applying relative dates', () => {
    expect(() => resolveSavedView({ period: 'weekly' as SavedViewPeriod, query: {} })).toThrow();
    expect(() => resolveSavedView({ period: 'today', query: {} }, new Date('invalid'))).toThrow();
  });

  it('preserves explicitly false bookmark state and optional fields without mutating the view', () => {
    const query: SavedViewQuery = Object.freeze({ bookmarked: false, q: '', limit: 40 });
    expect(resolveSavedView({ period: 'all-time', query })).toEqual({ bookmarked: false, q: '', limit: 40, offset: 0 });
  });
});
