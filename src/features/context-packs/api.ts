import type {
  ContextPack, ContextPackQuery, ContextPackPage, CreateContextPackInput, UpdateContextPackInput,
  ContextPackVersion, ContextPackItemInput, UpdateContextPackItemInput, ReorderContextPackInput,
  ContextPackCompilation, ContextPackExport, ContextPackExportFormat,
} from '../../../shared/context-packs';
import { ApiError, request } from '../../lib/api';
import { apiUrl } from '../../lib/urls';
import { toQueryString } from '../../lib/query';

const base = '/productivity/context-packs';
const path = (id: string) => `${base}/${encodeURIComponent(id)}`;
const json = (method: string, body: unknown, signal?: AbortSignal): RequestInit => ({ method, body: JSON.stringify(body), signal });

export const contextPacksApi = {
  list: (query: ContextPackQuery = {}, signal?: AbortSignal) =>
    request<ContextPackPage>(`${base}?${toQueryString(query)}`, { signal }),
  get: (id: string, signal?: AbortSignal) => request<ContextPack>(path(id), { signal }),
  create: (input: CreateContextPackInput, signal?: AbortSignal) =>
    request<ContextPack>(base, json('POST', input, signal)),
  update: (id: string, input: UpdateContextPackInput, signal?: AbortSignal) =>
    request<ContextPack>(path(id), json('PATCH', input, signal)),
  remove: (id: string, input: ContextPackVersion, signal?: AbortSignal) =>
    request<{ ok: true }>(path(id), json('DELETE', input, signal)),
  addItem: (id: string, input: ContextPackItemInput, signal?: AbortSignal) =>
    request<ContextPack>(`${path(id)}/items`, json('POST', input, signal)),
  updateItem: (id: string, itemId: string, input: UpdateContextPackItemInput, signal?: AbortSignal) =>
    request<ContextPack>(`${path(id)}/items/${encodeURIComponent(itemId)}`, json('PATCH', input, signal)),
  removeItem: (id: string, itemId: string, input: ContextPackVersion, signal?: AbortSignal) =>
    request<ContextPack>(`${path(id)}/items/${encodeURIComponent(itemId)}`, json('DELETE', input, signal)),
  reorder: (id: string, input: ReorderContextPackInput, signal?: AbortSignal) =>
    request<ContextPack>(`${path(id)}/reorder`, json('POST', input, signal)),
  compile: (id: string, signal?: AbortSignal) =>
    request<ContextPackCompilation>(`${path(id)}/compile`, json('POST', {}, signal)),
  async export(id: string, format: ContextPackExportFormat, signal?: AbortSignal): Promise<ContextPackExport> {
    let response: Response;
    try {
      response = await fetch(apiUrl(`${path(id)}/export?${toQueryString({ format })}`), {
        signal, credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: format === 'json' ? 'application/json' : 'text/markdown', 'X-Agent-Ops': '1' },
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      throw new ApiError('서버에 연결할 수 없습니다. my-agent-ops가 실행 중인지 확인하고 다시 시도하세요.', 0);
    }
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { error?: string } | null;
      throw new ApiError(failure?.error ?? `요청을 처리하지 못했습니다 (${response.status}). 다시 시도하세요.`, response.status);
    }
    return {
      body: await response.text(), extension: format,
      type: format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
      filename: `agent-ops-${id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100)}.${format}`,
    };
  },
};

export function downloadContextPack(result: ContextPackExport): void {
  const url = URL.createObjectURL(new Blob([result.body], { type: result.type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
