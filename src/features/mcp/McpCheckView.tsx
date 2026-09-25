import { Cable, RefreshCw, Square } from 'lucide-react';
import type { McpCheck, McpCheckStatus, McpCheckSummary, McpMetadataList } from '../../../shared/mcp';
import type { Project } from '../../../shared/types';
import { Button, EmptyState, ErrorState, InlineNotice } from '../../components/ui';
import { useFormat } from '../../i18n/useFormat';
import { useMcpI18n } from './i18n';
import { CHECK_LABELS, MCP_USAGE_NOTICE, TRANSPORT_LABELS } from './model';

export function McpCheckBadge({ status }: { status: McpCheckStatus }) {
  const { t } = useMcpI18n();
  return <span className={`status-badge mcp-check-${status}`}><span className="status-dot" aria-hidden />{t(CHECK_LABELS[status])}</span>;
}

export function McpLastCheck({ check }: { check: McpCheckSummary | null }) {
  const { t } = useMcpI18n();
  const { dateTime } = useFormat();
  const timestamp = check?.finishedAt ?? check?.startedAt;
  return <div className="mcp-last-check">
    <span>{t('마지막 워크벤치 점검')}</span>
    {check ? <McpCheckBadge status={check.status} /> : <strong className="text-muted">{t('점검하지 않음')}</strong>}
    {timestamp && <time dateTime={timestamp}>{dateTime(timestamp)}</time>}
  </div>;
}

function MetadataList({ title, list }: { title: string; list: McpMetadataList }) {
  const { t } = useMcpI18n();
  const { number } = useFormat();
  const labels = { 'not-requested': '요청하지 않음', ok: '목록 반환됨', unsupported: '서버에서 미지원', failed: '목록 조회 실패' };
  const observed = list.status === 'ok' || list.status === 'failed' || list.items.length > 0;
  return <section className="mcp-metadata-list" aria-label={title}>
    <div className="mcp-section-heading">
      <h4>{title}</h4><span className="numeric">{observed ? t('반환: {0}개', { 0: number(list.count) }) : '—'}</span>
    </div>
    <p className={`mcp-list-status ${list.status === 'failed' ? 'text-warning' : ''}`}>{t(labels[list.status])}</p>
    {list.truncated && <InlineNotice tone="warning"><strong>{t('부분 목록')}</strong>
      <p>{t('서버의 전체 개수는 알 수 없습니다. 반환된 항목만 표시합니다.')}</p></InlineNotice>}
    {list.status === 'failed' && <p className="mcp-hint">{t('조회가 완료되지 않았습니다. 표시한 항목만 확인되었습니다.')}</p>}
    {list.items.length > 0 ? <ul>{list.items.map((item, index) => <li key={`${item.name}-${index}`}>
      <code>{item.name}</code>
      {item.title && <strong className="mcp-metadata-title">{item.title}</strong>}
      <p className="mcp-original-description">{item.description ?? t('설명 없음')}</p>
    </li>)}</ul> : list.status === 'ok' ? <p className="mcp-hint">{t('반환한 항목이 없습니다.')}</p> : null}
  </section>;
}

export function McpCheckResult({ result }: { result: McpCheck | null }) {
  const { t, notice } = useMcpI18n();
  const { dateTime, duration } = useFormat();
  if (!result) return <EmptyState compact icon={Cable} title={t('점검하지 않음')}
    description={t('명시적으로 점검을 시작하면 결과가 여기에 표시됩니다.')} />;
  return <div className="mcp-result">
    <McpLastCheck check={result} />
    <p className="mcp-hint">{t(MCP_USAGE_NOTICE)}</p>
    <dl className="mcp-properties">
      <div><dt>{t('점검 시작')}</dt><dd><time dateTime={result.startedAt}>{dateTime(result.startedAt)}</time></dd></div>
      {result.finishedAt && <div><dt>{t('점검 종료')}</dt><dd><time dateTime={result.finishedAt}>{dateTime(result.finishedAt)}</time></dd></div>}
      <div><dt>{t('소요 시간')}</dt><dd>{duration(result.durationMs)}</dd></div>
      <div><dt>{t('전송 방식')}</dt><dd>{t(TRANSPORT_LABELS[result.transport])}</dd></div>
      <div><dt>{t('프로토콜 버전')}</dt><dd><code>{result.protocolVersion ?? '—'}</code></dd></div>
      <div><dt>{t('응답한 서버')}</dt><dd>{result.serverInfo?.name ?? '—'}</dd></div>
      <div><dt>{t('응답한 버전')}</dt><dd><code>{result.serverInfo?.version ?? '—'}</code></dd></div>
    </dl>
    {result.error && <InlineNotice tone={result.status === 'cancelled' ? 'info' : 'error'}>
      <code className="mcp-finding-code">{result.error.code}</code><p>{notice(result.error.message)}</p>
    </InlineNotice>}
    {result.warnings.length > 0 && <ul className="mcp-warnings">{result.warnings.map((warning, index) => <li key={index}>{notice(warning)}</li>)}</ul>}
    {result.usageNotice && <p className="mcp-hint">{notice(result.usageNotice)}</p>}
    <section>
      <h3>{t('반환된 메타데이터')}</h3>
      <p className="mcp-hint">{t('반환된 이름과 설명은 원문입니다. 도구 호출, 리소스 본문 읽기, 프롬프트 실행은 하지 않습니다.')}</p>
      <div className="mcp-metadata">
        <MetadataList title={t('도구 목록')} list={result.tools} />
        <MetadataList title={t('리소스 목록')} list={result.resources} />
        <MetadataList title={t('프롬프트 목록')} list={result.prompts} />
      </div>
    </section>
  </div>;
}

export interface McpActiveCheckProps {
  active: McpCheckSummary | null;
  result: McpCheck | null;
  projects: Project[];
  serverName?: string;
  error: string | null;
  cancelError: string | null;
  cancelling: boolean;
  disabled: boolean;
  onCancel: () => void;
  onRetry: () => void;
}

export function McpActiveCheck({ active, result, projects, serverName, error, cancelError, cancelling, disabled, onCancel, onRetry }: McpActiveCheckProps) {
  const { t, notice } = useMcpI18n();
  const { dateTime } = useFormat();
  if (active?.status !== 'running') return null;
  const current = result?.id === active.id ? result : null;
  return <section className="mcp-active-check" aria-label={t('진행 중인 워크벤치 점검')}>
    <div className="mcp-section-heading"><h3>{t('진행 중인 워크벤치 점검')}</h3>
      <Button size="small" variant="danger" icon={Square} busy={cancelling} disabled={disabled} onClick={onCancel}>{t('점검 취소')}</Button>
    </div>
    <p>{serverName ?? current?.serverId ?? active.id}</p>
    {current && <p className="mcp-hint">{t('선택된 프로젝트')}: {current.projectId
      ? projects.find(project => project.id === current.projectId)?.name ?? t('등록되지 않은 프로젝트') : t('전역')}</p>}
    <div className="mcp-active-status" role="status"><McpCheckBadge status={active.status} />
      <time dateTime={active.startedAt}>{dateTime(active.startedAt)}</time>
    </div>
    <p className="mcp-hint">{t('모든 어시스턴트와 프로젝트에서 한 번에 하나의 점검만 실행합니다.')}</p>
    {error && <><ErrorState compact message={notice(error)} />
      <p className="mcp-hint">{t('마지막으로 확인한 점검 상태를 표시합니다.')}</p>
      <Button size="small" icon={RefreshCw} disabled={disabled} onClick={onRetry}>{t('점검 상태 다시 조회')}</Button></>}
    {cancelError && <ErrorState compact message={notice(cancelError)} />}
  </section>;
}
