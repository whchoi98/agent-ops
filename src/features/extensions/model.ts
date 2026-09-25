import type { ExtensionFileKind, ExtensionKind, ExtensionQuery, ExtensionScope, ExtensionStatus } from '../../../shared/extensions';
import { AGENTS, type Agent, type Project } from '../../../shared/types';

export const KIND_LABELS: Record<ExtensionKind, string> = {
  skill: '스킬', plugin: '플러그인', power: '파워',
};
export const SCOPE_LABELS: Record<ExtensionScope, string> = {
  user: '사용자', project: '프로젝트', system: '시스템',
};
export const STATUS_LABELS: Record<ExtensionStatus, string> = {
  enabled: '설정상 활성', disabled: '설정상 비활성', available: '사용 가능',
  unknown: '활성 여부 미확인', cached: '캐시됨',
};
export const FILE_KIND_LABELS: Record<ExtensionFileKind, string> = {
  instructions: '지시문', manifest: '매니페스트', script: '스크립트', reference: '참고 자료',
  hook: '훅', mcp: 'MCP', agent: '에이전트', other: '기타',
};
export const USAGE_NOTICE = '설정에서 확인한 상태입니다. 실제 호출 여부나 사용 횟수를 뜻하지 않습니다.';

function option<T extends string>(value: string | null, labels: Record<T, string>): T | undefined {
  return value && Object.hasOwn(labels, value) ? value as T : undefined;
}

export function readExtensionQuery(search: string, projects: Pick<Project, 'id'>[]): ExtensionQuery {
  const params = new URLSearchParams(search);
  const agent = params.get('agent') as Agent;
  const projectId = projects.find(project => project.id === params.get('projectId'))?.id;
  const scope = option(params.get('scope'), SCOPE_LABELS);
  const offset = Number(params.get('offset'));
  const limit = Number(params.get('limit'));
  return {
    agent: AGENTS.includes(agent) ? agent : undefined,
    kind: option(params.get('kind'), KIND_LABELS),
    status: option(params.get('status'), STATUS_LABELS),
    scope: scope === 'project' && !projectId ? undefined : scope,
    projectId,
    q: params.get('q')?.slice(0, 500) || undefined,
    offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
    limit: [20, 40, 60].includes(limit) ? limit : 20,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
