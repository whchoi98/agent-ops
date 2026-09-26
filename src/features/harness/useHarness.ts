import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createHarnessActionResource, createHarnessReadResource } from './resource';
import { createHarnessCatalogResource } from './catalog-resource';

export function useHarnessCatalog(projectId?: string) {
  const resource = useMemo(() => createHarnessCatalogResource(), []);
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  useEffect(() => { resource.start(); return resource.stop; }, [resource]);
  useEffect(() => {
    void resource.load(projectId);
    return resource.cancel;
  }, [resource, projectId]);
  const reload = useCallback(() => resource.load(projectId), [resource, projectId]);
  const refresh = useCallback(() => resource.load(projectId, true), [resource, projectId]);
  const matches = state.projectId === (projectId ?? null);
  return {
    data: matches ? state.data : null, global: state.global,
    loading: state.loading || !matches, error: matches ? state.error : null,
    reload, refresh, acceptSettings: resource.acceptSettings, acceptRuntime: resource.acceptRuntime,
    acceptPolicy: resource.acceptPolicy, acceptBinding: resource.acceptBinding,
  };
}

export function useHarnessRead<T>(key: string, loader: (signal: AbortSignal) => Promise<T>) {
  const resource = useMemo(() => createHarnessReadResource<T>(), []);
  const latestLoader = useRef(loader);
  latestLoader.current = loader;
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  useEffect(() => { resource.start(); return resource.stop; }, [resource]);
  useEffect(() => {
    void resource.load(key, signal => latestLoader.current(signal));
    return resource.cancel;
  }, [resource, key]);
  const reload = useCallback(() => { void resource.load(key, signal => latestLoader.current(signal)); }, [resource, key]);
  const replace = useCallback((data: T) => resource.replace(key, data), [resource, key]);
  return {
    data: state.key === key ? state.data : null,
    loading: state.loading || state.key !== key,
    error: state.key === key ? state.error : null,
    reload, replace,
  };
}

export function useHarnessAction(key = '') {
  const resource = useMemo(() => createHarnessActionResource(), [key]);
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  useEffect(() => { resource.start(); return resource.stop; }, [resource]);
  return { ...state, run: resource.run, clear: resource.clear };
}
