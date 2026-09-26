import type { CreateSavedView, SavedView, SavedViewList, UpdateSavedView } from '../../../shared/saved-views';
import { ApiError, request } from '../../lib/api';

async function boundedRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const parent = init.signal;
  const abort = () => controller.abort();
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  try {
    return await request<T>(path, { ...init, signal: controller.signal });
  } catch (cause) {
    if (timedOut) throw new ApiError('저장 검색 요청 시간이 초과되었습니다. 새로고침 후 다시 시도하세요.', 408);
    throw cause;
  } finally {
    clearTimeout(timeout);
    parent?.removeEventListener('abort', abort);
  }
}

const base = '/productivity/saved-views';
const json = (method: string, body: object, signal?: AbortSignal): RequestInit => ({
  method, body: JSON.stringify(body), signal,
});

export const savedViewsApi = {
  list: (signal?: AbortSignal) => boundedRequest<SavedViewList>(base, { signal }),
  create: (body: CreateSavedView, signal?: AbortSignal) => boundedRequest<SavedView>(base, json('POST', body, signal)),
  update: (id: string, body: UpdateSavedView, signal?: AbortSignal) =>
    boundedRequest<SavedView>(`${base}/${encodeURIComponent(id)}`, json('PATCH', body, signal)),
  remove: (id: string, version: number, signal?: AbortSignal) =>
    boundedRequest<{ ok: true }>(`${base}/${encodeURIComponent(id)}`, json('DELETE', { version }, signal)),
};
