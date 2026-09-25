import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/format';

export function useResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  key: string,
  keepPrevious = false,
) {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({
    data: null, loading: true, error: null,
  });
  useEffect(() => {
    const controller = new AbortController();
    setState(previous => ({ data: keepPrevious ? previous.data : null, loading: true, error: null }));
    loaderRef.current(controller.signal).then(data => {
      if (!controller.signal.aborted) setState({ data, loading: false, error: null });
    }).catch(error => {
      if (!controller.signal.aborted) setState(previous => ({ ...previous, loading: false, error: errorMessage(error) }));
    });
    return () => controller.abort();
  }, [key, version, keepPrevious]);
  const reload = useCallback(() => setVersion(value => value + 1), []);
  const replaceData = useCallback((data: T) => setState({ data, loading: false, error: null }), []);
  return { ...state, reload, replaceData };
}

export function useDebounced<T>(value: T, delay = 280) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timeout);
  }, [value, delay]);
  return debounced;
}

export function useNow(enabled: boolean, interval = 1000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(timer);
  }, [enabled, interval]);
  return now;
}
