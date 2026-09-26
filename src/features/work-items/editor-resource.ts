import type { Agent } from '../../../shared/types';
import type { WorkItem, WorkItemDetail, WorkItemFields, WorkItemPatch, WorkItemPrepared } from '../../../shared/work-items';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/format';
import {
  createWorkItemDraft, preparedWorkItemDraft, toggleWorkSession, workItemInput, workItemPatch,
  type WorkItemDraft, type WorkSessionReference,
} from './model';
import { workItemsApi } from './api';

export type WorkItemEditorSource = { id: string } | { draft: WorkItemDraft };
export type WorkItemEditorAction = 'save' | 'archive' | 'reopen' | 'delete' | 'prepare';
export interface WorkItemEditorSnapshot {
  draft: WorkItemDraft | null;
  dirty: boolean;
  loading: boolean;
  busy: WorkItemEditorAction | null;
  error: string | null;
  errorStatus: number | null;
  deleted: boolean;
}
export function createWorkItemEditorResource(source: WorkItemEditorSource) {
  const initial = 'draft' in source ? source.draft : null;
  let state: WorkItemEditorSnapshot = {
    draft: initial ? {
      ...initial, fields: { ...initial.fields, sessionIds: [...initial.fields.sessionIds], contextPackIds: [...initial.fields.contextPackIds] },
      sessions: initial.sessions.map(item => ({ ...item })), packs: initial.packs.map(item => ({ ...item })),
    } : null,
    dirty: !!initial, loading: !initial,
    busy: null, error: null, errorStatus: null, deleted: false,
  };
  const listeners = new Set<() => void>();
  let active = false;
  let pending: AbortController | null = null;
  let savedFields: string | null = null;
  function publish(patch: Partial<WorkItemEditorSnapshot>) {
    state = { ...state, ...patch };
    if (active) for (const listener of listeners) listener();
  }
  function accept(item: WorkItem, references = state.draft) {
    const detail: WorkItemDetail = {
      ...item,
      sessions: item.sessionIds.map(id => references?.sessions.find(source => source.id === id)
        ?? { id, title: id, agent: null, available: true }),
      packs: item.contextPackIds.map(id => references?.packs.find(source => source.id === id)
        // Newly attached references were validated by this accepted mutation.
        ?? { id, name: id, available: true }),
    };
    const draft = createWorkItemDraft(detail);
    savedFields = JSON.stringify(draft.fields);
    publish({ draft, dirty: false });
  }
  async function perform<T>(
    kind: WorkItemEditorAction | 'load', action: (signal: AbortSignal) => Promise<T>, accepted?: (result: T) => void,
  ): Promise<T | null> {
    if (!active || pending) return null;
    const controller = new AbortController();
    pending = controller;
    publish({ loading: kind === 'load', busy: kind === 'load' ? null : kind, error: null, errorStatus: null });
    try {
      const result = await action(controller.signal);
      if (!active || pending !== controller || controller.signal.aborted) return null;
      accepted?.(result);
      return result;
    } catch (cause) {
      if (active && pending === controller && !controller.signal.aborted) {
        publish({ error: errorMessage(cause), errorStatus: cause instanceof ApiError ? cause.status : null });
      }
      return null;
    } finally {
      if (pending === controller) {
        pending = null;
        if (active && !controller.signal.aborted) publish({ loading: false, busy: null });
      }
    }
  }
  function editable(): WorkItemDraft | null { return active && !pending ? state.draft : null; }
  function publishDraft(draft: WorkItemDraft) {
    publish({ draft, dirty: !draft.original || savedFields !== JSON.stringify(draft.fields) });
  }
  function requireSaved(draft: WorkItemDraft) {
    if (!draft.original) throw new Error('먼저 작업을 저장하세요.');
    if (state.dirty) throw new Error('저장하지 않은 변경 내용을 먼저 저장하세요.');
    return draft.original;
  }
  function patchState(kind: 'archive' | 'reopen', changes: Partial<WorkItemPatch>): Promise<WorkItem | null> {
    const draft = state.draft;
    if (!draft) return Promise.resolve(null);
    return perform(kind, async signal => {
      const original = requireSaved(draft);
      return workItemsApi.update(original.id, { ...changes, version: original.version }, signal);
    }, item => accept(item, draft));
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start: () => { active = true; },
    stop: () => {
      active = false;
      pending?.abort();
      pending = null;
      state = { ...state, busy: null };
    },
    // Called on first open or by the user's reload action, never from SSE or after a failed write.
    reload: async (): Promise<boolean> => {
      const id = state.draft?.original?.id ?? ('id' in source ? source.id : null);
      if (!id) return false;
      return (await perform('load', signal => workItemsApi.get(id, signal), detail => {
        const draft = createWorkItemDraft(detail);
        savedFields = JSON.stringify(draft.fields);
        publish({ draft, dirty: false, deleted: false });
      })) !== null;
    },
    edit: (fields: Partial<WorkItemFields>) => {
      const draft = editable();
      if (!draft) return;
      publishDraft({
        ...draft, fields: {
          ...draft.fields, ...fields,
          sessionIds: [...(fields.sessionIds ?? draft.fields.sessionIds)],
          contextPackIds: [...(fields.contextPackIds ?? draft.fields.contextPackIds)],
        },
      });
    },
    toggleSession: (source: WorkSessionReference) => {
      const draft = editable();
      if (!draft) return;
      try { publishDraft(toggleWorkSession(draft, source)); }
      catch (cause) { publish({ error: errorMessage(cause), errorStatus: null }); }
    },
    save: (): Promise<WorkItem | null> => {
      const draft = state.draft;
      if (!draft) return Promise.resolve(null);
      return perform('save', signal => draft.original
        ? workItemsApi.update(draft.original.id, workItemPatch(draft), signal)
        : workItemsApi.create(workItemInput(draft), signal), item => accept(item, draft));
    },
    archive: () => patchState('archive', { archived: true }),
    reopen: () => patchState('reopen', {
      archived: false, status: state.draft?.fields.status === 'done' ? 'todo' : state.draft?.fields.status,
    }),
    remove: async (): Promise<boolean> => {
      const draft = state.draft;
      if (!draft) return false;
      return (await perform('delete', async signal => {
        const original = requireSaved(draft);
        return workItemsApi.remove(original.id, original.version, signal);
      }, () => publish({ deleted: true }))) !== null;
    },
    prepare: (agent?: Agent): Promise<WorkItemPrepared['draft'] | null> => {
      const draft = state.draft;
      if (!draft) return Promise.resolve(null);
      return perform('prepare', async signal => {
        const original = requireSaved(draft);
        if (original.archivedAt || draft.fields.status === 'done') throw new Error('실행을 준비하려면 작업을 다시 여세요.');
        return preparedWorkItemDraft(draft, await workItemsApi.prepare(original.id, original.version, agent, signal));
      });
    },
  };
}
