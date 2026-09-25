import { useFormat } from '../i18n/useFormat';
import { useI18n, Trans } from '../i18n/I18nProvider';
import {
  ArrowRight, ArrowUpRight, CalendarDays, CircleDollarSign, CirclePlay, Clock3, Layers3,
  MessageSquare, Plus, RefreshCw, Terminal, Workflow,
} from 'lucide-react';
import { AGENTS, type Agent } from '../../shared/types';
import { ActivityChart } from '../components/ActivityChart';
import { SessionTable } from '../components/SessionTable';
import { StatCard } from '../components/Stats';
import { Button, EmptyState, PageHeading, Panel, ProviderMark, StatusBadge } from '../components/ui';
import { AGENT_META, compactNumber, isActiveRun, number } from '../lib/format';
import { useApp, useData } from '../state/AppProvider';

function AgentLane({ agent }: { agent: Agent }) {
  const { relativeTime } = useFormat();
  const { t } = useI18n();
  const data = useData();
  const { navigate, openNewRun, openSession, openRun } = useApp();
  const connector = data.connectors.find(item => item.agent === agent);
  const count = data.analytics.agents.find(item => item.agent === agent)?.sessions ?? 0;
  const latest = data.sessions.find(session => session.agent === agent);
  const active = data.runs.filter(run => run.agent === agent && isActiveRun(run.status));
  const running = active.filter(run => run.status === 'running');
  const days = data.analytics.daily.slice(-14);
  const max = Math.max(1, ...days.map(day => day[agent]));
  return <article className={`agent-lane provider-${agent}`}>
    <div className="lane-header"><ProviderMark agent={agent} size="large" /><div><h3>{AGENT_META[agent].name}</h3>
      <span className="lane-install-status"><Terminal size={11} aria-hidden />{connector?.installed ? t("CLI 설치됨") : t("CLI 미설치")}</span></div>
      <button className="lane-launch" title={t("{0} 새 실행", { "0": AGENT_META[agent].name })} aria-label={t("{0} 새 실행", { "0": AGENT_META[agent].name })}
        onClick={() => openNewRun({ agent })}><Plus size={17} aria-hidden /></button>
    </div>
    <div className="lane-activity">
      <button onClick={() => navigate('sessions', { agent })} className="lane-session-count"><strong className="numeric">{number(count)}</strong><span><Trans message={"기록된 세션"} /><ArrowUpRight size={12} aria-hidden /></span></button>
      <div className="lane-mini-chart">
        <svg viewBox="0 0 144 43" role="img" aria-label={t("{0} 최근 14일 세션 활동", { "0": AGENT_META[agent].name })}>
          <line x1="0" y1="42" x2="144" y2="42" stroke="var(--border)" />
          {days.map((day, index) => <rect key={day.date} x={index * (144 / Math.max(days.length, 1)) + 2}
            y={41 - day[agent] / max * 34} width={Math.max(3, 144 / Math.max(days.length, 1) - 5)}
            height={day[agent] / max * 34} rx={2} fill="currentColor"><title><Trans message={"{0} · {1}개"} values={{ "0": day.date, "1": day[agent] }} /></title></rect>)}
        </svg><span><Trans message={"최근 14일"} /></span>
      </div>
    </div>
    <div className="lane-latest"><span className="lane-caption"><Trans message={"최근 세션"} /></span>
      {latest ? <button onClick={() => openSession(latest.id)}><span>{latest.title}</span><ArrowUpRight size={13} aria-hidden /></button>
        : <button onClick={() => navigate('settings')}><span><Trans message={"기록 경로를 설정하세요"} /></span><ArrowUpRight size={13} aria-hidden /></button>}
      <span className="lane-timestamp">{latest ? relativeTime(latest.updatedAt) : t("아직 가져온 대화가 없습니다")}</span>
    </div>
    <div className={`lane-footer ${running.length ? 'lane-running' : ''}`}>
      {active.length ? <button onClick={() => openRun((running[0] ?? active[0]).id)}>
        <span className={running.length ? 'live-dot' : 'waiting-dot'} /><span>{running.length ? t("{0}개 실행 중", { "0": running.length }) : t("{0}개 대기 중", { "0": active.length })}</span>
        <ArrowRight size={13} aria-hidden />
      </button> : <span><span className="idle-dot" /><Trans message={"실행 중인 작업 없음"} /></span>}
      <button className="lane-history" onClick={() => navigate('sessions', { agent })}><Trans message={"기록 보기"} /><ArrowRight size={12} aria-hidden /></button>
    </div>
  </article>;
}

export function Overview() {
  const { dateTime, money, relativeTime } = useFormat();
  const { t } = useI18n();
  const data = useData();
  const { navigate, openRun, openNewRun, sync, syncing } = useApp();
  const { analytics } = data;
  const running = data.runs.filter(run => run.status === 'running');
  const queued = data.runs.filter(run => run.status === 'queued');
  const active = [...running, ...queued];
  return <>
    <PageHeading title={t("워크스페이스 개요")} description={t("흩어진 대화부터 지금 실행 중인 작업까지, 한눈에 확인하세요.")}
      eyebrow="WORKSPACE OVERVIEW"
      actions={<span className="date-chip"><CalendarDays size={15} aria-hidden />{dateTime(new Date().toISOString(), { month: 'long', day: 'numeric', weekday: 'short' })}</span>} />
    <div className="stats-grid">
      <StatCard label={t("전체 세션")} value={number(analytics.totalSessions)} detail={<><span className="stat-detail-dot" /><Trans message={"모든 에이전트 · 전체 기간"} /></>}
        icon={MessageSquare} onClick={() => navigate('sessions')} />
      <StatCard label={t("기록된 토큰")} value={analytics.knownTokenSessions ? compactNumber(analytics.totalTokens) : <span className="stat-unknown"><Trans message={"미기록"} /></span>}
        detail={t("{0} / {1}개 세션에 사용량 기록", { "0": number(analytics.knownTokenSessions), "1": number(analytics.totalSessions) })}
        icon={Layers3} accent="teal" onClick={() => navigate('analytics')} />
      <StatCard label={t("기록된 비용")} value={analytics.knownCostSessions ? money(analytics.recordedCostUsd) : <span className="stat-unknown"><Trans message={"미기록"} /></span>}
        detail={analytics.knownCostSessions ? t("{0}개 세션의 기록 · USD", { "0": number(analytics.knownCostSessions) }) : t("비용을 기록한 세션이 없습니다")}
        icon={CircleDollarSign} accent="violet" onClick={() => navigate('analytics')} />
      <StatCard label={t("실행 중인 작업")} value={<>{running.length}<span className="stat-unit"><Trans message={"개"} /></span></>}
        detail={<><span className={running.length ? 'live-dot' : 'idle-dot'} /><Trans message={"대기 {0}개 · 동시 실행 한도 {1}"} values={{ "0": queued.length, "1": data.settings.concurrency }} /></>}
        icon={Workflow} accent="amber" onClick={() => navigate('runs')} />
    </div>
    <section className="agent-workbench" aria-labelledby="agent-activity-title">
      <div className="section-title"><div><h2 id="agent-activity-title"><Trans message={"에이전트 활동"} /></h2><span><Trans message={"세 개의 에이전트, 하나의 작업 공간"} /></span></div>
        <button className="text-button" onClick={() => navigate('settings')}><Trans message={"커넥터 설정"} /><ArrowRight size={14} aria-hidden /></button>
      </div>
      <div className="agent-lanes">{AGENTS.map(agent => <AgentLane key={agent} agent={agent} />)}</div>
    </section>
    <div className="overview-middle-grid">
      <Panel title={t("날짜별 활동")} description={t("최근 30일 · 기록된 세션 수")} actions={<button className="text-button" onClick={() => navigate('analytics')}><Trans message={"분석 보기"} /><ArrowUpRight size={14} aria-hidden /></button>} className="daily-panel">
        <ActivityChart daily={analytics.daily} days={30} />
      </Panel>
      <Panel title={t("실행 중인 작업")} description={t("Agent Ops에서 시작한 작업")} actions={<span className="count-badge">{active.length}</span>} className="active-runs-panel">
        {active.length > 0 ? <div className="active-run-list">{active.slice(0, 4).map(run => <button key={run.id} className="active-run-row" onClick={() => openRun(run.id)}>
          <ProviderMark agent={run.agent} /><div><strong>{run.title}</strong><span>{run.projectName}</span></div>
          <StatusBadge status={run.status} />
        </button>)}</div> : <EmptyState compact icon={CirclePlay} title={t("다음 작업을 시작해 보세요")}
          description={t("시작한 작업의 상태와 로그가 이곳에 표시됩니다.")}
          action={<Button size="small" icon={Plus} onClick={() => openNewRun()}><Trans message={"새 실행"} /></Button>} />}
        <button className="panel-footer-link" onClick={() => navigate('runs')}><Trans message={"실행 보드 열기"} /><ArrowRight size={14} aria-hidden /></button>
      </Panel>
    </div>
    <Panel title={t("최근 세션")} description={t("최근에 기록된 대화에서 작업을 이어가세요.")}
      actions={<button className="text-button" onClick={() => navigate('sessions')}><Trans message={"전체 보기"} /><span className="inline-count">{number(data.sessionTotal)}</span><ArrowRight size={14} aria-hidden /></button>}
      className="recent-sessions-panel">
      {data.sessions.length > 0 ? <SessionTable sessions={data.sessions.slice(0, 7)} compact /> : <EmptyState title={t("첫 세션을 가져와 보세요")}
        description={t("설정한 경로의 Codex, Claude Code, Kiro 대화 기록을 찾아 정리합니다.")}
        action={<Button icon={RefreshCw} busy={syncing} onClick={() => void sync()}><Trans message={"세션 동기화"} /></Button>} />}
    </Panel>
    <div className="sync-footnote"><Clock3 size={13} aria-hidden />
      {data.sync ? <><Trans message={"마지막 동기화 {0}"} values={{ "0": relativeTime(data.sync.finishedAt) }} /><span>·</span><Trans message={"{0}개 파일 확인"} values={{ "0": number(data.sync.filesScanned) }} /></> : t("아직 동기화하지 않았습니다.")}
      {data.sync && data.sync.warnings.length > 0 && <button onClick={() => navigate('settings')}><Trans message={"확인할 항목 {0}개"} values={{ "0": data.sync.warnings.length }} /><ArrowRight size={12} aria-hidden /></button>}
    </div>
  </>;
}
