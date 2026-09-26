import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Layers, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import {
  CONTEXT_PACK_LIMITS as limits, type ContextPack, type ContextPackPage, type ContextPackSummary,
} from '../../shared/context-packs';
import type { Project } from '../../shared/types';
import { Dialog } from '../components/Dialog';
import { Button, EmptyState, IconButton, InlineNotice, PageHeading, Skeleton } from '../components/ui';
import { useDebounced } from '../hooks/useResource';
import { useFormat } from '../i18n/useFormat';
import { useContextPackI18n } from '../features/context-packs/i18n';
import { useContextPacks } from '../features/context-packs/useContextPacks';
import { contextPacksApi } from '../features/context-packs/api';
import { errorMessage } from '../lib/format';
import { useData } from '../state/AppProvider';
import '../features/context-packs/context-packs.css';

const ContextPackEditor = lazy(() => import('../features/context-packs/ContextPackEditor').then(module => ({ default: module.ContextPackEditor })));
interface PageQuery { q: string; projectId: string; offset: number }
export interface ContextPacksViewProps {
  page: ContextPackPage | null;
  projects: Project[];
  query: PageQuery;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onQuery: (query: PageQuery) => void;
  onNew: () => void;
  onOpen: (pack: ContextPackSummary) => void;
  onDelete: (pack: ContextPackSummary) => void;
  onReload: () => void;
}
export function ContextPacksView({
  page, projects, query, loading, busy, error, onQuery, onNew, onOpen, onDelete, onReload,
}: ContextPacksViewProps) {
  const { t, notice } = useContextPackI18n();
  const { dateTime } = useFormat();
  const pending = busy || loading;
  return <>
    <PageHeading title={t('컨텍스트 묶음')} eyebrow="CONTEXT LIBRARY"
      description={t('선택한 메시지 인용과 사용자 메모를 저장하고 다음 작업에 다시 사용하세요.')}
      actions={<Button variant="primary" icon={Plus} onClick={onNew}
        disabled={pending || (page?.total ?? 0) >= limits.packs}>{t('새 컨텍스트 묶음')}</Button>} />
    <div className="context-pack-toolbar">
      <div className="search-input"><Search size={16} aria-hidden />
        <input aria-label={t('묶음 검색')} maxLength={500} value={query.q} disabled={busy} placeholder={t('묶음 검색')}
          onChange={event => onQuery({ ...query, q: event.target.value, offset: 0 })} />
      </div>
      <select aria-label={t('프로젝트')} disabled={busy} value={query.projectId}
        onChange={event => onQuery({ ...query, projectId: event.target.value, offset: 0 })}>
        <option value="">{t('모든 프로젝트')}</option>
        {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <Button icon={RefreshCw} disabled={pending} onClick={onReload}>{t('묶음 다시 불러오기')}</Button>
    </div>
    {loading && <Skeleton rows={4} />}
    {error && <InlineNotice tone="error">{notice(error)}</InlineNotice>}
    <div className="context-pack-grid">
      {page?.items.map(pack => <article className="panel context-pack-card" key={pack.id}>
        <div className="context-pack-card-heading">
          <h2>{pack.name}</h2>
          <IconButton icon={Trash2} label={t('{name} 묶음 삭제', { name: pack.name })} disabled={pending}
            onClick={() => onDelete(pack)} />
        </div>
        {pack.description && <p>{pack.description}</p>}
        <p>{pack.projectId
          ? projects.find(project => project.id === pack.projectId)?.name ?? t('사용할 수 없는 프로젝트')
          : t('프로젝트 없음')}</p>
        <p>{t('{count}개 항목, {chars}자', { count: pack.itemCount, chars: pack.totalChars.toLocaleString() })}</p>
        <footer><time dateTime={pack.updatedAt}>{dateTime(pack.updatedAt)}</time>
          <Button size="small" aria-label={t('{name} 묶음 열기', { name: pack.name })} disabled={pending}
            onClick={() => onOpen(pack)}>{t('열기')}</Button>
        </footer>
      </article>)}
    </div>
    {!loading && !error && !page?.items.length && <EmptyState icon={Layers}
      title={query.q || query.projectId ? t('조건에 맞는 묶음이 없습니다') : t('컨텍스트 묶음이 없습니다')}
      description={query.q || query.projectId ? t('검색어나 프로젝트 조건을 바꿔보세요.') : t('메시지 인용이나 메모를 담을 묶음을 만들어 보세요.')}
      action={<Button icon={Plus} variant="primary" disabled={busy} onClick={onNew}>{t('새 컨텍스트 묶음')}</Button>} />}
    {page && page.total > 0 && <div className="context-pack-pagination">
      <Button disabled={pending || page.offset === 0} onClick={() => onQuery({ ...query, offset: Math.max(0, page.offset - page.limit) })}>
        {t('이전')}
      </Button>
      <span>{t('묶음 {from}–{to} / {total}개', {
        from: page.items.length ? page.offset + 1 : 0, to: Math.min(page.offset + page.items.length, page.total), total: page.total,
      })}</span>
      <Button disabled={pending || page.offset + page.limit >= page.total}
        onClick={() => onQuery({ ...query, offset: page.offset + page.limit })}>{t('다음')}</Button>
    </div>}
  </>;
}

export function ContextPacks() {
  const { projects } = useData();
  const { t, notice } = useContextPackI18n();
  const [query, setQuery] = useState<PageQuery>({ q: '', projectId: '', offset: 0 });
  const q = useDebounced(query.q);
  const resource = useContextPacks({ ...query, q, projectId: query.projectId || undefined, limit: 25 });
  const [editor, setEditor] = useState<ContextPack | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ContextPackSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, []);
  useEffect(() => {
    if (resource.loading || !resource.page || resource.error) return;
    if (query.offset > 0 && query.offset >= resource.page.total) {
      setQuery(value => ({ ...value, offset: Math.max(0, Math.floor((resource.page!.total - 1) / 25) * 25) }));
    }
  }, [resource.loading, resource.page, resource.error, query.offset]);

  async function perform<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
    if (pending.current) return null;
    const controller = new AbortController();
    pending.current = controller; setBusy(true); setError('');
    try {
      const result = await action(controller.signal);
      return controller.signal.aborted ? null : result;
    } catch (cause) { if (!controller.signal.aborted) setError(errorMessage(cause)); return null; }
    finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function open(pack: ContextPackSummary) {
    const detail = await perform(signal => contextPacksApi.get(pack.id, signal));
    if (detail) setEditor(detail);
  }
  async function remove() {
    if (!deleting) return;
    const result = await perform(signal => contextPacksApi.remove(deleting.id, { version: deleting.version }, signal));
    if (result) { setDeleting(null); resource.reload(); }
  }
  async function reloadDeleting() {
    if (!deleting) return;
    const result = await perform(signal => contextPacksApi.get(deleting.id, signal));
    if (result) { setDeleting(result); resource.reload(); }
  }
  function closeDelete() { if (!busy) { setDeleting(null); setError(''); } }
  return <>
    <ContextPacksView page={resource.page} projects={projects} query={query} onQuery={setQuery}
      loading={resource.loading || q !== query.q} busy={busy} error={resource.error || (!deleting ? error : '')}
      onNew={() => { setError(''); setEditor('new'); }} onOpen={pack => void open(pack)}
      onDelete={pack => { setError(''); setDeleting(pack); }} onReload={() => { setError(''); resource.reload(); }} />
    {editor && <Suspense fallback={<Skeleton rows={3} />}>
      <ContextPackEditor key={editor === 'new' ? 'new' : editor.id} pack={editor === 'new' ? undefined : editor}
        projects={projects} onSaved={() => resource.reload()} onClose={() => { setEditor(null); resource.reload(); }} />
    </Suspense>}
    {deleting && <Dialog title={t('컨텍스트 묶음을 삭제할까요?')} onClose={closeDelete} size="small"
      footer={<><Button disabled={busy} onClick={closeDelete}>{t('취소')}</Button>
        <Button variant="danger" icon={Trash2} busy={busy} onClick={() => void remove()}>{t('묶음 삭제')}</Button></>}>
      <p><strong>{deleting.name}</strong></p>
      <p>{t('저장한 묶음과 항목을 삭제합니다. 원본 세션은 유지됩니다.')}</p>
      {error && <InlineNotice tone="error">{notice(error)}
        <Button size="small" disabled={busy} onClick={() => void reloadDeleting()}>{t('최신 내용 다시 불러오기')}</Button>
      </InlineNotice>}
    </Dialog>}
  </>;
}
