import type { Agent, PromptTemplate, RunStatus, SessionStatus, Usage } from '../../shared/types';

export const AGENT_META: Record<Agent, { name: string; short: string; color: string; cli: string }> = {
  codex: { name: 'Codex', short: 'Codex', color: '#0e9f8f', cli: 'codex' },
  claude: { name: 'Claude Code', short: 'Claude', color: '#c57455', cli: 'claude' },
  kiro: { name: 'Kiro CLI', short: 'Kiro', color: '#8b5cf6', cli: 'kiro-cli' },
};

export const STATUS_LABEL: Record<RunStatus | SessionStatus, string> = {
  queued: '대기 중', running: '실행 중', completed: '완료', failed: '실패',
  cancelled: '취소됨', interrupted: '중단됨', recorded: '기록됨',
};
export const TEMPLATE_CATEGORIES: Record<PromptTemplate['category'], string> = {
  review: '코드 리뷰', build: '구현', debug: '디버깅', docs: '문서화', custom: '사용자 정의',
};

export const number = (value: number) => new Intl.NumberFormat('en-US').format(value);
export const compactNumber = (value: number) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export const money = (value: number | null | undefined) => value == null
  ? '미기록'
  : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < .01 ? 4 : 2 }).format(value);

export function tokenUsage(usage: Pick<Usage, 'inputTokens' | 'outputTokens'>) {
  return {
    total: usage.inputTokens === null && usage.outputTokens === null
      ? null : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    complete: usage.inputTokens !== null && usage.outputTokens !== null,
  };
}

export function recordedDuration(start: string, end: string): number | null {
  const result = Date.parse(end) - Date.parse(start);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

export function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '미기록';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 ${seconds % 60}초`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 ${minutes % 60}분`;
  return `${Math.floor(hours / 24)}일 ${hours % 24}시간`;
}

export function dateTime(value: string | null | undefined, options?: Intl.DateTimeFormatOptions): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '미기록';
  return new Intl.DateTimeFormat('ko-KR', options ?? {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

export function relativeTime(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '시간 미기록';
  const elapsed = Date.now() - Date.parse(value);
  if (elapsed < 0) return dateTime(value);
  if (elapsed < 60_000) return '방금 전';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}분 전`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}시간 전`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}일 전`;
  return dateTime(value, { month: 'short', day: 'numeric' });
}

export function parseTags(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map(tag => tag.trim().replace(/^#+/, '').trim()).filter(Boolean))];
}

export function safeMarkdownUrl(value: string): string {
  const candidate = value.trim();
  if (!/^(https?:\/\/|mailto:)/i.test(candidate) || /[\u0000-\u001f\u007f]/.test(candidate)) return '';
  try {
    const url = new URL(candidate);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? candidate : '';
  } catch { return ''; }
}

export function localDateBoundary(value: string, end = false): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function inputDate(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function cleanTerminal(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u007f]/g, '');
}

export const isActiveRun = (status: RunStatus) => status === 'queued' || status === 'running';
export const canRetryRun = (status: RunStatus) => ['failed', 'cancelled', 'interrupted'].includes(status);
export const projectColor = (color?: string) => color && /^#[a-f\d]{6}$/i.test(color) ? color : '#3564e8';
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '요청을 처리하지 못했습니다. 다시 시도하세요.';
