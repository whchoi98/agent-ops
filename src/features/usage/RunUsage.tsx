import type { Run } from '../../../shared/types';
import { creditValue } from '../../../shared/credits';
import { UsageValue } from '../../components/ui';
import { useCreditI18n } from './i18n';

/** Deliberately accepts only the run's usage, never a resumed session's total. */
export function RunUsage({ run }: { run: Pick<Run, 'agent' | 'usage'> }) {
  const { t } = useCreditI18n();
  return <div className="run-recorded-usage">
    <div><span>{t('기록된 사용량')}</span><UsageValue agent={run.agent} usage={run.usage} /></div>
    {run.agent === 'kiro' && creditValue(run.usage) === null &&
      <p>{t('크레딧은 이 실행에 기록된 값만 표시합니다. 일반 CLI 출력에는 크레딧이 없을 수 있습니다.')}</p>}
  </div>;
}
