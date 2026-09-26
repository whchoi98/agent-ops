import type {
  Agent, Bootstrap, CommandPreview, Handoff, Message, MessagePage, MessageQuery, Project, PromptTemplate, Run, RunDetail,
  RunRequest, SessionDetail, SessionPage, SessionQuery, Settings, SyncReport,
} from '../../shared/types';
import { toQueryString } from './query';
import { apiUrl } from './urls';
import type { ExtensionAnalysisDraft, ExtensionCatalog, ExtensionContent, ExtensionDetail, ExtensionQuery } from '../../shared/extensions';
import type { VersionReport } from '../../shared/versions';
import type { ResourceReport } from '../../shared/resources';
import type { SyncStatus } from '../../shared/sync-control';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function response(path: string, init: RequestInit = {}): Promise<Response> {
  let result: Response;
  try {
    result = await fetch(apiUrl(path), {
      credentials: 'same-origin', cache: 'no-store', ...init,
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'X-Agent-Ops': '1',
        ...init.headers,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('서버에 연결할 수 없습니다. my-agent-ops가 실행 중인지 확인하고 다시 시도하세요.', 0);
  }
  if (!result.ok) {
    const payload = await result.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(payload?.error || `요청을 처리하지 못했습니다 (${result.status}). 다시 시도하세요.`, result.status);
  }
  return result;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const result = await response(path, init);
  try { return await result.json() as T; }
  catch { throw new ApiError('서버 응답을 읽지 못했습니다. 새로고침 후 다시 시도하세요.', result.status); }
}

const id = encodeURIComponent;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
type TemplateFields = Omit<PromptTemplate, 'id' | 'updatedAt' | 'revision'> & { expectedRevision?: number };
type ProjectFields = Pick<Project, 'name' | 'path'> & Partial<Pick<Project, 'color' | 'executionEnabled'>>;

export const api = {
  bootstrap: (signal?: AbortSignal) => request<Bootstrap>('/bootstrap', { signal }),
  resources: (signal?: AbortSignal) => request<ResourceReport>('/resources', { signal }),
  versions: (signal?: AbortSignal) => request<VersionReport>('/connector-versions', { signal }),
  checkVersions: () => request<VersionReport>('/connector-versions/check', json('POST', {})),
  extensions: (query: ExtensionQuery = {}, signal?: AbortSignal) =>
    request<ExtensionCatalog>(`/extensions?${toQueryString(query)}`, { signal }),
  extension: (extensionId: string, projectId?: string, signal?: AbortSignal) =>
    request<ExtensionDetail>(`/extensions/${id(extensionId)}?${toQueryString({ projectId })}`, { signal }),
  extensionFile: (extensionId: string, fileId: string, projectId?: string, signal?: AbortSignal) =>
    request<ExtensionContent>(`/extensions/${id(extensionId)}/files/${id(fileId)}?${toQueryString({ projectId })}`, { signal }),
  refreshExtensions: (projectId?: string) =>
    request<{ ok: true }>('/extensions/refresh', json('POST', { projectId })),
  analyzeExtension: (extensionId: string, projectId?: string) =>
    request<ExtensionAnalysisDraft>(`/extensions/${id(extensionId)}/analyze`, json('POST', { projectId })),
  sessions: (query: SessionQuery, signal?: AbortSignal) => request<SessionPage>(`/sessions?${toQueryString(query)}`, { signal }),
  session: (sessionId: string, signal?: AbortSignal) =>
    request<SessionDetail>(`/sessions/${id(sessionId)}?includeMessages=false`, { signal }),
  updateSession: (sessionId: string, patch: Partial<Pick<SessionDetail, 'bookmarked' | 'tags' | 'note' | 'title'>>) =>
    request<SessionDetail>(`/sessions/${id(sessionId)}?includeMessages=false`, json('PATCH', patch)),
  messages: (sessionId: string, query: MessageQuery = {}, signal?: AbortSignal) =>
    request<MessagePage>(`/sessions/${id(sessionId)}/messages?${toQueryString({ offset: 0, limit: 50, ...query })}`, { signal }),
  message: (sessionId: string, messageId: string, signal?: AbortSignal) =>
    request<Message>(`/sessions/${id(sessionId)}/messages/${id(messageId)}`, { signal }),
  handoff: (body: { sessionId: string; targetAgent: Agent; instruction?: string }) =>
    request<Handoff>('/handoff', json('POST', body)),
  sync: () => request<SyncReport>('/sync', json('POST', {})),
  startSync: () => request<{ syncing: boolean }>('/sync/start', json('POST', {})),
  syncStatus: (signal?: AbortSignal) => request<SyncStatus>('/sync/status', { signal }),
  cancelSync: () => request<{ stopping: boolean; status: SyncStatus }>('/sync/cancel', json('POST', {})),
  run: (runId: string, signal?: AbortSignal) => request<RunDetail>(`/runs/${id(runId)}`, { signal }),
  runEvents: (runId: string, after: number, signal?: AbortSignal) =>
    request<RunDetail>(`/runs/${id(runId)}/events?after=${after}`, { signal }),
  previewRun: (body: RunRequest) => request<CommandPreview>('/runs/preview', json('POST', body)),
  createRun: (body: RunRequest) => request<Run>('/runs', json('POST', body)),
  cancelRun: (runId: string) => request<Run>(`/runs/${id(runId)}/cancel`, json('POST', {})),
  retryRun: (runId: string) => request<Run>(`/runs/${id(runId)}/retry`, json('POST', {})),
  createProject: (body: ProjectFields) => request<Project>('/projects', json('POST', body)),
  updateProject: (projectId: string, body: Partial<Omit<ProjectFields, 'path'>>) =>
    request<Project>(`/projects/${id(projectId)}`, json('PATCH', body)),
  createTemplate: (body: TemplateFields) => request<PromptTemplate>('/templates', json('POST', body)),
  templates: (signal?: AbortSignal) => request<PromptTemplate[]>('/templates', { signal }),
  updateTemplate: (templateId: string, body: TemplateFields) =>
    request<PromptTemplate>(`/templates/${id(templateId)}`, json('PATCH', body)),
  deleteTemplate: (templateId: string) =>
    request<{ ok: true }>(`/templates/${id(templateId)}`, json('DELETE', {})),
  updateSettings: (body: Partial<Settings>) => request<Settings>('/settings', json('PATCH', body)),
  async downloadSession(sessionId: string, format: 'json' | 'md' | 'html'): Promise<void> {
    const result = await response(`/sessions/${id(sessionId)}/export?format=${format}`, {
      headers: { Accept: format === 'json' ? 'application/json' : format === 'html' ? 'text/html' : 'text/markdown' },
    });
    const blob = await result.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `agent-ops-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 72)}.${format}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};
