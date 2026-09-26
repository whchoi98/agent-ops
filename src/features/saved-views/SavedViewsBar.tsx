import { useId, useState, type FormEvent } from 'react';
import { Bookmark, FolderOpen, Pencil, Pin, PinOff, RefreshCw, Save, Trash2 } from 'lucide-react';
import { SAVED_VIEW_LIMIT, type SavedView } from '../../../shared/saved-views';
import type { SessionQuery } from '../../../shared/types';
import { Dialog } from '../../components/Dialog';
import { Button, InlineNotice } from '../../components/ui';
import { errorMessage } from '../../lib/format';
import { applySavedView, buildSavedViewInput, createSavedViewDraft, replaceSavedViewQuery, type SavedViewDraft } from './editor';
import { useSavedViewsI18n } from './i18n';
import type { SavedViewsSnapshot } from './resource';
import { SavedViewForm } from './SavedViewForm';
import { useSavedViews } from './useSavedViews';
import './saved-views.css';

export interface SavedViewsBarProps {
  query: SessionQuery;
  /** A full replacement query; the result always has offset: 0. */
  onApply: (query: SessionQuery) => void;
  /** Change only when saved-view metadata needs refreshing, e.g. productivity-change. */
  revision?: number;
  className?: string;
}

export interface SavedViewsToolbarProps extends SavedViewsSnapshot {
  selectedId: string;
  onSelect: (id: string) => void;
  onOpen: () => void;
  onSave: () => void;
  onEdit: () => void;
  onPin: () => void;
  onDelete: () => void;
  onReload: () => void;
}

export function SavedViewsToolbar({
  views, loading, saving, error, writeError, selectedId, onSelect, onOpen, onSave, onEdit, onPin, onDelete, onReload,
}: SavedViewsToolbarProps) {
  const { t, notice } = useSavedViewsI18n();
  const selectId = useId();
  const selected = views.find(view => view.id === selectedId);
  const disabled = !selected || saving;
  return <section className="saved-views-bar" aria-label={t('저장 검색')} aria-busy={loading || saving || undefined}>
    <div className="saved-views-controls">
      <label htmlFor={selectId} className="saved-views-label"><Bookmark size={16} aria-hidden />{t('저장 검색')}</label>
      <select id={selectId} aria-label={t('저장 검색 선택')} value={selected?.id ?? ''} disabled={saving || !views.length}
        onChange={event => onSelect(event.target.value)}>
        <option value="">{t('저장 검색 선택')}</option>
        {views.map(view => <option key={view.id} value={view.id}>{view.pinned ? '★ ' : ''}{view.name}</option>)}
      </select>
      <div className="saved-views-actions">
        <Button size="small" icon={FolderOpen} disabled={disabled} onClick={onOpen}>{t('저장 검색 열기')}</Button>
        <Button size="small" icon={Save} disabled={saving || loading || views.length >= SAVED_VIEW_LIMIT}
          onClick={onSave}>{t('현재 조건 저장')}</Button>
        <Button size="small" icon={Pencil} disabled={disabled} onClick={onEdit}>{t('저장 검색 수정')}</Button>
        <Button size="small" icon={selected?.pinned ? PinOff : Pin} disabled={disabled} aria-pressed={selected?.pinned ?? false}
          onClick={onPin}>{t(selected?.pinned ? '저장 검색 고정 해제' : '저장 검색 고정')}</Button>
        <Button size="small" icon={Trash2} disabled={disabled} onClick={onDelete}>{t('저장 검색 삭제')}</Button>
      </div>
    </div>
    {loading && <p className="saved-views-status" role="status">{t('저장 검색을 불러오는 중입니다.')}</p>}
    {!loading && !error && !views.length && <p className="saved-views-status">{t('아직 저장한 검색이 없습니다.')}</p>}
    {views.length >= SAVED_VIEW_LIMIT && <p className="saved-views-status">{t('저장 검색은 최대 50개까지 만들 수 있습니다.')}</p>}
    {(error || writeError) && <div className="saved-views-errors">
      {error && <InlineNotice tone="error">{notice(error)}</InlineNotice>}
      {writeError && <InlineNotice tone="error">{notice(writeError)}</InlineNotice>}
      <Button size="small" icon={RefreshCw} disabled={loading || saving} onClick={onReload}>{t('저장 검색 새로고침')}</Button>
    </div>}
  </section>;
}

interface EditorState { view?: SavedView; draft: SavedViewDraft }

export function SavedViewsBar({ query, onApply, revision = 0, className = '' }: SavedViewsBarProps) {
  const { t, notice } = useSavedViewsI18n();
  const saved = useSavedViews(revision);
  const formId = useId();
  const [selectedId, setSelectedId] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleting, setDeleting] = useState<SavedView | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const selected = saved.views.find(view => view.id === selectedId);
  const stale = (view: SavedView | undefined) => !!view && !saved.loading
    && saved.views.find(item => item.id === view.id)?.version !== view.version;
  const editorStale = stale(editor?.view);
  const deleteStale = stale(deleting ?? undefined);

  function edit(view?: SavedView) {
    saved.clearWriteError();
    setFormError(null);
    setApplyError(null);
    setEditor({ view, draft: createSavedViewDraft(query, view) });
  }
  function open() {
    if (!selected) return;
    setApplyError(null);
    try { applySavedView(selected, onApply); }
    catch (cause) { setApplyError(errorMessage(cause)); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || saved.saving || editorStale) return;
    const attempt = editor;
    setFormError(null);
    try {
      const input = buildSavedViewInput(attempt.draft);
      const result = attempt.view
        ? await saved.update(attempt.view.id, { ...input, version: attempt.view.version })
        : await saved.create(input);
      if (result) {
        setSelectedId(result.id);
        setEditor(current => current === attempt ? null : current);
      }
    } catch (cause) { setFormError(errorMessage(cause)); }
  }
  async function remove() {
    if (!deleting || saved.saving || deleteStale) return;
    const attempt = deleting;
    if (await saved.remove(attempt.id, attempt.version)) {
      setSelectedId(current => current === attempt.id ? '' : current);
      setDeleting(current => current === attempt ? null : current);
    }
  }

  return <div className={className || undefined}>
    <SavedViewsToolbar {...saved} selectedId={selectedId} writeError={applyError ?? saved.writeError}
      onSelect={id => { setSelectedId(id); setApplyError(null); }}
      onOpen={open} onSave={() => edit()} onEdit={() => { if (selected) edit(selected); }}
      onPin={() => { if (selected) void saved.update(selected.id, { version: selected.version, pinned: !selected.pinned }); }}
      onDelete={() => { if (selected) { saved.clearWriteError(); setDeleting(selected); } }}
      onReload={() => { setApplyError(null); void saved.reload(); }} />
    {editor && <Dialog title={t(editor.view ? '저장 검색 수정' : '현재 조건 저장')} size="small"
      description={t('이름과 검색 조건을 저장합니다. 페이지 위치는 저장하지 않습니다.')}
      onClose={() => { if (!saved.saving) setEditor(null); }}
      footer={<>
        <Button disabled={saved.saving} onClick={() => setEditor(null)}>{t('취소')}</Button>
        <Button variant="primary" icon={Save} type="submit" form={formId} busy={saved.saving} disabled={editorStale}>{t('저장')}</Button>
      </>}>
      <SavedViewForm id={formId} draft={editor.draft} busy={saved.saving} stale={editorStale}
        error={formError ?? saved.writeError} onSubmit={save}
        onChange={draft => setEditor(current => current ? { ...current, draft } : current)}
        onUseCurrent={editor.view ? () => {
          setFormError(null);
          setEditor(current => current ? {
            ...current, draft: replaceSavedViewQuery(current.draft, query),
          } : current);
        } : undefined} />
    </Dialog>}
    {deleting && <Dialog title={t('저장 검색 삭제')} size="small" onClose={() => { if (!saved.saving) setDeleting(null); }}
      footer={<>
        <Button disabled={saved.saving} onClick={() => setDeleting(null)}>{t('취소')}</Button>
        <Button variant="danger" icon={Trash2} busy={saved.saving} disabled={deleteStale} onClick={() => void remove()}>{t('삭제')}</Button>
      </>}>
      <p>{t('“{0}” 저장 검색을 삭제할까요?', { 0: deleting.name })}</p>
      <p className="field-hint">{t('저장한 조건만 삭제합니다. 세션 기록은 유지됩니다.')}</p>
      {deleteStale && <InlineNotice tone="error">{t('창을 닫고 최신 검색을 선택한 뒤 다시 삭제하세요.')}</InlineNotice>}
      {saved.writeError && <InlineNotice tone="error">{notice(saved.writeError)}</InlineNotice>}
    </Dialog>}
  </div>;
}
