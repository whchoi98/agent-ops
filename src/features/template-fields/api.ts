import type { TemplateInput, TemplatePatch, TemplateRevision, TemplateValues } from '../../../shared/template-fields';
import { request } from '../../lib/api';

const path = (id: string) => `/templates/${encodeURIComponent(id)}`;
const json = (method: string, body: unknown, signal?: AbortSignal): RequestInit => ({
  method, body: JSON.stringify(body), signal,
});

export const templateFieldsApi = {
  create: (input: TemplateInput, signal?: AbortSignal) =>
    request<TemplateRevision>('/templates', json('POST', input, signal)),
  update: (id: string, input: TemplatePatch, signal?: AbortSignal) =>
    request<TemplateRevision>(path(id), json('PATCH', input, signal)),
  history: (id: string, signal?: AbortSignal) =>
    request<TemplateRevision[]>(`${path(id)}/history`, { signal }),
  restore: (id: string, revision: number, expectedRevision: number, signal?: AbortSignal) =>
    request<TemplateRevision>(`${path(id)}/restore`, json('POST', { revision, expectedRevision }, signal)),
  render: (id: string, values: TemplateValues, signal?: AbortSignal) =>
    request<{ prompt: string }>(`${path(id)}/render`, json('POST', { values }, signal)),
};
