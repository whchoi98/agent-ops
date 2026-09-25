import { useFormat } from '../i18n/useFormat';
import { useI18n, Trans } from '../i18n/I18nProvider';
import { Bookmark, ChevronRight, Folder, MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Session } from '../../shared/types';
import { api } from '../lib/api';
import { errorMessage } from '../lib/format';
import { useApp } from '../state/AppProvider';
import { AgentBadge, IconButton, StatusBadge, UsageValue } from './ui';
import { useCreditI18n } from '../features/usage/i18n';

export function BookmarkButton({ session, onChange }: { session: Session; onChange?: () => void }) {
  const { t } = useI18n();
  const { refresh, notify } = useApp();
  const [bookmarked, setBookmarked] = useState(session.bookmarked);
  const [busy, setBusy] = useState(false);
  useEffect(() => setBookmarked(session.bookmarked), [session.bookmarked]);
  async function toggle() {
    setBusy(true);
    try {
      const updated = await api.updateSession(session.id, { bookmarked: !bookmarked });
      setBookmarked(updated.bookmarked);
      onChange?.();
      await refresh(true);
    } catch (error) { notify(errorMessage(error), 'error'); }
    finally { setBusy(false); }
  }
  return <IconButton label={bookmarked ? t("북마크 해제") : t("북마크 추가")} icon={Bookmark}
    aria-pressed={bookmarked} busy={busy} className={bookmarked ? 'is-bookmarked' : ''}
    onClick={event => { event.stopPropagation(); void toggle(); }} />;
}

export function SessionTable({
  sessions, selected, onSelect, onChange, compact = false,
}: {
  sessions: Session[]; selected?: Set<string>; onSelect?: (session: Session) => void; onChange?: () => void; compact?: boolean;
}) {
  const { relativeTime, dateTime } = useFormat();
  const { t } = useI18n();
  const { t: creditT } = useCreditI18n();
  const { openSession } = useApp();
  return <div className={`session-table-wrap ${compact ? 'session-table-compact' : ''}`}>
    <table className="session-table">
      <thead><tr>
        {onSelect && <th className="selection-cell"><span className="sr-only"><Trans message={"비교 선택"} /></span></th>}
        <th><Trans message={"세션"} /></th><th className="provider-cell"><Trans message={"에이전트"} /></th>
        {!compact && <th className="session-status-cell"><Trans message={"상태"} /></th>}
        <th className="tokens-cell session-usage-cell">{creditT('사용량')}</th><th className="time-cell"><Trans message={"최근 기록"} /></th>
        <th className="bookmark-cell"><span className="sr-only"><Trans message={"북마크"} /></span></th>
      </tr></thead>
      <tbody>{sessions.map(session => <tr key={session.id} className={selected?.has(session.id) ? 'row-selected' : ''}>
        {onSelect && <td className="selection-cell"><input type="checkbox" checked={selected?.has(session.id) ?? false}
          aria-label={t("{0} 비교 선택", { "0": session.title })} onChange={() => onSelect(session)} /></td>}
        <td className="session-title-cell">
          <button className="session-open" onClick={() => openSession(session.id)}>
            <span className={`session-row-icon provider-${session.agent}`}><MessageSquare size={17} aria-hidden /></span>
            <span className="session-cell-text"><strong>{session.title || t("제목 없는 세션")}</strong>
              <span className="session-row-meta"><Folder size={12} aria-hidden /><span>{session.projectName || t("프로젝트 미지정")}</span>
                <span className="meta-separator">·</span><span><Trans message={"{0}개 메시지"} values={{ "0": session.messageCount }} /></span>
                {session.tags.length > 0 && <span className="row-tag">#{session.tags[0]}</span>}
              </span>
              <span className="session-mobile-meta"><AgentBadge agent={session.agent} compact /><span>{relativeTime(session.updatedAt)}</span>
                <UsageValue agent={session.agent} usage={session.usage} /></span>
            </span><ChevronRight size={15} className="session-row-chevron" aria-hidden />
          </button>
        </td>
        <td className="provider-cell"><AgentBadge agent={session.agent} compact /></td>
        {!compact && <td className="session-status-cell"><StatusBadge status={session.status} /></td>}
        <td className="tokens-cell session-usage-cell"><UsageValue agent={session.agent} usage={session.usage} /></td>
        <td className="time-cell"><time dateTime={session.updatedAt} title={dateTime(session.updatedAt)}>{relativeTime(session.updatedAt)}</time></td>
        <td className="bookmark-cell"><BookmarkButton session={session} onChange={onChange} /></td>
      </tr>)}</tbody>
    </table>
  </div>;
}
