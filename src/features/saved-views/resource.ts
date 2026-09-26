import type { CreateSavedView, SavedView, UpdateSavedView } from '../../../shared/saved-views';
import { errorMessage } from '../../lib/format';
import { savedViewsApi } from './api';

export interface SavedViewsSnapshot {
  views: SavedView[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  writeError: string | null;
}

/** One metadata read and one explicit write at most; no saved session searches. */
export function createSavedViewsResource() {
  let state: SavedViewsSnapshot = { views: [], loading: true, saving: false, error: null, writeError: null };
  const listeners = new Set<() => void>();
  let active = false;
  let read: AbortController | null = null;
  let write: AbortController | null = null;

  function publish(patch: Partial<SavedViewsSnapshot>) {
    state = { ...state, ...patch };
    if (active) for (const listener of listeners) listener();
  }
  async function reload(): Promise<void> {
    // The mutation's final reload also satisfies revisions received during the write.
    if (!active || write) return;
    read?.abort();
    const controller = new AbortController();
    read = controller;
    publish({ loading: true, error: null });
    try {
      const result = await savedViewsApi.list(controller.signal);
      if (active && read === controller && !controller.signal.aborted) publish({ views: result.items });
    } catch (cause) {
      if (active && read === controller && !controller.signal.aborted) publish({ error: errorMessage(cause) });
    } finally {
      if (active && read === controller && !controller.signal.aborted) {
        read = null;
        publish({ loading: false });
      }
    }
  }
  function upsert(view: SavedView): SavedView[] {
    return [...state.views.filter(item => item.id !== view.id), view].sort((left, right) =>
      Number(right.pinned) - Number(left.pinned)
      || (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }
  async function mutate<T>(
    action: (signal: AbortSignal) => Promise<T>, accepted: (result: T) => SavedView[],
  ): Promise<T | null> {
    if (!active || write) return null;
    read?.abort();
    read = null;
    const controller = new AbortController();
    write = controller;
    publish({ saving: true, loading: false, writeError: null });
    try {
      const result = await action(controller.signal);
      if (!active || write !== controller || controller.signal.aborted) return null;
      publish({ views: accepted(result) });
      return result;
    } catch (cause) {
      if (active && write === controller && !controller.signal.aborted) publish({ writeError: errorMessage(cause) });
      return null;
    } finally {
      if (write === controller) {
        write = null;
        if (active && !controller.signal.aborted) {
          publish({ saving: false });
          // Reconcile successes, conflicts, and ambiguous transport failures with a bounded GET.
          // Never automatically replay a mutation or discard the user's edit draft.
          void reload();
        }
      }
    }
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
      read?.abort();
      write?.abort();
      read = null;
      write = null;
      state = { ...state, saving: false };
    },
    reload,
    clearWriteError: () => publish({ writeError: null }),
    create: (input: CreateSavedView) => mutate(signal => savedViewsApi.create(input, signal), upsert),
    update: (id: string, input: UpdateSavedView) => mutate(signal => savedViewsApi.update(id, input, signal), upsert),
    remove: async (id: string, version: number) =>
      (await mutate(signal => savedViewsApi.remove(id, version, signal), () => state.views.filter(view => view.id !== id))) !== null,
  };
}
