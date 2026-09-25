import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react';
import type { Bootstrap, RunEvent, RunRequest, Settings } from '../../shared/types';
import { api } from '../lib/api';
import { apiUrl } from '../lib/urls';
import { errorMessage } from '../lib/format';
import { useNavigation } from '../lib/navigation';
import { createRefreshQueue } from './refreshQueue';

export type NewRunDraft = Partial<RunRequest>;
export type AppModal =
  | { type: 'session'; id: string }
  | { type: 'run'; id: string }
  | { type: 'compare'; ids: [string, string] }
  | { type: 'new-run'; draft: NewRunDraft }
  | null;
export type AppEvent = { type: 'refresh' } | { type: 'run-event'; runId: string; event: RunEvent };
export type Toast = { id: number; message: string; tone: 'success' | 'error' | 'info' };
export type Connection = 'connecting' | 'connected' | 'reconnecting';

function applyTheme(theme: Settings['theme']) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  try { localStorage.setItem('agent-ops-theme', theme); } catch { /* The server still persists the preference. */ }
}

function useAppState() {
  const navigation = useNavigation();
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [localSyncing, setLocalSyncing] = useState(false);
  const [themeSaving, setThemeSaving] = useState(false);
  const [archiveRevision, setArchiveRevision] = useState(0);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [modal, setModal] = useState<AppModal>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const listeners = useRef(new Set<(event: AppEvent) => void>());
  const refreshQueue = useRef<ReturnType<typeof createRefreshQueue> | null>(null);
  const mounted = useRef(true);
  const theme = data?.settings.theme ?? 'light';
  const syncing = localSyncing || Boolean(data?.syncing);

  const notify = useCallback((message: string, tone: Toast['tone'] = 'success') => {
    setToasts(items => [...items.slice(-3), { id: Date.now() + Math.random(), message, tone }]);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts(items => items.filter(item => item.id !== id)), []);

  if (!refreshQueue.current) {
    refreshQueue.current = createRefreshQueue(async force => {
      if (!mounted.current) return;
      try {
        const result = await api.bootstrap();
        if (!mounted.current) return;
        setData(result);
        setError(null);
        if (force) setArchiveRevision(value => value + 1);
      } catch (cause) {
        if (mounted.current) setError(errorMessage(cause));
      } finally {
        if (mounted.current) setLoading(false);
      }
    });
  }
  const refresh = useCallback((force = false): Promise<void> => {
    setRefreshing(true);
    const queue = refreshQueue.current!;
    return queue.refresh(force).finally(() => {
      if (mounted.current && !queue.isPending()) setRefreshing(false);
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const source = new EventSource(apiUrl('/events'));
    let debounce: number | undefined;
    let polling: number | undefined;
    const scheduleRefresh = (delay: number) => {
      if (debounce !== undefined) return;
      debounce = window.setTimeout(() => { debounce = undefined; void refresh(); }, delay);
    };
    source.onopen = () => {
      setConnection('connected');
      setArchiveRevision(value => value + 1);
      window.clearInterval(polling);
      polling = undefined;
      void refresh();
    };
    source.onerror = () => {
      setConnection('reconnecting');
      if (!polling) polling = window.setInterval(() => { if (!document.hidden) void refresh(true); }, 15_000);
    };
    source.onmessage = message => {
      try {
        const event = JSON.parse(message.data) as AppEvent;
        if (event.type !== 'refresh' && event.type !== 'run-event') return;
        if (event.type === 'refresh') setArchiveRevision(value => value + 1);
        for (const listener of listeners.current) listener(event);
        scheduleRefresh(event.type === 'refresh' ? 200 : 1800);
      } catch { /* Ignore incomplete event frames; reconnection refreshes state. */ }
    };
    const visible = () => { if (!document.hidden) void refresh(true); };
    document.addEventListener('visibilitychange', visible);
    const safetyRefresh = window.setInterval(() => { if (!document.hidden) void refresh(true); }, 60_000);
    return () => {
      mounted.current = false;
      source.close();
      window.clearTimeout(debounce);
      window.clearInterval(polling);
      window.clearInterval(safetyRefresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);

  useEffect(() => {
    if (!data) return;
    applyTheme(theme);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const change = () => applyTheme(theme);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, [theme, !!data]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(value => !value);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);

  const subscribe = useCallback((listener: (event: AppEvent) => void) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);
  const closeModal = useCallback(() => setModal(null), []);
  const openSession = useCallback((id: string) => setModal({ type: 'session', id }), []);
  const openRun = useCallback((id: string) => setModal({ type: 'run', id }), []);
  const openNewRun = useCallback((draft: NewRunDraft = {}) => setModal({ type: 'new-run', draft }), []);
  const openCompare = useCallback((ids: [string, string]) => setModal({ type: 'compare', ids }), []);
  const sync = useCallback(async () => {
    if (syncing) return;
    setLocalSyncing(true);
    try {
      await api.startSync();
      notify('동기화를 시작했습니다. 진행 상태는 자동으로 갱신됩니다.', 'info');
      await refresh(true);
    } catch (cause) { notify(errorMessage(cause), 'error'); }
    finally { setLocalSyncing(false); }
  }, [syncing, notify, refresh]);
  const setTheme = useCallback(async (next: Settings['theme']) => {
    if (themeSaving) return;
    setThemeSaving(true);
    applyTheme(next);
    try {
      const settings = await api.updateSettings({ theme: next });
      setData(previous => previous ? { ...previous, settings } : previous);
      notify('화면 모드를 저장했습니다.');
    } catch (cause) {
      applyTheme(theme);
      notify(errorMessage(cause), 'error');
    } finally { setThemeSaving(false); }
  }, [theme, themeSaving, notify]);

  return {
    ...navigation, data, error, loading, refreshing, refresh, archiveRevision, connection,
    syncing, sync, themeSaving, setTheme, modal, closeModal, openSession, openRun,
    openNewRun, openCompare, paletteOpen, setPaletteOpen, subscribe, notify, toasts, dismissToast,
  };
}

const AppContext = createContext<ReturnType<typeof useAppState> | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const value = useAppState();
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('Agent Ops context is unavailable.');
  return context;
}

export function useData(): Bootstrap {
  const { data } = useApp();
  if (!data) throw new Error('The workspace has not loaded.');
  return data;
}
