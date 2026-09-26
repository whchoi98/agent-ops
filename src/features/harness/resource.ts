import { harnessProblem, UNKNOWN_OUTCOME_NOTICE, type HarnessProblem } from './model';

export interface HarnessReadSnapshot<T> { key: string; data: T | null; loading: boolean; error: HarnessProblem | null }

/** Each endpoint owns its read generation; unrelated application refreshes never enter this resource. */
export function createHarnessReadResource<T>() {
  let state: HarnessReadSnapshot<T> = { key: '', data: null, loading: false, error: null };
  const listeners = new Set<() => void>();
  let active = false;
  let pending: AbortController | null = null;
  const publish = (patch: Partial<HarnessReadSnapshot<T>>) => {
    state = { ...state, ...patch };
    if (active) for (const listener of listeners) listener();
  };
  function cancel() { pending?.abort(); pending = null; }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: () => { active = true; },
    stop: () => { active = false; cancel(); state = { ...state, loading: false }; },
    cancel,
    replace: (key: string, data: T) => { cancel(); publish({ key, data, loading: false, error: null }); },
    load: async (key: string, operation: (signal: AbortSignal) => Promise<T>) => {
      if (!active) return;
      cancel();
      const controller = new AbortController();
      pending = controller;
      publish({ key, data: state.key === key ? state.data : null, loading: true, error: null });
      try {
        const data = await operation(controller.signal);
        if (active && pending === controller && !controller.signal.aborted) publish({ data, loading: false, error: null });
      } catch (cause) {
        if (active && pending === controller && !controller.signal.aborted) publish({ loading: false, error: harnessProblem(cause) });
      } finally {
        if (pending === controller) pending = null;
      }
    },
  };
}

export interface HarnessActionSnapshot { busy: boolean; error: HarnessProblem | null }
export function createHarnessActionResource() {
  let state: HarnessActionSnapshot = { busy: false, error: null };
  const listeners = new Set<() => void>();
  let active = false;
  let pending: AbortController | null = null;
  const publish = (patch: Partial<HarnessActionSnapshot>) => {
    state = { ...state, ...patch };
    if (active) for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: () => { active = true; },
    stop: () => {
      active = false;
      if (pending) {
        pending.abort();
        pending = null;
        state = { busy: false, error: { message: UNKNOWN_OUTCOME_NOTICE, status: null, unknown: true } };
      }
    },
    clear: () => { if (!pending) publish({ error: null }); },
    run: async <T,>(operation: (signal: AbortSignal) => Promise<T>, mutation = true): Promise<T | undefined> => {
      if (!active || pending) return undefined;
      const controller = new AbortController();
      pending = controller;
      publish({ busy: true, error: null });
      try {
        const result = await operation(controller.signal);
        return active && pending === controller && !controller.signal.aborted ? result : undefined;
      } catch (cause) {
        if (active && pending === controller && !controller.signal.aborted) publish({ error: harnessProblem(cause, mutation) });
        return undefined;
      } finally {
        if (pending === controller) { pending = null; publish({ busy: false }); }
      }
    },
  };
}
