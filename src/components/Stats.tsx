import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function StatCard({ label, value, detail, icon: Icon, accent = 'blue', onClick }: {
  label: string; value: ReactNode; detail: ReactNode; icon: LucideIcon;
  accent?: 'blue' | 'teal' | 'violet' | 'amber'; onClick?: () => void;
}) {
  const content = <>
    <div className="stat-top"><span>{label}</span><span className={`stat-icon stat-${accent}`}><Icon size={18} strokeWidth={1.8} aria-hidden /></span></div>
    <div className="stat-value">{value}</div><div className="stat-detail">{detail}</div>
  </>;
  return onClick ? <button className="stat-card stat-clickable" onClick={onClick}>{content}</button>
    : <div className="stat-card">{content}</div>;
}
