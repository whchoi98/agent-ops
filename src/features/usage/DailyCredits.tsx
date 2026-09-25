import type { Analytics } from '../../../shared/types';
import { AggregateCreditValue } from './CreditValue';
import { useCreditI18n } from './i18n';

export function DailyCredits({ daily, days = 30 }: { daily: Analytics['daily']; days?: number }) {
  const { t } = useCreditI18n();
  const entries = [...daily].sort((a, b) => a.date.localeCompare(b.date)).slice(-days);
  return <details className="daily-credits">
    <summary>{t('일별 Kiro 크레딧')}<span>{t('세션 시작일 (UTC)')}</span></summary>
    <p>{t('해당 날짜에 시작한 세션의 크레딧 합계입니다. 여러 날에 걸친 세션도 시작일에 묶습니다.')}</p>
    {entries.length ? <div className="table-scroll daily-credits-scroll" tabIndex={0} role="region" aria-label={t('일별 Kiro 크레딧')}>
      <table className="data-table daily-credits-table">
        <thead><tr><th scope="col">{t('세션 시작일 (UTC)')}</th><th scope="col">{t('기록된 Kiro 크레딧')}</th></tr></thead>
        <tbody>{entries.map(entry => <tr key={entry.date}>
          <th scope="row"><time dateTime={entry.date}>{entry.date}</time></th>
          <td><AggregateCreditValue totals={entry} /></td>
        </tr>)}</tbody>
      </table>
    </div> : <p>{t('날짜별 크레딧 기록이 없습니다.')}</p>}
  </details>;
}
