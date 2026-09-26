import { useEffect, useState } from 'react';
import { RefreshCw, Search, X } from 'lucide-react';
import type { SessionPage } from '../../../shared/types';
import { AGENTS, type Agent } from '../../../shared/types';
import { Button, InlineNotice, ProviderMark, Skeleton } from '../../components/ui';
import { api } from '../../lib/api';
import { AGENT_META } from '../../lib/format';
import { useDebounced, useResource } from '../../hooks/useResource';
import type { WorkSessionReference } from './model';
import { WORK_ITEM_UI_LIMITS, workSessionQuery } from './model';
import { useWorkItemI18n } from './i18n';

export interface SessionSelectionProps {
  page: SessionPage | null; selected: WorkSessionReference[]; loading: boolean; error: string | null;
  offset: number; limit: number; disabled: boolean;
  onToggle: (session: WorkSessionReference) => void; onPage: (offset: number) => void; onReload: () => void;
}
export interface SessionPickerProps {
  selected: WorkSessionReference[]; onToggle: (session: WorkSessionReference) => void;
  projectPath?: string; disabled?: boolean; refreshKey?: number;
}
export function SessionSelection({
  page, selected, loading, error, offset, limit, disabled, onToggle, onPage, onReload,
}: SessionSelectionProps) {
  const { t, notice } = useWorkItemI18n();
  const pending = disabled || loading;
  return <fieldset className="work-session-selection">
    <legend>{t('세션 연결')}</legend>
    <div className="work-section-heading"><span role="status">{t('{count} / 20개 선택', { count: selected.length })}</span>
      <Button size="small" icon={RefreshCw} disabled={pending} onClick={onReload}>{t('세션 다시 불러오기')}</Button>
    </div>
    <div className="work-session-chips">{selected.map(source => <Button key={source.id} size="small" icon={X} disabled={disabled}
      onClick={() => onToggle(source)}>{source.title}</Button>)}</div>
    {loading && <Skeleton rows={2} />}
    {error && <InlineNotice tone="error">{notice(error)}</InlineNotice>}
    <div className="work-session-options">{page?.items.map(session => {
      const checked = selected.some(source => source.id === session.id);
      return <label key={session.id} className="work-session-option">
        <input type="checkbox" checked={checked} disabled={pending || !!error || (!checked && selected.length >= WORK_ITEM_UI_LIMITS.sessions)}
          onChange={() => onToggle({ id: session.id, title: session.title, agent: session.agent, available: true })} />
        <ProviderMark agent={session.agent} size="small" />
        <span><strong>{session.title}</strong><small>{session.projectName}</small></span>
      </label>;
    })}</div>
    {!loading && !error && !page?.items.length && <p className="field-hint">{t('조건에 맞는 세션이 없습니다.')}</p>}
    {page && page.total > 0 && <div className="work-pagination">
      <Button size="small" disabled={pending || offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>{t('이전 페이지')}</Button>
      <span>{page.items.length ? offset + 1 : 0}–{page.items.length ? Math.min(offset + page.items.length, page.total) : 0} / {page.total}</span>
      <Button size="small" disabled={pending || offset + limit >= page.total} onClick={() => onPage(offset + limit)}>{t('다음 페이지')}</Button>
    </div>}
  </fieldset>;
}
export function SessionPicker({ selected, onToggle, projectPath, disabled = false, refreshKey = 0 }: SessionPickerProps) {
  const { t } = useWorkItemI18n();
  const [q, setQ] = useState('');
  const [agent, setAgent] = useState<Agent | undefined>();
  const [onlyProject, setOnlyProject] = useState(!!projectPath);
  const filteredProject = onlyProject ? projectPath : undefined;
  const [page, setPage] = useState({ projectPath: filteredProject, offset: 0 });
  useEffect(() => {
    setPage(current => current.projectPath === filteredProject ? current : { projectPath: filteredProject, offset: 0 });
  }, [filteredProject]);
  const debounced = useDebounced(q);
  const query = workSessionQuery({ q: debounced, agent, projectPath: filteredProject }, page);
  const offset = query.offset ?? 0;
  const setOffset = (offset: number) => setPage({ projectPath: filteredProject, offset });
  const key = JSON.stringify(query);
  const resource = useResource(signal => api.sessions(query, signal), `${key}:${refreshKey}`, false);
  return <div className="work-session-picker">
    <div className="work-filter-top"><div className="search-input"><Search size={16} aria-hidden />
      <input aria-label={t('세션 이름과 내용 검색')} placeholder={t('세션 이름과 내용 검색')} maxLength={500} disabled={disabled} value={q}
        onChange={event => { setQ(event.target.value); setOffset(0); }} />
    </div>
      <select aria-label={t('세션 에이전트')} value={agent ?? ''} disabled={disabled}
        onChange={event => { setAgent(event.target.value as Agent || undefined); setOffset(0); }}>
        <option value="">{t('모든 에이전트')}</option>{AGENTS.map(agent => <option key={agent} value={agent}>{AGENT_META[agent].name}</option>)}
      </select>
    </div>
    {projectPath && <label className="work-archive-filter"><input type="checkbox" checked={onlyProject}
      onChange={event => setOnlyProject(event.target.checked)} />{t('이 프로젝트의 세션만')}</label>}
    <SessionSelection page={resource.data} selected={selected} loading={resource.loading || q !== debounced} error={resource.error}
      offset={offset} limit={10} disabled={disabled} onToggle={onToggle} onPage={setOffset} onReload={resource.reload} />
  </div>;
}
