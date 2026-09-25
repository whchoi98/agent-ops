import { useEffect, useId, useRef, useState } from 'react';
import type { McpCheck, McpCheckPreview, McpDetail, McpServerSummary } from '../../../shared/mcp';
import type { Project } from '../../../shared/types';
import { Dialog } from '../../components/Dialog';
import { AgentBadge, Button, ErrorState, InlineNotice, Skeleton } from '../../components/ui';
import { useNow } from '../../hooks/useResource';
import { mcpApi } from './api';
import { McpActiveCheck, McpCheckResult, McpLastCheck, type McpActiveCheckProps } from './McpCheckView';
import { McpConfigBadge, McpConfigurationAnalysis } from './McpConfigurationView';
import { McpPreviewActions, McpPreviewView } from './McpPreview';
import { useMcpI18n } from './i18n';
import { checkBlockReason, MCP_USAGE_NOTICE, previewBlockReason } from './model';
import { useMcpAction, useMcpResource } from './useMcp';

const VIEWS = [{ id: 'analysis', label: '설정 분석' }, { id: 'check', label: '연결·메타데이터 점검' }] as const;

export function McpDetailDialog({ item, projectId, projects, demo, visible, activeCheck, onCheck, onCatalogReload, onClose }: {
  item: McpServerSummary; projectId?: string; projects: Project[]; demo: boolean; visible: boolean;
  activeCheck: McpActiveCheckProps; onCheck: (result: McpCheck) => void; onCatalogReload: () => void; onClose: () => void;
}) {
  const { t, notice } = useMcpI18n();
  const resource = useMcpResource<McpDetail>(JSON.stringify([item.id, projectId]), async signal => {
    const detail = await mcpApi.detail(item.id, projectId, signal);
    if (detail.id !== item.id || detail.projectId !== (projectId ?? null)) {
      throw new Error('현재 서버와 프로젝트에 맞는 새 미리보기가 필요합니다.');
    }
    return detail;
  }, visible);
  const detail = resource.data;
  const [view, setView] = useState<(typeof VIEWS)[number]['id']>('analysis');
  const [preview, setPreview] = useState<McpCheckPreview | null>(null);
  const action = useMcpAction(visible);
  const viewId = useId();
  const previewFocus = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const reloadedCheck = useRef<string | null>(null);
  const now = useNow(Boolean(preview) && visible);
  // Match the server's fingerprint-aware detail result before reusing a newer poll response.
  const result = detail?.lastResult?.id === activeCheck.result?.id ? activeCheck.result : detail?.lastResult ?? null;
  const obsoleteCheck = Boolean(activeCheck.error && !activeCheck.active && detail?.lastResult?.status === 'running');

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!visible) setPreview(null); }, [visible]);
  useEffect(() => {
    if (activeCheck.error && !activeCheck.active) resource.reload();
  }, [activeCheck.error, activeCheck.active?.id, resource.reload]);
  useEffect(() => {
    if (detail?.lastResult?.status === 'running') onCheck(detail.lastResult);
  }, [detail?.lastResult, onCheck]);
  useEffect(() => {
    if (!result || result !== activeCheck.result || result.status === 'running' || reloadedCheck.current === result.id) return;
    reloadedCheck.current = result.id;
    resource.reload();
  }, [result?.id, result?.status, resource.reload]);
  useEffect(() => { if (preview) previewFocus.current?.focus({ preventScroll: true }); }, [preview]);

  async function prepare() {
    if (!detail || resource.loading || resource.error || obsoleteCheck || checkBlockReason(detail, demo, activeCheck.active)) return;
    setPreview(null);
    setView('check');
    const prepared = await action.run('preview', signal => mcpApi.preview(item.id, projectId, signal));
    if (prepared) setPreview(prepared);
  }

  async function start() {
    if (!detail || !preview || resource.loading || resource.error || obsoleteCheck || checkBlockReason(detail, demo, activeCheck.active)
      || previewBlockReason(preview, item.id, projectId, Date.now())) return;
    const reviewed = preview;
    // A submitted token is not offered for retry, even if the response is lost.
    setPreview(null);
    setView('check');
    const accepted = await action.run('check', async signal => {
      const check = await mcpApi.check(item.id, projectId, reviewed.previewId, signal);
      if (check.serverId !== item.id || check.projectId !== (projectId ?? null)) {
        throw new Error('점검 결과의 식별자가 요청과 일치하지 않습니다.');
      }
      return check;
    });
    if (accepted) {
      resource.replaceData({ ...detail, lastCheck: accepted, lastResult: accepted });
      onCheck(accepted);
      setView('check');
    }
    if (mounted.current && !document.hidden) {
      // A rejected/lost POST may mean another tab holds the single check slot.
      resource.reload();
      onCatalogReload();
    }
  }

  return <Dialog title={detail?.name ?? item.name} size="large" className="mcp-detail-dialog"
    bodyClassName="mcp-detail-body" onClose={onClose}
    description={<div className="mcp-dialog-meta"><AgentBadge agent={detail?.agent ?? item.agent} compact />
      <McpConfigBadge status={detail?.status ?? item.status} /></div>}
    footer={<div className="mcp-detail-footer">
      <McpPreviewActions detail={resource.error ? null : detail} preview={preview} projectId={projectId}
        demo={demo} activeCheck={activeCheck.active} busy={action.busy}
        visible={visible && !resource.loading && !obsoleteCheck} now={now} onPreview={() => void prepare()} onCheck={() => void start()} />
      <Button onClick={onClose}>{t('닫기')}</Button>
    </div>}>
    <InlineNotice>{t(MCP_USAGE_NOTICE)}</InlineNotice>
    {!visible && <p className="mcp-hint" role="status">{t('화면이 숨겨져 조회를 일시정지했습니다.')}</p>}
    {activeCheck.error && !activeCheck.active && <ErrorState compact message={notice(activeCheck.error)} />}
    {action.error && <div className="mcp-action-error"><ErrorState compact message={notice(action.error)} />
      {action.failedAction === 'check' && <p className="mcp-hint">
        {t('시작 요청이 완료되지 않았습니다. 목록과 점검 상태를 확인하고 새 미리보기를 준비하세요.')}
      </p>}</div>}
    {resource.error ? <ErrorState message={notice(resource.error)} retry={resource.reload} /> : !detail ? <Skeleton rows={6} /> : <>
      {detail.usageNotice && <p className="mcp-hint">{notice(detail.usageNotice)}</p>}
      <McpLastCheck check={result ?? detail.lastCheck} />
      <div className="mcp-detail-tabs" role="group" aria-label={t('MCP 상세 보기')}
        onKeyDown={event => {
          const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (!direction && event.key !== 'Home' && event.key !== 'End') return;
          event.preventDefault();
          const current = VIEWS.findIndex(tab => tab.id === view);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? VIEWS.length - 1
            : (current + direction + VIEWS.length) % VIEWS.length;
          setView(VIEWS[next].id);
          event.currentTarget.querySelectorAll('button')[next]?.focus();
        }}>
        {VIEWS.map(tab => <button key={tab.id} type="button" id={`${viewId}-${tab.id}`} aria-pressed={view === tab.id}
          aria-controls={`${viewId}-content`} className={view === tab.id ? 'active' : ''} onClick={() => setView(tab.id)}>{t(tab.label)}</button>)}
      </div>
      <section id={`${viewId}-content`} aria-labelledby={`${viewId}-${view}`} className="mcp-detail-content">
        {view === 'analysis' ? <McpConfigurationAnalysis detail={detail} projects={projects} /> : <>
          <McpActiveCheck {...activeCheck} />
          {action.busy === 'check' ? <div><p className="mcp-hint" role="status">{t('워크벤치 점검 시작을 요청하고 있습니다…')}</p><Skeleton rows={3} /></div>
            : action.busy === 'preview' ? <Skeleton rows={4} /> : preview
            ? <div ref={previewFocus} tabIndex={-1} className="mcp-preview-focus" aria-label={t('점검 미리보기')}><McpPreviewView preview={preview} /></div>
            : <McpCheckResult result={result} />}
        </>}
      </section>
    </>}
    {(activeCheck.active || action.busy === 'check') && <p className="mcp-hint">{t('화면을 닫아도 시작된 점검은 서버의 제한 시간 안에서 계속됩니다. 중단하려면 점검 취소를 누르세요.')}</p>}
  </Dialog>;
}
