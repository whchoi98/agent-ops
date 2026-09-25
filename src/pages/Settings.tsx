import { useFormat } from '../i18n/useFormat';
import { useI18n, Trans, AppNotice } from '../i18n/I18nProvider';
import { useState, type FormEvent } from 'react';
import {
  Check, CheckCircle2, Clock3, FolderSearch, Monitor, Moon, RefreshCw, Save, Sun, Terminal,
} from 'lucide-react';
import { AGENTS, type Agent, type Settings as SettingsContract } from '../../shared/types';
import { Button, Field, InlineNotice, PageHeading, Panel, ProviderMark } from '../components/ui';
import { VersionComparison } from '../features/versions/VersionComparison';
import { VersionSection } from '../features/versions/VersionSection';
import { useVersions } from '../features/versions/useVersions';
import { api } from '../lib/api';
import { AGENT_META, errorMessage, number } from '../lib/format';
import { useApp, useData } from '../state/AppProvider';

const rootText = (roots: SettingsContract['sourceRoots']): Record<Agent, string> => ({
  codex: roots.codex.join('\n'), claude: roots.claude.join('\n'), kiro: roots.kiro.join('\n'),
});
const normalizeRoots = (text: string) => [...new Set(text.split(/\r?\n/).map(path => path.trim()).filter(Boolean))];

export function Settings() {
  const { relativeTime, dateTime } = useFormat();
  const { t } = useI18n();
  const data = useData();
  const { refresh, notify, sync, syncing, setTheme, themeSaving } = useApp();
  const versions = useVersions();
  const [roots, setRoots] = useState(() => rootText(data.settings.sourceRoots));
  const [concurrency, setConcurrency] = useState(String(data.settings.concurrency));
  const [timeout, setTimeout] = useState(String(data.settings.timeoutMinutes));
  const [interval, setInterval] = useState(String(data.settings.scanIntervalSeconds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const payload = {
    concurrency: Number(concurrency), timeoutMinutes: Number(timeout), scanIntervalSeconds: Number(interval),
    sourceRoots: { codex: normalizeRoots(roots.codex), claude: normalizeRoots(roots.claude), kiro: normalizeRoots(roots.kiro) },
  };
  const baseline = {
    concurrency: data.settings.concurrency, timeoutMinutes: data.settings.timeoutMinutes,
    scanIntervalSeconds: data.settings.scanIntervalSeconds, sourceRoots: data.settings.sourceRoots,
  };
  const dirty = JSON.stringify(payload) !== JSON.stringify(baseline);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (Object.values(payload.sourceRoots).some(paths => paths.length > 20)) { setError('에이전트별 기록 경로는 20개까지 저장할 수 있습니다.'); return; }
    setBusy(true); setError('');
    try {
      const settings = await api.updateSettings(payload);
      setRoots(rootText(settings.sourceRoots)); setConcurrency(String(settings.concurrency));
      setTimeout(String(settings.timeoutMinutes)); setInterval(String(settings.scanIntervalSeconds));
      await refresh(true); notify('설정을 저장했습니다.');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  function reset() {
    setRoots(rootText(data.settings.sourceRoots)); setConcurrency(String(data.settings.concurrency));
    setTimeout(String(data.settings.timeoutMinutes)); setInterval(String(data.settings.scanIntervalSeconds)); setError('');
  }
  return <>
    <PageHeading title={t("설정")} description={t("에이전트의 기록 경로와 실행 환경을 관리하세요.")} eyebrow="WORKSPACE SETTINGS"
      actions={<Button icon={RefreshCw} busy={syncing} onClick={() => void sync()}><Trans message={"지금 동기화"} /></Button>} />
    <form onSubmit={save} className="settings-form">
      <section aria-labelledby="connectors-heading"><div className="section-title"><div><h2 id="connectors-heading"><Trans message={"에이전트 커넥터"} /></h2><span><Trans message={"CLI 설치 상태와 세션을 가져올 경로"} /></span></div></div>
        <VersionSection state={versions} demo={data.demo}>
        <div className="connector-grid">{AGENTS.map(agent => {
          const connector = data.connectors.find(item => item.agent === agent);
          const installed = versions.report?.items.find(item => item.agent === agent)?.installed ?? connector?.installed;
          const changed = roots[agent] !== data.settings.sourceRoots[agent].join('\n');
          return <article key={agent} className={`connector-card provider-${agent}`}>
            <div className="connector-heading"><ProviderMark agent={agent} size="large" /><div><h3>{AGENT_META[agent].name}</h3>
              <span className={`installed-badge ${installed ? 'is-installed' : ''}`}><Terminal size={11} aria-hidden />{installed ? t("CLI 설치됨") : t("미설치")}</span></div></div>
            <VersionComparison agent={agent} state={versions} connector={connector} demo={data.demo} />
            <div className="connector-count"><strong className="numeric">{number(connector?.sessionCount ?? 0)}</strong><span><Trans message={"개 세션 기록"} /></span></div>
            <div className="connector-capabilities"><span className={connector?.supportsResume ? 'available' : ''}><Check size={12} aria-hidden /><Trans message={"이어가기 {0}"} values={{ "0": connector?.supportsResume ? t("지원") : t("미지원") }} /></span>
              <span className={connector?.supportsStreaming ? 'available' : ''}><Check size={12} aria-hidden /><Trans message={"구조화된 출력 {0}"} values={{ "0": connector?.supportsStreaming ? t("지원") : t("미지원") }} /></span></div>
            <Field label={t("기록 경로")} htmlFor={`roots-${agent}`} hint={t("한 줄에 하나씩 입력하세요. 최대 20개.")}>
              <textarea id={`roots-${agent}`} aria-label={t("{0} 기록 경로", { "0": AGENT_META[agent].name })} className="roots-textarea" rows={3}
                spellCheck={false} value={roots[agent]} onChange={event => setRoots(previous => ({ ...previous, [agent]: event.target.value }))}
                placeholder={t("세션 기록 디렉터리의 전체 경로")} />
            </Field>
            <span className={`roots-status ${connector?.existingRoots.length ? 'roots-readable' : ''}`}><FolderSearch size={13} aria-hidden />
              {changed ? t("저장하면 경로를 다시 확인합니다.") : t("{0} / {1}개 경로 확인됨", { "0": connector?.existingRoots.length ?? 0, "1": connector?.roots.length ?? 0 })}</span>
            {connector && (connector.error || connector.roots.length > 0) && <details className="connector-diagnostics"><summary><Trans message={"확인 결과"} /></summary>
              {connector.error && <p><AppNotice message={connector.error} /></p>}
              {connector.roots.map(path => <div key={path}><span>{connector.existingRoots.includes(path) ? t("확인됨") : t("찾을 수 없음")}</span><code>{path}</code></div>)}
            </details>}
          </article>;
        })}</div>
        </VersionSection>
        <p className="page-footnote"><Trans message={"CLI 설치 상태와 기록 경로를 확인합니다. 로그인이 필요한 경우 실행 로그에 안내됩니다."} /></p>
      </section>
      <Panel title={t("실행 및 동기화")} description={t("새 작업과 자동 기록 수집에 적용됩니다.")} className="execution-settings">
        <div className="settings-numeric-grid">
          <Field label={t("최대 동시 실행")} htmlFor="settings-concurrency" hint={t("1~8개 · 같은 프로젝트의 작업은 직렬 실행")}>
            <div className="input-with-unit"><input id="settings-concurrency" type="number" min={1} max={8} step={1} required value={concurrency}
              onChange={event => setConcurrency(event.target.value)} /><span><Trans message={"개"} /></span></div></Field>
          <Field label={t("실행 제한 시간")} htmlFor="settings-timeout" hint={t("1~240분 · 제한 시간이 지나면 실행 종료")}>
            <div className="input-with-unit"><input id="settings-timeout" type="number" min={1} max={240} step={1} required value={timeout}
              onChange={event => setTimeout(event.target.value)} /><span><Trans message={"분"} /></span></div></Field>
          <Field label={t("자동 동기화 간격")} htmlFor="settings-interval" hint={t("15~3,600초 · 앱이 실행 중일 때 수집")}>
            <div className="input-with-unit"><input id="settings-interval" type="number" min={15} max={3600} step={1} required value={interval}
              onChange={event => setInterval(event.target.value)} /><span><Trans message={"초"} /></span></div></Field>
        </div>
      </Panel>
      {error && <InlineNotice tone="error"><AppNotice message={error} /></InlineNotice>}
      <div className={`settings-save-bar ${dirty ? 'has-changes' : ''}`}>
        <span>{dirty ? <><span className="unsaved-dot" /><Trans message={"저장하지 않은 변경사항이 있습니다."} /></> : <><CheckCircle2 size={15} aria-hidden /><Trans message={"설정이 저장되어 있습니다."} /></>}</span>
        <div><Button disabled={!dirty || busy} onClick={reset}><Trans message={"변경 취소"} /></Button><Button type="submit" variant="primary" icon={Save} busy={busy} disabled={!dirty}><Trans message={"설정 저장"} /></Button></div>
      </div>
    </form>
    <Panel title={t("화면 모드")} description={t("선택한 모드는 자동으로 저장됩니다.")} className="theme-settings">
      <div className="theme-options">{([
        { id: 'light', name: '라이트', description: '밝고 선명한 작업 공간', icon: Sun },
        { id: 'dark', name: '다크', description: '눈이 편안한 어두운 화면', icon: Moon },
        { id: 'system', name: '시스템', description: '기기의 화면 모드 따르기', icon: Monitor },
      ] as const).map(({ id, name, description, icon: Icon }) => <button key={id} type="button" aria-pressed={data.settings.theme === id}
        disabled={themeSaving} className={`theme-option ${data.settings.theme === id ? 'selected' : ''}`} onClick={() => void setTheme(id)}>
        <span className={`theme-preview theme-preview-${id}`} aria-hidden><i className="theme-preview-sidebar" /><i className="theme-preview-header" />
          <i className="theme-preview-card theme-preview-card-one" /><i className="theme-preview-card theme-preview-card-two" /><i className="theme-preview-line" /></span>
        <span className="theme-option-label"><Icon size={16} aria-hidden /><strong>{t(name)}</strong>{data.settings.theme === id && <CheckCircle2 size={17} />}</span><small>{t(description)}</small>
      </button>)}</div>
    </Panel>
    <Panel title={t("동기화 기록")} description={data.sync ? t("마지막 동기화 {0}", { "0": relativeTime(data.sync.finishedAt) }) : t("아직 동기화하지 않았습니다.")}
      actions={<Button size="small" icon={RefreshCw} busy={syncing} onClick={() => void sync()}><Trans message={"동기화"} /></Button>} className="sync-settings">
      {data.sync ? <div className="sync-report"><div className="sync-report-metrics">
        <div><span><Trans message={"확인한 파일"} /></span><strong>{number(data.sync.filesScanned)}</strong></div>
        <div><span><Trans message={"가져온 세션"} /></span><strong>{number(data.sync.imported)}</strong></div>
        <div><span><Trans message={"건너뛴 항목"} /></span><strong>{number(data.sync.skipped)}</strong></div>
        <div><span><Trans message={"확인할 항목"} /></span><strong className={data.sync.warnings.length ? 'text-warning' : ''}>{number(data.sync.warnings.length)}</strong></div>
      </div><p className="sync-report-time"><Clock3 size={13} aria-hidden />{dateTime(data.sync.startedAt)} → {dateTime(data.sync.finishedAt)}</p>
        {data.sync.warnings.length > 0 ? <details className="sync-warnings" open><summary><Trans message={"수집 중 확인할 항목 {0}개"} values={{ "0": data.sync.warnings.length }} /></summary>
          <ul>{data.sync.warnings.map((warning, index) => <li key={index}><AppNotice message={warning} /></li>)}</ul></details>
          : <div className="sync-success"><CheckCircle2 size={15} aria-hidden /><Trans message={"마지막 동기화에서 확인할 항목이 없습니다."} /></div>}
      </div> : <div className="sync-not-started"><FolderSearch size={24} aria-hidden /><p><Trans message={"기록 경로를 저장하고 동기화를 시작하세요. 수집 결과와 확인할 항목이 이곳에 표시됩니다."} /></p></div>}
    </Panel>
  </>;
}
