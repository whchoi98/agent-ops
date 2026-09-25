import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunDetail, RunEvent } from '../../shared/types';
import { api } from '../lib/api';
import { errorMessage, isActiveRun } from '../lib/format';
import { useApp } from '../state/AppProvider';

export function mergeEvents(previous: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  const events = new Map(previous.map(event => [event.id, event]));
  for (const event of incoming) events.set(event.id, event);
  return [...events.values()].sort((a, b) => a.id - b.id);
}

export function useRunDetail(id: string) {
  const { subscribe } = useApp();
  const [data, setData] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const current = useRef<RunDetail | null>(null);
  const reloadRef = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    let confirmedCursor = 0;
    current.current = null;
    setData(null); setError(null); setLoading(true);
    function apply(next: RunDetail) {
      current.current = next;
      setData(next);
    }
    async function load() {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        const previous = current.current;
        const result = previous
          ? await api.runEvents(id, confirmedCursor, controller.signal)
          : await api.run(id, controller.signal);
        if (controller.signal.aborted) return;
        confirmedCursor = result.events.reduce((cursor, event) => Math.max(cursor, event.id), confirmedCursor);
        apply({ run: result.run, events: mergeEvents(current.current?.events ?? [], result.events) });
        setError(null);
      } catch (cause) {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    reloadRef.current = () => { void load(); };
    void load();
    const unsubscribe = subscribe(event => {
      if (event.type === 'refresh') void load();
      if (event.type === 'run-event' && event.runId === id && current.current) {
        apply({ ...current.current, events: mergeEvents(current.current.events, [event.event]) });
      }
    });
    const timer = window.setInterval(() => {
      if (!document.hidden && (!current.current || isActiveRun(current.current.run.status))) void load();
    }, 2500);
    return () => { controller.abort(); unsubscribe(); window.clearInterval(timer); };
  }, [id, subscribe]);
  const reload = useCallback(() => reloadRef.current(), []);
  return { data, error, loading, reload };
}
