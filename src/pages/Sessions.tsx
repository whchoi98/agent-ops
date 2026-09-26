import { useI18n, Trans } from '../i18n/I18nProvider';
import { lazy, Suspense, useMemo, useState } from 'react';
import {
  Bookmark, Check, ChevronLeft, ChevronRight, GitCompareArrows, ListFilter, RefreshCw, Search, SlidersHorizontal, X,
} from 'lucide-react';
import { AGENTS, type Agent, type Session, type SessionQuery, type SessionStatus } from '../../shared/types';
import { SessionTable } from '../components/SessionTable';
import { Button, EmptyState, ErrorState, Field, IconButton, PageHeading, ProviderMark, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { AGENT_META, inputDate, localDateBoundary, number } from '../lib/format';
import { useDebounced, useResource } from '../hooks/useResource';
import { useApp, useData } from '../state/AppProvider';
import { useCreditI18n } from '../features/usage/i18n';

const SavedViewsBar = lazy(() => import('../features/saved-views').then(module => ({ default: module.SavedViewsBar })));

function readQuery(search: string): SessionQuery {
  const params = new URLSearchParams(search);
  const agent = params.get('agent') as Agent;
  const status = params.get('status') as SessionStatus;
  const sort = params.get('sort') as SessionQuery['sort'];
  return {
    q: params.get('q') || undefined, agent: AGENTS.includes(agent) ? agent : undefined,
    project: params.get('project') || undefined,
    status: ['completed', 'failed', 'recorded'].includes(status) ? status : undefined,
    bookmarked: params.get('bookmarked') === 'true' || undefined,
    tag: params.get('tag') || undefined,
    since: params.get('since') || undefined, until: params.get('until') || undefined,
    sort: sort && ['recent', 'oldest', 'tokens', 'credits'].includes(sort) ? sort : 'recent',
    limit: Number.isInteger(Number(params.get('limit'))) && Number(params.get('limit')) >= 1 && Number(params.get('limit')) <= 200
      ? Number(params.get('limit')) : 20,
    offset: Math.max(0, Number(params.get('offset')) || 0),
  };
}

export function Sessions() {
  const { t } = useI18n();
  const { t: creditT } = useCreditI18n();
  const data = useData();
  const { search, navigate, archiveRevision, productivityRevision, openCompare, notify, sync, syncing } = useApp();
  const query = useMemo(() => readQuery(search), [search]);
  const debouncedQ = useDebounced(query.q ?? '');
  const debouncedTag = useDebounced(query.tag ?? '');
  const requestQuery = { ...query, q: debouncedQ, tag: debouncedTag };
  const resource = useResource(signal => api.sessions(requestQuery, signal), `${JSON.stringify(requestQuery)}:${archiveRevision}`, true);
  const [expanded, setExpanded] = useState(!!(query.tag || query.since || query.until || query.status));
  const [selection, setSelection] = useState<Session[]>([]);
  const selectedIds = new Set(selection.map(session => session.id));
  const isSearching = resource.loading || debouncedQ !== (query.q ?? '') || debouncedTag !== (query.tag ?? '');
  const update = (patch: SessionQuery) => navigate('sessions', { ...query, offset: 0, ...patch }, true);
  const clear = () => navigate('sessions', {}, true);
  const filtered = !!(query.q || query.agent || query.project || query.status || query.bookmarked || query.tag || query.since || query.until);
  const advancedCount = [query.status, query.tag, query.since, query.until].filter(Boolean).length;
  const total = resource.data?.total ?? 0;
  const limit = query.limit ?? 20;
  const offset = query.offset ?? 0;
  const page = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const pageNumbers = [...new Set([1, ...Array.from({ length: 3 }, (_, i) => page + i - 1), pageCount])]
    .filter(value => value > 0 && value <= pageCount).sort((a, b) => a - b);
  const knownTags = [...new Set(data.sessions.flatMap(session => session.tags))].sort();
  function select(session: Session) {
    if (selection.some(item => item.id === session.id)) setSelection(items => items.filter(item => item.id !== session.id));
    else if (selection.length < 2) setSelection(items => [...items, session]);
    else notify('비교할 세션은 2개까지 선택할 수 있습니다.', 'info');
  }
  return <>
    <PageHeading title={t("세션 탐색")} description={t("대화의 전체 내용을 검색하고, 필요한 맥락에서 다시 시작하세요.")} eyebrow="SESSION EXPLORER"
      actions={<Button icon={RefreshCw} busy={syncing} onClick={() => void sync()}><Trans message={"세션 동기화"} /></Button>} />
    <Suspense fallback={<Skeleton rows={1} />}>
      <SavedViewsBar query={query} revision={productivityRevision} onApply={value => navigate('sessions', value, true)} />
    </Suspense>
    <section className="panel session-explorer">
      <div className="explorer-search-row"><div className="search-input search-input-large">
        <Search size={19} aria-hidden /><input aria-label={t("세션 전체 내용 검색")} maxLength={500} placeholder={t("제목과 대화 내용 검색…")} value={query.q ?? ''}
          onChange={event => update({ q: event.target.value })} />
        {query.q && <IconButton label={t("검색어 지우기")} icon={X} onClick={() => update({ q: undefined })} />}
        <span className="search-scope"><Trans message={"전체 대화 검색"} /></span>
      </div></div>
      <div className="explorer-toolbar">
        <div className="provider-tabs" aria-label={t("에이전트 필터")}>
          <button aria-label={t("전체 에이전트")} aria-pressed={!query.agent} className={!query.agent ? 'active' : ''} onClick={() => update({ agent: undefined })}>
            <span className="provider-all-desktop"><Trans message={"전체 에이전트"} /></span><span className="provider-all-mobile"><Trans message={"전체"} /></span>
          </button>
          {AGENTS.map(agent => <button key={agent} className={query.agent === agent ? 'active' : ''} aria-pressed={query.agent === agent}
            onClick={() => update({ agent })}><ProviderMark agent={agent} size="small" />{AGENT_META[agent].short}</button>)}
        </div>
        <div className="explorer-quick-filters">
          <select aria-label={t("프로젝트 필터")} value={query.project ?? ''} onChange={event => update({ project: event.target.value || undefined })}>
            <option value=""><Trans message={"모든 프로젝트"} /></option>{data.projects.map(project => <option key={project.id} value={project.path}>{project.name}</option>)}
          </select>
          <button className={`filter-button ${query.bookmarked ? 'filter-active' : ''}`} aria-pressed={!!query.bookmarked}
            onClick={() => update({ bookmarked: query.bookmarked ? undefined : true })}><Bookmark size={15} aria-hidden /><Trans message={"북마크"} /></button>
          <button className={`filter-button ${expanded || advancedCount ? 'filter-active' : ''}`} aria-expanded={expanded} aria-controls="advanced-session-filters"
            onClick={() => setExpanded(value => !value)}><SlidersHorizontal size={15} aria-hidden /><Trans message={"필터{0}"} values={{ "0": advancedCount > 0 && <span>{advancedCount}</span> }} /></button>
        </div>
      </div>
      {expanded && <div className="advanced-filters" id="advanced-session-filters">
        <Field label={t("상태")} htmlFor="session-status"><select id="session-status" value={query.status ?? ''}
          onChange={event => update({ status: (event.target.value || undefined) as SessionQuery['status'] })}>
          <option value=""><Trans message={"모든 상태"} /></option><option value="recorded"><Trans message={"기록됨"} /></option><option value="completed"><Trans message={"완료"} /></option><option value="failed"><Trans message={"실패"} /></option>
        </select></Field>
        <Field label={t("태그")} htmlFor="session-tag"><input id="session-tag" maxLength={60} value={query.tag ?? ''} list="known-session-tags"
          placeholder={t("태그 이름")} onChange={event => update({ tag: event.target.value || undefined })} />
          <datalist id="known-session-tags">{knownTags.map(tag => <option value={tag} key={tag} />)}</datalist>
        </Field>
        <Field label={t("시작일")} htmlFor="session-since"><input id="session-since" type="date" value={inputDate(query.since)}
          max={inputDate(query.until) || undefined} onChange={event => update({ since: localDateBoundary(event.target.value) })} /></Field>
        <Field label={t("종료일")} htmlFor="session-until"><input id="session-until" type="date" value={inputDate(query.until)}
          min={inputDate(query.since) || undefined} onChange={event => update({ until: localDateBoundary(event.target.value, true) })} /></Field>
        <div className="filter-reset"><button className="text-button" onClick={clear}><Trans message={"필터 초기화"} /></button><span><Trans message={"날짜는 현지 시간 기준"} /></span></div>
      </div>}
      <div className="results-heading"><span><strong>{number(total)}</strong><Trans message={"개 세션{0}"} values={{ "0": isSearching && <span className="results-pending">{t('검색 중…')}</span> }} /></span>
        <div>{filtered && <button className="text-button clear-filters" onClick={clear}><X size={12} aria-hidden /><Trans message={"조건 지우기"} /></button>}
          <label className="sort-control"><ListFilter size={14} aria-hidden /><span className="sr-only"><Trans message={"세션 정렬"} /></span><select value={query.sort}
            onChange={event => update({ sort: event.target.value as SessionQuery['sort'] })}>
            <option value="recent"><Trans message={"최근 기록순"} /></option><option value="oldest"><Trans message={"오래된 기록순"} /></option><option value="tokens"><Trans message={"토큰 많은 순"} /></option>
            <option value="credits">{creditT('크레딧 많은 순')}</option>
          </select></label>
        </div>
      </div>
      {resource.error ? <ErrorState message={resource.error} retry={resource.reload} /> : !resource.data ? <Skeleton rows={7} className="table-skeleton" />
        : resource.data.items.length ? <div className={isSearching ? 'results-loading' : ''} aria-busy={isSearching}>
          <SessionTable sessions={resource.data.items} selected={selectedIds} onSelect={select} onChange={resource.reload} />
        </div> : <EmptyState icon={Search} title={filtered ? t("검색 조건에 맞는 세션이 없습니다") : t("아직 세션이 없습니다")}
          description={filtered ? t("검색어를 바꾸거나 필터를 초기화해 보세요.") : t("기록 경로를 설정하고 동기화하면 세션이 표시됩니다.")}
          action={filtered ? <Button onClick={clear}><Trans message={"필터 초기화"} /></Button> : <Button onClick={() => navigate('settings')}><Trans message={"기록 경로 설정"} /></Button>} />}
      {resource.data && total > 0 && <div className="pagination">
        <div className="pagination-summary"><span>{number(Math.min(offset + 1, total))}–{number(Math.min(offset + limit, total))} / {number(total)}</span>
          <select aria-label={t("페이지당 세션 수")} value={limit} onChange={event => update({ limit: Number(event.target.value) })}>
            {![20, 40, 60].includes(limit) && <option value={limit}>{t('{0}개씩', { 0: limit })}</option>}
            <option value={20}><Trans message={"20개씩"} /></option><option value={40}><Trans message={"40개씩"} /></option><option value={60}><Trans message={"60개씩"} /></option>
          </select>
        </div>
        <nav aria-label={t("세션 페이지")} className="pagination-controls">
          <IconButton label={t("이전 페이지")} icon={ChevronLeft} disabled={offset === 0 || isSearching} onClick={() => update({ offset: Math.max(0, offset - limit) })} />
          {pageNumbers.map((item, index) => <span key={item} className="page-number-item">
            {index > 0 && item - pageNumbers[index - 1] > 1 && <span className="pagination-ellipsis">…</span>}
            <button className={`page-number ${page === item ? 'current' : ''}`} aria-label={t("{0}페이지", { "0": item })}
              aria-current={page === item ? 'page' : undefined} disabled={isSearching} onClick={() => update({ offset: (item - 1) * limit })}>{item}</button>
          </span>)}
          <IconButton label={t("다음 페이지")} icon={ChevronRight} disabled={offset + limit >= total || isSearching} onClick={() => update({ offset: offset + limit })} />
        </nav>
      </div>}
    </section>
    <p className="page-footnote"><Trans message={"체크박스로 세션 2개를 선택하면 모델, 사용량과 기록 시간을 비교할 수 있습니다. "} /><span><Trans message={"미기록은 사용량 0을 뜻하지 않습니다."} /></span></p>
    {selection.length > 0 && <div className="selection-tray">
      <span className="selection-icon"><Check size={17} aria-hidden /></span><strong><Trans message={"{0}개 선택"} values={{ "0": selection.length }} /></strong>
      <div className="selection-items">{selection.map(session => <span key={session.id}><ProviderMark agent={session.agent} size="small" />
        <span>{session.title}</span><IconButton icon={X} label={t("{0} 비교 선택 해제", { "0": session.title })} onClick={() => select(session)} /></span>)}</div>
      <Button variant="primary" size="small" icon={GitCompareArrows} disabled={selection.length !== 2}
        onClick={() => openCompare([selection[0].id, selection[1].id])}><Trans message={"세션 비교"} /></Button>
      <IconButton icon={X} label={t("선택 모두 해제")} onClick={() => setSelection([])} />
    </div>}
  </>;
}
