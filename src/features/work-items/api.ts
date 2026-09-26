import type { Agent } from '../../../shared/types';
import type {
  WorkItem, WorkItemDetail, WorkItemFields, WorkItemPage, WorkItemPatch, WorkItemPrepared, WorkItemQuery,
} from '../../../shared/work-items';
import { ApiError, request } from '../../lib/api';
import { toQueryString } from '../../lib/query';
import { requestWorkItemQuery } from './model';

const base = '/productivity/work-items';
async function boundedRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const parent = init.signal;
  const abort = () => controller.abort();
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  try { return await request<T>(path, { ...init, signal: controller.signal }); }
  catch (cause) {
    if (timedOut) throw new ApiError('작업 요청 시간이 초과되었습니다. 상태를 확인하고 다시 시도하세요.', 408);
    throw cause;
  } finally {
    clearTimeout(timeout);
    parent?.removeEventListener('abort', abort);
  }
}
const json = (method: string, body: object, signal?: AbortSignal): RequestInit => ({ method, body: JSON.stringify(body), signal });
export const workItemsApi = {
  list: (query: WorkItemQuery = {}, signal?: AbortSignal) =>
    boundedRequest<WorkItemPage>(`${base}?${toQueryString(requestWorkItemQuery(query))}`, { signal }),
  open: (projectId?: string, signal?: AbortSignal) => workItemsApi.list({ status: 'open', projectId, limit: 5, offset: 0 }, signal),
  get: (id: string, signal?: AbortSignal) => boundedRequest<WorkItemDetail>(`${base}/${encodeURIComponent(id)}`, { signal }),
  create: (fields: WorkItemFields, signal?: AbortSignal) => boundedRequest<WorkItem>(base, json('POST', fields, signal)),
  update: (id: string, patch: WorkItemPatch, signal?: AbortSignal) =>
    boundedRequest<WorkItem>(`${base}/${encodeURIComponent(id)}`, json('PATCH', patch, signal)),
  remove: (id: string, version: number, signal?: AbortSignal) =>
    boundedRequest<{ ok: true }>(`${base}/${encodeURIComponent(id)}`, json('DELETE', { version }, signal)),
  prepare: (id: string, version: number, agent?: Agent, signal?: AbortSignal) =>
    boundedRequest<WorkItemPrepared>(`${base}/${encodeURIComponent(id)}/prepare`, json('POST', { version, ...(agent ? { agent } : {}) }, signal)),
};
