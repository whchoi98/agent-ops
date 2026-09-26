import type {
  HarnessAction, HarnessAuditClient, HarnessAuditRecord, HarnessBinding, HarnessHookPreview, HarnessHookRequest,
  HarnessPolicySummary, HarnessRisk, HarnessRuntime, HarnessScope, HarnessSettings,
} from '../../../shared/harness';
import { ApiError } from '../../lib/api';

export const HARNESS_TEXT_LIMIT = 64 * 1024;
export const PYTHON_PATH_LIMIT = 4096;
export const TOOL_NAME_LIMIT = 160;
export const AUDIT_TEXT_LIMIT = 500;
export const AUDIT_SESSION_LIMIT = 200;
export const TESTED_ENGINE_VERSION = '0.1.1';
export const INSTALL_COMMAND = [
  'python3 --version',
  'python3 -m venv .venv-autoharness',
  '.venv-autoharness/bin/python -m pip install "https://github.com/aiming-lab/AutoHarness/archive/3561e468f9ca9f9bf282512e695bd32e4e90fef4.tar.gz"',
].join('\n');

export const CLIENT_LABELS: Record<HarnessAuditClient, string> = {
  codex: 'Codex', 'claude-code': 'Claude Code', 'kiro-ide': 'Kiro IDE', 'kiro-cli': 'Kiro CLI', kiro: 'Kiro 공통',
};
export const ACTION_LABELS: Record<HarnessAction, string> = { allow: '허용', ask: '승인 필요', deny: '차단', error: '엔진 오류' };
export const RISK_LABELS: Record<HarnessRisk, string> = { low: '낮음', medium: '보통', high: '높음', critical: '매우 높음' };
export const SCOPE_LABELS: Record<HarnessScope, string> = {
  builtin: '기본 제공', user: '사용자', project: '프로젝트', local: '프로젝트 로컬', managed: '앱 관리',
};
export const RUNTIME_LABELS: Record<HarnessRuntime['state'], string> = {
  unchecked: '확인하지 않음', ready: '엔진 준비됨', missing: '엔진 또는 Python 없음',
  unsupported: '지원하지 않는 Python 또는 엔진', error: '엔진 확인 오류',
};
export const BINDING_LABELS: Record<HarnessBinding['state'], string> = {
  unconfigured: '설정되지 않음', configured: '설정됨', 'needs-review': '검토 필요', changed: '설정 변경 감지',
  unsupported: '지원 확인 필요', unknown: '설정 상태 불명',
};
export const ORIGIN_LABELS: Record<HarnessAuditRecord['origin'], string> = {
  'agent-ops-test': '판정 테스트', 'agent-ops-hook': '네이티브 훅', autoharness: 'AutoHarness 가져온 기록',
};
export const DEMO_NOTICE = '데모에서는 엔진 확인, 실제 판정 테스트와 훅 변경을 사용할 수 없습니다. 정책 조회와 구조 검증은 사용할 수 있습니다.';
export const UNKNOWN_OUTCOME_NOTICE = '요청이 끝났는지 확인되지 않았습니다. 요청 취소나 연결 종료가 서버 프로세스 종료를 뜻하지는 않습니다. 상태를 새로 확인한 뒤 직접 다시 시도하세요.';
export const KIRO_SHARED_NOTICE = 'Kiro IDE와 Kiro CLI는 하나의 .kiro 훅 설정과 연결을 공유합니다. 설치·업데이트·제거는 두 클라이언트에 함께 적용됩니다.';
export const CODEX_TRUST_NOTICE = 'Codex의 네이티브 훅 신뢰 검토는 Codex에서 직접 완료해야 합니다. 설정됨은 활성화됨을 뜻하지 않습니다.';

export interface HarnessProblem { message: string; status: number | null; unknown: boolean }
export function harnessProblem(cause: unknown, mutation = false): HarnessProblem {
  const status = cause instanceof ApiError ? cause.status : null;
  const aborted = cause instanceof Error && cause.name === 'AbortError';
  return {
    message: aborted ? UNKNOWN_OUTCOME_NOTICE : cause instanceof Error ? cause.message : '하니스 요청을 처리하지 못했습니다.',
    status,
    unknown: mutation && (aborted || status === 0 || status === 408 || status === null),
  };
}
export function textBytes(value: string) { return new TextEncoder().encode(value).byteLength; }
export function parseToolInput(content: string): Record<string, unknown> {
  if (textBytes(content) > HARNESS_TEXT_LIMIT) throw new Error('도구 입력은 UTF-8 기준 64 KiB 이하여야 합니다.');
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error('도구 입력에 올바른 JSON 객체를 입력하세요.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('도구 입력은 배열이나 단일 값이 아닌 JSON 객체여야 합니다.');
  const stack: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++visited > 10000 || depth > 24) throw new Error('도구 입력의 깊이 또는 항목 수가 한도를 초과했습니다.');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('도구 입력의 숫자는 유한한 값이어야 합니다.');
    if (typeof value === 'string' && value.includes('\0')) throw new Error('도구 입력에 NUL 문자를 사용할 수 없습니다.');
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key) || key.includes('\0')) throw new Error('도구 입력에 지원하지 않는 키가 있습니다.');
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return parsed as Record<string, unknown>;
}
export function unsupportedPython(pythonVersion: string | null): boolean {
  const version = /(?:Python\s+)?(\d+)\.(\d+)/.exec(pythonVersion ?? '');
  return !!version && (Number(version[1]) !== 3 || Number(version[2]) < 10);
}
export function runtimeState(runtime: HarnessRuntime): HarnessRuntime['state'] {
  return unsupportedPython(runtime.pythonVersion) ? 'unsupported' : runtime.state;
}
export function isEditablePolicy(policy: HarnessPolicySummary, projectId?: string): boolean {
  return policy.scope === 'managed' && policy.editable && !policy.redacted && policy.projectId === (projectId ?? null);
}
export function previewBlockReason(preview: HarnessHookPreview, request: HarnessHookRequest, now: number): string | null {
  if (preview.projectId !== request.projectId || preview.client !== request.client || preview.action !== request.action) {
    return '미리보기의 프로젝트나 작업이 다릅니다. 새 미리보기를 요청하세요.';
  }
  if (!Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= now) {
    return '미리보기가 만료되었습니다. 새 미리보기를 검토하세요.';
  }
  if (!preview.canApply) return '이 미리보기는 적용할 수 없습니다. 안내를 확인하고 새 미리보기를 요청하세요.';
  return null;
}

export interface HarnessSettingsDraft { pythonPath: string; retentionDays: string; maxCacheRecords: string }
export function settingsDraft(settings: HarnessSettings): HarnessSettingsDraft {
  return { pythonPath: settings.pythonPath ?? '', retentionDays: String(settings.retentionDays), maxCacheRecords: String(settings.maxCacheRecords) };
}
export function settingsInput(original: HarnessSettings, draft: HarnessSettingsDraft): HarnessSettings {
  if (draft.pythonPath.length > PYTHON_PATH_LIMIT || /[\u0000\r\n]/.test(draft.pythonPath)) {
    throw new Error('Python 경로는 줄바꿈 없이 4,096자 이내로 입력하세요.');
  }
  const pythonPath = draft.pythonPath.trim();
  if (pythonPath && !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(pythonPath)) throw new Error('Python 실행 파일의 절대 경로를 입력하세요.');
  const retentionDays = Number(draft.retentionDays);
  const maxCacheRecords = Number(draft.maxCacheRecords);
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 90) {
    throw new Error('보관 기간은 1~90일의 정수로 입력하세요.');
  }
  if (!Number.isSafeInteger(maxCacheRecords) || maxCacheRecords < 100 || maxCacheRecords > 10000) {
    throw new Error('캐시 한도는 100~10,000개의 정수로 입력하세요.');
  }
  return { revision: original.revision, pythonPath: pythonPath || null, retentionDays, maxCacheRecords };
}
