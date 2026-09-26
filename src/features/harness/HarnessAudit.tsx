import { ChevronLeft, ChevronRight, RefreshCw, Search } from 'lucide-react';
import {
  HARNESS_AUDIT_CLIENTS, type HarnessAction, type HarnessAuditClient, type HarnessAuditPage, type HarnessAuditQuery,
} from '../../../shared/harness';
import { Button, EmptyState, Field, IconButton, Panel, Skeleton } from '../../components/ui';
import { useDebounced } from '../../hooks/useResource';
import { useFormat } from '../../i18n/useFormat';
import { harnessApi } from './api';
import { useHarnessI18n } from './i18n';
import {
  ACTION_LABELS, AUDIT_SESSION_LIMIT, AUDIT_TEXT_LIMIT, CLIENT_LABELS, ORIGIN_LABELS, RISK_LABELS, type HarnessProblem,
} from './model';
import { HarnessActionBadge, HarnessError, HarnessNotices, HarnessStorageView } from './ui';
import { useHarnessRead } from './useHarness';

export interface HarnessAuditViewProps {
  page: HarnessAuditPage | null; query: HarnessAuditQuery; loading: boolean; error: HarnessProblem | null;
  onFilters: (patch: HarnessAuditQuery) => void; onPage: (offset: number) => void; onReload: () => void;
}
export function HarnessAuditView({ page, query, loading, error, onFilters, onPage, onReload }: HarnessAuditViewProps) {
  const { t } = useHarnessI18n();
  const { dateTime, number } = useFormat();
  const offset = page?.offset ?? query.offset ?? 0;
  const limit = page?.limit ?? query.limit ?? 20;
  return <Panel title={t('최근 감사 기록')}
    actions={<Button size="small" icon={RefreshCw} busy={loading} onClick={onReload}>{t('감사 기록 새로고침')}</Button>}>
    <div className="harness-panel-body harness-stack">
      <div className="harness-audit-filters">
        <Field label={t('감사 클라이언트 필터')} htmlFor="harness-audit-client">
          <select id="harness-audit-client" value={query.client ?? ''}
            onChange={event => onFilters({ client: event.target.value as HarnessAuditClient || undefined })}>
            <option value="">{t('모든 클라이언트')}</option>
            {HARNESS_AUDIT_CLIENTS.map(client => <option key={client} value={client}>{t(CLIENT_LABELS[client])}</option>)}
          </select>
        </Field>
        <Field label={t('감사 판정 필터')} htmlFor="harness-audit-action">
          <select id="harness-audit-action" value={query.action ?? ''} onChange={event => onFilters({ action: event.target.value as HarnessAction || undefined })}>
            <option value="">{t('모든 판정')}</option>
            {Object.entries(ACTION_LABELS).map(([action, label]) => <option key={action} value={action}>{t(label)}</option>)}
          </select>
        </Field>
        <Field label={t('세션 ID 필터')} htmlFor="harness-audit-session">
          <input id="harness-audit-session" value={query.sessionId ?? ''} maxLength={AUDIT_SESSION_LIMIT} autoComplete="off" spellCheck={false}
            onChange={event => onFilters({ sessionId: event.target.value || undefined })} />
        </Field>
        <Field label={t('감사 텍스트 검색')} htmlFor="harness-audit-q">
          <input id="harness-audit-q" value={query.q ?? ''} maxLength={AUDIT_TEXT_LIMIT} placeholder={t('도구 이름·이유·메타데이터 검색')}
            onChange={event => onFilters({ q: event.target.value || undefined })} />
        </Field>
      </div>
      {(query.client || query.action || query.q || query.sessionId) && <div className="harness-actions">
        <Button size="small" variant="ghost" onClick={() => onFilters({ client: undefined, action: undefined, q: undefined, sessionId: undefined })}>
          {t('필터 초기화')}
        </Button>
      </div>}
      <p className="harness-hint">{t('전체 원본 건수가 아닌 읽어서 보관한 범위의 합계입니다.')}</p>
      <HarnessError problem={error} onRetry={onReload} busy={loading} retryLabel={t('감사 기록 새로고침')} />
      <div aria-busy={loading}>
        {page ? <>
          <table className="harness-audit-table">
            <caption aria-live="polite">{t('보관 범위 내 일치 기록 {total}개', { total: number(page.total) })}</caption>
            <thead><tr><th scope="col">{t('시각 · 클라이언트')}</th><th scope="col">{t('도구 · 판정')}</th>
              <th scope="col">{t('위험도 · 이유')}</th><th scope="col">{t('출처 · 메타데이터')}</th></tr></thead>
            <tbody>{page.items.map(record => <tr key={record.id}>
              <td data-label={t('시각 · 클라이언트')}>
                <time dateTime={record.timestamp}>{dateTime(record.timestamp)}</time>
                <span>{record.client ? t(CLIENT_LABELS[record.client]) : t('클라이언트 미기록')}</span>
              </td>
              <td data-label={t('도구 · 판정')}><code translate="no">{record.toolName}</code><HarnessActionBadge action={record.action} /></td>
              <td data-label={t('위험도 · 이유')}>
                <strong>{record.risk ? t(RISK_LABELS[record.risk]) : t('위험도 미기록')}</strong>
                <p translate="no">{record.reason}</p>
              </td>
              <td data-label={t('출처 · 메타데이터')}>
                <span className="tag">{t(ORIGIN_LABELS[record.origin])}</span>
                <details className="harness-record-details"><summary>{t('메타데이터')}</summary>
                  <dl className="harness-properties harness-record-properties">
                    <div><dt>{t('세션 ID')}</dt><dd translate="no">{record.sessionId ?? '—'}</dd></div>
                    <div><dt>{t('실행 ID')}</dt><dd translate="no">{record.runId ?? '—'}</dd></div>
                    <div><dt>{t('프로젝트 ID')}</dt><dd translate="no">{record.projectId ?? '—'}</dd></div>
                    <div><dt>{t('이벤트 유형')}</dt><dd translate="no">{record.eventType}</dd></div>
                    <div><dt>{t('출처 ID')}</dt><dd translate="no">{record.sourceId}</dd></div>
                    <div><dt>{t('기록 ID')}</dt><dd translate="no">{record.id}</dd></div>
                    <div><dt>{t('원본 상태')}</dt><dd translate="no">{record.status ?? '—'}</dd></div>
                    <div><dt>{t('소요 시간')}</dt><dd>{record.durationMs == null ? '—' : `${number(record.durationMs)} ms`}</dd></div>
                  </dl>
                </details>
              </td>
            </tr>)}</tbody>
          </table>
          {!page.items.length && !loading && <EmptyState compact icon={Search}
            title={t(page.total ? '이 페이지에 기록이 없습니다. 이전 페이지로 이동하거나 새로고침하세요.' : '감사 기록이 없습니다')}
            description={t('선택한 프로젝트와 필터를 확인하거나 감사 기록을 새로고침하세요.')} />}
          <div className="harness-pagination">
            <span className="harness-hint">{page.items.length ? number(offset + 1) : 0}–{page.items.length ? number(Math.min(offset + page.items.length, page.total)) : 0} / {number(page.total)}</span>
            <select aria-label={t('페이지당 감사 기록 수')} value={limit} disabled={loading}
              onChange={event => onFilters({ limit: Number(event.target.value) })}>
              {[20, 50, 100].map(size => <option key={size} value={size}>{t('{0}개씩', { 0: size })}</option>)}
            </select>
            <nav aria-label={t('감사 페이지')}>
              <IconButton icon={ChevronLeft} label={t('이전 페이지')} disabled={loading || offset === 0}
                onClick={() => onPage(Math.max(0, offset - limit))} />
              <span>{t('{0} / {1} 페이지', { 0: number(Math.floor(offset / limit) + 1), 1: number(Math.max(1, Math.ceil(page.total / limit))) })}</span>
              <IconButton icon={ChevronRight} label={t('다음 페이지')} disabled={loading || offset + limit >= page.total}
                onClick={() => onPage(offset + limit)} />
            </nav>
          </div>
        </> : loading ? <Skeleton rows={4} /> : null}
      </div>
      <p className="harness-hint">{t('원본 입력과 출력은 감사 표에 표시하거나 저장하지 않습니다.')}</p>
      {page && <>
        <HarnessNotices messages={page.warnings} />
        <HarnessStorageView storage={page.storage} sources={page.sources} />
      </>}
    </div>
  </Panel>;
}

export function HarnessAudit({ query, revision, onFilters, onPage }: {
  query: HarnessAuditQuery; revision: number; onFilters: HarnessAuditViewProps['onFilters']; onPage: HarnessAuditViewProps['onPage'];
}) {
  const q = useDebounced(query.q ?? '');
  const sessionId = useDebounced(query.sessionId ?? '');
  const requested = { ...query, q: q || undefined, sessionId: sessionId.trim() || undefined };
  const resource = useHarnessRead(JSON.stringify([requested, revision]), signal => harnessApi.audit(requested, signal));
  const editing = q !== (query.q ?? '') || sessionId !== (query.sessionId ?? '');
  return <HarnessAuditView page={editing ? null : resource.data} query={query} loading={resource.loading || editing}
    error={resource.error} onFilters={onFilters} onPage={onPage} onReload={resource.reload} />;
}
