import { useState } from 'react';
import { ArrowUpRight, BarChart3, CircleDollarSign, DatabaseZap, Layers3, MessageSquare, Wrench } from 'lucide-react';
import type { RunStatus } from '../../shared/types';
import { ActivityChart } from '../components/ActivityChart';
import { StatCard } from '../components/Stats';
import { AgentBadge, AggregateTokenValue, EmptyState, InlineNotice, PageHeading, Panel, StatusBadge } from '../components/ui';
import { compactNumber, money, number } from '../lib/format';
import { useApp, useData } from '../state/AppProvider';

const OUTCOMES: Array<{ status: RunStatus; color: string }> = [
  { status: 'completed', color: '#0e9f8f' }, { status: 'running', color: '#3564e8' },
  { status: 'queued', color: '#94a3b8' }, { status: 'failed', color: '#d76b65' },
  { status: 'cancelled', color: '#a6afbd' }, { status: 'interrupted', color: '#c9962b' },
];

function Breakdown({ title, description, rows, onSelect }: {
  title: string; description: string; rows: Array<{ id: string; label: string; detail?: string; sessions: number; tokens: number; knownTokenSessions: number }>;
  onSelect?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const max = Math.max(1, ...rows.map(row => row.sessions));
  return <Panel title={title} description={description} className="breakdown-panel">
    {rows.length ? <>
      <div className="breakdown-table"><div className="breakdown-table-heading"><span>이름</span><span>세션</span><span>기록된 토큰</span></div>
        {(expanded ? rows : rows.slice(0, 7)).map(row => <div key={row.id} className="breakdown-row">
          <div className="breakdown-name">{onSelect ? <button title={row.detail ?? row.label} onClick={() => onSelect(row.id)}>{row.label}<ArrowUpRight size={12} aria-hidden /></button>
            : <strong title={row.detail ?? row.label}>{row.label}</strong>}
            <span className="breakdown-track"><i style={{ width: `${row.sessions / max * 100}%` }} /></span>
          </div><span className="numeric">{number(row.sessions)}</span><AggregateTokenValue tokens={row.tokens} sessions={row.sessions} knownTokenSessions={row.knownTokenSessions} />
        </div>)}
      </div>
      {rows.length > 7 && <button className="panel-footer-link" onClick={() => setExpanded(value => !value)}>{expanded ? '간략히 보기' : `전체 ${rows.length}개 보기`}</button>}
    </> : <EmptyState compact icon={BarChart3} title="집계할 기록이 없습니다" description="세션을 동기화하면 분석이 표시됩니다." />}
  </Panel>;
}

export function Analytics() {
  const { analytics } = useData();
  const { navigate } = useApp();
  const [days, setDays] = useState(30);
  const [allTools, setAllTools] = useState(false);
  const cacheRatio = analytics.inputTokens > 0 ? analytics.cacheReadTokens / analytics.inputTokens * 100 : null;
  const totalRuns = Object.values(analytics.runOutcomes).reduce((sum, value) => sum + value, 0);
  const maxTool = Math.max(1, ...analytics.tools.map(tool => tool.count));
  return <>
    <PageHeading title="사용량 분석" description="실제 기록에서 확인할 수 있는 활동과 사용량을 살펴보세요." eyebrow="WORKSPACE ANALYTICS"
      actions={<span className="period-chip"><DatabaseZap size={15} aria-hidden />전체 기간 집계</span>} />
    <div className="stats-grid">
      <StatCard label="전체 세션" value={number(analytics.totalSessions)} detail={`${number(analytics.totalMessages)}개 메시지 · 전체 기간`} icon={MessageSquare} />
      <StatCard label="기록된 토큰" value={analytics.knownTokenSessions ? compactNumber(analytics.totalTokens) : <span className="stat-unknown">미기록</span>}
        detail={`${number(analytics.knownTokenSessions)}개 세션에 사용량 기록`} icon={Layers3} accent="teal" />
      <StatCard label="기록된 비용" value={analytics.knownCostSessions ? money(analytics.recordedCostUsd) : <span className="stat-unknown">미기록</span>}
        detail={analytics.knownCostSessions ? `${number(analytics.knownCostSessions)}개 세션 · USD` : '비용을 기록한 세션이 없습니다'} icon={CircleDollarSign} accent="violet" />
      <StatCard label="기록된 캐시 비율" value={cacheRatio === null ? <span className="stat-unknown">계산 불가</span> : <>{cacheRatio.toFixed(1)}<span className="stat-unit">%</span></>}
        detail={cacheRatio === null ? '입력 토큰 기록이 필요합니다' : `캐시 읽기 ${compactNumber(analytics.cacheReadTokens)} / 입력 ${compactNumber(analytics.inputTokens)}`}
        icon={DatabaseZap} accent="amber" />
    </div>
    <div className="analytics-record-notice"><InlineNotice>
      <strong>기록된 값만 집계합니다.</strong> 토큰·비용의 미기록 값은 합계에서 제외하며, 요금으로 환산하거나 추정하지 않습니다.
      {analytics.totalSessions > 0 && <span> 비용 미기록 {number(Math.max(0, analytics.totalSessions - analytics.knownCostSessions))}개 · 토큰 미기록 {number(Math.max(0, analytics.totalSessions - analytics.knownTokenSessions))}개 세션.</span>}
    </InlineNotice></div>
    <Panel title="날짜별 활동" description={`최근 ${days}일 · 기록된 세션 수 · 다른 집계는 전체 기간 기준`}
      actions={<select aria-label="활동 차트 기간" value={days} onChange={event => setDays(Number(event.target.value))}><option value={7}>최근 7일</option><option value={14}>최근 14일</option><option value={30}>최근 30일</option></select>}>
      <ActivityChart daily={analytics.daily} days={days} />
    </Panel>
    <div className="analytics-grid">
      <Panel title="에이전트별 사용량" description="기록된 세션, 토큰과 비용" className="provider-analytics-panel">
        {analytics.agents.length ? <div className="table-scroll"><table className="data-table provider-analytics-table">
          <thead><tr><th>에이전트</th><th>세션</th><th>토큰</th><th>기록된 비용</th></tr></thead><tbody>
            {analytics.agents.map(agent => <tr key={agent.agent}><td><button className="provider-table-button" onClick={() => navigate('sessions', { agent: agent.agent })}><AgentBadge agent={agent.agent} /></button></td>
              <td className="numeric">{number(agent.sessions)}</td><td><AggregateTokenValue tokens={agent.tokens} sessions={agent.sessions} knownTokenSessions={agent.knownTokenSessions} /></td>
              <td><span className={`numeric ${!agent.knownCostSessions ? 'text-muted' : ''}`}>{agent.knownCostSessions ? money(agent.costUsd) : '미기록'}</span>
                {agent.knownCostSessions > 0 && <small className="table-secondary">{agent.knownCostSessions}개 세션 기록</small>}</td></tr>)}
          </tbody></table></div> : <EmptyState compact title="에이전트 기록이 없습니다" description="세션을 가져와 사용량을 확인하세요." />}
      </Panel>
      <Panel title="실행 결과" description={`전체 기간 · Agent Ops 실행 ${number(totalRuns)}개`} className="outcomes-panel">
        {totalRuns > 0 ? <div className="run-outcomes">
          <div className="outcomes-bar" role="img" aria-label={`총 ${totalRuns}개 실행의 상태 분포`}>
            {OUTCOMES.map(({ status, color }) => <span key={status} style={{ width: `${(analytics.runOutcomes[status] ?? 0) / totalRuns * 100}%`, background: color }} />)}
          </div><div className="outcomes-legend">{OUTCOMES.map(({ status }) => <div key={status}><StatusBadge status={status} /><strong className="numeric">{number(analytics.runOutcomes[status] ?? 0)}</strong></div>)}</div>
        </div> : <EmptyState compact title="아직 실행 기록이 없습니다" description="에이전트를 실행하면 결과가 집계됩니다." />}
      </Panel>
      <Breakdown title="프로젝트별 활동" description="전체 기간 · 세션 수 기준"
        rows={analytics.projects.map(project => ({ id: project.path, label: project.name, detail: project.path, sessions: project.sessions, tokens: project.tokens, knownTokenSessions: project.knownTokenSessions }))}
        onSelect={path => navigate('sessions', { project: path })} />
      <Breakdown title="모델별 사용량" description="세션에 마지막으로 기록된 모델 기준"
        rows={analytics.models.map(model => ({ id: model.model, label: model.model || '모델 미기록', sessions: model.sessions, tokens: model.tokens, knownTokenSessions: model.knownTokenSessions }))} />
      <Panel title="도구 사용" description={`전체 기간 · ${number(analytics.totalToolCalls)}회 도구 호출`} actions={<Wrench size={17} className="text-muted" aria-hidden />} className="tools-analytics-panel">
        {analytics.tools.length ? <><div className="tool-usage-list">{(allTools ? analytics.tools : analytics.tools.slice(0, 8)).map(tool => <div className="tool-usage-row" key={tool.name}>
          <code>{tool.name}</code><span className="tool-usage-track"><i style={{ width: `${tool.count / maxTool * 100}%` }} /></span><strong className="numeric">{number(tool.count)}</strong>
        </div>)}</div>{analytics.tools.length > 8 && <button className="panel-footer-link" onClick={() => setAllTools(value => !value)}>{allTools ? '간략히 보기' : `전체 ${analytics.tools.length}개 도구 보기`}</button>}</>
          : <EmptyState compact icon={Wrench} title="도구 호출 기록이 없습니다" description="도구 사용이 기록된 세션을 가져오면 표시됩니다." />}
      </Panel>
      <Panel title="입력과 캐시" description="캐시 읽기는 입력 토큰에 포함됩니다." className="cache-panel">
        <div className="cache-visual"><div><span>캐시 읽기 비율</span><strong className="numeric">{cacheRatio === null ? '—' : `${cacheRatio.toFixed(1)}%`}</strong></div>
          <div className="cache-track" role="img" aria-label={cacheRatio === null ? '캐시 비율을 계산할 입력 기록 없음' : `기록된 입력 대비 캐시 읽기 ${cacheRatio.toFixed(1)}퍼센트`}>
            <span style={{ width: `${Math.max(0, Math.min(100, cacheRatio ?? 0))}%` }} /></div>
          <dl><div><dt>입력 토큰</dt><dd>{analytics.knownTokenSessions ? number(analytics.inputTokens) : '미기록'}</dd></div>
            <div><dt>기록된 캐시 읽기</dt><dd>{analytics.knownTokenSessions ? number(analytics.cacheReadTokens) : '미기록'}</dd></div></dl>
          <p>캐시 읽기 ÷ 입력 토큰으로 계산합니다. 미기록 캐시 사용량은 반영되지 않습니다.</p>
        </div>
      </Panel>
    </div>
    <p className="page-footnote">— 는 토큰 기록이 없는 그룹입니다. 일부 세션에만 기록이 있으면 기록 범위를 함께 표시합니다. 실제 0토큰과 미기록은 구분합니다.</p>
  </>;
}
