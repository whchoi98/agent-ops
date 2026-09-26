import type { ReactNode } from 'react';
import { Archive, Link, Play, RotateCcw, Save, Trash2, X } from 'lucide-react';
import type { Project } from '../../../shared/types';
import type { WorkItemFields } from '../../../shared/work-items';
import { WORK_ITEM_PRIORITIES, WORK_ITEM_STATUSES } from '../../../shared/work-items';
import { Button, Field, IconButton } from '../../components/ui';
import type { WorkItemDraft, WorkSessionReference } from './model';
import { WORK_ITEM_UI_LIMITS } from './model';
import type { WorkItemEditorAction } from './editor-resource';
import { useWorkItemI18n } from './i18n';
import { WORK_PRIORITY_LABELS, WORK_STATUS_LABELS } from './ui';

export interface WorkItemFormProps {
  id: string; draft: WorkItemDraft; projects: Project[]; disabled: boolean;
  onEdit: (patch: Partial<WorkItemFields>) => void;
  onToggleSession: (source: WorkSessionReference) => void;
  onPickSessions: () => void; onPickPacks: () => void;
  onOpenSession: (id: string) => void; onOpenPack: (id: string) => void;
  sessionPicker?: ReactNode; packPicker?: ReactNode;
}
export interface WorkItemEditorActionsProps {
  formId: string; draft: WorkItemDraft; dirty: boolean; busy: WorkItemEditorAction | null; loading: boolean;
  onPrepare: () => void; onArchive: () => void; onReopen: () => void; onDelete: () => void; onClose: () => void;
}
export function WorkItemForm({
  id, draft, projects, disabled, onEdit, onToggleSession, onPickSessions, onPickPacks, onOpenSession, onOpenPack, sessionPicker, packPicker,
}: WorkItemFormProps) {
  const { t } = useWorkItemI18n();
  const fields = draft.fields;
  return <fieldset className="form-stack form-reset" disabled={disabled}>
    <legend className="sr-only">{t('작업 편집')}</legend>
    <Field label={t('작업 제목')} htmlFor={`${id}-title`}>
      <input id={`${id}-title`} required data-autofocus maxLength={WORK_ITEM_UI_LIMITS.title} value={fields.title}
        onChange={event => onEdit({ title: event.target.value })} />
    </Field>
    <div className="form-grid">
      <Field label={t('프로젝트')} htmlFor={`${id}-project`}>
        <select id={`${id}-project`} value={fields.projectId ?? ''} onChange={event => onEdit({ projectId: event.target.value || null })}>
          <option value="">{t('프로젝트 없음')}</option>
          {fields.projectId && !projects.some(project => project.id === fields.projectId) && <option value={fields.projectId}>{t('사용할 수 없는 프로젝트')}</option>}
          {projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
        </select>
      </Field>
      <Field label={t('기한')} htmlFor={`${id}-due`}>
        <input id={`${id}-due`} type="date" min="0001-01-01" max="9999-12-31" value={fields.dueDate ?? ''}
          onChange={event => onEdit({ dueDate: event.target.value || null })} />
      </Field>
      <Field label={t('작업 상태')} htmlFor={`${id}-status`}>
        <select id={`${id}-status`} value={fields.status} onChange={event => onEdit({ status: event.target.value as WorkItemFields['status'] })}>
          {WORK_ITEM_STATUSES.map(status => <option value={status} key={status}>{t(WORK_STATUS_LABELS[status])}</option>)}
        </select>
      </Field>
      <Field label={t('우선순위')} htmlFor={`${id}-priority`}>
        <select id={`${id}-priority`} value={fields.priority} onChange={event => onEdit({ priority: event.target.value as WorkItemFields['priority'] })}>
          {WORK_ITEM_PRIORITIES.map(priority => <option value={priority} key={priority}>{t(WORK_PRIORITY_LABELS[priority])}</option>)}
        </select>
      </Field>
    </div>
    <Field label={t('다음 할 일')} htmlFor={`${id}-next`}>
      <textarea id={`${id}-next`} rows={3} maxLength={WORK_ITEM_UI_LIMITS.text} value={fields.nextAction}
        onChange={event => onEdit({ nextAction: event.target.value })} />
    </Field>
    <Field label={t('작업 설명')} htmlFor={`${id}-description`}>
      <textarea id={`${id}-description`} rows={5} maxLength={WORK_ITEM_UI_LIMITS.text} value={fields.description}
        onChange={event => onEdit({ description: event.target.value })} />
    </Field>
    <section className="work-references" aria-label={t('연결된 세션')}>
      <div className="work-section-heading"><h3>{t('연결된 세션')}</h3>
        <Button size="small" icon={Link} aria-expanded={!!sessionPicker} onClick={onPickSessions}>{t(sessionPicker ? '선택 닫기' : '세션 찾기')}</Button>
      </div>
      {!draft.sessions.length && <p className="field-hint">{t('연결된 세션이 없습니다.')}</p>}
      {draft.sessions.map(source => <div className="work-source" key={source.id}>
        <Button variant="ghost" size="small" disabled={!source.available}
          aria-label={t('{title} 세션 열기', { title: source.title })} onClick={() => onOpenSession(source.id)}>{source.title}</Button>
        {!source.available && <span>{t('사용할 수 없는 원본')}</span>}
        <IconButton icon={X} label={t('{title} 연결 해제', { title: source.title })} onClick={() => onToggleSession(source)} />
      </div>)}
      {sessionPicker}
    </section>
    <section className="work-references" aria-label={t('연결된 컨텍스트')}>
      <div className="work-section-heading"><h3>{t('연결된 컨텍스트')}</h3>
        <Button size="small" icon={Link} aria-expanded={!!packPicker} onClick={onPickPacks}>{t(packPicker ? '선택 닫기' : '컨텍스트 선택')}</Button>
      </div>
      {!fields.contextPackIds.length && <p className="field-hint">{t('연결된 묶음이 없습니다.')}</p>}
      {fields.contextPackIds.map(packId => {
        const pack = draft.packs.find(source => source.id === packId);
        const name = pack?.name ?? packId;
        return <div className="work-source" key={packId}>
          <Button variant="ghost" size="small" disabled={pack?.available === false}
            aria-label={t('{name} 묶음 열기', { name })} onClick={() => onOpenPack(packId)}>{name}</Button>
          {pack?.available === false && <span>{t('사용할 수 없는 원본')}</span>}
          <IconButton icon={X} label={t('{title} 연결 해제', { title: name })}
            onClick={() => onEdit({ contextPackIds: fields.contextPackIds.filter(id => id !== packId) })} />
        </div>;
      })}
      {packPicker}
    </section>
  </fieldset>;
}
export function WorkItemEditorActions({
  formId, draft, dirty, busy, loading, onPrepare, onArchive, onReopen, onDelete, onClose,
}: WorkItemEditorActionsProps) {
  const { t } = useWorkItemI18n();
  const pending = loading || !!busy;
  const saved = !!draft.original;
  const inactive = !!draft.original?.archivedAt || draft.fields.status === 'done';
  return <div className="work-editor-footer">
    <div className="work-editor-state">
      {dirty && <span>{t('저장하지 않은 변경 내용을 먼저 저장하세요.')}</span>}
      {saved && <>
        <Button size="small" icon={inactive ? RotateCcw : Archive} disabled={pending || dirty}
          onClick={inactive ? onReopen : onArchive}>{t(inactive ? '작업 다시 열기' : '작업 보관')}</Button>
        <Button size="small" icon={Trash2} disabled={pending || dirty} onClick={onDelete}>{t('작업 삭제')}</Button>
      </>}
    </div>
    <div className="work-editor-primary">
      <Button disabled={pending} onClick={onClose}>{t('닫기')}</Button>
      <Button icon={Play} disabled={pending || !saved || dirty || inactive} busy={busy === 'prepare'} onClick={onPrepare}>{t('실행 준비')}</Button>
      <Button icon={Save} variant="primary" type="submit" form={formId} busy={busy === 'save'} disabled={pending || (saved && !dirty)}>{t('작업 저장')}</Button>
    </div>
  </div>;
}
