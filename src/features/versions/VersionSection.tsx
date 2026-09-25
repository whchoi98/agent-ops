import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button, InlineNotice } from '../../components/ui';
import type { VersionResource } from './types';

export function VersionSection({ state, demo = false, children }: { state: VersionResource; demo?: boolean; children: ReactNode }) {
  const sample = state.report?.demo ?? demo;
  return <section className="cli-version-section" aria-label="CLI 버전 비교">
    <div className="cli-version-heading">
      <div><h3>CLI 버전 비교</h3><p>현재 버전은 로컬 CLI, 최신 버전은 표시된 공개 채널 기준입니다.</p></div>
      <Button type="button" size="small" icon={RefreshCw} busy={state.loading || state.checking}
        onClick={() => void state.check()}>최신 버전 확인</Button>
    </div>
    {sample && <p className="cli-version-demo-notice">데모 샘플 버전입니다. 실제 설치 상태나 최신 공개 버전을 나타내지 않습니다.</p>}
    {state.report?.notice && <p className="cli-version-report-notice">{state.report.notice}</p>}
    {state.error && <InlineNotice tone="warning">
      <strong>버전 확인을 완료하지 못했습니다.</strong><p>{state.error}</p>
      <p>{state.report ? '아래 숫자는 마지막 확인 값입니다.' : '확인된 현재 버전이 있으면 함께 표시합니다.'}</p>
    </InlineNotice>}
    {children}
  </section>;
}
