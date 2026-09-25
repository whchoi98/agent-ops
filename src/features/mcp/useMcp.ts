import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { McpCatalog, McpCheck } from '../../../shared/mcp';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/format';
import { mcpApi } from './api';
import type { McpAction } from './model';
import { pollMcpCheck, updateCheckState } from './polling';

export function useMcpVisibility() {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', change);
    change();
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  return visible;
}

/** Passive reads resume on visibility; mutations are never replayed. */
export function useMcpResource<T>(key: string, loader: (signal: AbortSignal) => Promise<T>, visible: boolean) {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; data: T | null; loading: boolean; error: string | null }>({
    key, data: null, loading: true, error: null,
  });
  useEffect(() => {
    if (!visible) {
      setState(previous => ({ ...previous, loading: false }));
      return;
    }
    const controller = new AbortController();
    setState(previous => ({ key, data: previous.key === key ? previous.data : null, loading: true, error: null }));
    void loaderRef.current(controller.signal).then(data => {
      if (!controller.signal.aborted) setState({ key, data, loading: false, error: null });
    }).catch(cause => {
      if (!controller.signal.aborted) setState(previous => ({ ...previous, loading: false, error: errorMessage(cause) }));
    });
    return () => controller.abort();
  }, [key, revision, visible]);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  const replaceData = useCallback((data: T) => setState({ key, data, loading: false, error: null }), [key]);
  return {
    data: state.key === key ? state.data : null,
    loading: visible && (state.loading || state.key !== key),
    error: state.key === key ? state.error : null,
    reload, replaceData,
  };
}

export function useMcpAction(visible: boolean) {
  const attempt = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const [busy, setBusy] = useState<McpAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedAction, setFailedAction] = useState<McpAction | null>(null);
  useEffect(() => {
    mounted.current = true;
    setBusy(null);
    return () => {
      mounted.current = false;
      attempt.current?.abort();
      attempt.current = null;
    };
  }, [visible]);
  const run = useCallback(async <T,>(name: McpAction, operation: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
    if (!visible || document.hidden || attempt.current || !mounted.current) return undefined;
    const controller = new AbortController();
    attempt.current = controller;
    setBusy(name); setError(null); setFailedAction(null);
    try {
      const result = await operation(controller.signal);
      return controller.signal.aborted || !mounted.current ? undefined : result;
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) { setError(errorMessage(cause)); setFailedAction(name); }
      return undefined;
    } finally {
      if (attempt.current === controller) {
        attempt.current = null;
        if (mounted.current) setBusy(null);
      }
    }
  }, [visible]);
  return { busy, error, failedAction, run };
}

/** The page owns the single observer, so closing a detail dialog never duplicates polling. */
export function useMcpChecks(catalog: McpCatalog | null, visible: boolean, onCatalogReload: () => void) {
  const [state, dispatch] = useReducer(updateCheckState, { active: null, result: null });
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const completed = useRef<string | null>(null);
  const accept = useCallback((result: McpCheck) => dispatch({ type: 'result', result }), []);
  const retry = useCallback(() => { setError(null); setRevision(value => value + 1); }, []);
  useEffect(() => { dispatch({ type: 'catalog', active: catalog?.activeCheck ?? null }); }, [catalog]);
  const activeId = state.active?.id;
  useEffect(() => {
    if (!state.active || !visible) return;
    setError(null);
    return pollMcpCheck(state.active, {
      read: mcpApi.getCheck, onResult: accept,
      onError: (message, cause) => {
        setError(message);
        if (cause instanceof ApiError && cause.status === 404) {
          dispatch({ type: 'forget', id: state.active!.id });
          onCatalogReload();
        }
      },
    });
  }, [activeId, visible, revision, accept, onCatalogReload]);
  useEffect(() => {
    if (!state.result || state.result.status === 'running' || completed.current === state.result.id) return;
    completed.current = state.result.id;
    onCatalogReload();
  }, [state.result, onCatalogReload]);
  return { ...state, error, accept, retry };
}
