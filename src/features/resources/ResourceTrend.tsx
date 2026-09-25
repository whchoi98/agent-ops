import { useId, useMemo, useState } from 'react';
import { RESOURCE_SCOPES, type ResourceSample } from '../../../shared/resources';
import { useI18n } from '../../i18n/I18nProvider';
import { formatBytes, formatCpu, resourcePaths, SCOPE_NAMES } from './model';

export function ResourceTrend({ history, metric, label }: {
  history: ResourceSample[]; metric: 'cpuPercent' | 'rssBytes'; label: string;
}) {
  const { language, t } = useI18n();
  const id = useId();
  const [selectedAt, setSelectedAt] = useState<string | null>(null);
  const chart = useMemo(() => resourcePaths(history, metric), [history, metric]);
  const selected = selectedAt === null ? history.length - 1 : Math.max(0, history.findIndex(sample => sample.at === selectedAt));
  const current = history[selected];
  const format = (value: number | null) => metric === 'cpuPercent' ? formatCpu(value, language) : formatBytes(value, language);
  const time = (value: string) => new Intl.DateTimeFormat(language === 'ko' ? 'ko-KR' : 'en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value));
  if (!history.length) return <div className="resource-chart-empty">{t('첫 자원 표본을 기다리고 있습니다.')}</div>;
  return <div className="resource-trend">
    <div className="resource-plot">
      <div className="resource-y-axis" aria-hidden>{[4, 3, 2, 1, 0].map(step =>
        <span key={step}>{format(chart.ceiling * step / 4)}</span>)}</div>
    <svg viewBox="0 0 660 160" preserveAspectRatio="none" role="img" aria-labelledby={`${id}-title ${id}-description`}
      onPointerMove={event => {
        if (history.length < 2) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const position = (event.clientX - rect.left) / Math.max(1, rect.width) * 660;
        let index = 0;
        for (let i = 1; i < history.length; i++) if (Math.abs(chart.x(i) - position) < Math.abs(chart.x(index) - position)) index = i;
        setSelectedAt(history[index].at);
      }} onPointerLeave={() => setSelectedAt(null)}>
      <title id={`${id}-title`}>{label}</title>
      <desc id={`${id}-description`}>{t('표본 선택 막대와 아래 값으로 추이를 확인할 수 있습니다. 미측정 구간은 선으로 잇지 않습니다.')}</desc>
      {[0, 1, 2, 3, 4].map(step => <g key={step}>
        <line x1="0" x2="660" y1={step * 40} y2={step * 40} className="resource-grid-line" />
      </g>)}
      <g>
        {RESOURCE_SCOPES.map(scope => <path key={scope} d={chart.paths[scope]} className={`resource-line resource-${scope}`} />)}
        {current && <line x1={chart.x(selected)} x2={chart.x(selected)} y1="0" y2="160" className="resource-cursor" />}
      </g>
    </svg>
    </div>
    <div className="resource-time-axis" aria-hidden><span>{time(history[0].at)}</span><span>{time(history.at(-1)!.at)}</span></div>
    <label className="resource-sample-picker">
      <span>{t('표본 선택')} {current && <strong>{time(current.at)}</strong>}</span>
      <input type="range" min={0} max={Math.max(0, history.length - 1)} value={selected}
        aria-label={t('{0} 표본 선택', { 0: label })} disabled={history.length < 2}
        onChange={event => setSelectedAt(history[Number(event.target.value)]?.at ?? null)} />
    </label>
    <div className="resource-legend">{RESOURCE_SCOPES.map(scope => <div key={scope}>
      <i className={`resource-dot resource-${scope}`} /><span>{t(SCOPE_NAMES[scope])}</span>
      <strong className="numeric">{format(current?.scopes[scope][metric] ?? null)}</strong>
    </div>)}</div>
  </div>;
}
