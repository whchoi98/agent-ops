import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import type { HarnessAction, HarnessAuditSource, HarnessStorage } from '../../../shared/harness';
import { Button, InlineNotice } from '../../components/ui';
import { useFormat } from '../../i18n/useFormat';
import { useHarnessI18n } from './i18n';
import { ACTION_LABELS, UNKNOWN_OUTCOME_NOTICE, type HarnessProblem } from './model';

export function HarnessBadge({ children, tone = 'neutral' }: {
  children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
}) {
  return <span className={`status-badge harness-badge-${tone}`}><span className="status-dot" aria-hidden />{children}</span>;
}
export function HarnessActionBadge({ action }: { action: HarnessAction }) {
  const { t } = useHarnessI18n();
  return <HarnessBadge tone={action === 'allow' ? 'success' : action === 'ask' ? 'warning' : 'danger'}>
    {t(ACTION_LABELS[action])}
  </HarnessBadge>;
}
export function HarnessNotices({ messages, label }: { messages: string[]; label?: string }) {
  const { notice } = useHarnessI18n();
  return messages.length ? <ul className="harness-notices" aria-label={label}>
    {messages.map((message, index) => <li key={index}>{notice(message)}</li>)}
  </ul> : null;
}
export function HarnessError({ problem, onRetry, retryLabel, busy = false }: {
  problem: HarnessProblem | null; onRetry?: () => void; retryLabel?: string; busy?: boolean;
}) {
  const { t, notice } = useHarnessI18n();
  return problem ? <InlineNotice tone="error">
    <p>{notice(problem.message)}</p>
    {problem.unknown && problem.message !== UNKNOWN_OUTCOME_NOTICE && <p>{t(UNKNOWN_OUTCOME_NOTICE)}</p>}
    {onRetry && <Button size="small" disabled={busy} icon={RefreshCw} onClick={onRetry}>{retryLabel ?? t('다시 시도')}</Button>}
  </InlineNotice> : null;
}
export function HarnessStorageView({ storage, sources }: { storage: HarnessStorage; sources: HarnessAuditSource[] }) {
  const { t } = useHarnessI18n();
  const { number } = useFormat();
  return <details className="harness-details">
    <summary>{t('캐시 및 읽기 진단')}</summary>
    <div className="harness-stack">
      <dl className="harness-properties">
        <div><dt>{t('보관한 기록')}</dt><dd>{number(storage.cachedRecords)}</dd></div>
        <div><dt>{t('캐시 한도')}</dt><dd>{number(storage.cacheLimit)}</dd></div>
        <div><dt>{t('보관 기간')}</dt><dd>{t('{days}일', { days: number(storage.retentionDays) })}</dd></div>
        <div><dt>{t('원본 파일 크기')}</dt><dd>{number(storage.sourceBytes)} B</dd></div>
        <div><dt>{t('읽은 바이트')}</dt><dd>{number(storage.bytesRead)} B</dd></div>
        <div><dt>{t('잘못된 줄')}</dt><dd>{number(storage.invalidLines)}</dd></div>
      </dl>
      {storage.truncated ? <InlineNotice tone="warning">{t('읽기 또는 보관 범위가 잘렸습니다. 표시된 기록은 전체 원본의 일부입니다.')}</InlineNotice>
        : <p className="harness-hint">{t('잘림 보고 없음')}</p>}
      <p className="harness-hint">{t('기본값은 최근 2,000개, 30일입니다. 외부 원본 로그는 삭제하지 않습니다.')}</p>
      {!!sources.length && <section aria-label={t('감사 출처')}>
        <h3>{t('감사 출처')}</h3>
        <ul className="harness-source-list">{sources.map(source => <li key={source.id}>
          <code translate="no">{source.path}</code>
          <span className="tag">{t(source.managed ? '앱 관리' : '외부 설정')}</span>
        </li>)}</ul>
      </section>}
    </div>
  </details>;
}
