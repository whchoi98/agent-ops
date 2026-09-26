import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useHarnessI18n } from './i18n';

const TABS = [
  { id: 'engine', label: '엔진' },
  { id: 'policies', label: '정책' },
  { id: 'decision', label: '판정 테스트' },
  { id: 'hooks', label: '훅' },
  { id: 'audit', label: '감사 기록' },
] as const;
export type HarnessTab = typeof TABS[number]['id'];

export function HarnessTabs({ id, active, onChange }: { id: string; active: HarnessTab; onChange: (tab: HarnessTab) => void }) {
  const { t } = useHarnessI18n();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % TABS.length
        : event.key === 'ArrowLeft' ? (index - 1 + TABS.length) % TABS.length : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(TABS[next].id);
    buttons.current[next]?.focus();
  }
  return <div className="harness-tabs" role="tablist" aria-label={t('하니스 관리 구역')} aria-orientation="horizontal">
    {TABS.map((tab, index) => <button key={tab.id} type="button" role="tab" className="harness-tab"
      id={`${id}-tab-${tab.id}`} aria-controls={`${id}-panel-${tab.id}`} aria-selected={active === tab.id}
      tabIndex={active === tab.id ? 0 : -1} ref={element => { buttons.current[index] = element; }}
      onClick={() => onChange(tab.id)} onKeyDown={event => move(event, index)}>{t(tab.label)}</button>)}
  </div>;
}

/** Hidden panels stay mounted so tab navigation cannot discard drafts or cancel owned requests. */
export function HarnessTabPanel({ id, tab, active, children }: { id: string; tab: HarnessTab; active: boolean; children: ReactNode }) {
  return <section className="harness-tab-panel" role="tabpanel" id={`${id}-panel-${tab}`}
    aria-labelledby={`${id}-tab-${tab}`} hidden={!active} tabIndex={active ? 0 : -1}>
    {children}
  </section>;
}
