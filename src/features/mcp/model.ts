import type {
  McpCheckPreview, McpCheckStatus, McpCheckSummary, McpConfigStatus, McpDetail, McpScope, McpTransport,
} from '../../../shared/mcp';

export const MCP_USAGE_NOTICE = '설정이 있다는 사실만으로 어시스턴트의 연결을 확인할 수 없습니다. 점검 결과는 표시된 시각에 이 워크벤치가 별도로 확인한 결과입니다.';
export const CONFIG_LABELS: Record<McpConfigStatus, string> = {
  enabled: '설정상 활성', disabled: '설정상 비활성', unknown: '설정 상태 불명', shadowed: '상위 설정으로 대체됨',
};
export const SCOPE_LABELS: Record<McpScope, string> = {
  user: '사용자 범위', project: '프로젝트 범위', local: '로컬 범위',
};
export const TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: 'stdio', http: 'HTTP', sse: 'SSE', unsupported: '지원하지 않는 전송 방식',
};
export const CHECK_LABELS: Record<McpCheckStatus, string> = {
  running: '워크벤치 점검 중', reachable: '점검 당시 응답함', failed: '점검 실패',
  cancelled: '점검 취소됨', timeout: '점검 시간 초과', unsupported: '점검 미지원',
};
export type McpAction = 'preview' | 'check' | 'cancel' | 'refresh';

export function checkBlockReason(detail: McpDetail | null, demo: boolean, active: McpCheckSummary | null): string | null {
  if (demo || detail?.demo) return '데모에서는 프로세스나 네트워크 점검을 시작할 수 없습니다.';
  if (!detail) return '상세 정보를 불러온 뒤 점검할 수 있습니다.';
  if (active?.status === 'running') return '다른 점검이 진행 중입니다. 완료되거나 취소 정리가 끝난 뒤 새 점검을 시작하세요.';
  if (detail.status === 'disabled' || detail.status === 'shadowed') return '비활성화되거나 다른 설정으로 대체된 선언은 점검할 수 없습니다.';
  if (detail.checkSupport === 'unsupported') return '이 설정의 점검은 지원하지 않습니다. 정적 진단을 확인하세요.';
  if (detail.checkSupport !== 'supported') return '이 설정은 점검이 차단되어 있습니다. 정적 진단을 확인하세요.';
  return null;
}

export function previewBlockReason(
  preview: McpCheckPreview, serverId: string, projectId: string | undefined, now: number,
): string | null {
  if (preview.serverId !== serverId || preview.projectId !== (projectId ?? null)) {
    return '현재 서버와 프로젝트에 맞는 새 미리보기가 필요합니다.';
  }
  if (preview.demo || !preview.canCheck || preview.blockedReasons.some(reason => reason.level === 'error')) {
    return '이 미리보기로는 점검을 시작할 수 없습니다. 차단 사유를 확인하세요.';
  }
  if (!Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= now) {
    return '미리보기가 만료되었습니다. 새 미리보기를 확인하세요.';
  }
  return null;
}

/** Display-only defense: never turn configuration URLs into links or show paths/credentials. */
export function endpointOrigin(value: string | null): string | null {
  if (!value) return null;
  if (value === '[environment-defined endpoint]') return value;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || value.includes('${')) return '[redacted]';
    return `${url.protocol}//${url.host}/[redacted]`;
  } catch { return '[redacted]'; }
}
