import { CalendarDays, ExternalLink, Flag } from 'lucide-react';
import type { Project } from '../../../shared/types';
import type { WorkItemDetail, WorkItemPriority, WorkItemStatus, WorkItemSummary } from '../../../shared/work-items';
import { Button, StatusBadge } from '../../components/ui';
import { workItemDueState } from './model';
import { useWorkItemI18n } from './i18n';
import './work-items.css';

export const WORK_STATUS_LABELS: Record<WorkItemStatus, string> = { todo: '할 일', in_progress: '진행 중', blocked: '막힘', done: '완료' };
export const WORK_PRIORITY_LABELS: Record<WorkItemPriority, string> = { high: '높음', normal: '보통', low: '낮음' };

export function WorkStatus({ status }: { status: WorkItemStatus }) {
  const { t } = useWorkItemI18n();
  return <span className={`work-status work-status-${status}`}><span aria-hidden />{t(WORK_STATUS_LABELS[status])}</span>;
}
export function WorkPriority({ priority }: { priority: WorkItemPriority }) {
  const { t } = useWorkItemI18n();
  return <span className={`work-priority work-priority-${priority}`}><Flag size={12} aria-hidden />{t(WORK_PRIORITY_LABELS[priority])}</span>;
}
export function WorkDueDate({ item, today }: { item: Pick<WorkItemDetail, 'dueDate' | 'status' | 'archivedAt'>; today: string }) {
  const { t } = useWorkItemI18n();
  const state = workItemDueState(item, today);
  return <span className={`work-due work-due-${state}`}><CalendarDays size={13} aria-hidden />
    {item.dueDate ? <time dateTime={item.dueDate}>{item.dueDate}</time> : t('기한 없음')}
    {state === 'overdue' && <strong>{t('기한 지남')}</strong>}
    {state === 'today' && <strong>{t('오늘')}</strong>}
  </span>;
}

export function WorkItemCard({ item, projects, today, onOpen, onOpenRun }: {
  item: WorkItemSummary; projects: Project[]; today: string; onOpen: (id: string) => void; onOpenRun: (id: string) => void;
}) {
  const { t } = useWorkItemI18n();
  return <article className="work-item-card">
    <div className="work-card-top"><WorkStatus status={item.status} /><WorkPriority priority={item.priority} /></div>
    <h3><button type="button" className="work-item-title" aria-label={t('{title} 작업 열기', { title: item.title })}
      onClick={() => onOpen(item.id)}>{item.title}</button></h3>
    {item.descriptionPreview && <p className="work-description-preview">{item.descriptionPreview}</p>}
    <p className="work-next-action"><strong>{t('다음 할 일')}</strong> {item.nextActionPreview || t('다음 행동을 정해 보세요.')}</p>
    <div className="work-card-meta">
      <span>{item.projectId ? projects.find(project => project.id === item.projectId)?.name ?? t('사용할 수 없는 프로젝트') : t('프로젝트 없음')}</span>
      <WorkDueDate item={item} today={today} />
      <span>{t('세션 {sessions}개 · 묶음 {packs}개', { sessions: item.sessionIds.length, packs: item.contextPackIds.length })}</span>
    </div>
    {item.lastRunId && <div className="work-last-run"><span>{t('마지막 실행')}</span>
      {item.lastRunStatus && <StatusBadge status={item.lastRunStatus} />}
      <Button size="small" variant="ghost" icon={ExternalLink} onClick={() => onOpenRun(item.lastRunId!)}>{t('마지막 실행 보기')}</Button>
    </div>}
  </article>;
}
