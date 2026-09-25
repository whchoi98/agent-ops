import { RefreshCw } from 'lucide-react';
import {
  APP_UPDATE_SOURCE_URL, type AppUpdateErrorCode, type AppUpdateReport, type AppUpdateStatus,
} from '../../../shared/app-update';
import { Button, CopyButton, InlineNotice, Panel } from '../../components/ui';
import { useNow } from '../../hooks/useResource';
import { useFormat } from '../../i18n/useFormat';
import { useAppUpdateI18n } from './i18n';
import { useAppUpdate } from './useAppUpdate';
import './app-update.css';

export interface AppUpdateProps { demo?: boolean }

export interface AppUpdateViewProps {
  report: AppUpdateReport | null;
  loading: boolean;
  checking: boolean;
  error: string | null;
  check: () => Promise<void>;
  reload: () => void;
  demo?: boolean;
  now?: number;
}

const statuses: Record<AppUpdateStatus, { label: string; style: string }> = {
  'not-checked': { label: '아직 확인하지 않음', style: 'unknown' },
  current: { label: '최신 릴리스와 같음', style: 'current' },
  'update-available': { label: '앱 업데이트 가능', style: 'update-available' },
  ahead: { label: '공개 릴리스보다 앞선 버전', style: 'ahead' },
  unavailable: { label: '릴리스 확인 불가', style: 'check-failed' },
  demo: { label: '데모 모드', style: 'unknown' },
};

const errorLabels: Record<AppUpdateErrorCode, string> = {
  'invalid-current-version': '실행 중인 앱 버전이 올바른 SemVer 형식이 아닙니다.',
  'invalid-release': '릴리스 메타데이터가 올바르지 않거나 안정 릴리스가 아닙니다.',
  'request-failed': 'GitHub 릴리스를 가져오지 못했습니다. 잠시 후 다시 확인하세요.',
  'redirect-rejected': 'GitHub 릴리스 요청의 리다이렉트를 허용하지 않습니다.',
  'response-too-large': '릴리스 응답이 256 KiB 크기 제한을 초과했습니다.',
  timeout: 'GitHub 릴리스 확인이 8초 제한 시간을 초과했습니다.',
  closed: '앱 업데이트 확인 서비스가 종료되었습니다.',
};

function Command({ title, label, command }: { title: string; label: string; command: string }) {
  return <div className="code-block">
    <div className="code-heading"><span>{title}</span><CopyButton text={command} label={label} compact /></div>
    <pre tabIndex={0}><code>{command}</code></pre>
  </div>;
}

export function AppUpdateView({
  report, loading, checking, error, check, reload, demo = false, now: suppliedNow,
}: AppUpdateViewProps) {
  const { t, notice } = useAppUpdateI18n();
  const { dateTime } = useFormat();
  const sample = demo || report?.demo || report?.status === 'demo';
  const nextCheck = !sample && report?.nextCheckAt ? Date.parse(report.nextCheckAt) : 0;
  const localNow = useNow(suppliedNow === undefined && nextCheck > Date.now());
  const now = suppliedNow ?? localNow;
  const remaining = Math.max(0, Math.ceil((nextCheck - now) / 1000));
  const busy = loading || !sample && (checking || Boolean(report?.checking) && !error);
  const status: AppUpdateStatus = sample ? 'demo' : error ? 'unavailable' : report?.status ?? 'not-checked';
  const latest = sample ? null : report?.latest;
  const failure = !sample && !busy && report?.error ? t(errorLabels[report.error]) : null;
  const canCopy = !sample && !busy && !error && !failure && status === 'update-available' && Boolean(latest);
  const npm = canCopy && latest?.archive ? report?.commands.npm : null;
  const git = canCopy ? report?.commands.git : null;
  return <Panel title={t('my-agent-ops 업데이트')} description={t('현재 실행 중인 작업대 앱의 버전을 확인합니다.')}
    className="app-update" actions={
      <Button type="button" size="small" icon={RefreshCw} busy={busy}
        disabled={sample || remaining > 0 || report?.checking || report?.error === 'invalid-current-version' || report?.error === 'closed'}
        onClick={() => void check()}>{t('앱 최신 릴리스 확인')}</Button>
    }>
    <div className="app-update-body cli-version-section" role="region" aria-label={t('my-agent-ops 업데이트')} aria-busy={busy}>
      <p className="cli-version-report-notice">{t('이 버전은 my-agent-ops 앱 자체의 버전이며 코딩 CLI와 데스크톱 앱 버전과 별개입니다.')}</p>
      <dl className="cli-version-values">
        <div><dt>{t('실행 중인 앱 버전')}</dt><dd><code>{report?.currentVersion || t('미확인')}</code></dd></div>
        <div><dt>{t('최신 공개 릴리스')}</dt><dd><code>{latest?.version || t('미확인')}</code></dd></div>
      </dl>
      <div className="cli-version-status-row" aria-live="polite">
        <span className={`status-badge cli-version-${busy ? 'checking' : statuses[status].style}`}>
          {loading ? t('앱 업데이트 정보를 불러오는 중...') : busy ? t('앱 릴리스를 확인하는 중...') : t(statuses[status].label)}
        </span>
      </div>
      {sample && <p className="cli-version-demo-notice">{t('데모에서는 GitHub를 조회하거나 설치 명령을 제공하지 않습니다.')}</p>}
      {!sample && error && !busy && <InlineNotice tone="error">
        <strong>{t('앱 업데이트 정보를 불러오지 못했습니다.')}</strong>
        <p>{notice(error)}</p>
        {latest && <p>{t('아래 값은 이전에 확인한 릴리스 정보입니다.')}</p>}
        <Button type="button" size="small" onClick={reload}>{t('캐시 상태 다시 불러오기')}</Button>
      </InlineNotice>}
      {failure && <InlineNotice tone="error">{failure}</InlineNotice>}
      <div className="cli-version-meta">
        <span>{t('마지막 확인 시각')}: {!sample && report?.checkedAt
          ? <time dateTime={report.checkedAt} title={report.checkedAt}>{dateTime(report.checkedAt)}</time> : t('확인 전')}</span>
        {latest && <span>{t('릴리스 게시 시각')}: <time dateTime={latest.publishedAt} title={latest.publishedAt}>{dateTime(latest.publishedAt)}</time></span>}
        {!sample && report?.nextCheckAt && <span>{t('다음 확인 가능 시각')}: <time dateTime={report.nextCheckAt} title={report.nextCheckAt}>{dateTime(report.nextCheckAt)}</time></span>}
      </div>
      <div className="cli-version-sources">
        <span>{t('릴리스 출처')}:</span>
        <a href={APP_UPDATE_SOURCE_URL} target="_blank" rel="noreferrer noopener">GitHub Releases: whchoi98/agent-ops</a>
        {latest && <a href={latest.releaseUrl} target="_blank" rel="noreferrer noopener">{t('릴리스 보기')} ({latest.tag})</a>}
      </div>
      {!sample && <p className="cli-version-note">{t('최신 릴리스는 버튼을 눌러 확인할 때만 조회합니다.')}</p>}
      {!sample && remaining > 0 && <p className="cli-version-note">{t('{0}초 후 다시 확인할 수 있습니다.', { 0: remaining })}</p>}
      {latest && !latest.archive && !busy && <p className="cli-version-note">{t('검증된 npm 설치 파일이 없어 npm 명령을 제공하지 않습니다.')}</p>}
      {(npm || git) && <div className="app-update-instructions">
        <h3>{t('앱 업데이트 방법')}</h3>
        <p>{t('실행 중인 작업과 수집이 끝나면 앱을 실행한 서버 터미널에서 Ctrl+C로 앱을 중지하세요.')}</p>
        <p>{t('설치 방식에 맞는 명령을 같은 서버 터미널에서 실행하세요. 이 화면은 명령을 복사할 뿐 설치나 재시작을 실행하지 않습니다.')}</p>
        {npm && <Command title={t('npm으로 설치한 경우')} label={t('npm 업데이트 명령 복사')} command={npm} />}
        {git && <>
          <p>{t('Git으로 설치했다면 my-agent-ops 소스 저장소에서 로컬 변경 사항을 저장한 뒤 실행하세요.')}</p>
          <Command title={t('Git으로 설치한 경우')} label={t('Git 업데이트 명령 복사')} command={git} />
        </>}
        <p>{t('설치 후 기존 데이터 디렉터리, 환경 변수, --data-dir, --port, --public-url 옵션을 유지한 시작 명령으로 앱을 다시 실행하세요.')}</p>
        <p>{t('앱이 다시 시작되면 브라우저를 새로고침하세요.')}</p>
      </div>}
    </div>
  </Panel>;
}

function LoadedAppUpdate({ demo }: { demo: boolean }) {
  const state = useAppUpdate(demo);
  return <AppUpdateView {...state} demo={demo} />;
}

/** The initial read includes the running app version, even in demo mode. It only reads server cache. */
export function AppUpdate({ demo = false }: AppUpdateProps) {
  return <LoadedAppUpdate key={demo ? 'demo' : 'live'} demo={demo} />;
}
