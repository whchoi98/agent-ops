import {
  captureSavedViewQuery, resolveSavedView, savedViewRangeError, SAVED_VIEW_NAME_LIMIT,
  type CreateSavedView, type SavedView,
} from '../../../shared/saved-views';
import type { SessionQuery } from '../../../shared/types';

export type SavedViewDraft = Required<CreateSavedView>;

export function createSavedViewDraft(query: SessionQuery, view?: SavedView): SavedViewDraft {
  return {
    name: view?.name ?? '', query: captureSavedViewQuery(view?.query ?? query, 'custom'),
    period: view?.period ?? (query.since || query.until ? 'custom' : 'all-time'), pinned: view?.pinned ?? false,
  };
}

export function replaceSavedViewQuery(draft: SavedViewDraft, query: SessionQuery): SavedViewDraft {
  const current = createSavedViewDraft(query);
  return { ...draft, query: current.query, period: current.period };
}

export function buildSavedViewInput(draft: SavedViewDraft): CreateSavedView {
  if (!draft.name.trim()) throw new Error('저장 검색 이름을 입력하세요.');
  if (draft.name.length > SAVED_VIEW_NAME_LIMIT) throw new Error('저장 검색 이름은 120자까지 입력할 수 있습니다.');
  if (/[\u0000-\u001f\u007f]/.test(draft.name)) throw new Error('검색 이름에는 제어 문자를 사용할 수 없습니다.');
  const query = captureSavedViewQuery(draft.query, draft.period);
  const invalid = savedViewRangeError(query, draft.period);
  if (invalid) throw new Error(invalid);
  return { name: draft.name.trim(), query, period: draft.period, pinned: draft.pinned };
}

export function applySavedView(
  view: SavedView, onApply: (query: SessionQuery) => void, now: Date = new Date(),
): void {
  onApply(resolveSavedView(view, now));
}
