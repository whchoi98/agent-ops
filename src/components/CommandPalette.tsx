import { useI18n, Trans } from '../i18n/I18nProvider';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { ArrowUpRight, BookOpen, FolderKanban, ListTodo, LoaderCircle, Pin, Plus, Search } from 'lucide-react';
import { Dialog } from './Dialog';
import { NAV_ITEMS } from './Shell';
import { ProviderMark } from './ui';
import { useDebounced, useResource } from '../hooks/useResource';
import { api, request } from '../lib/api';
import { useApp } from '../state/AppProvider';
import { useSavedViews } from '../features/saved-views/useSavedViews';
import { resolveSavedView } from '../../shared/saved-views';
import { toQueryString } from '../lib/query';
import type { WorkItemPage } from '../../shared/work-items';

type PaletteItem = { id: string; label: string; description?: string; icon: ReactNode; group: string; run: () => void };

export function CommandPalette() {
  const { t } = useI18n();
  const { data, navigate, setPaletteOpen, openSession, openNewRun, closeModal, productivityRevision, notify } = useApp();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const debounced = useDebounced(query.trim(), 220);
  const resource = useResource(signal => debounced ? api.sessions({ q: debounced, limit: 5 }, signal)
    : Promise.resolve({ items: [], total: 0 }), debounced);
  const workItems = useResource(signal => request<WorkItemPage>(
    `/productivity/work-items?${toQueryString({ q: debounced || undefined, status: debounced ? undefined : 'open', limit: 5 })}`, { signal }),
  `${debounced}:${productivityRevision}`);
  const savedViews = useSavedViews(productivityRevision);
  const id = useId();
  const close = () => setPaletteOpen(false);
  const choose = (action: () => void) => { close(); action(); };
  const lowered = query.trim().toLocaleLowerCase();
  const items: PaletteItem[] = [];
  if (data && (!lowered || '새 실행 new run 작업 시작'.includes(lowered))) items.push({
    id: 'new-run', label: t('새 실행'), description: t('에이전트에게 새 작업 맡기기'), icon: <Plus size={18} />, group: t('빠른 실행'),
    run: () => choose(() => openNewRun()),
  });
  for (const item of NAV_ITEMS) {
    if (!lowered || `${item.label} ${item.english}`.toLocaleLowerCase().includes(lowered)) items.push({
      id: item.page, label: t(item.label), description: item.english, icon: <item.icon size={18} />, group: t('페이지'),
      run: () => choose(() => navigate(item.page)),
    });
  }
  if (debounced === query.trim() && workItems.data) {
    for (const item of workItems.data.items) items.push({
      id: `work-${item.id}`, label: item.title, description: item.nextActionPreview || undefined,
      icon: <ListTodo size={18} />, group: t('작업센터'),
      run: () => choose(() => { closeModal(); navigate('work-items', { id: item.id }); }),
    });
  }
  for (const view of savedViews.pinnedViews.filter(view => !lowered || view.name.toLocaleLowerCase().includes(lowered)).slice(0, 8)) {
    items.push({
      id: `saved-${view.id}`, label: view.name, description: t('저장 검색 열기'),
      icon: <Pin size={18} />, group: t('저장 검색'),
      run: () => choose(() => {
        try { closeModal(); navigate('sessions', resolveSavedView(view)); }
        catch { notify('저장 검색을 열지 못했습니다. 기간과 조건을 확인하세요.', 'error'); }
      }),
    });
  }
  if (lowered) {
    for (const project of (data?.projects ?? []).filter(project =>
      `${project.name} ${project.path}`.toLocaleLowerCase().includes(lowered)).slice(0, 5)) {
      items.push({
        id: `project-${project.id}`, label: project.name, description: t('프로젝트 세션 열기'),
        icon: <FolderKanban size={18} />, group: t('프로젝트'),
        run: () => choose(() => { closeModal(); navigate('sessions', { project: project.path }); }),
      });
    }
    for (const template of (data?.templates ?? []).filter(template =>
      `${template.name} ${template.description}`.toLocaleLowerCase().includes(lowered)).slice(0, 5)) {
      items.push({
        id: `template-${template.id}`, label: template.name, description: t('템플릿으로 실행 준비'),
        icon: <BookOpen size={18} />, group: t('템플릿'),
        run: () => choose(() => openNewRun({
          templateId: template.id, title: template.name, prompt: template.prompt, policy: template.policy,
          ...(template.agent !== 'any' ? { agent: template.agent } : {}),
        })),
      });
    }
    items.push({
      id: 'search-work-items', label: t('“{0}” 작업 검색', { 0: query.trim() }), icon: <ListTodo size={18} />,
      group: t('작업센터'), run: () => choose(() => { closeModal(); navigate('work-items', { q: query.trim() }); }),
    });
    items.push({ id: 'search-all', label: t('“{0}” 전체 검색', { 0: query.trim() }), description: t('제목과 전체 대화 내용에서 찾기'), icon: <Search size={18} />,
      group: t('세션 검색'), run: () => choose(() => navigate('sessions', { q: query.trim() })) });
    if (debounced === query.trim() && resource.data) for (const session of resource.data.items) items.push({
      id: `session-${session.id}`, label: session.title, description: session.projectName,
      icon: <ProviderMark agent={session.agent} />, group: t('세션 검색'), run: () => choose(() => openSession(session.id)),
    });
  }
  useEffect(() => setSelectedId(null), [query]);
  const selected = selectedId ? items.findIndex(item => item.id === selectedId) : 0;
  const active = Math.max(0, selected);
  useEffect(() => {
    document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [active, id]);
  return <Dialog title={t("빠른 검색 및 이동")} onClose={close} size="medium" className="command-palette" hideHeading
    footer={<div className="palette-help"><span><kbd>↑</kbd><kbd>↓</kbd><Trans message={" 이동"} /></span><span><kbd>↵</kbd><Trans message={" 선택"} /></span><span><kbd>esc</kbd><Trans message={" 닫기"} /></span></div>}>
    <div className="palette-input"><Search size={20} aria-hidden /><input autoFocus data-autofocus value={query} maxLength={500} placeholder={t("페이지, 세션 검색 또는 새 실행…")}
      aria-label={t("빠른 검색 및 이동")} role="combobox" aria-expanded aria-controls={`${id}-results`} aria-autocomplete="list"
      aria-activedescendant={items.length ? `${id}-option-${active}` : undefined} onChange={event => setQuery(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (items.length) setSelectedId(items[(active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].id);
        } else if (event.key === 'Enter' && items[active]) { event.preventDefault(); items[active].run(); }
      }} /></div>
    <div className="palette-results" role="listbox" id={`${id}-results`} aria-label={t("빠른 이동 결과")}>
      {items.map((item, index) => <div key={item.id}>
        {(index === 0 || items[index - 1].group !== item.group) && <div className="palette-group-label" role="presentation">{item.group}</div>}
        <button type="button" role="option" aria-selected={index === active} id={`${id}-option-${index}`}
          className={`palette-option ${index === active ? 'selected' : ''}`} onClick={item.run}
          onMouseMove={() => setSelectedId(item.id)}><span className="palette-option-icon" aria-hidden>{item.icon}</span>
          <span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span><ArrowUpRight size={15} aria-hidden /></button>
      </div>)}
      {lowered && (resource.loading || debounced !== query.trim()) && <div className="palette-feedback"><LoaderCircle size={14} className="spin" aria-hidden /><Trans message={"세션 검색 중…"} /></div>}
      {lowered && resource.error && <div className="palette-feedback palette-error" role="status"><Trans message={"세션 검색에 연결하지 못했습니다. "} /><button onClick={resource.reload}><Trans message={"다시 시도"} /></button></div>}
      {workItems.error && <div className="palette-feedback palette-error" role="status">{t('작업 목록을 불러오지 못했습니다.')} <button onClick={workItems.reload}>{t('다시 시도')}</button></div>}
      {savedViews.error && <div className="palette-feedback palette-error" role="status">{t('저장 검색을 불러오지 못했습니다.')} <button onClick={() => void savedViews.reload()}>{t('다시 시도')}</button></div>}
      {lowered && !resource.loading && resource.data?.items.length === 0 && <div className="palette-feedback"><Trans message={"일치하는 세션이 없습니다. 검색어를 바꿔보세요."} /></div>}
    </div>
  </Dialog>;
}
