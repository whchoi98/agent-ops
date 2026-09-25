import { useI18n, Trans, AppNotice } from '../i18n/I18nProvider';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Puzzle, RefreshCw, Search, X } from 'lucide-react';
import type { ExtensionAnalysisDraft, ExtensionCatalog, ExtensionQuery, ExtensionSummary } from '../../shared/extensions';
import { Button, EmptyState, ErrorState, InlineNotice, PageHeading, Skeleton } from '../components/ui';
import { ExtensionCounts, ExtensionDiscovery, ExtensionList, ExtensionPagination } from '../features/extensions/ExtensionCatalog';
import { ExtensionFilters } from '../features/extensions/ExtensionFilters';
import { readExtensionQuery, USAGE_NOTICE } from '../features/extensions/model';
import { VersionComparison } from '../features/versions/VersionComparison';
import { VersionSection } from '../features/versions/VersionSection';
import { useVersions } from '../features/versions/useVersions';
import { useDebounced, useResource } from '../hooks/useResource';
import { api } from '../lib/api';
import { errorMessage, number } from '../lib/format';
import { useApp, useData } from '../state/AppProvider';

const ExtensionDetailDialog = lazy(() => import('../features/extensions/ExtensionDetailDialog').then(module => ({ default: module.ExtensionDetailDialog })));

export function Extensions() {
  const { t } = useI18n();
  const { projects, connectors, demo } = useData();
  const { search, navigate, openNewRun, notify, modal } = useApp();
  const versions = useVersions();
  const query = useMemo(() => readExtensionQuery(search, projects), [search, projects]);
  const debouncedQ = useDebounced(query.q ?? '');
  const requestQuery = { ...query, q: debouncedQ.trim() || undefined };
  const requestKey = JSON.stringify(requestQuery);
  const resource = useResource<{ key: string; catalog: ExtensionCatalog }>(async signal => ({
    key: requestKey, catalog: await api.extensions(requestQuery, signal),
  }), requestKey);
  const catalog = resource.data?.key === requestKey ? resource.data.catalog : null;
  const pending = resource.loading || debouncedQ !== (query.q ?? '') || (!catalog && !resource.error);
  const [selection, setSelection] = useState<{ item: ExtensionSummary; projectId?: string } | null>(null);
  const selected = selection?.projectId === query.projectId ? selection?.item : null;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const refreshAttempt = useRef<AbortController | null>(null);
  const filtered = Boolean(query.agent || query.kind || query.status || query.scope || query.q);
  const update = (patch: ExtensionQuery) => navigate('extensions', { ...query, offset: 0, ...patch }, true);
  const clear = () => navigate('extensions', { projectId: query.projectId, limit: query.limit }, true);
  const select = (item: ExtensionSummary) => setSelection({ item, projectId: query.projectId });

  useEffect(() => {
    setSelection(null);
    setRefreshing(false);
    setRefreshError('');
    return () => { refreshAttempt.current?.abort(); refreshAttempt.current = null; };
  }, [query.projectId]);
  useEffect(() => { if (modal) setSelection(null); }, [modal]);

  useEffect(() => {
    if (!catalog || pending || catalog.offset === 0 || catalog.offset < catalog.total) return;
    navigate('extensions', {
      ...query, offset: Math.max(0, Math.ceil(catalog.total / catalog.limit) - 1) * catalog.limit,
    }, true);
  }, [catalog, pending, navigate, query]);

  async function refreshCatalog() {
    if (refreshAttempt.current) return;
    const attempt = new AbortController();
    refreshAttempt.current = attempt;
    setRefreshing(true); setRefreshError('');
    try {
      await api.refreshExtensions(query.projectId);
      if (!attempt.signal.aborted) resource.reload();
    } catch (cause) {
      if (!attempt.signal.aborted) setRefreshError(errorMessage(cause));
    } finally {
      if (!attempt.signal.aborted) { setRefreshing(false); refreshAttempt.current = null; }
    }
  }

  function prepareRun(result: ExtensionAnalysisDraft) {
    // Finish the native dialog's cleanup before the run dialog takes focus.
    flushSync(() => setSelection(null));
    openNewRun({ ...result.draft, policy: 'read-only' });
    if (result.notice) notify(result.notice, 'info');
  }

  return <div className="extensions-workspace">
    <PageHeading title={t("스킬·플러그인")} eyebrow="ASSISTANT EXTENSIONS"
      description={t("어시스턴트의 확장을 찾아보고, 지시문과 설정 근거를 확인하세요.")}
      actions={<Button icon={RefreshCw} busy={refreshing} disabled={pending} onClick={() => void refreshCatalog()}><Trans message={"목록 새로고침"} /></Button>} />
    <InlineNotice><AppNotice message={USAGE_NOTICE} />
      {catalog?.usageNotice && catalog.usageNotice !== USAGE_NOTICE && <p><AppNotice message={catalog.usageNotice} /></p>}
    </InlineNotice>
    <VersionSection state={versions} demo={demo}>
      <ExtensionCounts catalog={catalog} loading={pending} renderVersion={agent =>
        <VersionComparison agent={agent} state={versions} connector={connectors.find(item => item.agent === agent)} demo={demo} />} />
    </VersionSection>
    {refreshError && <ErrorState compact message={refreshError} retry={() => void refreshCatalog()} />}
    <section className="panel extension-explorer" aria-label={t("스킬·플러그인 목록")}>
      <ExtensionFilters query={query} projects={projects} update={update} />
      <div className="extension-results-heading">
        <h2 aria-live="polite">{pending ? t("목록 확인 중…") : catalog ? <><span className="numeric">{number(catalog.total)}</span><Trans message={"개 항목"} /></> : t("목록 확인 실패")}</h2>
        {filtered && <button type="button" className="text-button" onClick={clear}><X size={13} aria-hidden /><Trans message={"필터 초기화"} /></button>}
      </div>
      <div aria-busy={pending}>
        {resource.error ? <ErrorState message={resource.error} retry={resource.reload} />
          : !catalog ? <Skeleton rows={6} />
            : catalog.items.length ? <ExtensionList items={catalog.items} pending={pending} onSelect={select} />
              : pending ? <Skeleton rows={4} />
                : <EmptyState icon={filtered ? Search : Puzzle}
                  title={filtered ? t("조건에 맞는 확장이 없습니다") : t("발견한 확장이 없습니다")}
                  description={filtered ? t("검색어나 필터를 바꿔보세요.") : t("등록된 프로젝트를 선택하거나 검색 경로와 진단을 확인한 뒤 목록을 새로고침하세요.")}
                  action={filtered ? <Button onClick={clear}><Trans message={"필터 초기화"} /></Button>
                    : <Button icon={RefreshCw} busy={refreshing} onClick={() => void refreshCatalog()}><Trans message={"목록 새로고침"} /></Button>} />}
      </div>
      {catalog && !resource.error && <ExtensionPagination catalog={catalog} pending={pending} update={update} />}
    </section>
    {catalog && <ExtensionDiscovery catalog={catalog} />}
    {selected && <Suspense fallback={<div className="modal-loading" role="status"><Trans message={"확장 내용 불러오는 중…"} /></div>}>
      <ExtensionDetailDialog key={`${query.projectId ?? 'global'}:${selected.id}`} item={selected} projectId={query.projectId}
        onClose={() => setSelection(null)} onSelect={select} onPrepared={prepareRun} />
    </Suspense>}
  </div>;
}
