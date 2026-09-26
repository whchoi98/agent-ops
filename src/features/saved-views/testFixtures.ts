import type { SavedView } from '../../../shared/saved-views';

export function savedView(patch: Partial<SavedView> = {}): SavedView {
  return {
    id: 'saved-view-01234567-89ab-4cde-8fab-0123456789ab',
    name: '설정 [x]?* & review', query: { q: '[x]?*', agent: 'kiro', sort: 'credits', limit: 40 },
    period: 'last7', pinned: true, version: 1,
    createdAt: '2026-09-26T10:00:00.000Z', updatedAt: '2026-09-26T10:00:00.000Z',
    ...patch,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
