import type { Agent, ConnectorStatus } from '../../../shared/types';
import { AGENT_META, dateTime } from '../../lib/format';
import { comparisonStatus, VERSION_LABELS, versionSource } from './model';
import type { VersionSnapshot } from './types';

export interface VersionComparisonProps {
  agent: Agent;
  state: VersionSnapshot;
  connector?: Pick<ConnectorStatus, 'installed' | 'version'>;
  demo?: boolean;
}

export function VersionComparison({ agent, state, connector, demo = false }: VersionComparisonProps) {
  const version = state.report?.items.find(item => item.agent === agent);
  const unconfirmed = version?.installed === null;
  const installed = unconfirmed ? undefined : version?.installed ?? connector?.installed;
  const previousCurrent = unconfirmed && connector?.installed ? connector.version?.trim() : undefined;
  const current = version ? version.currentVersion?.trim() || previousCurrent : connector?.version?.trim();
  const latest = version?.latestVersion?.trim();
  const pending = state.loading || state.checking;
  const status = comparisonStatus(version, installed, Boolean(state.error));
  const source = versionSource(version?.sourceUrl);
  const release = versionSource(version?.releaseUrl);
  const sample = state.report?.demo ?? demo;
  const previousLatest = Boolean(latest && (state.error || state.checking));

  return <div className="cli-version-comparison" role="group" aria-label={`${AGENT_META[agent].name} CLI 버전`} aria-busy={pending}>
    <dl className="cli-version-values">
      <div><dt>현재 버전</dt><dd>{installed === false ? <span className="text-muted">미설치</span>
        : current ? <code>{current}</code> : <span className="text-muted">확인 불가</span>}
        {previousCurrent && <small>이전 확인 값</small>}
      </dd></div>
      <div><dt>최신 버전</dt><dd>{latest ? <code>{latest}</code>
        : <span className="text-muted">{pending ? '확인 중…' : '확인 불가'}</span>}
        {previousLatest && <small>이전 확인 값</small>}
      </dd></div>
    </dl>
    <div className="cli-version-status-row" aria-live="polite">
      <span className={`status-badge cli-version-${pending ? 'checking' : status}`}>
        <span className="status-dot" aria-hidden />{pending ? '확인 중…' : VERSION_LABELS[status]}
      </span>
      {sample && <span className="cli-version-sample">데모 샘플</span>}
    </div>
    {!pending && status === 'ahead' && <p className="cli-version-note">
      다른 배포 채널의 버전일 수 있습니다.
    </p>}
    {!pending && status === 'unknown' && <p className="cli-version-note">확인된 값만 표시합니다.</p>}
    {version?.error && !pending && <p className="cli-version-error">{version.error}</p>}
    {!current && version?.currentRaw && <details className="cli-version-raw">
      <summary>현재 버전 응답</summary><code>{version.currentRaw}</code>
    </details>}
    <div className="cli-version-meta">
      <span>채널 <strong>{version?.channel || '미확인'}</strong></span>
      <span>확인 시각 {version?.checkedAt
        ? <time dateTime={version.checkedAt}>{dateTime(version.checkedAt)}</time> : '미확인'}</span>
    </div>
    <div className="cli-version-sources">
      <span>출처</span>{source
        ? <a href={source.href} title={source.href} target="_blank" rel="noreferrer noopener"
          aria-label={`${AGENT_META[agent].name} 버전 조회 출처`}>{source.hostname}</a>
        : <span>미제공</span>}
      {release && <a href={release.href} target="_blank" rel="noreferrer noopener"
        aria-label={`${AGENT_META[agent].name} 릴리스 정보`}>릴리스 정보</a>}
    </div>
  </div>;
}
