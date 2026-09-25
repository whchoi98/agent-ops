import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type {
  DesktopApp, DesktopAppInstallation, DesktopAppIssue, DesktopAppIssueCode, DesktopAppReport,
} from '../../../shared/desktop-apps';
import { Button, InlineNotice, ProviderMark } from '../../components/ui';
import { useResource } from '../../hooks/useResource';
import { AppNotice, useI18n } from '../../i18n/I18nProvider';
import { useFormat } from '../../i18n/useFormat';
import { errorMessage } from '../../lib/format';
import { desktopApi } from './desktopApi';

export interface DesktopAppsViewProps {
  report: DesktopAppReport | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  demo?: boolean;
}

const statusLabels = {
  installed: '앱 설치됨', 'not-installed': '후보 경로에서 찾지 못함',
  unverified: '설치 여부 미확인', 'unsupported-host': '지원하지 않는 호스트',
};
const scopeLabels = { app: '데스크톱 앱', 'app-container': '앱/컨테이너', ide: 'IDE' };
const versionLabels = { app: '앱 버전', 'app-container': '앱/컨테이너 버전', ide: 'IDE 버전' };
const fieldLabels = { version: '앱 버전', build: '빌드', bundleIdentifier: '번들 식별자' };
const issueLabels: Record<DesktopAppIssueCode, string> = {
  'unsafe-path': '허용 범위를 벗어나는 링크 또는 일반 파일·폴더가 아닌 경로를 제외했습니다.',
  'path-unavailable': '후보 경로에 접근하지 못했습니다.',
  'plist-missing': 'Info.plist를 찾지 못했습니다.',
  'plist-unreadable': 'Info.plist를 읽지 못했습니다.',
  'plist-too-large': 'Info.plist가 파일 크기 한도를 초과했습니다.',
  'plist-invalid': 'Info.plist 형식을 해석하지 못했습니다.',
  'metadata-limit': '변환한 메타데이터가 크기 또는 구조 한도를 초과했습니다.',
  'field-missing': 'Info.plist 필드가 없습니다: {0}',
  'field-invalid': 'Info.plist 필드 형식을 확인하지 못했습니다: {0}',
  'conversion-failed': '시스템 plist 변환기를 실행하지 못했거나 변환에 실패했습니다.',
  'conversion-timeout': 'plist 변환 제한 시간이 초과되었습니다.',
  'changed-during-read': '검사 중 파일 또는 경로가 바뀌어 메타데이터를 표시하지 않습니다.',
};

function Issue({ issue }: { issue: DesktopAppIssue }) {
  const { t } = useI18n();
  return <p className="cli-version-error">{t(issueLabels[issue.code], { 0: issue.field ? t(fieldLabels[issue.field]) : '' })}</p>;
}

function InstallationValues({ item, installation }: { item: DesktopApp; installation?: DesktopAppInstallation }) {
  const { t } = useI18n();
  const value = (text: string | null | undefined) => text
    ? <code dir="ltr">{text}</code> : <span className="text-muted">{t('미확인')}</span>;
  return <>
    <dl className="cli-version-values">
      <div><dt>{t(versionLabels[item.versionScope])}</dt><dd>{value(installation?.version)}</dd></div>
      <div><dt>{t('빌드')}</dt><dd>{value(installation?.build)}</dd></div>
      <div><dt>{t('번들 식별자')}</dt><dd>{value(installation?.bundleIdentifier)}</dd></div>
      <div><dt>{t('설치 위치')}</dt><dd>{value(installation?.path)}</dd></div>
    </dl>
    {installation && <p className="cli-version-note">{t(installation.location === 'system' ? '시스템 Applications' : '사용자 Applications')}</p>}
  </>;
}

function AppCard({ item }: { item: DesktopApp }) {
  const { t } = useI18n();
  const installation = item.installations[0];
  return <article className={`connector-card provider-${item.agent}`}>
    <div className="connector-heading"><ProviderMark agent={item.agent} size="large" />
      <div><h3>{item.name}</h3><span className="installed-badge">{t(scopeLabels[item.versionScope])}</span></div>
    </div>
    <InstallationValues item={item} installation={installation} />
    <div className="cli-version-status-row">
      <span className={`status-badge ${item.installed === true ? 'cli-version-current' : 'cli-version-unknown'}`}>
        <span className="status-dot" aria-hidden />{t(statusLabels[item.status])}
      </span>
    </div>
    {installation && installation.metadataStatus !== 'complete'
      && <p className="cli-version-error">{t('앱 메타데이터 일부를 확인하지 못했습니다.')}</p>}
    {item.id === 'claude-desktop' && <p className="cli-version-note">
      {t('Claude Code Desktop은 Claude 앱의 Code 탭입니다. 이 값은 앱/컨테이너 버전이며 내부 Code 엔진·CLI 버전과 별개입니다.')}
    </p>}
    {(installation || item.candidates.length > 0) && <details className="connector-diagnostics">
      <summary>{t('메타데이터 출처와 후보 경로')}</summary>
      {installation && <>
        <div><span>Info.plist</span><code className="cli-version-meta" dir="ltr">{installation.source.path}</code></div>
        {Object.entries(installation.source.keys).map(([field, key]) => <div key={field}>
          <span>{t(fieldLabels[field as keyof typeof fieldLabels])}</span><code>{key}</code>
        </div>)}
        {installation.issues.map((issue, index) => <Issue key={index} issue={issue} />)}
      </>}
      {item.candidates.map(candidate => <div key={candidate.path}>
        <span>{t(candidate.status === 'found' ? '번들 확인' : candidate.status === 'not-found' ? '후보 없음' : '경로 미확인')}</span>
        <code className="cli-version-meta" dir="ltr">{candidate.path}</code>
        {candidate.issues.map((issue, index) => <Issue key={index} issue={issue} />)}
      </div>)}
    </details>}
    {item.installations.length > 1 && <details className="connector-diagnostics">
      <summary>{item.installations.length === 2 ? t('다른 설치 위치 1개') : t('다른 설치 위치 {0}개', { 0: item.installations.length - 1 })}</summary>
      <p>{t('시스템 Applications를 우선 표시합니다. 메타데이터가 부족해도 다른 설치본으로 대체하지 않습니다.')}</p>
      {item.installations.slice(1).map(other => <div key={other.path}>
        <InstallationValues item={item} installation={other} />
        {other.issues.map((issue, index) => <Issue key={index} issue={issue} />)}
      </div>)}
    </details>}
  </article>;
}

/** Separate presentation keeps the inventory usable without changing the existing CLI version resource. */
export function DesktopAppsView({ report, loading, refreshing, error, refresh, demo = false }: DesktopAppsViewProps) {
  const { t } = useI18n();
  const { dateTime, number } = useFormat();
  const sample = demo || report?.demo || report?.status === 'demo';
  const busy = loading || refreshing;
  return <section className="cli-version-section" aria-label={t('macOS 데스크톱 앱')} aria-busy={busy}>
    <div className="cli-version-heading">
      <div><h3>{t('macOS 데스크톱 앱')}</h3><p>{t('앱을 실행하지 않고 설치 메타데이터를 확인합니다.')}</p></div>
      <Button type="button" size="small" icon={RefreshCw} busy={busy} disabled={sample}
        onClick={() => void refresh()}>{t('설치 정보 새로고침')}</Button>
    </div>
    <p className="cli-version-report-notice">{t('my-agent-ops 서버가 실행 중인 기기의 설치 정보입니다.')}</p>
    {sample ? <p className="cli-version-demo-notice">{t('데모에서는 데스크톱 앱 설치 정보를 조회하지 않습니다.')}</p> : <>
      {report?.status === 'unsupported-host' && <InlineNotice>
        {t('이 서버 호스트({0})는 macOS 앱 검사를 지원하지 않습니다. 브라우저 연결만으로 사용자의 Mac을 검사하지 않습니다.', { 0: report.platform })}
      </InlineNotice>}
      {error && <InlineNotice tone="warning">
        <strong>{t('데스크톱 앱 정보를 불러오지 못했습니다.')}</strong><p><AppNotice message={error} /></p>
        {report && <p>{t('아래 값은 이전에 확인한 설치 정보입니다.')}</p>}
      </InlineNotice>}
      {loading && !report && <p className="cli-version-report-notice" role="status">{t('데스크톱 앱 확인 중…')}</p>}
      {report && <div className="connector-grid" aria-live="polite">{report.items.map(item => <AppCard key={item.id} item={item} />)}</div>}
      {report && <div className="cli-version-meta">
        <span>{t('확인 시각 {0}', { 0: dateTime(report.checkedAt) })}</span>
        <span>{t('최대 {0}분 동안 결과를 재사용합니다. 새로고침하면 설치 정보를 다시 확인합니다.', { 0: number(report.cacheTtlMs / 60000) })}</span>
      </div>}
    </>}
    <p className="page-footnote">{t('데스크톱 앱과 npm CLI는 버전·배포 채널이 서로 다릅니다. 앱의 최신 버전은 비교하지 않습니다.')}
      <br />{t('인증 상태, 클라우드 대화, 전체 비공개 이력, 내부 Code 엔진 버전은 미확인입니다.')}</p>
  </section>;
}

function LoadedDesktopApps() {
  const resource = useResource<DesktopAppReport>(signal => desktopApi.report(signal), 'desktop-apps', true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const attempt = useRef<AbortController | null>(null);
  useEffect(() => () => attempt.current?.abort(), []);
  const refresh = useCallback(async () => {
    if (resource.loading || attempt.current) return;
    const controller = new AbortController();
    attempt.current = controller;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const report = await desktopApi.refresh(controller.signal);
      if (!controller.signal.aborted) resource.replaceData(report);
    } catch (cause) {
      if (!controller.signal.aborted) setRefreshError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) { setRefreshing(false); attempt.current = null; }
    }
  }, [resource.loading, resource.replaceData]);
  return <DesktopAppsView report={resource.data} loading={resource.loading} refreshing={refreshing}
    error={refreshing ? null : refreshError ?? resource.error} refresh={refresh} />;
}

/** Insert below Settings' existing CLI comparison. Demo mode makes no inventory request. */
export function DesktopApps({ demo = false }: { demo?: boolean }) {
  if (demo) return <DesktopAppsView demo report={null} loading={false} refreshing={false} error={null} refresh={async () => {}} />;
  return <LoadedDesktopApps />;
}
