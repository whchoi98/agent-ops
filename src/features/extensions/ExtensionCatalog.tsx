import { ArrowRight, ChevronLeft, ChevronRight, CircleAlert, FolderSearch } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ExtensionCatalog, ExtensionQuery, ExtensionStatus, ExtensionSummary } from '../../../shared/extensions';
import { AGENTS, type Agent } from '../../../shared/types';
import { AgentBadge, Button, IconButton } from '../../components/ui';
import { dateTime, number } from '../../lib/format';
import { KIND_LABELS, SCOPE_LABELS, STATUS_LABELS } from './model';

export function ExtensionStatusBadge({ status, reason }: { status: ExtensionStatus; reason?: string }) {
  return <span className={`status-badge extension-status-${status}`} title={reason}>
    <span className="status-dot" aria-hidden />{STATUS_LABELS[status]}
  </span>;
}

export function ExtensionCounts({ catalog, loading, renderVersion }: {
  catalog: ExtensionCatalog | null; loading: boolean; renderVersion?: (agent: Agent) => ReactNode;
}) {
  return <div className="extension-counts" aria-label="어시스턴트별 발견 항목" aria-busy={loading}>
    {AGENTS.map(agent => {
      const counts = catalog?.counts[agent];
      return <section className="panel extension-count-card" key={agent}>
        <div className="extension-count-heading"><AgentBadge agent={agent} />
          <span><strong className="numeric">{counts ? number(counts.total) : '—'}</strong>개</span>
        </div>
        <p className="extension-kind-counts">{counts
          ? `스킬 ${number(counts.skills)} · 플러그인 ${number(counts.plugins)} · 파워 ${number(counts.powers)}`
          : loading ? '목록 확인 중…' : '목록을 불러오면 개수가 표시됩니다.'}</p>
        {counts && <dl className="extension-status-counts">
          {Object.entries(STATUS_LABELS).map(([status, label]) => <div key={status}>
            <dt>{label}</dt><dd className="numeric">{number(counts[status as ExtensionStatus])}</dd>
          </div>)}
        </dl>}
        {renderVersion?.(agent)}
      </section>;
    })}
  </div>;
}

export function ExtensionList({ items, pending, onSelect }: {
  items: ExtensionSummary[]; pending: boolean; onSelect: (item: ExtensionSummary) => void;
}) {
  return <div className="extension-grid">
    {items.map(item => <article className="extension-card" key={item.id}>
      <div className="extension-card-heading"><AgentBadge agent={item.agent} />
        <ExtensionStatusBadge status={item.status} reason={item.statusReason} />
      </div>
      <h3>{item.name}</h3>
      <p className="extension-description">{item.description || '설명 선언이 없습니다. 내용을 열어 지시문과 설정을 확인하세요.'}</p>
      <div className="extension-item-meta">
        <span className="tag">{KIND_LABELS[item.kind]}</span><span>{SCOPE_LABELS[item.scope]}</span>
        {item.version && <span>v{item.version}</span>}
        {item.pluginName && <span>소속: {item.pluginName}</span>}
        {item.childCount > 0 && <span>포함 항목 {number(item.childCount)}개</span>}
      </div>
      <code className="extension-path">{item.path}</code>
      <div className="extension-card-footer">
        <span>{item.warnings.length > 0 && <><CircleAlert size={13} aria-hidden />확인할 항목 {item.warnings.length}개</>}</span>
        <Button size="small" disabled={pending} aria-label={`${item.name} 내용 보기`} onClick={() => onSelect(item)}>
          내용 보기<ArrowRight size={14} aria-hidden />
        </Button>
      </div>
    </article>)}
  </div>;
}

export function ExtensionPagination({ catalog, pending, update }: {
  catalog: ExtensionCatalog; pending: boolean; update: (patch: ExtensionQuery) => void;
}) {
  const { total, offset, limit } = catalog;
  const page = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  return <div className="pagination extension-pagination">
    <div className="pagination-summary">
      <span>{total ? number(Math.min(offset + 1, total)) : 0}–{number(Math.min(offset + catalog.items.length, total))} / {number(total)}</span>
      <select aria-label="페이지당 확장 수" value={limit} disabled={pending}
        onChange={event => update({ limit: Number(event.target.value) })}>
        <option value={20}>20개씩</option><option value={40}>40개씩</option><option value={60}>60개씩</option>
      </select>
    </div>
    <nav className="pagination-controls" aria-label="스킬·플러그인 페이지">
      <IconButton label="이전 페이지" icon={ChevronLeft} disabled={offset === 0 || pending}
        onClick={() => update({ offset: Math.max(0, offset - limit) })} />
      <span className="extension-page-number" aria-live="polite">{number(page)} / {number(pageCount)} 페이지</span>
      <IconButton label="다음 페이지" icon={ChevronRight} disabled={offset + limit >= total || pending}
        onClick={() => update({ offset: offset + limit })} />
    </nav>
  </div>;
}

export function ExtensionDiscovery({ catalog }: { catalog: ExtensionCatalog }) {
  return <details className="panel extension-discovery">
    <summary><FolderSearch size={16} aria-hidden />검색 경로와 진단
      {catalog.warnings.length > 0 && <span className="count-badge">{catalog.warnings.length}</span>}
    </summary>
    <div className="extension-discovery-body">
      <p className="extension-scan-time">확인 시각 <time dateTime={catalog.scannedAt}>{dateTime(catalog.scannedAt)}</time>
        {catalog.demo && <span className="tag">데모 데이터</span>}</p>
      {!!catalog.warnings.length && <ul className="extension-warnings">{catalog.warnings.map((warning, index) =>
        <li key={index}>{warning}</li>)}</ul>}
      {catalog.roots.length ? <ul className="extension-roots">{catalog.roots.map((root, index) => <li key={`${root.agent}-${root.path}-${index}`}>
        <div><AgentBadge agent={root.agent} /><span>{SCOPE_LABELS[root.scope]}</span>
          <span className={root.exists ? '' : 'text-warning'}>{root.exists ? '경로 있음' : '경로 없음'}</span></div>
        <code>{root.path}</code><p>{root.description}</p>
      </li>)}</ul> : <p className="text-muted">표시할 검색 경로가 없습니다.</p>}
    </div>
  </details>;
}
