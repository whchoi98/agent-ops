import type { CreditTotals } from '../../../shared/types';
import { AggregateCreditValue } from './CreditValue';
import { useCreditI18n } from './i18n';

export function CreditSummary({ totals }: { totals: CreditTotals }) {
  const { t } = useCreditI18n();
  return <section className="panel credit-summary" aria-label={t('기록된 Kiro 크레딧')}>
    <div className="credit-summary-heading">
      <h2>{t('기록된 Kiro 크레딧')}</h2>
      <p>{t('Kiro 기록에서 확인된 크레딧만 합산합니다. 토큰과 USD 비용은 별도로 표시합니다.')}</p>
    </div>
    <AggregateCreditValue totals={totals} />
  </section>;
}
