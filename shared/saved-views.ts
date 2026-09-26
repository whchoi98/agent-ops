import type { SessionQuery } from './types.js';

export const SAVED_VIEW_PERIODS = ['all-time', 'today', 'last7', 'last30', 'custom'] as const;
export const SAVED_VIEW_LIMIT = 50;
export const SAVED_VIEW_NAME_LIMIT = 120;
export type SavedViewPeriod = (typeof SAVED_VIEW_PERIODS)[number];
/** Uses the existing session API/URL keys. Pagination position is never saved. */
export type SavedViewQuery = Omit<SessionQuery, 'offset'>;

export interface SavedView {
  id: string;
  name: string;
  query: SavedViewQuery;
  period: SavedViewPeriod;
  pinned: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSavedView {
  name: string;
  query: SavedViewQuery;
  period?: SavedViewPeriod;
  pinned?: boolean;
}

export interface UpdateSavedView {
  version: number;
  name?: string;
  query?: SavedViewQuery;
  period?: SavedViewPeriod;
  pinned?: boolean;
}

export interface SavedViewList { items: SavedView[] }
export interface DeleteSavedView { version: number }

/** Reject rollover dates such as February 30, which Date.parse otherwise accepts. */
export function isSavedViewDate(value: string): boolean {
  if (typeof value !== 'string' || value.length > 40) return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if (!parts) return false;
  const [, yearText, monthText, dayText, hour, minute, second, zone] = parts;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return false;
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59)) return false;
  if (zone && zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

/** Custom date-only boundaries retain the session API's inclusive-until semantics. */
export function savedViewRangeError(
  query: SavedViewQuery, period: SavedViewPeriod, interpretServerLocalDates = false,
): string | null {
  if (!SAVED_VIEW_PERIODS.includes(period)) return '저장 검색의 기간을 선택하세요.';
  if (period !== 'custom') {
    return query.since !== undefined || query.until !== undefined
      ? '상대 기간과 전체 기간에는 고정 날짜를 저장할 수 없습니다.' : null;
  }
  if (query.since === undefined && query.until === undefined) return '시작일 또는 종료일을 입력하세요.';
  if ((query.since !== undefined && !isSavedViewDate(query.since))
    || (query.until !== undefined && !isSavedViewDate(query.until))) return '올바른 날짜를 입력하세요.';
  if (query.since && query.until) {
    const naive = (value: string) => value.includes('T') && !/(?:Z|[+-]\d{2}:\d{2})$/.test(value);
    // The session API interprets timezone-free timestamps on its host. A browser
    // in another timezone cannot reject or reinterpret that accepted filter.
    if (!interpretServerLocalDates && (naive(query.since) || naive(query.until))) return null;
    const until = query.until.length === 10 ? `${query.until}T23:59:59.999Z` : query.until;
    if (Date.parse(query.since) > Date.parse(until)) return '종료일은 시작일보다 빠를 수 없습니다.';
  }
  return null;
}

export function captureSavedViewQuery(query: SessionQuery, period: SavedViewPeriod): SavedViewQuery {
  const { offset: _offset, ...filters } = query;
  if (period !== 'custom') {
    delete filters.since;
    delete filters.until;
  }
  return filters;
}

/**
 * Call at the user's open action, not when fetching the list. The result replaces
 * the current Sessions query; use the existing navigate/toQueryString contract.
 */
export function resolveSavedView(
  view: Pick<SavedView, 'query' | 'period'>, now: Date = new Date(),
): SessionQuery {
  const query = captureSavedViewQuery(view.query, view.period);
  const invalid = savedViewRangeError(query, view.period);
  if (invalid) throw new Error(invalid);
  if (view.period === 'all-time' || view.period === 'custom') return { ...query, offset: 0 };
  if (!Number.isFinite(now.getTime())) throw new Error('올바른 날짜를 입력하세요.');
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  // Calendar arithmetic preserves local midnight across 23/25-hour and half-hour DST days.
  since.setDate(since.getDate() - (view.period === 'last7' ? 6 : view.period === 'last30' ? 29 : 0));
  const until = new Date(now);
  until.setHours(23, 59, 59, 999);
  return { ...query, since: since.toISOString(), until: until.toISOString(), offset: 0 };
}
