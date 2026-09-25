import { useCallback, useEffect, useState } from 'react';
import { Cable, RefreshCw, Search, X } from 'lucide-react';
import type { McpCatalog, McpQuery, McpServerSummary } from '../../shared/mcp';
import { Button, EmptyState, ErrorState, InlineNotice, PageHeading, Panel, Skeleton } from '../components/ui';
import { mcpApi } from '../features/mcp/api';
import { McpDiscovery, McpFilters, McpPagination, McpServerList } from '../features/mcp/McpCatalog';
import { McpActiveCheck, type McpActiveCheckProps } from '../features/mcp/McpCheckView';
import { McpDetailDialog } from '../features/mcp/McpDetailDialog';
import { useMcpI18n } from '../features/mcp/i18n';
import { MCP_USAGE_NOTICE } from '../features/mcp/model';
import { useMcpAction, useMcpChecks, useMcpResource, useMcpVisibility } from '../features/mcp/useMcp';
import { useDebounced } from '../hooks/useResource';
import { useFormat } from '../i18n/useFormat';
import { useApp, useData } from '../state/AppProvider';
import '../styles/mcp.css';

/** Independent page; the coordinator supplies only the application route/navigation entry. */
export function Mcp() {
  const { t, notice } = useMcpI18n();
  const { number } = useFormat();
  const { projects, demo } = useData();
  const { modal } = useApp();
  const visible = useMcpVisibility();
  const [query, setQuery] = useState<McpQuery>({ limit: 20, offset: 0 });
  const q = useDebounced(query.q ?? '');
  const requestQuery = { ...query, q: q.trim() || undefined };
  const key = JSON.stringify(requestQuery);
  const resource = useMcpResource<McpCatalog>(key, signal => mcpApi.catalog(requestQuery, signal), visible);
  const catalog = resource.data;
  const checks = useMcpChecks(catalog, visible, resource.reload);
  const refreshAction = useMcpAction(visible);
  const cancelAction = useMcpAction(visible);
  const [selection, setSelection] = useState<{ item: McpServerSummary; projectId?: string } | null>(null);
  const selected = selection && selection.projectId === query.projectId ? selection : null;
  const pending = resource.loading || q !== (query.q ?? '');
  const filtered = Boolean(query.q || query.agent || query.scope || query.transport || query.status);
  const isDemo = demo || Boolean(catalog?.demo);
  const update = useCallback((patch: McpQuery) => setQuery(previous => ({ ...previous, offset: 0, ...patch })), []);
  const clear = () => setQuery(previous => ({ projectId: previous.projectId, limit: previous.limit, offset: 0 }));

  useEffect(() => { setSelection(null); }, [query.projectId, modal]);
  useEffect(() => {
    if (query.projectId && !projects.some(project => project.id === query.projectId)) {
      setQuery(previous => ({ ...previous, projectId: undefined, scope: undefined, offset: 0 }));
    }
  }, [projects, query.projectId]);
  useEffect(() => {
    if (catalog && !pending && catalog.offset > 0 && catalog.offset >= catalog.total) {
      update({ offset: Math.max(0, Math.ceil(catalog.total / catalog.limit) - 1) * catalog.limit });
    }
  }, [catalog, pending, update]);

  async function refreshCatalog() {
    const refreshed = await refreshAction.run('refresh', signal => mcpApi.refresh(query.projectId, signal));
    if (refreshed) resource.reload();
  }
  async function cancelCheck() {
    if (!checks.active || isDemo) return;
    const checkId = checks.active.id;
    const cancelled = await cancelAction.run('cancel', signal => mcpApi.cancel(checkId, signal));
    if (cancelled?.id === checkId) checks.accept(cancelled);
  }
  const activeCheck: McpActiveCheckProps = {
    active: checks.active, result: checks.result, projects,
    serverName: checks.result?.id === checks.active?.id
      ? catalog?.items.find(item => item.id === checks.result?.serverId)?.name : undefined,
    error: checks.error, cancelError: cancelAction.error, cancelling: cancelAction.busy === 'cancel',
    disabled: !visible || isDemo, onCancel: () => void cancelCheck(), onRetry: checks.retry,
  };

  return <div className="mcp-workspace">
    <PageHeading title={t('MCP 서버')} eyebrow="ASSISTANT MCP"
      description={t('어시스턴트별 서버 선언을 살펴보고, 설정 분석과 별도의 연결·메타데이터 점검을 진행하세요.')}
      actions={<Button icon={RefreshCw} busy={refreshAction.busy === 'refresh'} disabled={pending || !visible}
        onClick={() => void refreshCatalog()}>{t('목록 새로고침')}</Button>} />
    <InlineNotice>{t(MCP_USAGE_NOTICE)}</InlineNotice>
    {catalog?.usageNotice && <p className="mcp-hint">{notice(catalog.usageNotice)}</p>}
    {isDemo && <InlineNotice>{t('데모에서는 프로세스나 네트워크 점검을 시작할 수 없습니다.')}</InlineNotice>}
    {!visible && <p className="mcp-hint" role="status">{t('화면이 숨겨져 조회를 일시정지했습니다.')}</p>}
    {refreshAction.error && <ErrorState compact message={notice(refreshAction.error)} retry={() => void refreshCatalog()} />}
    <McpActiveCheck {...activeCheck} />
    {checks.error && !checks.active && <ErrorState compact message={notice(checks.error)}
      retry={() => { checks.retry(); resource.reload(); }} />}
    <Panel title={t('서버 선언')} className="mcp-explorer">
      <div aria-label={t('MCP 서버 목록')}>
        <McpFilters query={query} projects={projects} update={update} />
        <div className="mcp-results-heading">
          <p aria-live="polite">{pending ? t('MCP 목록 확인 중…') : catalog ? t('서버 {0}개', { 0: number(catalog.total) }) : t('MCP 목록 확인 실패')}</p>
          {filtered && <button type="button" className="text-button" onClick={clear}><X size={13} aria-hidden />{t('필터 초기화')}</button>}
        </div>
        <div aria-busy={pending}>
          {resource.error ? <ErrorState message={notice(resource.error)} retry={resource.reload} />
            : !catalog ? <Skeleton rows={6} />
              : catalog.items.length ? <McpServerList items={catalog.items} projects={projects} pending={pending}
                onSelect={item => setSelection({ item, projectId: query.projectId })} />
                : pending ? <Skeleton rows={4} /> : <EmptyState icon={filtered ? Search : Cable}
                  title={t(filtered ? '조건에 맞는 MCP 서버가 없습니다' : '발견한 MCP 서버가 없습니다')}
                  description={t('프로젝트 선택과 검색 조건을 확인한 뒤 목록을 새로고침하세요.')}
                  action={filtered ? <Button onClick={clear}>{t('필터 초기화')}</Button>
                    : <Button icon={RefreshCw} busy={refreshAction.busy === 'refresh'} disabled={!visible}
                      onClick={() => void refreshCatalog()}>{t('목록 새로고침')}</Button>} />}
        </div>
        {catalog && !resource.error && <McpPagination catalog={catalog} pending={pending} update={update} />}
      </div>
    </Panel>
    {catalog && <McpDiscovery catalog={catalog} />}
    {selected && <McpDetailDialog key={`${selected.projectId ?? 'global'}:${selected.item.id}`} item={selected.item}
      projectId={selected.projectId} projects={projects} demo={isDemo} visible={visible} activeCheck={activeCheck}
      onCheck={checks.accept} onCatalogReload={resource.reload} onClose={() => setSelection(null)} />}
  </div>;
}
