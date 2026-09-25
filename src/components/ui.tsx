import { useI18n, Trans, AppNotice } from '../i18n/I18nProvider';
import {
  Asterisk, Check, CheckCircle2, CircleAlert, Copy, Inbox, Info,
  LoaderCircle, RefreshCw, X, type LucideIcon,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Agent, RunStatus, SessionStatus, Usage } from '../../shared/types';
import { AGENT_META, compactNumber, number, STATUS_LABEL, tokenUsage } from '../lib/format';
import { useApp, type Toast } from '../state/AppProvider';
import { CreditValue } from '../features/usage/CreditValue';

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
  const pixels = size === 'small' ? 14 : size === 'large' ? 24 : 20;
  return <span className={`provider-mark provider-${agent} provider-mark-${size}`} aria-hidden>
    {agent === 'claude' ? <Asterisk size={pixels} strokeWidth={2.3} />
      : <svg width={pixels} height={pixels} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <image href={`icons/${agent === 'codex' ? 'codex.png' : 'kiro.svg'}`}
          width="24" height="24" preserveAspectRatio="xMidYMid meet" />
      </svg>}
  </span>;
}

export function AgentBadge({ agent, compact = false }: { agent: Agent; compact?: boolean }) {
  return <span className={`agent-badge provider-${agent}`}>
    <ProviderMark agent={agent} size="small" />
    <span>{compact ? AGENT_META[agent].short : AGENT_META[agent].name}</span>
  </span>;
}

export function StatusBadge({ status }: { status: RunStatus | SessionStatus }) {
  const { t } = useI18n();
  return <span className={`status-badge status-${status}`}>
    <span className="status-dot" aria-hidden />{t(STATUS_LABEL[status])}
  </span>;
}

export function TokenValue({ usage, compact = true }: { usage: Usage; compact?: boolean }) {
  const { t } = useI18n();
  const { total, complete } = tokenUsage(usage);
  return <span className={`numeric ${total === null ? 'text-muted' : ''}`} title={
    total === null ? t("이 세션에는 토큰 사용량이 기록되지 않았습니다.")
      : t("입력 {0} · 출력 {1}{2}", { "0": usage.inputTokens === null ? t("미기록") : number(usage.inputTokens), "1": usage.outputTokens === null ? t("미기록") : number(usage.outputTokens), "2": complete ? '' : t(" · 부분 기록") })
  }>
    {total === null ? t("미기록") : compact ? compactNumber(total) : number(total)}
    {total !== null && !complete && <span className="partial-indicator" aria-label={t("부분 기록")}>*</span>}
  </span>;
}

export function UsageValue({ agent, usage, compact = true }: { agent: Agent; usage: Usage; compact?: boolean }) {
  const { t } = useI18n();
  return agent === 'kiro' ? <CreditValue usage={usage} compact={compact} />
    : <span className="usage-value"><TokenValue usage={usage} compact={compact} />{' '}<span className="usage-unit">{t('토큰')}</span></span>;
}

export function AggregateTokenValue({ tokens, knownTokenSessions, sessions, showCoverage = true }: {
  tokens: number; knownTokenSessions: number; sessions: number; showCoverage?: boolean;
}) {
  const { t } = useI18n();
  const hasRecord = knownTokenSessions > 0;
  const partial = hasRecord && knownTokenSessions < sessions;
  const label = hasRecord
    ? t('{0} 토큰 · {1}/{2}개 세션 기록{3}', { 0: number(tokens), 1: knownTokenSessions, 2: sessions, 3: partial ? t(' · 부분 합계') : '' })
    : t('토큰 기록 없음');
  return <span className="aggregate-usage" title={label} aria-label={label}>
    <span className={`numeric ${hasRecord ? '' : 'text-muted'}`}>{hasRecord ? compactNumber(tokens) : '—'}</span>
    {partial && showCoverage && <small className="group-coverage"><Trans message={"{0}/{1}개 기록"} values={{ "0": knownTokenSessions, "1": sessions }} /></small>}
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
    <CircleAlert size={21} aria-hidden /><div><strong><Trans message={"불러오지 못했습니다"} /></strong><p><AppNotice message={message} /></p></div>
    {retry && <Button size="small" icon={RefreshCw} onClick={retry}><Trans message={"다시 시도"} /></Button>}
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
  const { t } = useI18n();
  return <div className={`skeleton-group ${className}`} role="status" aria-label={t("불러오는 중")}>
    {Array.from({ length: rows }, (_, index) => <div className="skeleton" key={index} style={{ width: index === rows - 1 ? '72%' : '100%' }} />)}
    <span className="sr-only"><Trans message={"불러오는 중입니다."} /></span>
  </div>;
}

export function CopyButton({ text, label, compact = false }: { text: string; label?: string; compact?: boolean }) {
  const { t } = useI18n();
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
  const actualLabel = copied ? t('복사됨') : failed ? t('복사 실패. 텍스트를 선택해 복사하세요.') : label ?? t('복사');
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
  const { t } = useI18n();
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(toast.id), toast.tone === 'error' ? 8500 : 5000);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.tone, dismiss]);
  const Icon = toast.tone === 'success' ? CheckCircle2 : toast.tone === 'error' ? CircleAlert : Info;
  return <div className={`toast toast-${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
    <Icon size={19} aria-hidden /><span><AppNotice message={toast.message} /></span>
    <IconButton label={t("알림 닫기")} icon={X} onClick={() => dismiss(toast.id)} />
  </div>;
}

export function Toasts() {
  const { t } = useI18n();
  const { toasts, dismissToast, modal, paletteOpen } = useApp();
  const [target, setTarget] = useState<Element>(document.body);
  useLayoutEffect(() => {
    const dialogs = document.querySelectorAll('dialog[open]');
    setTarget(dialogs.item(dialogs.length - 1) || document.body);
  }, [toasts, modal, paletteOpen]);
  return createPortal(<div className="toasts" aria-label={t("알림")}>{toasts.map(toast => <ToastItem key={toast.id} toast={toast} dismiss={dismissToast} />)}</div>, target);
}
