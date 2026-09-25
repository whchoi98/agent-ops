import { useI18n, Trans, AppNotice } from '../../i18n/I18nProvider';
import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button, InlineNotice } from '../../components/ui';
import type { VersionResource } from './types';

export function VersionSection({ state, demo = false, children }: { state: VersionResource; demo?: boolean; children: ReactNode }) {
  const { t } = useI18n();
  const sample = state.report?.demo ?? demo;
  return <section className="cli-version-section" aria-label={t("CLI 버전 비교")}>
    <div className="cli-version-heading">
      <div><h3><Trans message={"CLI 버전 비교"} /></h3><p><Trans message={"현재 버전은 로컬 CLI, 최신 버전은 표시된 공개 채널 기준입니다."} /></p></div>
      <Button type="button" size="small" icon={RefreshCw} busy={state.loading || state.checking}
        onClick={() => void state.check()}><Trans message={"최신 버전 확인"} /></Button>
    </div>
    {sample && <p className="cli-version-demo-notice"><Trans message={"데모 샘플 버전입니다. 실제 설치 상태나 최신 공개 버전을 나타내지 않습니다."} /></p>}
    {state.report?.notice && <p className="cli-version-report-notice"><AppNotice message={state.report.notice} /></p>}
    {state.error && <InlineNotice tone="warning">
      <strong><Trans message={"버전 확인을 완료하지 못했습니다."} /></strong><p><AppNotice message={state.error} /></p>
      <p>{state.report ? t("아래 숫자는 마지막 확인 값입니다.") : t("확인된 현재 버전이 있으면 함께 표시합니다.")}</p>
    </InlineNotice>}
    {children}
  </section>;
}
