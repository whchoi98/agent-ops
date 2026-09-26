import type { CSSProperties } from 'react';
import { ClipboardList, LayoutGrid, List, Plus, RefreshCw, Search } from 'lucide-react';
import type { Project } from '../../../shared/types';
import type { WorkItemPage, WorkItemQuery } from '../../../shared/work-items';
import { WORK_ITEM_PRIORITIES, WORK_ITEM_STATUSES } from '../../../shared/work-items';
import { Button, EmptyState, PageHeading, InlineNotice, Skeleton } from '../../components/ui';
import { useWorkItemI18n } from './i18n';
import { workItemColumns, workItemRange } from './model';
import { WorkItemCard, WORK_PRIORITY_LABELS, WORK_STATUS_LABELS } from './ui';

export interface WorkItemsViewProps {
  page: WorkItemPage | null;
  query: WorkItemQuery;
  projects: Project[];
  mode: 'list' | 'board';
  today: string;
  loading: boolean;
  error: string | null;
  onFilters: (patch: Partial<WorkItemQuery>) => void;
  onPage: (offset: number) => void;
  onMode: (mode: 'list' | 'board') => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onOpenRun: (id: string) => void;
  onReload: () => void;
}
export function WorkItemsView({
  page, query, projects, mode, today, loading, error, onFilters, onPage, onMode, onNew, onOpen, onOpenRun, onReload,
}: WorkItemsViewProps) {
  const { t, notice } = useWorkItemI18n();
  const range = page ? workItemRange(page) : null;
  const columns = page ? workItemColumns(page, query.status) : [];
  const filtered = !!(query.q || query.projectId || query.priority || query.due || (query.status && query.status !== 'open'));
  const limit = query.limit ?? 25;
  return <>
    <PageHeading title={t('작업센터')} eyebrow="WORK ITEMS" description={t('해야 할 일과 다음 행동, 참고할 세션을 한곳에서 관리하세요.')}
      actions={<Button variant="primary" icon={Plus} onClick={onNew}>{t('새 작업')}</Button>} />
    <section className="panel work-filters" aria-label={t('작업 검색')}>
      <div className="work-filter-top">
        <div className="search-input"><Search size={17} aria-hidden />
          <input aria-label={t('작업 검색')} placeholder={t('작업 제목과 설명 검색')} maxLength={200} value={query.q ?? ''}
            onChange={event => onFilters({ q: event.target.value || undefined })} />
        </div>
        <div className="work-view-switch" aria-label={t('작업센터')}>
          <Button size="small" icon={List} aria-pressed={mode === 'list'} onClick={() => onMode('list')}>{t('목록 보기')}</Button>
          <Button size="small" icon={LayoutGrid} aria-pressed={mode === 'board'} onClick={() => onMode('board')}>{t('보드 보기')}</Button>
        </div>
      </div>
      <div className="work-filter-controls">
        <select aria-label={t('프로젝트 필터')} value={query.projectId ?? ''} onChange={event => onFilters({ projectId: event.target.value || undefined })}>
          <option value="">{t('모든 프로젝트')}</option>
          {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <select aria-label={t('작업 상태')} value={query.status ?? ''} onChange={event => onFilters({ status: event.target.value as WorkItemQuery['status'] || undefined })}>
          <option value="open">{t('진행할 작업')}</option><option value="">{t('모든 상태')}</option>
          {WORK_ITEM_STATUSES.map(status => <option key={status} value={status}>{t(WORK_STATUS_LABELS[status])}</option>)}
        </select>
        <select aria-label={t('우선순위')} value={query.priority ?? ''} onChange={event => onFilters({ priority: event.target.value as WorkItemQuery['priority'] || undefined })}>
          <option value="">{t('모든 우선순위')}</option>
          {WORK_ITEM_PRIORITIES.map(priority => <option key={priority} value={priority}>{t(WORK_PRIORITY_LABELS[priority])}</option>)}
        </select>
        <select aria-label={t('기한')} value={query.due ?? ''} onChange={event => onFilters({ due: event.target.value as WorkItemQuery['due'] || undefined })}>
          <option value="">{t('모든 기한')}</option><option value="overdue">{t('기한 지남')}</option>
          <option value="today">{t('오늘')}</option><option value="week">{t('앞으로 7일')}</option><option value="none">{t('기한 없음')}</option>
        </select>
        <label className="work-archive-filter"><input type="checkbox" checked={!!query.archived}
          onChange={event => onFilters({ archived: event.target.checked, status: event.target.checked ? undefined : 'open' })} />{t('보관함')}</label>
        <select aria-label={t('작업 정렬')} value={query.sort ?? 'priority'} onChange={event => onFilters({ sort: event.target.value as WorkItemQuery['sort'] })}>
          <option value="priority">{t('우선순위순')}</option><option value="recent">{t('최근 수정순')}</option><option value="due">{t('기한순')}</option>
        </select>
        <Button size="small" icon={RefreshCw} disabled={loading} onClick={onReload}>{t('작업 새로고침')}</Button>
      </div>
    </section>
    {error && <InlineNotice tone="error">{notice(error)}</InlineNotice>}
    {loading && !page && <Skeleton rows={5} />}
    {page && <div aria-busy={loading || undefined} className={loading ? 'work-results work-results-pending' : 'work-results'}>
      {mode === 'board' ? <div className="work-board" style={{ '--work-columns': columns.length } as CSSProperties}>
        {columns.map(column => <section className="work-board-column" key={column.status} aria-label={t(WORK_STATUS_LABELS[column.status])}>
          <div className="work-column-heading"><h2>{t(WORK_STATUS_LABELS[column.status])}</h2>
            <span>{t('표시 {visible} / 전체 {total}', { visible: column.visible, total: column.total })}</span>
          </div>
          {column.items.length ? column.items.map(item => <WorkItemCard key={item.id} item={item} projects={projects} today={today}
            onOpen={onOpen} onOpenRun={onOpenRun} />) : <p className="work-column-empty">{t('이 페이지에 표시할 작업이 없습니다.')}</p>}
        </section>)}
      </div> : <div className="work-item-list">{page.items.map(item => <WorkItemCard key={item.id} item={item}
        projects={projects} today={today} onOpen={onOpen} onOpenRun={onOpenRun} />)}</div>}
      {range && <div className="work-pagination">
        <span className="numeric">{range.from}–{range.to} / {range.total}</span>
        <select aria-label={t('페이지당 작업 수')} value={limit} onChange={event => onFilters({ limit: Number(event.target.value) })}>
          {[...new Set([25, 50, 100, limit])].sort((a, b) => a - b).map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <nav aria-label={t('작업센터')}>
          <Button size="small" disabled={loading || page.offset === 0} onClick={() => onPage(Math.max(0, page.offset - page.limit))}>{t('이전 페이지')}</Button>
          <Button size="small" disabled={loading || page.offset + page.limit >= page.total} onClick={() => onPage(page.offset + page.limit)}>{t('다음 페이지')}</Button>
        </nav>
      </div>}
    </div>}
    {!loading && !error && page && page.total === 0 && <EmptyState icon={ClipboardList}
      title={query.archived ? t('보관한 작업이 없습니다') : filtered ? t('조건에 맞는 작업이 없습니다') : t('아직 작업이 없습니다')}
      description={filtered ? t('검색어나 필터를 바꿔보세요.') : t('새 작업을 만들거나 세션에서 이어 할 일을 정리하세요.')}
      action={filtered ? <Button onClick={() => onFilters({ q: undefined, projectId: undefined, priority: undefined, due: undefined, status: 'open', archived: false })}>{t('조건 초기화')}</Button>
        : <Button icon={Plus} onClick={onNew}>{t('새 작업')}</Button>} />}
    <p className="page-footnote">{t('실행이 끝나도 작업은 자동으로 완료되지 않습니다.')}</p>
  </>;
}
