import { useEffect, useId, useRef, useState } from 'react';
import { Plus, RefreshCw, Save } from 'lucide-react';
import {
  CONTEXT_PACK_LIMITS as limits, type ContextPack, type ContextPackCompilation, type ContextPackExportFormat,
} from '../../../shared/context-packs';
import type { Project } from '../../../shared/types';
import { Dialog } from '../../components/Dialog';
import { Button, Field, InlineNotice } from '../../components/ui';
import { errorMessage } from '../../lib/format';
import { useApp } from '../../state/AppProvider';
import { contextPacksApi, downloadContextPack } from './api';
import { ContextPackFields, type ContextPackFieldsValue } from './ContextPackFields';
import { ContextPackItemEditor, type ContextPackItemDraft } from './ContextPackItemEditor';
import { ContextPackOutput } from './ContextPackOutput';
import {
  contextPackItemPatch, contextPackReorderInput, contextPackRunDraft, moveContextPackItem,
  reconcileItemDrafts, reconcileItemOrder,
} from './model';
import { useContextPackI18n } from './i18n';
import './context-packs.css';

function metadata(pack?: ContextPack): ContextPackFieldsValue {
  return {
    name: pack?.name ?? '', description: pack?.description ?? '', projectId: pack?.projectId ?? null,
    instructions: pack?.instructions ?? '',
  };
}

export interface ContextPackEditorProps {
  pack?: ContextPack;
  projects: Project[];
  onClose: () => void;
  onSaved?: (pack: ContextPack) => void;
}
export function ContextPackEditor({ pack: initial, projects, onClose, onSaved }: ContextPackEditorProps) {
  const { t, notice } = useContextPackI18n();
  const { openNewRun, openSession } = useApp();
  const formId = useId();
  // This is the editable snapshot and its optimistic version, not live summary
  // data. SSE/prop refreshes must never rebase old fields onto a newer version.
  const [pack, setPack] = useState(initial);
  const [fields, setFields] = useState(() => metadata(initial));
  const [drafts, setDrafts] = useState<Record<string, ContextPackItemDraft>>(() => initial ? reconcileItemDrafts(initial, {}) : {});
  const [order, setOrder] = useState(() => initial?.items.map(item => item.id) ?? []);
  const [newNote, setNewNote] = useState({ title: '', text: '' });
  const [compiled, setCompiled] = useState<ContextPackCompilation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, []);

  const originalFields = metadata(pack);
  const metadataDirty = (Object.keys(fields) as Array<keyof ContextPackFieldsValue>).some(key => fields[key] !== originalFields[key]);
  const itemsDirty = pack?.items.some(item => {
    const draft = drafts[item.id];
    return draft && (draft.title !== item.title || (item.kind === 'note' && draft.text !== item.text));
  });
  const orderDirty = Boolean(pack && order.some((id, index) => id !== pack.items[index]?.id));
  const dirty = metadataDirty || orderDirty || Boolean(itemsDirty || newNote.title || newNote.text);
  const orderedItems = order.flatMap(id => pack?.items.find(item => item.id === id) ?? []);

  async function perform<T>(action: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
    if (pending.current) return null;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(action); setError('');
    try {
      const result = await operation(controller.signal);
      return controller.signal.aborted ? null : result;
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
      return null;
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  function accept(next: ContextPack, savedItemId?: string) {
    setPack(next);
    setDrafts(previous => reconcileItemDrafts(next, previous, savedItemId));
    setOrder(previous => reconcileItemOrder(next, previous));
    setCompiled(null);
    onSaved?.(next);
  }
  async function save() {
    if (!fields.name.trim()) return;
    const next = await perform('save', signal => pack
      ? contextPacksApi.update(pack.id, { ...fields, version: pack.version }, signal)
      : contextPacksApi.create(fields, signal));
    if (next) { accept(next); setFields(metadata(next)); }
  }
  async function reload() {
    if (!pack) return;
    const next = await perform('reload', signal => contextPacksApi.get(pack.id, signal));
    if (next) {
      accept(next); setFields(metadata(next)); setDrafts(reconcileItemDrafts(next, {})); setNewNote({ title: '', text: '' });
      setOrder(next.items.map(item => item.id));
    }
  }
  async function saveItem(itemId: string) {
    const item = pack?.items.find(item => item.id === itemId);
    if (!pack || !item) return;
    const next = await perform('item', signal => contextPacksApi.updateItem(pack.id, itemId,
      contextPackItemPatch(pack.version, item, drafts[itemId]), signal));
    if (next) accept(next, itemId);
  }
  async function removeItem(itemId: string) {
    if (!pack) return;
    const next = await perform('item', signal => contextPacksApi.removeItem(pack.id, itemId, { version: pack.version }, signal));
    if (next) accept(next);
  }
  async function saveOrder() {
    if (!pack || !orderDirty) return;
    const next = await perform('order', signal => contextPacksApi.reorder(pack.id, contextPackReorderInput(pack, order), signal));
    if (next) accept(next);
  }
  async function addNote() {
    if (!pack || !newNote.title.trim() || !newNote.text) return;
    const next = await perform('note', signal =>
      contextPacksApi.addItem(pack.id, { kind: 'note', ...newNote, version: pack.version }, signal));
    if (next) { accept(next); setNewNote({ title: '', text: '' }); }
  }
  async function compile() {
    if (!pack || dirty) return;
    setCompiled(null);
    const result = await perform('compile', async signal => {
      const output = await contextPacksApi.compile(pack.id, signal);
      contextPackRunDraft(pack, output);
      return output;
    });
    if (result) setCompiled(result);
  }
  async function exportPack(format: ContextPackExportFormat) {
    if (!pack || dirty) return;
    const result = await perform('export', signal => contextPacksApi.export(pack.id, format, signal));
    if (result) {
      try { downloadContextPack(result); }
      catch (cause) { setError(errorMessage(cause)); }
    }
  }
  function prepareRun() {
    if (!pack || !compiled || dirty || busy) return;
    try {
      const draft = contextPackRunDraft(pack, compiled);
      onClose();
      openNewRun(draft);
    } catch (cause) { setError(errorMessage(cause)); setCompiled(null); }
  }
  function close() { pending.current?.abort(); onClose(); }
  const noteAllowed = pack && pack.itemCount < limits.items && pack.totalChars + newNote.text.length <= limits.totalChars;
  return <Dialog title={pack ? t('컨텍스트 묶음 편집') : t('새 컨텍스트 묶음')} size="large" onClose={close}
    description={t('선택한 메시지 인용과 사용자 메모를 저장하고 다음 작업에 다시 사용하세요.')}
    footer={<>
      <Button onClick={close} disabled={Boolean(busy)}>{t('닫기')}</Button>
      <Button type="submit" form={formId} variant="primary" icon={Save} busy={busy === 'save'}
        disabled={Boolean(busy) || !fields.name.trim() || Boolean(pack && !metadataDirty)}>
        {pack ? t('묶음 저장') : t('묶음 만들기')}
      </Button>
    </>}>
    <form id={formId} onSubmit={event => { event.preventDefault(); void save(); }}>
      <ContextPackFields value={fields} onChange={setFields} projects={projects} disabled={Boolean(busy)} idPrefix={formId} />
    </form>
    {error && <div className="context-pack-conflict">
      <InlineNotice tone="error">{notice(error)}</InlineNotice>
      {pack && <>
        <Button size="small" icon={RefreshCw} disabled={Boolean(busy)} onClick={() => void reload()}>{t('최신 내용 다시 불러오기')}</Button>
        <p className="field-hint">{t('다시 불러오면 저장하지 않은 수정 내용이 초기화됩니다.')}</p>
      </>}
    </div>}
    {pack && <>
      <p className="field-hint">{t('{count}개 항목 / 20개, {chars}자 / 48,000자', {
        count: pack.itemCount, chars: pack.totalChars.toLocaleString(),
      })}</p>
      {pack.items.length > 1 && <div className="context-pack-actions">
        <p className="field-hint">{t('화살표로 순서를 바꾼 뒤 저장하세요. 저장 전까지 실행용 컨텍스트에는 반영되지 않습니다.')}</p>
        <Button size="small" icon={Save} busy={busy === 'order'} disabled={Boolean(busy) || !orderDirty}
          onClick={() => void saveOrder()}>{t('순서 저장')}</Button>
      </div>}
      {orderedItems.map((item, index) => <ContextPackItemEditor key={item.id} item={item}
        draft={drafts[item.id] ?? { title: item.title, text: item.text }} index={index} total={pack.items.length}
        disabled={Boolean(busy)} onChange={draft => setDrafts(previous => ({ ...previous, [item.id]: draft }))}
        onSave={() => void saveItem(item.id)} onRemove={() => void removeItem(item.id)}
        onMove={direction => setOrder(previous => moveContextPackItem(previous, item.id, direction))}
        onOpenSource={id => { close(); openSession(id); }} />)}
      <form className="context-pack-add-note form-stack" onSubmit={event => { event.preventDefault(); void addNote(); }}>
        <h3>{t('메모 추가')}</h3>
        <Field label={t('메모 제목')} htmlFor={`${formId}-note-title`}>
          <input id={`${formId}-note-title`} maxLength={limits.nameChars} required disabled={Boolean(busy) || pack.itemCount >= limits.items}
            value={newNote.title} onChange={event => setNewNote(value => ({ ...value, title: event.target.value }))} />
        </Field>
        <Field label={t('메모 내용')} htmlFor={`${formId}-note-text`}>
          <textarea id={`${formId}-note-text`} rows={5} maxLength={limits.itemChars} required disabled={Boolean(busy) || pack.itemCount >= limits.items}
            value={newNote.text} onChange={event => setNewNote(value => ({ ...value, text: event.target.value }))} />
        </Field>
        <p className="field-hint">{t('최대 20개 항목, 항목당 8,000자, 본문 합계 48,000자입니다.')}</p>
        <div><Button type="submit" icon={Plus} busy={busy === 'note'}
          disabled={Boolean(busy) || !noteAllowed || !newNote.title.trim() || !newNote.text}>{t('메모 추가')}</Button></div>
      </form>
      <ContextPackOutput compilation={compiled} busy={Boolean(busy)} dirty={dirty}
        onCompile={() => void compile()} onPrepareRun={prepareRun} onExport={format => void exportPack(format)} />
    </>}
  </Dialog>;
}
