import type { HarnessBinding, HarnessHookPreview, HarnessHookRequest } from '../../../shared/harness';
import { harnessApi } from './api';
import { harnessProblem, previewBlockReason, UNKNOWN_OUTCOME_NOTICE, type HarnessProblem } from './model';

export interface HarnessHookSnapshot {
  request: HarnessHookRequest | null;
  preview: HarnessHookPreview | null;
  busy: 'preview' | 'apply' | null;
  error: HarnessProblem | null;
  needsPreview: boolean;
  applied: HarnessBinding | null;
}
export function createHarnessHookResource(projectId?: string) {
  let state: HarnessHookSnapshot = { request: null, preview: null, busy: null, error: null, needsPreview: false, applied: null };
  const listeners = new Set<() => void>();
  let active = false;
  let pending: AbortController | null = null;
  function publish(patch: Partial<HarnessHookSnapshot>) {
    state = { ...state, ...patch };
    if (active) for (const listener of listeners) listener();
  }
  async function perform<T>(
    kind: 'preview' | 'apply', operation: (signal: AbortSignal) => Promise<T>, accept: (result: T) => void,
  ): Promise<T | null> {
    if (!active || pending) return null;
    const controller = new AbortController();
    pending = controller;
    publish({ busy: kind, error: null });
    try {
      const result = await operation(controller.signal);
      if (!active || pending !== controller || controller.signal.aborted) return null;
      accept(result);
      return result;
    } catch (cause) {
      if (active && pending === controller && !controller.signal.aborted) {
        publish({ error: harnessProblem(cause, kind === 'apply'), needsPreview: true });
      }
      return null;
    } finally {
      if (pending === controller) { pending = null; publish({ busy: null }); }
    }
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: () => { active = true; },
    stop: () => {
      active = false;
      if (pending) {
        pending.abort(); pending = null;
        state = { ...state, busy: null, needsPreview: true, error: { message: UNKNOWN_OUTCOME_NOTICE, unknown: true, status: null } };
      }
    },
    close: () => {
      if (state.busy === 'apply') return;
      pending?.abort(); pending = null;
      publish({ request: null, preview: null, busy: null, error: null, needsPreview: false, applied: null });
    },
    preview: (request: HarnessHookRequest, managed: boolean): Promise<HarnessHookPreview | null> => {
      if (!active || pending) return Promise.resolve(null);
      if (!projectId || request.projectId !== projectId || (request.action === 'remove' && !managed)) {
        publish({ error: {
          message: request.action === 'remove' && !managed ? '앱이 관리하지 않는 외부 훅은 제거할 수 없습니다.' : '훅을 변경할 프로젝트를 선택하세요.',
          status: null, unknown: false,
        } });
        return Promise.resolve(null);
      }
      const sameContext = state.request?.client === request.client && state.request.action === request.action;
      publish({ request, preview: sameContext ? state.preview : null, needsPreview: true, applied: null });
      return perform('preview', signal => harnessApi.previewHook(request, signal), preview => {
        const blocked = previewBlockReason(preview, request, Date.now());
        publish({ preview, needsPreview: !!blocked, error: blocked ? { message: blocked, status: null, unknown: false } : null });
      });
    },
    apply: (): Promise<HarnessBinding | null> => {
      if (!active || pending || !state.preview || !state.request || state.needsPreview || state.applied) return Promise.resolve(null);
      const blocked = previewBlockReason(state.preview, state.request, Date.now());
      if (blocked) {
        publish({ error: { message: blocked, status: null, unknown: false }, needsPreview: true });
        return Promise.resolve(null);
      }
      const preview = state.preview;
      // A request may have succeeded on the server even if its response is lost. Never replay it.
      publish({ needsPreview: true });
      return perform('apply', signal => harnessApi.applyHook(preview.id, projectId!, signal), applied => publish({ applied }));
    },
  };
}
