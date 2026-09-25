import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock3, Folder, Search, Terminal, X } from 'lucide-react';
import type { RunEvent } from '../../../shared/types';
import { Dialog } from '../../components/Dialog';
import { highlightText } from '../../components/Markdown';
import { AgentBadge, Button, CopyButton, ErrorState, IconButton, InlineNotice, Skeleton, StatusBadge, TokenValue } from '../../components/ui';
import { cleanTerminal, dateTime, duration, isActiveRun, money, number } from '../../lib/format';
import { useNow } from '../../hooks/useResource';
import { useRunDetail } from '../../hooks/useRunDetail';
import { useApp } from '../../state/AppProvider';
import { RunActions } from './RunActions';

export function RunDetailDialog({ id }: { id: string }) {
  const { closeModal } = useApp();
  const resource = useRunDetail(id);
  const run = resource.data?.run;
  const [stream, setStream] = useState<RunEvent['stream'] | 'all'>('all');
  const [search, setSearch] = useState('');
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const now = useNow(run?.status === 'running');
  const events = useMemo(() => (resource.data?.events ?? []).filter(event =>
    (stream === 'all' || event.stream === stream) && (!search || cleanTerminal(event.text).toLocaleLowerCase().includes(search.toLocaleLowerCase())),
  ), [resource.data?.events, stream, search]);
  const latest = resource.data?.events.at(-1)?.id;
  useEffect(() => {
    if (follow && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [latest, follow, stream, search]);
  const elapsed = run?.startedAt ? (run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.startedAt) : null;
  return <Dialog title={run?.title || '실행 불러오는 중'} size="drawer" onClose={closeModal} className="run-detail-dialog"
    bodyClassName="run-detail-body"
    description={run && <div className="session-dialog-meta"><AgentBadge agent={run.agent} /><StatusBadge status={run.status} /><span><Folder size={13} aria-hidden />{run.projectName}</span></div>}
    footer={run && <><span className="run-footer-status">{isActiveRun(run.status) ? '이 화면을 닫아도 작업은 계속됩니다.' : run.exitCode !== null ? `프로세스 종료 코드 ${run.exitCode}` : '실행 기록이 저장되었습니다.'}</span>
      <Button onClick={closeModal}>닫기</Button><RunActions run={run} onChanged={resource.reload} /></>}>
    {resource.error && <ErrorState message={resource.error} retry={resource.reload} compact />}
    {!run ? <Skeleton rows={8} /> : <>
      <div className="run-summary-grid"><div><span>시작 시간</span><strong>{run.startedAt ? dateTime(run.startedAt, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '실행 대기'}</strong></div>
        <div><span>실행 시간</span><strong><Clock3 size={14} aria-hidden />{elapsed === null ? '아직 시작하지 않음' : duration(elapsed)}</strong></div>
        <div><span>작업 권한</span><strong className="mono">{run.policy}</strong></div><div><span>모델</span><strong className="mono">{run.model || 'CLI 기본 모델'}</strong></div></div>
      {run.error && <InlineNotice tone="error">{run.error}</InlineNotice>}
      <details className="run-request-details"><summary>실행 정보와 프롬프트</summary><div className="run-request-content">
        <dl className="detail-properties"><div><dt>프로젝트 경로</dt><dd><code>{run.projectPath}</code></dd></div>
          <div><dt>생성 시간</dt><dd>{dateTime(run.createdAt)}</dd></div>{run.finishedAt && <div><dt>종료 시간</dt><dd>{dateTime(run.finishedAt)}</dd></div>}
          {run.agent !== 'codex' && run.policy === 'workspace-write' && <div><dt>터미널 명령</dt><dd>{run.allowShell ? '자동 실행 허용' : '자동 실행 허용 안 함'}</dd></div>}
          <div><dt>기록된 사용량</dt><dd><TokenValue usage={run.usage} /> 토큰 · {money(run.usage.costUsd)}</dd></div></dl>
        <div className="code-block"><div className="code-heading"><span>COMMAND</span><CopyButton text={run.command} compact label="명령 복사" /></div><pre><code>{run.command || '명령 미기록'}</code></pre></div>
        <div className="run-prompt"><span className="field-label">프롬프트</span><pre>{run.prompt}</pre></div>
      </div></details>
      <section className="run-log-section" aria-label="실행 로그">
        <div className="run-log-title"><div><Terminal size={17} aria-hidden /><h3>출력 로그</h3>
          <span>{number(resource.data?.events.length ?? 0)}개 이벤트</span>{run.status === 'running' && <span className="log-live"><i className="live-dot" />LIVE</span>}</div>
          <CopyButton compact text={events.map(event => `[${event.timestamp}] [${event.stream}] ${cleanTerminal(event.text)}`).join('\n')} label="표시된 로그 복사" /></div>
        <div className="log-toolbar"><select aria-label="로그 스트림 필터" value={stream} onChange={event => setStream(event.target.value as typeof stream)}>
          <option value="all">모든 출력</option><option value="stdout">stdout</option><option value="stderr">stderr</option><option value="system">system</option></select>
          <div className="search-input log-search"><Search size={14} aria-hidden /><input value={search} aria-label="실행 로그 검색" placeholder="로그 검색"
            onChange={event => setSearch(event.target.value)} />{search && <IconButton icon={X} label="로그 검색 지우기" onClick={() => setSearch('')} />}</div>
          <label className="follow-control"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />자동 스크롤</label>
        </div>
        <div className="log-output" ref={scrollRef} tabIndex={0} role="region" aria-label="실행 출력"
          onScroll={() => { const node = scrollRef.current; if (node && follow && node.scrollHeight - node.clientHeight - node.scrollTop > 100) setFollow(false); }}>
          {events.length ? events.map(event => <div key={event.id} className={`log-line log-${event.stream}`}>
            <time dateTime={event.timestamp}>{dateTime(event.timestamp, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time>
            <span className="log-stream">{event.stream}</span><pre>{highlightText(cleanTerminal(event.text), search)}</pre>
          </div>) : <div className="log-empty"><Terminal size={28} aria-hidden /><strong>{search || stream !== 'all' ? '조건에 맞는 로그가 없습니다' : run.status === 'queued' ? '작업이 대기 중입니다' : '아직 출력 로그가 없습니다'}</strong>
            <p>{search || stream !== 'all' ? '검색어와 출력 필터를 확인하세요.' : run.status === 'queued' ? '동시 실행 한도 또는 같은 프로젝트의 작업이 끝나면 시작합니다.' : isActiveRun(run.status) ? 'CLI가 출력하면 자동으로 표시됩니다.' : '이 실행에 남아 있는 출력이 없습니다.'}</p></div>}
        </div>
      </section>
    </>}
  </Dialog>;
}
