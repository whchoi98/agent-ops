import { ArrowRight, RefreshCw } from 'lucide-react';
import type { Project } from '../../../shared/types';
import type { WorkItemPage } from '../../../shared/work-items';
import { Button, InlineNotice, Panel, Skeleton } from '../../components/ui';
import { useApp, useData } from '../../state/AppProvider';
import { workItemLink } from './model';
import { useLocalWorkDate, useOpenWorkItems } from './useWorkItems';
import { useWorkItemI18n } from './i18n';
import { WorkDueDate, WorkStatus } from './ui';

export interface OpenWorkItemsProps { projectId?: string; className?: string }
export interface OpenWorkItemsViewProps {
  page: WorkItemPage | null; projects: Project[]; today: string;
  loading: boolean; error: string | null; onReload: () => void;
}
export function OpenWorkItemsView({ page, projects, today, loading, error, onReload }: OpenWorkItemsViewProps) {
  const { t, notice } = useWorkItemI18n();
  return <Panel title={t('진행할 작업')} className="open-work-items"
    actions={<a className="text-button" href={workItemLink()}>{t('모든 작업 보기')}<ArrowRight size={13} aria-hidden /></a>}>
    {loading && !page && <Skeleton rows={3} />}
    {error && <InlineNotice tone="error">{notice(error)}
      <Button size="small" icon={RefreshCw} disabled={loading} onClick={onReload}>{t('작업 새로고침')}</Button>
    </InlineNotice>}
    {page && <div aria-busy={loading || undefined}>
      <p className="work-widget-count">{t('진행할 작업 {total}개 중 {visible}개 표시', { total: page.total, visible: page.items.length })}</p>
      <ul className="work-widget-list">{page.items.map(item => <li key={item.id}>
        <div><a href={workItemLink(item.id)}>{item.title}</a><WorkStatus status={item.status} /></div>
        {item.nextActionPreview && <p>{item.nextActionPreview}</p>}
        <div className="work-card-meta"><span>{item.projectId
          ? projects.find(project => project.id === item.projectId)?.name ?? t('사용할 수 없는 프로젝트') : t('프로젝트 없음')}</span>
          <WorkDueDate item={item} today={today} /></div>
      </li>)}</ul>
      {!page.items.length && <p className="field-hint">{t('진행할 작업이 없습니다.')}</p>}
    </div>}
  </Panel>;
}
export function OpenWorkItems({ projectId, className }: OpenWorkItemsProps) {
  const { productivityRevision } = useApp();
  const { projects } = useData();
  const today = useLocalWorkDate();
  const resource = useOpenWorkItems(projectId, productivityRevision);
  return <div className={className}><OpenWorkItemsView {...resource} projects={projects} today={today} onReload={resource.reload} /></div>;
}
