import { useI18n, Trans } from '../../i18n/I18nProvider';
import { useEffect, useState } from 'react';
import { ArrowRightLeft, Download, Folder, MessageSquare, RotateCcw } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { BookmarkButton } from '../../components/SessionTable';
import { AgentBadge, Button, ErrorState, InlineNotice, Skeleton, StatusBadge, TokenValue } from '../../components/ui';
import { api } from '../../lib/api';
import { errorMessage, number } from '../../lib/format';
import { useResource } from '../../hooks/useResource';
import { useApp, useData } from '../../state/AppProvider';
import { SessionReader } from './SessionReader';
import { SessionInfo, SessionMetadata } from './SessionMetadata';
import { HandoffDialog } from './HandoffDialog';

const DETAIL_TABS = [
  { id: 'conversation', label: '대화' }, { id: 'notes', label: '메모·태그' }, { id: 'info', label: '세션 정보' },
] as const;

export function SessionDetailDialog({ id }: { id: string }) {
  const { t } = useI18n();
  const data = useData();
  const { closeModal, openNewRun, notify, subscribe } = useApp();
  const resource = useResource(signal => api.session(id, signal), id, true);
  const session = resource.data;
  const [tab, setTab] = useState<'conversation' | 'notes' | 'info'>('conversation');
  const [handoff, setHandoff] = useState(false);
  const [format, setFormat] = useState<'md' | 'json' | 'html'>('md');
  const [exporting, setExporting] = useState(false);
  const connector = data.connectors.find(item => item.agent === session?.agent);
  const canResume = Boolean(connector?.supportsResume && session?.resumable !== false);
  useEffect(() => subscribe(event => { if (event.type === 'refresh') resource.reload(); }), [subscribe, resource.reload]);
  async function download() {
    setExporting(true);
    try { await api.downloadSession(id, format); notify('마스킹한 세션 파일을 내보냈습니다.'); }
    catch (error) { notify(errorMessage(error), 'error'); }
    finally { setExporting(false); }
  }
  function resume() {
    if (!session) return;
    openNewRun({
      agent: session.agent, projectId: data.projects.find(project => project.path === session.projectPath)?.id,
      resumeSessionId: session.id, title: `${session.title.slice(0, 180)} · 이어가기`, policy: 'read-only',
      model: session.model && session.model !== 'unknown' ? session.model : undefined,
    });
  }
  return <>
    <Dialog title={session?.title || t("세션 불러오는 중")} size="drawer" className="session-detail-dialog"
      bodyClassName="session-detail-body" onClose={closeModal}
      description={session && <div className="session-dialog-meta"><AgentBadge agent={session.agent} /><StatusBadge status={session.status} /><span><Folder size={13} aria-hidden />{session.projectName || t("프로젝트 미지정")}</span></div>}
      actions={session && <BookmarkButton session={session} onChange={resource.reload} />}
      footer={session && <div className="session-footer">
        <div className="export-controls"><select aria-label={t("내보내기 형식")} value={format} onChange={event => setFormat(event.target.value as typeof format)}>
          <option value="md">Markdown</option><option value="json">JSON</option><option value="html">HTML</option>
        </select><Button icon={Download} busy={exporting} onClick={() => void download()} title={t("공통 자격증명 패턴을 마스킹한 파일을 다운로드합니다.")}><Trans message={"내보내기"} /></Button></div>
        <div className="session-continuation-actions"><Button icon={ArrowRightLeft} onClick={() => setHandoff(true)}><Trans message={"다른 에이전트에 전달"} /></Button>
          <Button icon={RotateCcw} variant="primary" onClick={resume} disabled={!canResume}
            title={canResume ? t("기존 세션을 이어갈 새 실행 준비") : t("이 기록은 CLI에서 직접 이어갈 수 없습니다. 작업 인계를 사용하세요.")}><Trans message={"이어가기"} /></Button></div>
        {!canResume && <span className="resume-unavailable"><Trans message={"이 기록은 CLI에서 직접 이어갈 수 없습니다. 다른 에이전트에 맥락을 전달할 수 있습니다."} /></span>}
      </div>}>
      {resource.error && <ErrorState message={resource.error} retry={resource.reload} compact />}
      {!session ? <Skeleton rows={8} /> : <>
        <div className="session-summary-strip"><span><MessageSquare size={14} aria-hidden /><Trans message={"{0}개 메시지"} values={{ "0": number(session.messageCount) }} /></span>
          <span><TokenValue usage={session.usage} /><Trans message={" 토큰"} /></span><span className="session-summary-model">{session.model || t("모델 미기록")}</span>
          {session.tags.map(tag => <span className="tag" key={tag}>#{tag}</span>)}</div>
        <div className="detail-tabs" role="tablist" aria-label={t("세션 상세")}
          onKeyDown={event => {
            const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
            if (!direction && event.key !== 'Home' && event.key !== 'End') return;
            event.preventDefault();
            const current = DETAIL_TABS.findIndex(item => item.id === tab);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? DETAIL_TABS.length - 1
              : (current + direction + DETAIL_TABS.length) % DETAIL_TABS.length;
            setTab(DETAIL_TABS[next].id);
            document.getElementById(`session-tab-${DETAIL_TABS[next].id}`)?.focus();
          }}>
          {DETAIL_TABS.map(item =>
            <button key={item.id} id={`session-tab-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`session-panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{t(item.label)}
              {item.id === 'notes' && (session.note || session.tags.length > 0) && <i className="tab-content-dot" />}</button>)}
        </div>
        {DETAIL_TABS.map(item => <div key={item.id} id={`session-panel-${item.id}`} role="tabpanel"
          aria-labelledby={`session-tab-${item.id}`} hidden={tab !== item.id}
          style={tab !== item.id ? { display: 'none' } : undefined}
          className={`session-tab-panel ${item.id === 'conversation' ? 'reader-panel' : ''}`}>
          {item.id === 'conversation' ? <SessionReader session={session} /> : item.id === 'notes'
            ? <SessionMetadata session={session} onSaved={resource.replaceData} />
            : <SessionInfo session={session} />}
        </div>)}
      </>}
    </Dialog>
    {handoff && session && <HandoffDialog session={session} onClose={() => setHandoff(false)} />}
  </>;
}
