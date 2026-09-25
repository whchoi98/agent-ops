import { lazy, Suspense } from 'react';
import { RefreshCw } from 'lucide-react';
import { AppProvider, useApp } from './state/AppProvider';
import { Shell } from './components/Shell';
import { CommandPalette } from './components/CommandPalette';
import { Button, EmptyState, Skeleton, Toasts } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Overview } from './pages/Overview';
import { Sessions } from './pages/Sessions';
import { Runs } from './pages/Runs';
import { Projects } from './pages/Projects';
import { Analytics } from './pages/Analytics';
import { Templates } from './pages/Templates';
import { Extensions } from './pages/Extensions';
import { Settings } from './pages/Settings';
import { I18nProvider, useI18n, Trans } from './i18n/I18nProvider';

const SessionDetailDialog = lazy(() => import('./features/sessions/SessionDetail').then(module => ({ default: module.SessionDetailDialog })));
const CompareDialog = lazy(() => import('./features/sessions/CompareDialog').then(module => ({ default: module.CompareDialog })));
const NewRunDialog = lazy(() => import('./features/runs/NewRunDialog').then(module => ({ default: module.NewRunDialog })));
const RunDetailDialog = lazy(() => import('./features/runs/RunDetailDialog').then(module => ({ default: module.RunDetailDialog })));

function WorkspaceContent() {
  const { t, notice } = useI18n();
  const { data, error, refreshing, refresh, page } = useApp();
  if (!data && error) return <div className="panel connection-error"><EmptyState icon={RefreshCw} title={t("워크스페이스를 불러오지 못했습니다")}
    description={notice(error)} action={<Button variant="primary" icon={RefreshCw} busy={refreshing} onClick={() => void refresh()}><Trans message={"다시 연결"} /></Button>} /></div>;
  if (!data) return <div className="workspace-skeleton" aria-label={t("워크스페이스 불러오는 중")}>
    <Skeleton rows={2} /><div className="stats-grid">{[0, 1, 2, 3].map(index => <div className="panel" key={index}><Skeleton rows={3} /></div>)}</div>
    <div className="panel"><Skeleton rows={5} /></div><div className="panel"><Skeleton rows={6} /></div>
  </div>;
  switch (page) {
    case 'sessions': return <Sessions />;
    case 'runs': return <Runs />;
    case 'projects': return <Projects />;
    case 'analytics': return <Analytics />;
    case 'templates': return <Templates />;
    case 'extensions': return <Extensions />;
    case 'settings': return <Settings />;
    default: return <Overview />;
  }
}

function ModalHost() {
  const { data, modal } = useApp();
  if (!data || !modal) return null;
  return <Suspense fallback={<div className="modal-loading" role="status"><Trans message={"화면 불러오는 중…"} /></div>}>
    {modal.type === 'session' ? <SessionDetailDialog id={modal.id} key={`session-${modal.id}`} />
      : modal.type === 'run' ? <RunDetailDialog id={modal.id} key={`run-${modal.id}`} />
        : modal.type === 'compare' ? <CompareDialog ids={modal.ids} />
          : <NewRunDialog draft={modal.draft} />}
  </Suspense>;
}

function AppWorkspace() {
  const { paletteOpen, page } = useApp();
  return <>
    <Shell><ErrorBoundary key={page}><WorkspaceContent /></ErrorBoundary></Shell>
    <ErrorBoundary><ModalHost />{paletteOpen && <CommandPalette />}</ErrorBoundary><Toasts />
  </>;
}

export default function App() {
  return <I18nProvider><ErrorBoundary><AppProvider><AppWorkspace /></AppProvider></ErrorBoundary></I18nProvider>;
}
