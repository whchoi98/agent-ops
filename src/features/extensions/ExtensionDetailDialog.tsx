import { useEffect, useId, useRef, useState } from 'react';
import { FileText, Terminal } from 'lucide-react';
import type { ExtensionAnalysisDraft, ExtensionDetail, ExtensionSummary } from '../../../shared/extensions';
import { Dialog } from '../../components/Dialog';
import { AgentBadge, Button, EmptyState, ErrorState, InlineNotice, Skeleton } from '../../components/ui';
import { useResource } from '../../hooks/useResource';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/format';
import { ExtensionAnalysisView } from './ExtensionAnalysisView';
import { ExtensionStatusBadge } from './ExtensionCatalog';
import { ExtensionContentView } from './ExtensionContentView';
import { ExtensionFiles } from './ExtensionFiles';
import { KIND_LABELS, SCOPE_LABELS, USAGE_NOTICE } from './model';

const VIEWS = [
  { id: 'analysis', label: '내용 분석' }, { id: 'source', label: '원문' }, { id: 'files', label: '파일' },
] as const;

export function ExtensionDetailDialog({ item, projectId, onClose, onSelect, onPrepared }: {
  item: ExtensionSummary; projectId?: string; onClose: () => void;
  onSelect: (item: ExtensionSummary) => void; onPrepared: (result: ExtensionAnalysisDraft) => void;
}) {
  const resource = useResource<ExtensionDetail>(signal => api.extension(item.id, projectId, signal), JSON.stringify([item.id, projectId]));
  const detail = resource.data;
  const [view, setView] = useState<(typeof VIEWS)[number]['id']>('analysis');
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const draftAttempt = useRef<AbortController | null>(null);
  const viewId = useId();
  useEffect(() => () => draftAttempt.current?.abort(), []);

  function close() {
    draftAttempt.current?.abort();
    onClose();
  }
  function selectChild(child: ExtensionSummary) {
    draftAttempt.current?.abort();
    onSelect(child);
  }
  async function prepare() {
    if (!detail || draftAttempt.current) return;
    const attempt = new AbortController();
    draftAttempt.current = attempt;
    setPreparing(true); setError('');
    try {
      const result = await api.analyzeExtension(detail.id, projectId);
      if (!attempt.signal.aborted) onPrepared(result);
    } catch (cause) {
      if (!attempt.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!attempt.signal.aborted) { setPreparing(false); draftAttempt.current = null; }
    }
  }

  return <Dialog title={detail?.name ?? item.name} size="large" className="extension-detail-dialog"
    bodyClassName="extension-detail-body" onClose={close}
    description={<div className="extension-dialog-meta">
      <AgentBadge agent={detail?.agent ?? item.agent} />
      <span>{KIND_LABELS[detail?.kind ?? item.kind]} · {SCOPE_LABELS[detail?.scope ?? item.scope]}</span>
      <ExtensionStatusBadge status={detail?.status ?? item.status} reason={detail?.statusReason ?? item.statusReason} />
    </div>}
    footer={<div className="extension-detail-footer">
      <p>읽기 전용 초안을 준비합니다. 실행은 다음 화면에서 직접 시작합니다.</p>
      <div><Button onClick={close}>닫기</Button>
        <Button variant="primary" icon={Terminal} busy={preparing} disabled={!detail || Boolean(resource.error)}
          onClick={() => void prepare()}>CLI 분석 작업 준비</Button></div>
    </div>}>
    <div className="extension-detail-notice"><InlineNotice>{USAGE_NOTICE}</InlineNotice></div>
    {error && <div className="extension-detail-notice"><InlineNotice tone="error">{error}</InlineNotice></div>}
    {resource.error ? <ErrorState message={resource.error} retry={resource.reload} />
      : !detail ? <Skeleton rows={7} /> : <>
        <div className="detail-tabs extension-detail-tabs" role="group" aria-label="확장 상세 보기"
          onKeyDown={event => {
            const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
            if (!direction && event.key !== 'Home' && event.key !== 'End') return;
            event.preventDefault();
            const current = VIEWS.findIndex(tab => tab.id === view);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? VIEWS.length - 1
              : (current + direction + VIEWS.length) % VIEWS.length;
            setView(VIEWS[next].id);
            event.currentTarget.querySelectorAll('button')[next]?.focus();
          }}>
          {VIEWS.map(tab => <button type="button" key={tab.id} id={`${viewId}-${tab.id}`} aria-pressed={view === tab.id}
            aria-controls={`${viewId}-content`} className={view === tab.id ? 'active' : ''} onClick={() => setView(tab.id)}>{tab.label}</button>)}
        </div>
        <section id={`${viewId}-content`} aria-labelledby={`${viewId}-${view}`} className="extension-detail-content">
          {view === 'analysis' ? <ExtensionAnalysisView detail={detail} onSelect={selectChild} />
            : view === 'source' ? detail.entry ? <ExtensionContentView key={detail.entry.fileId} content={detail.entry} />
              : <EmptyState compact icon={FileText} title="표시할 원문이 없습니다"
                description="파일 탭에서 참고 자료를 선택하거나 내용 분석의 설정 근거를 확인하세요." />
              : <ExtensionFiles extensionId={detail.id} files={detail.files} projectId={projectId} />}
        </section>
      </>}
  </Dialog>;
}
