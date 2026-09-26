import { useEffect, useRef, useState } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import type { Project } from '../../../shared/types';
import type { WorkItemPage, WorkItemSummary } from '../../../shared/work-items';
import { Button, InlineNotice, Panel, Skeleton } from '../../components/ui';
import { errorMessage } from '../../lib/format';
import { useApp, useData } from '../../state/AppProvider';
import { workItemsApi } from './api';
import { workItemLink } from './model';
import { useLocalWorkDate, useOpenWorkItems } from './useWorkItems';
import { useWorkItemI18n } from './i18n';
import { WorkDueDate, WorkStatus } from './ui';

export interface OpenWorkItemsProps { projectId?: string; className?: string }
export interface OpenWorkItemsViewProps {
  page: WorkItemPage | null; projects: Project[]; today: string;
  loading: boolean; error: string | null; onReload: () => void;
  pendingId: string | null; onComplete: (item: WorkItemSummary) => void;
}
export function OpenWorkItemsView({ page, projects, today, loading, error, onReload, pendingId, onComplete }: OpenWorkItemsViewProps) {
  const { t, notice } = useWorkItemI18n();
  return <Panel title={t('진행할 작업')} className="open-work-items"
    actions={<a className="text-button" href={workItemLink()}>{t('모든 작업 보기')}<ArrowRight size={13} aria-hidden /></a>}>
    <div className="work-widget-body" aria-busy={loading || undefined}>
      {loading && !page && <Skeleton rows={3} />}
      {error && <InlineNotice tone="error">{notice(error)}
        <Button size="small" icon={RefreshCw} disabled={loading || pendingId !== null} onClick={onReload}>{t('작업 새로고침')}</Button>
      </InlineNotice>}
      {page && <>
        <p className="work-widget-count">{t('진행할 작업 {total}개 중 {visible}개 표시', { total: page.total, visible: page.items.length })}</p>
        <ul className="work-widget-list">{page.items.map(item => <li key={item.id} aria-busy={pendingId === item.id || undefined}>
          <label className="work-widget-check">
            <input type="checkbox" checked={pendingId === item.id || item.status === 'done'}
              disabled={loading || pendingId !== null} onChange={() => onComplete(item)} />
            <span className="sr-only">{t('{title} 작업 완료', { title: item.title })}</span>
          </label>
          <div className="work-widget-item">
            <div className="work-widget-item-header"><a href={workItemLink(item.id)}>{item.title}</a><WorkStatus status={item.status} /></div>
            {item.nextActionPreview && <p>{item.nextActionPreview}</p>}
            <div className="work-card-meta"><span>{item.projectId
              ? projects.find(project => project.id === item.projectId)?.name ?? t('사용할 수 없는 프로젝트') : t('프로젝트 없음')}</span>
              <WorkDueDate item={item} today={today} /></div>
          </div>
        </li>)}</ul>
        {!page.items.length && <p className="field-hint">{t('진행할 작업이 없습니다.')}</p>}
      </>}
    </div>
  </Panel>;
}
export function OpenWorkItems({ projectId, className }: OpenWorkItemsProps) {
  const { productivityRevision, notify } = useApp();
  const { t } = useWorkItemI18n();
  const { projects } = useData();
  const today = useLocalWorkDate();
  const resource = useOpenWorkItems(projectId, productivityRevision);
  const pending = useRef<AbortController | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);
  useEffect(() => {
    setPendingId(null);
    setCompletionError(null);
    return () => { pending.current?.abort(); pending.current = null; };
  }, [projectId]);

  async function complete(item: WorkItemSummary) {
    if (pending.current || resource.loading) return;
    const controller = new AbortController();
    pending.current = controller;
    setPendingId(item.id);
    setCompletionError(null);
    try {
      await workItemsApi.update(item.id, { version: item.version, status: 'done' }, controller.signal);
      if (pending.current !== controller || controller.signal.aborted) return;
      resource.reload();
      notify(t('작업을 완료했습니다.'));
    } catch (cause) {
      if (pending.current === controller && !controller.signal.aborted) setCompletionError(errorMessage(cause));
    } finally {
      if (pending.current === controller) { pending.current = null; setPendingId(null); }
    }
  }
  function reload() { setCompletionError(null); resource.reload(); }
  return <div className={className}><OpenWorkItemsView {...resource} projects={projects} today={today}
    error={completionError ?? resource.error} pendingId={pendingId} onComplete={complete} onReload={reload} /></div>;
}
