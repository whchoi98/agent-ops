import {
  ArrowUpRight, BarChart3, BookOpen, ChevronRight, Command, FlaskConical, FolderKanban,
  LayoutDashboard, Menu, MessageSquare, Moon, Play, Plus, Puzzle, RefreshCw, Search, Settings2,
  ShieldCheck, Sun, type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { PAGE_NAMES, type Page } from '../lib/navigation';
import { compactNumber, isActiveRun } from '../lib/format';
import { useApp } from '../state/AppProvider';
import { Dialog } from './Dialog';
import { Button, IconButton, InlineNotice } from './ui';
import { LanguageToggle, useI18n, Trans } from '../i18n/I18nProvider';

export const NAV_ITEMS: Array<{ page: Page; label: string; english: string; icon: LucideIcon }> = [
  { page: 'overview', label: '개요', english: 'Overview', icon: LayoutDashboard },
  { page: 'sessions', label: '세션', english: 'Sessions', icon: MessageSquare },
  { page: 'runs', label: '실행', english: 'Runs', icon: Play },
  { page: 'projects', label: '프로젝트', english: 'Projects', icon: FolderKanban },
  { page: 'analytics', label: '분석', english: 'Analytics', icon: BarChart3 },
  { page: 'templates', label: '템플릿', english: 'Templates', icon: BookOpen },
  { page: 'extensions', label: '스킬·플러그인', english: 'Extensions', icon: Puzzle },
  { page: 'settings', label: '설정', english: 'Settings', icon: Settings2 },
];
const SEARCH_SHORTCUT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';

export function Brand() {
  return <div className="brand">
    <span className="brand-mark" aria-hidden><svg width="31" height="31" viewBox="0 0 32 32" fill="none">
      <rect x="4" y="5" width="5" height="22" rx="2" fill="#73d9cc" />
      <rect x="13.5" y="10" width="5" height="17" rx="2" fill="white" />
      <rect x="23" y="5" width="5" height="22" rx="2" fill="#aebdff" />
      <path d="M9 16H13.5M18.5 16H23" stroke="white" strokeWidth="2" />
    </svg></span><span className="brand-text">my-agent-ops<span>LOCAL WORKSPACE</span></span>
  </div>;
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { language, t } = useI18n();
  const { page, data, connection, setPaletteOpen } = useApp();
  const activeRuns = data?.runs.filter(run => isActiveRun(run.status)).length ?? 0;
  return <>
    <Brand />
    <div className="workspace-label"><span className="workspace-avatar">W</span><div><Trans message={"내 워크스페이스"} /><small>Personal workspace</small></div>
      <ShieldCheck size={15} aria-hidden />
    </div>
    <nav aria-label={t("주요 메뉴")} className="main-nav">
      <span className="nav-caption"><Trans message={"워크스페이스"} /></span>
      {NAV_ITEMS.map(({ page: item, label, english, icon: Icon }, index) => <div key={item}>
        {index === 4 && <span className="nav-caption nav-caption-secondary"><Trans message={"분석 및 관리"} /></span>}
        <a href={`#/${item}`} onClick={onNavigate} className={`nav-item ${page === item ? 'nav-active' : ''}`}
          aria-current={page === item ? 'page' : undefined}>
          <Icon size={18} strokeWidth={page === item ? 2.1 : 1.7} aria-hidden /><span>{language === 'en' ? english : label}</span>
          {item === 'sessions' && !!data?.sessionTotal && <span className="nav-count">{compactNumber(data.sessionTotal)}</span>}
          {item === 'runs' && activeRuns > 0 && <span className="nav-count nav-count-live">{activeRuns}</span>}
        </a>
      </div>)}
    </nav>
    <div className="sidebar-bottom">
      <button className="sidebar-shortcut" onClick={() => { onNavigate?.(); setPaletteOpen(true); }}>
        <Command size={17} aria-hidden /><span><Trans message={"빠른 이동"} /></span><kbd>{SEARCH_SHORTCUT}</kbd>
      </button>
      <div className="local-workspace-card">
        <div><ShieldCheck size={16} aria-hidden /><strong><Trans message={"내 컴퓨터에 보관"} /></strong></div>
        <p><Trans message={"대화와 작업 기록을 한곳에서."} /></p>
        <span className="sidebar-connection"><i className={connection === 'connected' ? 'connection-on' : ''} />
          {connection === 'connected' ? t("실시간 갱신 중") : connection === 'connecting' ? t("서버 확인 중") : t("갱신 재연결 중")}</span>
      </div>
      <div className="sidebar-version"><span>my-agent-ops</span>{data && <span>v{data.version}</span>}</div>
    </div>
  </>;
}

export function Shell({ children }: { children: ReactNode }) {
  const { language, t } = useI18n();
  const { page, data, error, refresh, refreshing, syncing, sync, openNewRun, setPaletteOpen, setTheme, themeSaving } = useApp();
  const [mobileMenu, setMobileMenu] = useState(false);
  useEffect(() => {
    setMobileMenu(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [page]);
  useEffect(() => { document.title = `${t(PAGE_NAMES[page])} · my-agent-ops`; }, [page, language, t]);
  const dark = document.documentElement.dataset.theme === 'dark';
  return <div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={event => {
      event.preventDefault(); document.getElementById('main-content')?.focus();
    }}><Trans message={"본문으로 건너뛰기"} /></a>
    <aside className="sidebar"><SidebarContent /></aside>
    {mobileMenu && <Dialog title={t("워크스페이스 메뉴")} onClose={() => setMobileMenu(false)} className="mobile-sidebar-dialog" size="small" bodyClassName="mobile-sidebar-content">
      <SidebarContent onNavigate={() => setMobileMenu(false)} />
    </Dialog>}
    <div className="workspace">
      <header className="topbar">
        <IconButton className="mobile-menu-button" icon={Menu} label={t("메뉴 열기")} onClick={() => setMobileMenu(true)} />
        <div className="breadcrumb"><span><Trans message={"워크스페이스"} /></span><ChevronRight size={13} aria-hidden /><strong>{t(PAGE_NAMES[page])}</strong></div>
        <div className="topbar-actions">
          <button className="global-search-button" aria-label={t("빠른 검색 및 이동 ({0})", { "0": SEARCH_SHORTCUT })} onClick={() => setPaletteOpen(true)}>
            <Search size={16} aria-hidden /><span><Trans message={"빠른 검색 및 이동"} /></span><kbd>{SEARCH_SHORTCUT}</kbd>
          </button>
          <IconButton className="topbar-theme-button" label={dark ? t("라이트 모드로 전환") : t("다크 모드로 전환")}
            icon={dark ? Sun : Moon} busy={themeSaving} disabled={!data} onClick={() => void setTheme(dark ? 'light' : 'dark')} />
          <LanguageToggle />
          <IconButton className="topbar-sync-button" label={t("세션 동기화")} icon={RefreshCw} busy={syncing} disabled={!data} onClick={() => void sync()} />
          <span className="topbar-divider" />
          <Button variant="primary" icon={Plus} onClick={() => openNewRun()} disabled={!data}><Trans message={"새 실행"} /></Button>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="main-content">
        {data?.demo && <div className="demo-banner" role="status">
          <span className="demo-icon"><FlaskConical size={20} aria-hidden /></span>
          <div><strong><span className="demo-label">DEMO</span><Trans message={"데모 워크스페이스"} /></strong>
            <p><Trans message={"샘플 데이터로 둘러보세요. 정리와 명령 미리보기는 가능하며 실제 에이전트는 실행되지 않습니다."} /></p>
          </div>
          <button className="demo-action" onClick={() => openNewRun()}><Trans message={"실행 흐름 살펴보기"} /><ArrowUpRight size={15} aria-hidden /></button>
        </div>}
        {data && error && <InlineNotice tone="warning"><div className="refresh-error">
          <span><Trans message={"최신 상태를 가져오지 못했습니다. 마지막으로 불러온 기록을 표시합니다."} /></span>
          <Button size="small" icon={RefreshCw} busy={refreshing} onClick={() => void refresh()}><Trans message={"다시 연결"} /></Button>
        </div></InlineNotice>}
        <div className="page-content" key={page}>{children}</div>
        {data && <footer className="workspace-footer"><span>my-agent-ops <span>·</span><Trans message={" 로컬 워크스페이스"} /></span><span>Codex / Claude Code / Kiro CLI</span></footer>}
      </main>
    </div>
  </div>;
}
