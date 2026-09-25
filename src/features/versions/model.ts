import type { ConnectorVersion, VersionStatus } from '../../../shared/versions';

export const VERSION_LABELS: Record<VersionStatus, string> = {
  current: '최신 상태',
  'update-available': '업데이트 있음',
  ahead: '공개 최신보다 새 버전',
  'not-installed': '미설치',
  unknown: '비교 불가',
  'check-failed': '조회 실패',
};

export function comparisonStatus(version: ConnectorVersion | undefined, installed: boolean | undefined, failed: boolean): VersionStatus {
  if (failed) return 'check-failed';
  if (!version) return installed === false ? 'not-installed' : 'unknown';
  if (['current', 'update-available', 'ahead'].includes(version.status)
    && (!version.currentVersion?.trim() || !version.latestVersion?.trim() || !version.installed)) {
    return version.installed === false ? 'not-installed' : 'unknown';
  }
  return version.status;
}

export function versionSource(value: string | undefined): URL | null {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch { return null; }
}
