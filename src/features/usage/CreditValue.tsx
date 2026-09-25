import type { CreditTotals, Usage } from '../../../shared/types';
import { creditValue } from '../../../shared/credits';
import { number } from '../../lib/format';
import { useCreditI18n } from './i18n';
import './usage.css';

export type CreditValueProps = {
  usage: Pick<Usage, 'credits' | 'creditsPartial'>;
  compact?: boolean;
};

function creditNumber(value: number, compact: boolean) {
  if (!compact) return String(value);
  // Avoid rounding a positive measurement to zero or expanding huge values into a long integer.
  if ((value > 0 && value < 0.000001) || value >= 1e15) return value.toExponential(2);
  return new Intl.NumberFormat('en-US', {
    notation: value >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 1000 ? 2 : 6,
  }).format(value);
}

export function CreditValue({ usage, compact = true }: CreditValueProps) {
  const { t } = useCreditI18n();
  const value = creditValue(usage);
  const partial = value !== null && usage.creditsPartial === true;
  const label = value === null ? t('크레딧 사용량이 기록되지 않았습니다.')
    : `${t('기록된 크레딧: {0} credits', { 0: String(value) })}${partial ? `, ${t('일부 사용량만 기록되었습니다.')}` : ''}`;
  return <span className="usage-value credit-value" title={label} aria-label={label}>
    <span className={`numeric ${value === null ? 'text-muted' : ''}`}>
      {value === null ? t('미기록') : creditNumber(value, compact)}
      {partial && <span className="partial-indicator" aria-label={t('부분 기록')}>*</span>}
    </span>{' '}<span className="usage-unit">credits</span>
  </span>;
}

function count(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function CreditCoverage({ totals }: { totals: CreditTotals }) {
  const { t } = useCreditI18n();
  const known = count(totals.knownCreditSessions);
  const sessions = count(totals.kiroSessions);
  const partial = count(totals.partialCreditSessions);
  const coverage = sessions === 0 && known === 0 ? t('Kiro 세션 없음')
    : known !== null && sessions !== null ? t('{0}/{1}개 Kiro 세션 기록', { 0: number(known), 1: number(sessions) })
      : known !== null && known > 0 ? t('{0}개 Kiro 세션 기록', { 0: number(known) })
        : t('크레딧 기록 범위 미확인');
  return <span className="credit-coverage">
    <span>{coverage}</span>
    {partial !== null && partial > 0 && <span>{t('부분 기록 {0}개', { 0: number(partial) })}</span>}
  </span>;
}

export type AggregateCreditValueProps = {
  totals: CreditTotals;
  compact?: boolean;
  showCoverage?: boolean;
};

export function AggregateCreditValue({ totals, compact = true, showCoverage = true }: AggregateCreditValueProps) {
  const { t } = useCreditI18n();
  const known = count(totals.knownCreditSessions);
  const sessions = count(totals.kiroSessions);
  const recorded = known !== null && known > 0;
  const value = recorded ? creditValue({ credits: totals.recordedCredits }) : null;
  const overflow = recorded && totals.recordedCredits === null;
  const partial = recorded && ((sessions !== null && known < sessions) || (count(totals.partialCreditSessions) ?? 0) > 0);
  const label = overflow ? t('크레딧 합계가 숫자 범위를 초과했습니다.')
    : value === null ? t('크레딧 사용량이 기록되지 않았습니다.')
      : `${t('기록된 크레딧: {0} credits', { 0: String(value) })}${partial ? `, ${t('부분 합계')}` : ''}`;
  return <span className="aggregate-usage credit-total">
    <span className="usage-value" title={label} aria-label={label}>
      <span className={`numeric ${value === null ? 'text-muted' : ''}`}>
        {overflow ? t('합계 범위 초과') : value === null ? t('미기록') : creditNumber(value, compact)}
        {partial && value !== null && <span className="partial-indicator" aria-label={t('부분 합계')}>*</span>}
      </span>{' '}<span className="usage-unit">credits</span>
    </span>
    {showCoverage && <CreditCoverage totals={totals} />}
  </span>;
}
