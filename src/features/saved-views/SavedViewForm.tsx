import type { FormEventHandler } from 'react';
import { SAVED_VIEW_NAME_LIMIT, SAVED_VIEW_PERIODS, isSavedViewDate, type SavedViewPeriod } from '../../../shared/saved-views';
import { Button, Field, InlineNotice } from '../../components/ui';
import { AGENT_META, STATUS_LABEL, inputDate, localDateBoundary } from '../../lib/format';
import type { SavedViewDraft } from './editor';
import { useSavedViewsI18n } from './i18n';

export interface SavedViewFormProps {
  id: string;
  draft: SavedViewDraft;
  busy: boolean;
  stale: boolean;
  error: string | null;
  onChange: (draft: SavedViewDraft) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onUseCurrent?: () => void;
}

const periodLabels: Record<SavedViewPeriod, string> = {
  'all-time': '전체 기간', today: '오늘', last7: '최근 7일', last30: '최근 30일', custom: '직접 지정',
};
const sortLabels = { recent: '최근 기록순', oldest: '오래된 기록순', tokens: '토큰 많은 순', credits: '크레딧 많은 순' };
const dateInput = (value?: string) => value?.length === 10 ? value : inputDate(value);

export function SavedViewForm({
  id, draft, busy, stale, error, onChange, onSubmit, onUseCurrent,
}: SavedViewFormProps) {
  const { t, notice } = useSavedViewsI18n();
  const query = draft.query;
  const dateChange = (side: 'since' | 'until', value: string) => {
    // Keep invalid input invalid; Date must not roll an impossible day into the next month.
    const boundary = value ? isSavedViewDate(value) ? localDateBoundary(value, side === 'until') : value : undefined;
    onChange({ ...draft, query: { ...query, [side]: boundary } });
  };
  return <form id={id} className="form-stack" onSubmit={onSubmit} aria-busy={busy || undefined}>
    <fieldset className="saved-view-fields" disabled={busy}>
      <legend className="sr-only">{t('저장 검색 수정')}</legend>
      <Field label={t('검색 이름')} htmlFor={`${id}-name`}>
        <input id={`${id}-name`} data-autofocus required maxLength={SAVED_VIEW_NAME_LIMIT} value={draft.name}
          onChange={event => onChange({ ...draft, name: event.target.value })} />
      </Field>
      <Field label={t('기간')} htmlFor={`${id}-period`} hint={t('상대 기간은 열 때 현지 날짜로 다시 계산합니다.')}>
        <select id={`${id}-period`} value={draft.period}
          onChange={event => onChange({ ...draft, period: event.target.value as SavedViewPeriod })}>
          {SAVED_VIEW_PERIODS.map(period => <option key={period} value={period}>{t(periodLabels[period])}</option>)}
        </select>
      </Field>
      {draft.period === 'custom' && <div className="saved-view-dates">
        <Field label={t('시작일')} htmlFor={`${id}-since`}>
          <input id={`${id}-since`} type="date" value={dateInput(query.since)} min="0001-01-01"
            max={dateInput(query.until) || '9999-12-31'} onChange={event => dateChange('since', event.target.value)} />
        </Field>
        <Field label={t('종료일')} htmlFor={`${id}-until`}>
          <input id={`${id}-until`} type="date" value={dateInput(query.until)} max="9999-12-31"
            min={dateInput(query.since) || '0001-01-01'} onChange={event => dateChange('until', event.target.value)} />
        </Field>
      </div>}
      <label className="saved-view-pin"><input type="checkbox" checked={draft.pinned}
        onChange={event => onChange({ ...draft, pinned: event.target.checked })} />{t('빠른 검색에 고정')}</label>
      <div className="saved-view-query-preview">
        <strong>{t('저장할 조건')}</strong>
        <p>{query.q || t('모든 세션')}</p>
        <div className="saved-view-filter-summary">
          {query.agent && <span>{t('에이전트')}: {AGENT_META[query.agent].name}</span>}
          {query.project && <span>{t('프로젝트')}: {query.project}</span>}
          {query.status && <span>{t(STATUS_LABEL[query.status])}</span>}
          {query.tag && <span>{t('태그')}: {query.tag}</span>}
          {query.bookmarked && <span>{t('북마크만')}</span>}
          {query.sort && <span>{t(sortLabels[query.sort])}</span>}
          {query.limit && <span>{t('페이지당 {0}개', { 0: query.limit })}</span>}
        </div>
        {onUseCurrent && <Button size="small" onClick={onUseCurrent}>{t('현재 세션 조건 가져오기')}</Button>}
      </div>
    </fieldset>
    {stale && <InlineNotice tone="error">
      {t('다른 곳에서 이 검색을 수정했습니다.')} {t('창을 닫고 최신 조건을 확인한 뒤 다시 수정하세요.')}
    </InlineNotice>}
    {error && <InlineNotice tone="error">{notice(error)}</InlineNotice>}
  </form>;
}
