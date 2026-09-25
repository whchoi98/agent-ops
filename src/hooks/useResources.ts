import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResourceReport } from '../../shared/resources';
import { api } from '../lib/api';
import { errorMessage } from '../lib/format';

/** Polls the cached resource endpoint without refreshing the archive/bootstrap. */
export function useResources() {
  const [data, setData] = useState<ResourceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [paused, setPaused] = useState(false);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    let disposed = false, trailing = false;
    let controller: AbortController | null = null;
    let timer: number | undefined;
    const load = async (manual = false) => {
      if (disposed || document.hidden || paused && !manual) return;
      window.clearTimeout(timer);
      if (controller) { trailing = true; return; }
      const own = new AbortController();
      controller = own;
      let timedOut = false;
      const timeout = window.setTimeout(() => { timedOut = true; own.abort(); }, 8000);
      setRefreshing(true);
      try {
        const result = await api.resources(own.signal);
        if (!disposed && !own.signal.aborted) { setData(result); setError(null); }
      } catch (cause) {
        if (!disposed && (!own.signal.aborted || timedOut)) {
          setError(timedOut ? '자원 정보 요청 시간이 초과되었습니다.' : errorMessage(cause));
        }
      } finally {
        window.clearTimeout(timeout);
        if (controller === own) controller = null;
        if (!disposed) {
          setRefreshing(false);
          if (!document.hidden && !paused) {
            if (trailing) { trailing = false; void load(); }
            else timer = window.setTimeout(() => { void load(); }, 5000);
          }
        }
      }
    };
    const visible = () => {
      window.clearTimeout(timer);
      if (document.hidden) { trailing = false; controller?.abort(); }
      else if (!paused) void load();
    };
    refreshRef.current = () => { void load(true); };
    document.addEventListener('visibilitychange', visible);
    setRefreshing(false);
    if (!paused) void load();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', visible);
      refreshRef.current = () => {};
    };
  }, [paused]);
  return { data, error, refreshing, paused, setPaused, refresh };
}
