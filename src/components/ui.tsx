import {
  Asterisk, Check, CheckCircle2, CircleAlert, Code2, Copy, Inbox, Info,
  LoaderCircle, Orbit, RefreshCw, X, type LucideIcon,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Agent, RunStatus, SessionStatus, Usage } from '../../shared/types';
import { AGENT_META, compactNumber, number, STATUS_LABEL, tokenUsage } from '../lib/format';
import { useApp, type Toast } from '../state/AppProvider';

export function Button({
  children, variant = 'secondary', size = 'normal', busy = false, icon: Icon,
  className = '', disabled, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'normal' | 'small';
  busy?: boolean;
  icon?: LucideIcon;
}) {
  return <button {...props} type={props.type ?? 'button'} disabled={disabled || busy}
    className={`button button-${variant} ${size === 'small' ? 'button-small' : ''} ${className}`} aria-busy={busy || undefined}>
    {busy ? <LoaderCircle size={16} className="spin" aria-hidden /> : Icon ? <Icon size={16} aria-hidden /> : null}
    {children}
  </button>;
}

export function IconButton({
  label, icon: Icon, busy = false, className = '', ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: LucideIcon; busy?: boolean }) {
  return <button {...props} type={props.type ?? 'button'} aria-label={label} title={props.title ?? label}
    disabled={props.disabled || busy} className={`icon-button ${className}`} aria-busy={busy || undefined}>
    {busy ? <LoaderCircle size={17} className="spin" aria-hidden /> : <Icon size={17} aria-hidden />}
  </button>;
}

export function ProviderMark({ agent, size = 'normal' }: { agent: Agent; size?: 'small' | 'normal' | 'large' }) {
  const Icon = agent === 'codex' ? Code2 : agent === 'claude' ? Asterisk : Orbit;
  return <span className={`provider-mark provider-${agent} provider-mark-${size}`} aria-hidden>
    <Icon size={size === 'small' ? 14 : size === 'large' ? 24 : 20} strokeWidth={agent === 'claude' ? 2.3 : 1.9} />
  </span>;
}

export function AgentBadge({ agent, compact = false }: { agent: Agent; compact?: boolean }) {
  return <span className={`agent-badge provider-${agent}`}>
    <ProviderMark agent={agent} size="small" />
    <span>{compact ? AGENT_META[agent].short : AGENT_META[agent].name}</span>
  </span>;
}

export function StatusBadge({ status }: { status: RunStatus | SessionStatus }) {
  return <span className={`status-badge status-${status}`}>
    <span className="status-dot" aria-hidden />{STATUS_LABEL[status]}
  </span>;
}

export function TokenValue({ usage, compact = true }: { usage: Usage; compact?: boolean }) {
  const { total, complete } = tokenUsage(usage);
  return <span className={`numeric ${total === null ? 'text-muted' : ''}`} title={
    total === null ? '이 세션에는 토큰 사용량이 기록되지 않았습니다.'
      : `입력 ${usage.inputTokens === null ? '미기록' : number(usage.inputTokens)} · 출력 ${usage.outputTokens === null ? '미기록' : number(usage.outputTokens)}${complete ? '' : ' · 부분 기록'}`
  }>
    {total === null ? '미기록' : compact ? compactNumber(total) : number(total)}
    {total !== null && !complete && <span className="partial-indicator" aria-label="부분 기록">*</span>}
  </span>;
}

export function AggregateTokenValue({ tokens, knownTokenSessions, sessions, showCoverage = true }: {
  tokens: number; knownTokenSessions: number; sessions: number; showCoverage?: boolean;
}) {
  const hasRecord = knownTokenSessions > 0;
  const partial = hasRecord && knownTokenSessions < sessions;
  const label = hasRecord
    ? `${number(tokens)} 토큰 · ${knownTokenSessions}/${sessions}개 세션 기록${partial ? ' · 부분 합계' : ''}`
    : '토큰 기록 없음';
  return <span className="aggregate-usage" title={label} aria-label={label}>
    <span className={`numeric ${hasRecord ? '' : 'text-muted'}`}>{hasRecord ? compactNumber(tokens) : '—'}</span>
    {partial && showCoverage && <small className="group-coverage">{knownTokenSessions}/{sessions}개 기록</small>}
  </span>;
}

export function EmptyState({
  title, description, action, icon: Icon = Inbox, compact = false,
}: { title: string; description: string; action?: ReactNode; icon?: LucideIcon; compact?: boolean }) {
  return <div className={`empty-state ${compact ? 'empty-state-compact' : ''}`}>
    <span className="empty-icon"><Icon size={25} strokeWidth={1.6} aria-hidden /></span>
    <h3>{title}</h3><p>{description}</p>{action}
  </div>;
}

export function ErrorState({ message, retry, compact = false }: { message: string; retry?: () => void; compact?: boolean }) {
  return <div className={`error-state ${compact ? 'error-state-compact' : ''}`} role="alert">
    <CircleAlert size={21} aria-hidden /><div><strong>불러오지 못했습니다</strong><p>{message}</p></div>
    {retry && <Button size="small" icon={RefreshCw} onClick={retry}>다시 시도</Button>}
  </div>;
}

export function InlineNotice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warning' | 'error' | 'success' }) {
  const Icon = tone === 'error' || tone === 'warning' ? CircleAlert : tone === 'success' ? CheckCircle2 : Info;
  return <div className={`inline-notice notice-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
    <Icon size={17} aria-hidden /><div>{children}</div>
  </div>;
}

export function PageHeading({ title, description, actions, eyebrow }: {
  title: string; description: string; actions?: ReactNode; eyebrow?: string;
}) {
  return <div className="page-heading">
    <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1 tabIndex={-1}>{title}</h1><p>{description}</p></div>
    {actions && <div className="page-actions">{actions}</div>}
  </div>;
}

export function Panel({ title, description, actions, children, className = '' }: {
  title: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  return <section className={`panel ${className}`}>
    <div className="panel-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{actions}</div>
    {children}
  </section>;
}

export function Skeleton({ rows = 4, className = '' }: { rows?: number; className?: string }) {
  return <div className={`skeleton-group ${className}`} role="status" aria-label="불러오는 중">
    {Array.from({ length: rows }, (_, index) => <div className="skeleton" key={index} style={{ width: index === rows - 1 ? '72%' : '100%' }} />)}
    <span className="sr-only">불러오는 중입니다.</span>
  </div>;
}

export function CopyButton({ text, label = '복사', compact = false }: { text: string; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied && !failed) return;
    const timer = window.setTimeout(() => { setCopied(false); setFailed(false); }, 2500);
    return () => window.clearTimeout(timer);
  }, [copied, failed]);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch { setFailed(true); }
  }
  const actualLabel = copied ? '복사됨' : failed ? '복사 실패. 텍스트를 선택해 복사하세요.' : label;
  return compact
    ? <IconButton label={actualLabel} icon={copied ? Check : Copy} onClick={copy} className={copied ? 'copied' : ''} />
    : <Button size="small" icon={copied ? Check : Copy} onClick={copy}>{actualLabel}</Button>;
}

export function Field({ label, htmlFor, hint, children, className = '' }: {
  label: string; htmlFor: string; hint?: ReactNode; children: ReactNode; className?: string;
}) {
  return <div className={`field ${className}`}>
    <label htmlFor={htmlFor}>{label}</label>{children}{hint && <p className="field-hint">{hint}</p>}
  </div>;
}

export function Switch({ checked, onChange, label, disabled = false }: {
  checked: boolean; onChange: () => void; label: string; disabled?: boolean;
}) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label}
    disabled={disabled} onClick={onChange} className={`switch ${checked ? 'switch-on' : ''}`}>
    <span aria-hidden />
  </button>;
}

function ToastItem({ toast, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(toast.id), toast.tone === 'error' ? 8500 : 5000);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.tone, dismiss]);
  const Icon = toast.tone === 'success' ? CheckCircle2 : toast.tone === 'error' ? CircleAlert : Info;
  return <div className={`toast toast-${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
    <Icon size={19} aria-hidden /><span>{toast.message}</span>
    <IconButton label="알림 닫기" icon={X} onClick={() => dismiss(toast.id)} />
  </div>;
}

export function Toasts() {
  const { toasts, dismissToast, modal, paletteOpen } = useApp();
  const [target, setTarget] = useState<Element>(document.body);
  useLayoutEffect(() => {
    const dialogs = document.querySelectorAll('dialog[open]');
    setTarget(dialogs.item(dialogs.length - 1) || document.body);
  }, [toasts, modal, paletteOpen]);
  return createPortal(<div className="toasts" aria-label="알림">{toasts.map(toast => <ToastItem key={toast.id} toast={toast} dismiss={dismissToast} />)}</div>, target);
}
