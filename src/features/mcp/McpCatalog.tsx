import { ArrowRight, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import type { McpCatalog, McpQuery, McpServerSummary } from '../../../shared/mcp';
import { AGENTS, type Agent, type Project } from '../../../shared/types';
import { AgentBadge, Button, Field, IconButton } from '../../components/ui';
import { useFormat } from '../../i18n/useFormat';
import { AGENT_META } from '../../lib/format';
import { McpConfigBadge } from './McpConfigurationView';
import { McpLastCheck } from './McpCheckView';
import { McpClientNames } from './McpClients';
import { useMcpI18n } from './i18n';
import { CONFIG_LABELS, SCOPE_LABELS, TRANSPORT_LABELS } from './model';

export function McpFilters({ query, projects, update }: {
  query: McpQuery; projects: Project[]; update: (patch: McpQuery) => void;
}) {
  const { t } = useMcpI18n();
  return <div className="mcp-filters">
    <div className="mcp-search-row">
      <div className="search-input"><Search size={18} aria-hidden />
        <input aria-label={t('MCP 서버 검색')} placeholder={t('서버 이름·설정 경로·플러그인 검색…')} maxLength={500}
          value={query.q ?? ''} onChange={event => update({ q: event.target.value || undefined })} />
        {query.q && <IconButton label={t('검색어 지우기')} icon={X} onClick={() => update({ q: undefined })} />}
      </div>
      <Field label={t('프로젝트')} htmlFor="mcp-project">
        <select id="mcp-project" aria-label={t('MCP 프로젝트 선택')} value={query.projectId ?? ''}
          onChange={event => update({ projectId: event.target.value || undefined,
            scope: !event.target.value && query.scope !== 'user' ? undefined : query.scope })}>
          <option value="">{t('전역 · 사용자 설정')}</option>
          {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </Field>
    </div>
    <div className="mcp-filter-grid">
      <Field label={t('어시스턴트')} htmlFor="mcp-agent">
        <select id="mcp-agent" aria-label={t('MCP 어시스턴트 필터')} value={query.agent ?? ''}
          onChange={event => update({ agent: event.target.value as Agent || undefined })}>
          <option value="">{t('모든 어시스턴트')}</option>
          {AGENTS.map(agent => <option key={agent} value={agent}>{AGENT_META[agent].short}</option>)}
        </select>
      </Field>
      <Field label={t('범위')} htmlFor="mcp-scope">
        <select id="mcp-scope" aria-label={t('MCP 범위 필터')} value={query.scope ?? ''}
          onChange={event => update({ scope: event.target.value as McpQuery['scope'] || undefined })}>
          <option value="">{t('모든 범위')}</option>
          {Object.entries(SCOPE_LABELS).map(([scope, label]) =>
            <option key={scope} value={scope} disabled={scope !== 'user' && !query.projectId}>{t(label)}</option>)}
        </select>
      </Field>
      <Field label={t('전송 방식')} htmlFor="mcp-transport">
        <select id="mcp-transport" aria-label={t('MCP 전송 방식 필터')} value={query.transport ?? ''}
          onChange={event => update({ transport: event.target.value as McpQuery['transport'] || undefined })}>
          <option value="">{t('모든 전송 방식')}</option>
          {Object.entries(TRANSPORT_LABELS).map(([transport, label]) => <option key={transport} value={transport}>{t(label)}</option>)}
        </select>
      </Field>
      <Field label={t('설정 상태')} htmlFor="mcp-status">
        <select id="mcp-status" aria-label={t('MCP 설정 상태 필터')} value={query.status ?? ''}
          onChange={event => update({ status: event.target.value as McpQuery['status'] || undefined })}>
          <option value="">{t('모든 상태')}</option>
          {Object.entries(CONFIG_LABELS).map(([status, label]) => <option key={status} value={status}>{t(label)}</option>)}
        </select>
      </Field>
    </div>
    <p className="field-hint">{t('등록된 프로젝트를 선택하면 사용자 설정과 해당 프로젝트의 선언을 함께 확인합니다.')}</p>
  </div>;
}

export function McpServerList({ items, projects, pending, onSelect }: {
  items: McpServerSummary[]; projects: Project[]; pending: boolean; onSelect: (item: McpServerSummary) => void;
}) {
  const { t } = useMcpI18n();
  return <div className="mcp-server-grid">
    {items.map(item => <article className="mcp-server-card" key={item.id}>
      <div className="mcp-card-heading"><AgentBadge agent={item.agent} compact /><McpConfigBadge status={item.status} reason={item.statusReason} /></div>
      <h3>{item.name}</h3>
      <div className="mcp-source-clients"><span>{t('설정 클라이언트')}</span><McpClientNames source={item.source} /></div>
      <dl className="mcp-card-properties">
        <div><dt>{t('프로젝트')}</dt><dd>{item.projectId
          ? projects.find(project => project.id === item.projectId)?.name ?? t('등록되지 않은 프로젝트') : t('전역')}</dd></div>
        <div><dt>{t('범위')}</dt><dd>{t(SCOPE_LABELS[item.scope])}</dd></div>
        <div><dt>{t('전송 방식')}</dt><dd>{t(TRANSPORT_LABELS[item.transport])}</dd></div>
        <div><dt>{t('어시스턴트 연결')}</dt><dd>{t('연결 상태 불명')}</dd></div>
      </dl>
      <code className="mcp-source-path">{item.source.path}</code>
      {(item.source.pluginName || item.source.agentName) && <p className="mcp-hint">{item.source.pluginName ?? item.source.agentName}</p>}
      <McpLastCheck check={item.lastCheck} />
      {item.checkSupport !== 'supported' && <p className="mcp-hint">{t(item.checkSupport === 'blocked' ? '설정 근거로 점검 차단' : '워크벤치 점검 미지원')}</p>}
      <div className="mcp-card-footer"><span>{t('정적 진단 {0}개', { 0: item.findings.length })}</span>
        <Button size="small" disabled={pending} aria-label={t('{0} 설정 및 점검 보기', { 0: item.name })} onClick={() => onSelect(item)}>
          {t('설정 및 점검')}<ArrowRight size={14} aria-hidden />
        </Button>
      </div>
    </article>)}
  </div>;
}

export function McpPagination({ catalog, pending, update }: {
  catalog: McpCatalog; pending: boolean; update: (patch: McpQuery) => void;
}) {
  const { t } = useMcpI18n();
  const { number } = useFormat();
  const { offset, total, limit } = catalog;
  return <div className="pagination mcp-pagination">
    <div className="pagination-summary">
      <span>{total ? number(Math.min(offset + 1, total)) : 0}–{number(Math.min(offset + catalog.items.length, total))} / {number(total)}</span>
      <select aria-label={t('페이지당 MCP 서버 수')} value={limit} disabled={pending}
        onChange={event => update({ limit: Number(event.target.value), offset: 0 })}>
        {[20, 40, 60].map(size => <option value={size} key={size}>{t('{0}개씩', { 0: size })}</option>)}
      </select>
    </div>
    <nav className="pagination-controls" aria-label={t('MCP 페이지')}>
      <IconButton label={t('이전 페이지')} icon={ChevronLeft} disabled={pending || offset === 0}
        onClick={() => update({ offset: Math.max(0, offset - limit) })} />
      <span className="mcp-page-number">{t('{0} / {1} 페이지', {
        0: number(Math.floor(offset / limit) + 1), 1: number(Math.max(1, Math.ceil(total / limit))),
      })}</span>
      <IconButton label={t('다음 페이지')} icon={ChevronRight} disabled={pending || offset + limit >= total}
        onClick={() => update({ offset: offset + limit })} />
    </nav>
  </div>;
}

export function McpDiscovery({ catalog }: { catalog: McpCatalog }) {
  const { t, notice } = useMcpI18n();
  const { dateTime } = useFormat();
  return <details className="panel mcp-discovery">
    <summary>{t('검색 진단')}{catalog.warnings.length > 0 && <span className="count-badge">{catalog.warnings.length}</span>}</summary>
    <div><p className="mcp-hint">{t('검색 시각')} <time dateTime={catalog.scannedAt}>{dateTime(catalog.scannedAt)}</time>
      {catalog.demo && <span className="tag">{t('데모 데이터')}</span>}</p>
      {catalog.warnings.length > 0 && <ul className="mcp-warnings">{catalog.warnings.map((warning, index) => <li key={index}>{notice(warning)}</li>)}</ul>}
      <p className="mcp-hint">{t('설정 파일은 읽기 전용입니다. 목록 갱신으로 프로세스나 연결 점검을 시작하지 않습니다.')}</p>
    </div>
  </details>;
}
