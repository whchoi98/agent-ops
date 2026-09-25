import type { McpCatalog, McpCheck, McpCheckPreview, McpDetail, McpQuery } from '../../../shared/mcp';
import { ApiError, request } from '../../lib/api';
import { toQueryString } from '../../lib/query';

/** Transport guards and proxy mounting belong to the shared request function. */
async function boundedRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  const parent = init.signal;
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  try {
    return await request<T>(path, { ...init, signal: controller.signal });
  } catch (cause) {
    if (timedOut) throw new ApiError('MCP 요청 시간이 초과되었습니다. 상태를 확인한 뒤 다시 시도하세요.', 408);
    throw cause;
  } finally {
    clearTimeout(timeout);
    parent?.removeEventListener('abort', abort);
  }
}

const id = encodeURIComponent;
const post = (body: object, signal?: AbortSignal): RequestInit => ({ method: 'POST', body: JSON.stringify(body), signal });

/** IDs originate in catalog/detail/check DTOs; there is no URL, command or config mutation API here. */
export const mcpApi = {
  catalog: (query: McpQuery = {}, signal?: AbortSignal) =>
    boundedRequest<McpCatalog>(`/mcp?${toQueryString(query)}`, { signal }),
  refresh: (projectId?: string, signal?: AbortSignal) =>
    boundedRequest<{ ok: true }>('/mcp/refresh', post({ projectId }, signal)),
  detail: (serverId: string, projectId?: string, signal?: AbortSignal) =>
    boundedRequest<McpDetail>(`/mcp/${id(serverId)}?${toQueryString({ projectId })}`, { signal }),
  preview: (serverId: string, projectId?: string, signal?: AbortSignal) =>
    boundedRequest<McpCheckPreview>(`/mcp/${id(serverId)}/preview`, post({ projectId }, signal)),
  check: (serverId: string, projectId: string | undefined, previewId: string, signal?: AbortSignal) =>
    boundedRequest<McpCheck>(`/mcp/${id(serverId)}/check`, post({ projectId, previewId }, signal)),
  getCheck: (checkId: string, signal?: AbortSignal) =>
    boundedRequest<McpCheck>(`/mcp/checks/${id(checkId)}`, { signal }),
  cancel: (checkId: string, signal?: AbortSignal) =>
    boundedRequest<McpCheck>(`/mcp/checks/${id(checkId)}/cancel`, post({}, signal)),
};
