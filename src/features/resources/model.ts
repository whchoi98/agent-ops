import { RESOURCE_SCOPES, type ResourceSample, type ResourceScope, type ResourceWarning } from '../../../shared/resources';

export const SCOPE_NAMES: Record<ResourceScope, string> = {
  server: '앱 서버', sync: '동기화 작업', agents: '에이전트 실행', mcp: 'MCP 점검',
};
export const WARNING_NAMES: Record<ResourceWarning, string> = {
  owned_processes_unavailable: '일부 실행 작업의 자원을 측정하지 못했습니다.',
  owned_process_identity_changed: '프로세스가 바뀌어 이전 작업의 측정값을 연결하지 않았습니다.',
  owned_process_limit: '소유 프로세스 측정 한도에 도달했습니다.',
  owned_platform_unsupported: '이 운영체제에서는 실행 작업의 자원 측정을 지원하지 않습니다.',
  disk_unavailable: '앱 데이터 디렉터리의 용량을 확인하지 못했습니다.',
  disk_entry_limit: '디스크 탐색 항목 수 한도로 부분 집계했습니다.',
  disk_depth_limit: '디스크 탐색 깊이 한도로 부분 집계했습니다.',
  disk_time_limit: '디스크 탐색 시간 한도로 부분 집계했습니다.',
  disk_scan_incomplete: '일부 파일의 메타데이터를 읽지 못해 부분 집계했습니다.',
  disk_volume_unavailable: '파일시스템의 여유 공간을 확인하지 못했습니다.',
  sampling_failed: '이번 자원 표본을 완전히 측정하지 못했습니다.',
};
export function formatBytes(value: number | null | undefined, language = 'ko'): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const exponent = value === 0 ? 0 : Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${new Intl.NumberFormat(language === 'ko' ? 'ko-KR' : 'en-US', {
    maximumFractionDigits: exponent === 0 ? 0 : 2,
  }).format(value / 1024 ** exponent)} ${units[exponent]}`;
}
export function formatCpu(value: number | null | undefined, language = 'ko'): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  return `${new Intl.NumberFormat(language === 'ko' ? 'ko-KR' : 'en-US', { maximumFractionDigits: 2 }).format(value)}%`;
}
export function resourcePaths(history: ResourceSample[], metric: 'cpuPercent' | 'rssBytes', width = 660, height = 160) {
  const values = history.flatMap(sample => RESOURCE_SCOPES.map(scope => sample.scopes[scope][metric]))
    .filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
  const peak = Math.max(metric === 'cpuPercent' ? 1 : 1024, ...values);
  const step = 10 ** Math.floor(Math.log10(peak));
  const ceiling = Math.ceil(peak / step) * step;
  const times = history.map(sample => Date.parse(sample.at));
  const first = times[0] ?? 0, span = Math.max(5000, (times.at(-1) ?? 0) - first);
  const x = (index: number) => Math.max(0, Math.min(width, ((times[index] - first) / span) * width));
  const y = (value: number) => height - value / ceiling * height;
  const paths = Object.fromEntries(RESOURCE_SCOPES.map(scope => {
    let path = '', connected = false;
    history.forEach((sample, index) => {
      const value = sample.scopes[scope][metric];
      if (value === null || !Number.isFinite(value) || value < 0) { connected = false; return; }
      if (index > 0 && times[index] - times[index - 1] > 15_000) connected = false;
      path += `${connected ? 'L' : 'M'}${x(index).toFixed(2)},${y(value).toFixed(2)} `;
      connected = true;
    });
    return [scope, path.trim()];
  })) as Record<ResourceScope, string>;
  return { paths, ceiling, x, y };
}
