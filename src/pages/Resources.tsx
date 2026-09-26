import { useState } from 'react';
import { Activity, Cpu, HardDrive, MemoryStick, Pause, Play, RefreshCw } from 'lucide-react';
import { DISK_CATEGORIES, RESOURCE_SCOPES } from '../../shared/resources';
import { Button, ErrorState, InlineNotice, PageHeading, Panel, Skeleton } from '../components/ui';
import { StatCard } from '../components/Stats';
import { useResources } from '../hooks/useResources';
import { useI18n } from '../i18n/I18nProvider';
import { useData } from '../state/AppProvider';
import { ResourceTrend } from '../features/resources/ResourceTrend';
import { formatBytes, formatCpu, SCOPE_NAMES, WARNING_NAMES } from '../features/resources/model';

const DISK_NAMES = { database: '데이터베이스', wal: 'WAL·공유 메모리 파일', backups: '백업 파일', other: '기타 데이터 파일' };

export function Resources() {
  const { language, t, notice } = useI18n();
  const { demo } = useData();
  const { data, error, refreshing, paused, setPaused, refresh } = useResources();
  const [minutes, setMinutes] = useState(15);
  const current = data?.current, disk = data?.disk;
  const bytes = (value: number | null | undefined) => formatBytes(value, language);
  const cpu = (value: number | null | undefined) => formatCpu(value, language);
  const when = (value: string) => new Intl.DateTimeFormat(language === 'ko' ? 'ko-KR' : 'en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value));
  const stale = current && Date.now() - Date.parse(current.at) > 20_000;
  const warnings = [...new Set([...(current?.warnings ?? []), ...(disk?.warnings ?? [])])];
  const history = data?.history.filter(sample => !current || Date.parse(sample.at) >= Date.parse(current.at) - minutes * 60_000) ?? [];
  const freeRatio = disk?.volume ? disk.volume.availableBytes / disk.volume.totalBytes : null;
  return <>
    <PageHeading eyebrow="APPLICATION RESOURCES" title={t('자원 모니터링')}
      description={t('앱 서버, 수집 작업, 에이전트 실행이 사용하는 자원을 구분해 확인합니다.')}
      actions={<>
        <Button icon={paused ? Play : Pause} onClick={() => setPaused(value => !value)}>{paused ? t('자동 조회 재개') : t('자동 조회 일시정지')}</Button>
        <Button icon={RefreshCw} busy={refreshing} onClick={refresh}>{t('새로고침')}</Button>
      </>} />
    <div className="resource-status" role="status">
      <span><i className={`resource-state-dot ${paused || error || stale ? '' : 'resource-state-live'}`} />{paused ? t('자동 조회 일시정지됨') : t('5초마다 자원 표본 확인')}</span>
      <span>{current ? t('측정 시각 {0}', { 0: when(current.at) }) : t('첫 자원 표본을 기다리고 있습니다.')}</span>
    </div>
    {demo && <InlineNotice>{t('대화는 샘플 데이터이며, 자원 값은 현재 데모 서버의 실제 측정값입니다.')}</InlineNotice>}
    {error && <div className="resource-notice"><ErrorState message={notice(error)} retry={refresh} compact /></div>}
    {stale && !paused && <div className="resource-notice"><InlineNotice tone="warning">{t('최근 표본을 받지 못했습니다. 마지막 측정 시각을 확인해 주세요.')}</InlineNotice></div>}
    {!data ? !error && <div className="panel resource-loading"><Skeleton rows={5} /></div> : <>
      <div className="stats-grid resource-stats">
        <StatCard label={t('앱 서버 CPU')} value={cpu(current?.scopes.server.cpuPercent)} icon={Cpu}
          detail={t('100% = 논리 CPU 1개 · {0}개 사용 가능', { 0: data.server.logicalCpuCount })} />
        <StatCard label={t('앱 서버 메모리')} value={bytes(current?.scopes.server.rssBytes)} icon={MemoryStick} accent="teal"
          detail={t('RSS · 힙 사용 {0}', { 0: bytes(current?.heapUsedBytes) })} />
        <StatCard label={t('앱 데이터 파일')} value={bytes(disk?.logicalBytes)} icon={HardDrive} accent="violet"
          detail={!disk ? t('디스크 메타데이터 집계 중') : disk.complete ? t('일반 파일 {0}개 · 하드링크 중복 제외', { 0: disk.fileCount }) : t('부분 집계 · 확인된 파일 {0}개', { 0: disk.fileCount })} />
        <StatCard label={t('파일시스템 여유 공간')} value={bytes(disk?.volume?.availableBytes)} icon={Activity} accent="amber"
          detail={disk?.volume ? t('데이터 경로가 있는 파일시스템 · 전체 {0}', { 0: bytes(disk.volume.totalBytes) }) : t('파일시스템 정보 확인 중')} />
      </div>
      {freeRatio !== null && freeRatio < 0.1 && <div className="resource-notice"><InlineNotice tone="warning">{t('데이터 파일시스템의 여유 공간이 10% 미만입니다. 백업을 포함한 사용량을 확인해 주세요.')}</InlineNotice></div>}
      {warnings.length > 0 && <div className="resource-notice"><InlineNotice tone="warning"><ul className="resource-warning-list">
        {warnings.map(warning => <li key={warning}>{t(WARNING_NAMES[warning])}</li>)}
      </ul></InlineNotice></div>}
      <div className="resource-section-toolbar"><h2>{t('최근 자원 추이')}</h2>
        <select aria-label={t('자원 추이 기간')} value={minutes} onChange={event => setMinutes(Number(event.target.value))}>
          <option value={5}>{t('최근 5분')}</option><option value={15}>{t('최근 15분')}</option>
        </select>
      </div>
      <div className="resource-chart-grid">
        <Panel title={t('CPU 사용률')} description={t('논리 CPU 1개 기준 · 여러 코어를 사용하면 100%를 넘을 수 있습니다.')}>
          <ResourceTrend history={history} metric="cpuPercent" label={t('CPU 사용률')} />
        </Panel>
        <Panel title={t('상주 메모리')} description={t('범위별 RSS 합계 · 공유 페이지는 각 프로세스에 포함됩니다.')}>
          <ResourceTrend history={history} metric="rssBytes" label={t('상주 메모리')} />
        </Panel>
      </div>
      <Panel title={t('프로세스 범위')} description={t('이 앱이 소유한 작업만 집계합니다. 다른 터미널에서 실행한 도구는 포함하지 않습니다.')}>
        <div className="table-scroll"><table className="data-table resource-table">
          <thead><tr><th>{t('측정 대상')}</th><th>{t('프로세스 수')}</th><th>{t('CPU 사용률')}</th><th>{t('상주 메모리')}</th></tr></thead>
          <tbody>{RESOURCE_SCOPES.map(scope => <tr key={scope}>
            <td><span className="resource-scope-name"><i className={`resource-dot resource-${scope}`} />{t(SCOPE_NAMES[scope])}</span></td>
            <td className="numeric">{current?.scopes[scope]?.processCount ?? '—'}</td>
            <td className="numeric">{cpu(current?.scopes[scope]?.cpuPercent)}</td>
            <td className="numeric">{bytes(current?.scopes[scope]?.rssBytes)}</td>
          </tr>)}</tbody>
        </table></div>
        <p className="resource-explanation">{t('— 는 첫 표본이거나 측정하지 못한 값입니다. 작업이 없는 범위의 0과 구분합니다. 짧은 작업은 표본 사이에 종료될 수 있습니다.')}</p>
      </Panel>
      <div className="resource-bottom-grid">
        <Panel title={t('앱 데이터 용량')} description={t('설치 의존성과 원본 코딩 도구 기록을 제외한 데이터 디렉터리 기준입니다.')}>
          <p className="resource-data-path"><code>{disk?.dataDirectory ?? t('경로 확인 중')}</code></p>
          <div className="table-scroll"><table className="data-table resource-table">
            <thead><tr><th>{t('구분')}</th><th>{t('파일 크기')}</th><th>{t('파일 할당량')}</th></tr></thead>
            <tbody>{DISK_CATEGORIES.map(category => <tr key={category}>
              <td>{t(DISK_NAMES[category])}</td>
              <td className="numeric">{bytes(disk?.logicalBytes == null ? null : disk.categories[category].logicalBytes)}</td>
              <td className="numeric">{bytes(disk?.logicalBytes == null ? null : disk.categories[category].allocatedBytes)}</td>
            </tr>)}</tbody>
            <tfoot><tr><th>{disk?.complete ? t('합계') : t('확인된 합계')}</th><td className="numeric">{bytes(disk?.logicalBytes)}</td><td className="numeric">{bytes(disk?.allocatedBytes)}</td></tr></tfoot>
          </table></div>
          <p className="resource-explanation">{t('파일 할당량은 디스크 블록 기준입니다. 희소 파일은 파일 크기와 다를 수 있으며 폴더 메타데이터는 포함하지 않습니다.')}</p>
          <p className="resource-explanation">{disk ? t('디스크 확인 {0} · 제외한 심볼릭 링크 {1}개', { 0: when(disk.at), 1: disk.skippedLinks }) : t('디스크 메타데이터 집계 중')}</p>
        </Panel>
        <Panel title={t('수집 비용과 보관')} description={t('새 데이터베이스 테이블이나 외부 모니터링 서비스 없이 수집합니다.')}>
          <dl className="resource-facts">
            <div><dt>{t('CPU·메모리 주기')}</dt><dd>{t('{0}초', { 0: data.sampleIntervalSeconds })}</dd></div>
            <div><dt>{t('디스크 주기')}</dt><dd>{t('{0}초', { 0: data.diskIntervalSeconds })}</dd></div>
            <div><dt>{t('메모리 보관')}</dt><dd>{t('최대 {0}분 · 현재 {1}개 표본', { 0: data.retentionSeconds / 60, 1: data.history.length })}</dd></div>
            <div><dt>{t('최근 수집 시간')}</dt><dd>{current ? `${current.durationMs.toFixed(2)} ms` : '—'}</dd></div>
            <div><dt>{t('최대 수집 시간')}</dt><dd>{`${data.collector.maxDurationMs.toFixed(2)} ms`}</dd></div>
            <div><dt>{t('최근 디스크 집계')}</dt><dd>{disk ? `${disk.durationMs.toFixed(2)} ms` : '—'}</dd></div>
            <div><dt>{t('겹친 주기 생략')}</dt><dd>{data.collector.skippedSamples}</dd></div>
            <div><dt>{t('서버 프로세스')}</dt><dd>PID {data.server.pid} · {data.server.platform}</dd></div>
          </dl>
          <p className="resource-explanation">{t('최근 수집 시간은 메타데이터 조회를 포함한 경과 시간이며 CPU 사용 시간과는 다릅니다.')}</p>
          <p className="resource-explanation">{t('파일 내용은 읽지 않으며 표본은 메모리에만 보관합니다. 서버를 재시작하면 추이가 초기화됩니다.')}</p>
        </Panel>
      </div>
    </>}
  </>;
}
