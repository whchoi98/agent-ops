import { useEffect, useId, useRef, useState } from 'react';
import { AGENTS, type Analytics } from '../../shared/types';
import { AGENT_META, number } from '../lib/format';
import { EmptyState } from './ui';
import { BarChart3 } from 'lucide-react';

export function ActivityChart({ daily, days = 30 }: { daily: Analytics['daily']; days?: number }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [width, setWidth] = useState(800);
  const plotRef = useRef<HTMLDivElement>(null);
  const chartId = useId();
  const entries = [...daily].sort((a, b) => a.date.localeCompare(b.date)).slice(-days);
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const observer = new ResizeObserver(entries => {
      setWidth(Math.max(260, Math.round(entries[0].contentRect.width)));
    });
    observer.observe(plot);
    return () => observer.disconnect();
  }, [entries.length]);
  if (!entries.length) return <EmptyState compact icon={BarChart3} title="아직 활동 기록이 없습니다"
    description="세션을 동기화하면 날짜별 활동을 확인할 수 있습니다." />;
  const height = 228;
  const left = 36;
  const right = 10;
  const top = 18;
  const bottom = 34;
  const graphHeight = height - top - bottom;
  const maxValue = Math.max(1, ...entries.map(day => Math.max(day.sessions, day.codex + day.claude + day.kiro)));
  const maximum = Math.max(2, Math.ceil(maxValue / 4) * 4);
  const slot = (width - left - right) / entries.length;
  const barWidth = Math.min(24, slot * .64);
  const active = hovered === null ? null : entries[hovered];
  const dateLabel = (date: string) => date.slice(5).replace('-', '/');
  return <div className="activity-chart">
    <div className="chart-plot" ref={plotRef}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={chartId} className="chart-svg">
        <title id={chartId}>최근 {days}일 날짜별 세션 수. {entries[0].date}부터 {entries.at(-1)!.date}까지, UTC 기준.</title>
        {[0, 1, 2, 3, 4].map(tick => {
          const value = maximum * tick / 4;
          const y = top + graphHeight - graphHeight * tick / 4;
          return <g key={tick}><line x1={left} x2={width - right} y1={y} y2={y} className="chart-grid-line" />
            <text x={left - 12} y={y + 4} textAnchor="end" className="chart-axis-text">{number(value)}</text></g>;
        })}
        {entries.map((entry, index) => {
          let stacked = 0;
          const x = left + index * slot + (slot - barWidth) / 2;
          const label = `${entry.date}: 총 ${entry.sessions}개 세션, Codex ${entry.codex}, Claude ${entry.claude}, Kiro ${entry.kiro}. ${entry.knownTokenSessions > 0 ? `${number(entry.tokens)} 토큰, ${entry.knownTokenSessions}/${entry.sessions}개 세션에 기록` : '토큰 기록 없음'}`;
          const showDate = index === 0 || index === entries.length - 1 || index % Math.max(1, Math.ceil(entries.length / 7)) === 0;
          return <g key={entry.date} tabIndex={0} role="graphics-symbol" aria-label={label}
            onMouseEnter={() => setHovered(index)} onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(index)} onBlur={() => setHovered(null)}
            onClick={() => setHovered(index === hovered ? null : index)} className="chart-day">
            <rect x={left + index * slot} y={top - 4} width={slot} height={graphHeight + 8} rx={5}
              fill={hovered === index ? 'var(--chart-hover)' : 'transparent'} />
            {AGENTS.map(agent => {
              const barHeight = entry[agent] / maximum * graphHeight;
              const y = top + graphHeight - stacked - barHeight;
              stacked += barHeight;
              return <rect key={agent} x={x} y={y} width={barWidth} height={barHeight} rx={1.5} fill={AGENT_META[agent].color} />;
            })}
            {showDate && <text x={x + barWidth / 2} y={height - 9} textAnchor="middle" className="chart-axis-text">{dateLabel(entry.date)}</text>}
          </g>;
        })}
      </svg>
      {active && <div className="chart-tooltip" style={{ left: `${Math.min(78, Math.max(16, (hovered! + .5) / entries.length * 100))}%` }} role="status">
        <strong>{active.date}<span>{number(active.sessions)}개 세션</span></strong>
        {AGENTS.map(agent => <span key={agent}><i style={{ background: AGENT_META[agent].color }} />{AGENT_META[agent].short}<b>{number(active[agent])}</b></span>)}
        <span className="chart-tooltip-token"><span>토큰</span><b>{active.knownTokenSessions > 0 ? number(active.tokens) : '미기록'}</b></span>
        {active.knownTokenSessions > 0 && active.knownTokenSessions < active.sessions && <small>{active.knownTokenSessions}/{active.sessions}개 세션 기록</small>}
      </div>}
    </div>
    <div className="chart-bottom"><div className="chart-legend">
      {AGENTS.map(agent => <span key={agent}><i style={{ background: AGENT_META[agent].color }} />{AGENT_META[agent].short}</span>)}
    </div><span className="chart-timezone">UTC 기준</span></div>
  </div>;
}
