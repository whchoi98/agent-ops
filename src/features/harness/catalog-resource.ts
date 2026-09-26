import type {
  HarnessBinding, HarnessCatalog, HarnessClient, HarnessPolicyDetail, HarnessRuntime, HarnessSettings,
} from '../../../shared/harness';
import { harnessApi } from './api';
import { harnessProblem, TESTED_ENGINE_VERSION, type HarnessProblem } from './model';

type GlobalEvidence = Pick<HarnessCatalog, 'runtime' | 'settings' | 'demo'>;
interface HarnessCatalogSnapshot {
  projectId: string | null;
  data: HarnessCatalog | null;
  global: GlobalEvidence | null;
  loading: boolean;
  error: HarnessProblem | null;
}
const globalEvidence = ({ runtime, settings, demo }: HarnessCatalog): GlobalEvidence => ({ runtime, settings, demo });
const unchecked = (): HarnessRuntime => ({
  state: 'unchecked', pythonPath: null, pythonVersion: null, engineVersion: null,
  testedVersion: TESTED_ENGINE_VERSION, checkedAt: null, error: null,
});

/** Catalog GETs, explicit refreshes and accepted mutations share one ordering boundary. */
export function createHarnessCatalogResource() {
  let state: HarnessCatalogSnapshot = { projectId: null, data: null, global: null, loading: false, error: null };
  const listeners = new Set<() => void>();
  let active = false;
  let generation = 0;
  let pending: AbortController | null = null;
  function publish(patch: Partial<HarnessCatalogSnapshot>) {
    state = { ...state, ...patch };
    if (active) for (const listener of listeners) listener();
  }
  function invalidate() {
    generation++;
    pending?.abort();
    pending = null;
  }
  async function load(projectId?: string, refresh = false): Promise<HarnessCatalog | null> {
    if (!active) return null;
    invalidate();
    const started = generation;
    const scope = projectId ?? null;
    const controller = new AbortController();
    pending = controller;
    publish({ projectId: scope, data: state.projectId === scope ? state.data : null, loading: true, error: null });
    try {
      const result = await (refresh ? harnessApi.refresh(projectId, controller.signal) : harnessApi.catalog(projectId, controller.signal));
      if (!active || generation !== started || controller.signal.aborted) return null;
      if (result.projectId !== scope) throw new Error('하니스 요청을 처리하지 못했습니다.');
      // A request begun after the last mutation is authoritative, including an unchecked
      // runtime after a service restart. checkedAt is evidence, not an ordering token.
      publish({ data: result, global: globalEvidence(result), loading: false });
      return result;
    } catch (cause) {
      if (active && generation === started && !controller.signal.aborted) {
        publish({ loading: false, error: harnessProblem(cause) });
      }
      return null;
    } finally {
      if (pending === controller) pending = null;
    }
  }
  function commit(data: HarnessCatalog | null, global = state.global) {
    invalidate();
    publish({ data, global, loading: false, error: null });
    // A global mutation can finish while a new scope has no catalog yet. Obtain a fresh
    // local GET in that case; never replay the invalidated POST or any mutation.
    if (!data) void load(state.projectId ?? undefined);
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: () => { active = true; },
    stop: () => { active = false; invalidate(); state = { ...state, loading: false }; },
    cancel: () => { invalidate(); publish({ loading: false }); },
    load,
    acceptSettings: (settings: HarnessSettings): boolean => {
      if (!active || state.global && state.global.settings.revision > settings.revision) return false;
      const runtime = state.global?.settings.pythonPath === settings.pythonPath ? state.global.runtime : unchecked();
      const global = { settings, runtime, demo: state.global?.demo ?? false };
      commit(state.data ? { ...state.data, settings, runtime } : null, global);
      return true;
    },
    acceptRuntime: (runtime: HarnessRuntime, settingsRevision: number): boolean => {
      if (!active || state.global?.settings.revision !== settingsRevision) return false;
      commit(state.data ? { ...state.data, runtime } : null, { ...state.global, runtime });
      return true;
    },
    acceptPolicy: (detail: HarnessPolicyDetail): boolean => {
      if (!active || detail.projectId !== state.projectId) return false;
      let data = state.data;
      if (data) {
        const present = data.policies.some(item => item.id === detail.id);
        const policies = present ? data.policies.map(item => item.id === detail.id ? detail : item) : [...data.policies, detail];
        data = { ...data, policies };
      }
      commit(data);
      return true;
    },
    acceptBinding: (binding: HarnessBinding): boolean => {
      if (!active || binding.projectId !== state.projectId) return false;
      let data = state.data;
      if (data) {
        const affected: HarnessClient[] = binding.client.startsWith('kiro') ? ['kiro-ide', 'kiro-cli'] : [binding.client];
        const bindings = data.bindings.map(item => affected.includes(item.client) ? {
          ...item, state: binding.state, managed: binding.managed, path: binding.path, scope: binding.scope,
          policyRevision: binding.policyRevision, lastObservedAt: binding.lastObservedAt,
        } : item);
        if (!bindings.some(item => item.client === binding.client)) bindings.push(binding);
        data = { ...data, bindings };
      }
      commit(data);
      return true;
    },
  };
}
