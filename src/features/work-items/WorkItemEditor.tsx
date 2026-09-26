import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import type { Agent, Project } from '../../../shared/types';
import { AGENTS } from '../../../shared/types';
import type { WorkItem } from '../../../shared/work-items';
import type { ContextPack } from '../../../shared/context-packs';
import { ContextPackEditor, ContextPackPicker, contextPacksApi } from '../context-packs/index';
import { Dialog } from '../../components/Dialog';
import { Button, Field, InlineNotice, Skeleton } from '../../components/ui';
import { AGENT_META, errorMessage } from '../../lib/format';
import { useApp } from '../../state/AppProvider';
import { createWorkItemDraft, type WorkItemDraft } from './model';
import { useWorkItemEditor } from './useWorkItems';
import { useWorkItemI18n } from './i18n';
import { WorkItemForm, WorkItemEditorActions } from './WorkItemForm';
import { SessionPicker } from './SessionPicker';
import './work-items.css';

export interface WorkItemEditorProps {
  itemId?: string;
  initialDraft?: WorkItemDraft;
  projects: Project[];
  onClose: () => void;
  onSaved?: (item: WorkItem) => void;
  onDeleted?: (id: string) => void;
}
type Confirmation = 'archive' | 'reopen' | 'delete' | 'reload';
const confirmationTitles: Record<Confirmation, string> = {
  archive: '작업을 보관할까요?', reopen: '작업을 다시 열까요?', delete: '작업을 삭제할까요?', reload: '최신 내용을 불러올까요?',
};
const confirmationActions: Record<Confirmation, string> = {
  archive: '작업 보관', reopen: '작업 다시 열기', delete: '작업 삭제', reload: '최신 내용 다시 불러오기',
};

export function WorkItemEditorNotice({ error, saved, busy, onReload }: {
  error: string | null; saved: boolean; busy: boolean; onReload: () => void;
}) {
  const { t, notice } = useWorkItemI18n();
  return error ? <div className="work-editor-error">
    <InlineNotice tone="error">{notice(error)}</InlineNotice>
    {saved && <Button size="small" icon={RefreshCw} disabled={busy} onClick={onReload}>{t('최신 내용 다시 불러오기')}</Button>}
  </div> : null;
}

function WorkItemEditorContent({ itemId, initialDraft, projects, onClose, onSaved, onDeleted }: WorkItemEditorProps) {
  const { t, notice } = useWorkItemI18n();
  const { openSession, openRun, openNewRun, productivityRevision } = useApp();
  const work = useWorkItemEditor(itemId ? { id: itemId } : { draft: initialDraft ?? createWorkItemDraft() });
  const formId = useId();
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [pickSessions, setPickSessions] = useState(false);
  const [pickPacks, setPickPacks] = useState(false);
  const [agent, setAgent] = useState<Agent>('codex');
  const [pack, setPack] = useState<ContextPack | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const packRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { packRequest.current?.abort(); }, []);
  const draft = work.draft;
  const pending = work.loading || !!work.busy;
  const projectPath = projects.find(project => project.id === draft?.fields.projectId)?.path;
  function close() {
    if (work.busy) return;
    packRequest.current?.abort();
    onClose();
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await work.save();
    if (result) onSaved?.(result);
  }
  async function prepare() {
    const prepared = await work.prepare(agent);
    if (prepared) {
      onClose();
      openNewRun(prepared);
    }
  }
  function requestReload() {
    if (work.dirty && draft?.original) setConfirmation('reload');
    else void work.reload();
  }
  async function confirm() {
    if (!confirmation) return;
    if (confirmation === 'reload') {
      if (await work.reload()) setConfirmation(null);
    } else if (confirmation === 'delete') {
      const id = draft?.original?.id;
      if (await work.remove()) { if (id) onDeleted?.(id); onClose(); }
    } else {
      const result = await (confirmation === 'archive' ? work.archive() : work.reopen());
      if (result) { setConfirmation(null); onSaved?.(result); }
    }
  }
  async function openPack(id: string) {
    packRequest.current?.abort();
    const controller = new AbortController();
    packRequest.current = controller;
    setSourceError(null);
    try {
      const result = await contextPacksApi.get(id, controller.signal);
      if (!controller.signal.aborted) setPack(result);
    } catch (cause) { if (!controller.signal.aborted) setSourceError(errorMessage(cause)); }
    finally { if (packRequest.current === controller) packRequest.current = null; }
  }

  return <>
    <Dialog title={t(draft?.original ? '작업 편집' : itemId ? '작업 불러오기' : '새 작업')} size="large" onClose={close}
      description={t('준비한 프롬프트는 실행 창에서 검토합니다. 아직 CLI를 시작하지 않습니다.')}
      footer={draft ? <WorkItemEditorActions formId={formId} draft={draft} dirty={work.dirty} busy={work.busy} loading={work.loading}
        onPrepare={() => void prepare()} onArchive={() => setConfirmation('archive')} onReopen={() => setConfirmation('reopen')}
        onDelete={() => setConfirmation('delete')} onClose={close} /> : <Button onClick={close}>{t('닫기')}</Button>}>
      {work.loading && <Skeleton rows={4} />}
      {draft && <>
        <form id={formId} onSubmit={save}>
          <WorkItemForm id={formId} draft={draft} projects={projects} disabled={pending} onEdit={work.edit}
            onToggleSession={work.toggleSession} onPickSessions={() => setPickSessions(value => !value)} onPickPacks={() => setPickPacks(value => !value)}
            onOpenSession={openSession} onOpenPack={id => void openPack(id)}
            sessionPicker={pickSessions ? <SessionPicker selected={draft.sessions} onToggle={work.toggleSession}
              projectPath={projectPath} disabled={pending} refreshKey={productivityRevision} /> : undefined}
            packPicker={pickPacks ? <ContextPackPicker selectedIds={draft.fields.contextPackIds} onChange={contextPackIds => work.edit({ contextPackIds })}
              projectId={draft.fields.projectId ?? undefined} maxSelected={5} disabled={pending} refreshKey={productivityRevision} /> : undefined} />
        </form>
        <div className="work-run-controls">
          <Field label={t('에이전트')} htmlFor={`${formId}-agent`}>
            <select id={`${formId}-agent`} value={agent} disabled={pending} onChange={event => setAgent(event.target.value as Agent)}>
              {AGENTS.map(value => <option value={value} key={value}>{AGENT_META[value].name}</option>)}
            </select>
          </Field>
          {draft.original?.lastRunId && <Button size="small" icon={ExternalLink}
            onClick={() => openRun(draft.original!.lastRunId!)}>{t('마지막 실행 보기')}</Button>}
        </div>
        <p className="field-hint">{t('실행이 끝나도 작업은 자동으로 완료되지 않습니다.')}</p>
      </>}
      {!confirmation && <WorkItemEditorNotice error={work.error} saved={!!(itemId || draft?.original)}
        busy={pending} onReload={requestReload} />}
      {sourceError && <InlineNotice tone="error">{notice(sourceError)}</InlineNotice>}
    </Dialog>
    {confirmation && <Dialog title={t(confirmationTitles[confirmation])} size="small" onClose={() => { if (!pending) setConfirmation(null); }}
      footer={<>
        <Button disabled={pending} onClick={() => setConfirmation(null)}>{t('취소')}</Button>
        <Button variant={confirmation === 'delete' ? 'danger' : 'primary'} busy={pending} onClick={() => void confirm()}>
          {t(confirmationActions[confirmation])}
        </Button>
      </>}>
      {draft && <p><strong>{draft.fields.title}</strong></p>}
      <p>{t(confirmation === 'reload' ? '현재 수정 내용을 버리고 서버에 저장된 최신 내용으로 바꿉니다.'
        : confirmation === 'delete' ? '삭제한 작업은 되돌릴 수 없습니다. 세션과 실행 기록은 유지됩니다.'
          : '작업만 변경합니다. 원본 세션과 실행 기록은 유지됩니다.')}</p>
      {confirmation === 'reopen' && <p>{t('완료한 작업은 할 일 상태로 다시 엽니다.')}</p>}
      <WorkItemEditorNotice error={work.error} saved={!!draft?.original} busy={pending} onReload={() => setConfirmation('reload')} />
    </Dialog>}
    {pack && <ContextPackEditor pack={pack} projects={projects} onClose={() => setPack(null)} />}
  </>;
}

/** Changing the selected ID remounts; metadata/list revisions never remount an open editor. */
export function WorkItemEditor(props: WorkItemEditorProps) {
  return <WorkItemEditorContent key={props.itemId ?? 'new'} {...props} />;
}
