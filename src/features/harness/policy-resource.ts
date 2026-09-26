import type { HarnessPolicyDetail, HarnessPolicySummary, HarnessValidation } from '../../../shared/harness';
import { harnessApi } from './api';
import { HARNESS_TEXT_LIMIT, harnessProblem, isEditablePolicy, textBytes, UNKNOWN_OUTCOME_NOTICE, type HarnessProblem } from './model';

export interface HarnessPolicyDraft {
  content: string;
  expectedRevision: string | null;
  baseContent: string;
}
export interface HarnessPolicySnapshot {
  selectedId: string | null;
  detail: HarnessPolicyDetail | null;
  draft: HarnessPolicyDraft | null;
  loading: boolean;
  busy: 'save' | 'validate' | null;
  error: HarnessProblem | null;
  validation: HarnessValidation | null;
  saved: boolean;
}
export const policyDirty = (draft: HarnessPolicyDraft | null) =>
  !!draft && (draft.expectedRevision === null || draft.content !== draft.baseContent);

/** A controller belongs to exactly one project scope. Drafts survive selection and catalog changes. */
export function createHarnessPolicyResource(projectId?: string) {
  let state: HarnessPolicySnapshot = {
    selectedId: null, detail: null, draft: null, loading: false, busy: null, error: null, validation: null, saved: false,
  };
  let policies: HarnessPolicySummary[] = [];
  const drafts = new Map<string, HarnessPolicyDraft>();
  const details = new Map<string, HarnessPolicyDetail>();
  const listeners = new Set<() => void>();
  let active = false;
  let reading: AbortController | null = null;
  let writing: AbortController | null = null;
  function publish(patch: Partial<HarnessPolicySnapshot>) {
    state = { ...state, ...patch };
    if (active) for (const listener of listeners) listener();
  }
  function storeDraft(draft: HarnessPolicyDraft) {
    if (state.selectedId) drafts.set(state.selectedId, draft);
    publish({ draft });
  }
  function acceptRead(detail: HarnessPolicyDetail) {
    if (state.selectedId) details.set(state.selectedId, detail);
    let draft = state.draft;
    if (!draft && isEditablePolicy(detail, projectId)) {
      draft = { content: detail.content, expectedRevision: detail.revision, baseContent: detail.content };
      if (state.selectedId) drafts.set(state.selectedId, draft);
    }
    publish({ detail, draft, loading: false });
  }
  async function load(id: string): Promise<boolean> {
    if (!active || writing) return false;
    reading?.abort();
    const controller = new AbortController();
    reading = controller;
    publish({ loading: true, error: null });
    try {
      const detail = await harnessApi.policy(id, projectId, controller.signal);
      if (!active || reading !== controller || controller.signal.aborted) return false;
      acceptRead(detail);
      return true;
    } catch (cause) {
      if (active && reading === controller && !controller.signal.aborted) publish({ error: harnessProblem(cause), loading: false });
      return false;
    } finally {
      if (reading === controller) reading = null;
    }
  }
  async function select(id: string): Promise<boolean> {
    if (!active || writing) return false;
    reading?.abort(); reading = null;
    publish({
      selectedId: id, detail: details.get(id) ?? null, draft: drafts.get(id) ?? null,
      error: null, validation: null, saved: false,
    });
    return load(id);
  }
  async function perform<T>(
    action: 'save' | 'validate', operation: (signal: AbortSignal) => Promise<T>, accept: (result: T) => void,
  ): Promise<T | null> {
    if (!active || writing || reading) return null;
    const controller = new AbortController();
    writing = controller;
    publish({ busy: action, error: null, saved: false });
    try {
      const result = await operation(controller.signal);
      if (!active || writing !== controller || controller.signal.aborted) return null;
      accept(result);
      return result;
    } catch (cause) {
      if (active && writing === controller && !controller.signal.aborted) publish({ error: harnessProblem(cause, action === 'save') });
      return null;
    } finally {
      if (writing === controller) { writing = null; publish({ busy: null }); }
    }
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: () => { active = true; },
    stop: () => {
      active = false;
      reading?.abort(); reading = null;
      if (writing) {
        writing.abort(); writing = null;
        state = { ...state, error: { message: UNKNOWN_OUTCOME_NOTICE, unknown: true, status: null } };
      }
      state = { ...state, loading: false, busy: null };
    },
    setPolicies: (next: HarnessPolicySummary[]) => { policies = next; },
    select,
    newPolicy: () => {
      if (!active || writing) return;
      const existing = policies.find(item => item.scope === 'managed' && item.projectId === (projectId ?? null));
      if (existing) { void select(existing.id); return; }
      reading?.abort(); reading = null;
      const draft = drafts.get('new') ?? { content: '', expectedRevision: null, baseContent: '' };
      drafts.set('new', draft);
      publish({ selectedId: 'new', detail: null, draft, loading: false, error: null, validation: null, saved: false });
    },
    edit: (content: string) => {
      if (!active || writing || !state.draft || content.length > HARNESS_TEXT_LIMIT) return;
      if (state.detail && !isEditablePolicy(state.detail, projectId)) return;
      storeDraft({ ...state.draft, content });
      publish({ validation: null, saved: false });
    },
    // A read never replaces draft text or changes the revision a subsequent write will use.
    reload: (): Promise<boolean> => {
      const id = state.selectedId === 'new'
        ? policies.find(item => item.scope === 'managed' && item.projectId === (projectId ?? null))?.id : state.selectedId;
      return id ? load(id) : Promise.resolve(false);
    },
    adoptRevision: () => {
      if (!active || reading || writing || !state.draft || !state.detail || !isEditablePolicy(state.detail, projectId)) return;
      const draft = { ...state.draft, expectedRevision: state.detail.revision, baseContent: state.detail.content };
      if (state.selectedId === 'new') drafts.delete('new');
      publish({ selectedId: state.detail.id, validation: null, error: null, saved: false });
      storeDraft(draft);
    },
    save: (): Promise<HarnessPolicyDetail | null> => {
      const draft = state.draft;
      if (!draft || (state.detail && !isEditablePolicy(state.detail, projectId))) return Promise.resolve(null);
      return perform('save', signal => {
        if (textBytes(draft.content) > HARNESS_TEXT_LIMIT) throw new Error('정책은 UTF-8 기준 64 KiB 이하여야 합니다.');
        if (!draft.content.trim()) throw new Error('저장할 정책 내용을 입력하세요.');
        return harnessApi.savePolicy({ projectId, content: draft.content, expectedRevision: draft.expectedRevision }, signal);
      }, detail => {
        if (state.selectedId === 'new') drafts.delete('new');
        const next = isEditablePolicy(detail, projectId)
          ? { content: detail.content, expectedRevision: detail.revision, baseContent: detail.content } : null;
        if (next) drafts.set(detail.id, next);
        else drafts.delete(detail.id);
        details.set(detail.id, detail);
        publish({ selectedId: detail.id, detail, draft: next, validation: null, saved: true });
      });
    },
    validate: (): Promise<HarnessValidation | null> => {
      const { draft, detail } = state;
      if (!draft && !detail) return Promise.resolve(null);
      return perform('validate', signal => {
        if (draft) {
          if (textBytes(draft.content) > HARNESS_TEXT_LIMIT) throw new Error('정책은 UTF-8 기준 64 KiB 이하여야 합니다.');
          return harnessApi.validate({ projectId, content: draft.content }, signal);
        }
        return harnessApi.validate({ projectId, policyId: detail!.id, revision: detail!.revision }, signal);
      }, validation => publish({ validation }));
    },
  };
}
