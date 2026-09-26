import type {
  HarnessAuditPage, HarnessAuditQuery, HarnessBinding, HarnessCatalog, HarnessDecision, HarnessEvaluationRequest,
  HarnessHookPreview, HarnessHookRequest, HarnessPolicyDetail, HarnessRuntime, HarnessSettings, HarnessValidation,
} from '../../../shared/harness';
import { ApiError, request } from '../../lib/api';
import { toQueryString } from '../../lib/query';

export type HarnessValidationInput = { projectId?: string } & (
  { policyId: string; revision: string; content?: never } | { content: string; policyId?: never; revision?: never }
);
export interface HarnessPolicyInput { projectId?: string; content: string; expectedRevision: string | null }

async function boundedRequest<T>(path: string, init: RequestInit = {}, deadline = 15000): Promise<T> {
  const controller = new AbortController();
  const parent = init.signal;
  const abort = () => controller.abort();
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadline);
  try { return await request<T>(path, { ...init, signal: controller.signal }); }
  catch (cause) {
    if (timedOut) throw new ApiError('하니스 요청 시간이 초과되었습니다. 서버 처리 결과를 확인한 뒤 다시 시도하세요.', 408);
    throw cause;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  }
}
const json = (method: string, body: object, signal?: AbortSignal): RequestInit => ({ method, body: JSON.stringify(body), signal });
const base = '/harness';
export const harnessApi = {
  catalog: (projectId?: string, signal?: AbortSignal) =>
    boundedRequest<HarnessCatalog>(`${base}?${toQueryString({ projectId })}`, { signal }),
  refresh: (projectId?: string, signal?: AbortSignal) =>
    boundedRequest<HarnessCatalog>(`${base}/refresh`, json('POST', { projectId }, signal)),
  saveSettings: (settings: HarnessSettings, signal?: AbortSignal) =>
    boundedRequest<HarnessSettings>(`${base}/settings`, json('PATCH', settings, signal)),
  // Probes always use saved settings. Typing a Python path must never execute it.
  probe: (signal?: AbortSignal) =>
    boundedRequest<HarnessRuntime>(`${base}/runtime/check`, json('POST', {}, signal), 30000),
  policy: (policyId: string, projectId?: string, signal?: AbortSignal) =>
    boundedRequest<HarnessPolicyDetail>(`${base}/policies/${encodeURIComponent(policyId)}?${toQueryString({ projectId })}`, { signal }),
  validate: (input: HarnessValidationInput, signal?: AbortSignal) =>
    boundedRequest<HarnessValidation>(`${base}/policies/validate`, json('POST', input, signal)),
  savePolicy: (input: HarnessPolicyInput, signal?: AbortSignal) =>
    boundedRequest<HarnessPolicyDetail>(`${base}/policies/managed`, json('PUT', input, signal)),
  evaluate: (input: HarnessEvaluationRequest, signal?: AbortSignal) =>
    boundedRequest<HarnessDecision>(`${base}/evaluate`, json('POST', input, signal), 30000),
  previewHook: (input: HarnessHookRequest, signal?: AbortSignal) =>
    boundedRequest<HarnessHookPreview>(`${base}/hooks/preview`, json('POST', input, signal)),
  applyHook: (previewId: string, projectId: string, signal?: AbortSignal) =>
    boundedRequest<HarnessBinding>(`${base}/hooks/apply`, json('POST', { previewId, projectId }, signal)),
  audit: (query: HarnessAuditQuery = {}, signal?: AbortSignal) =>
    boundedRequest<HarnessAuditPage>(`${base}/audit?${toQueryString(query)}`, { signal }),
};
