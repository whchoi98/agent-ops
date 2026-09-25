import { useMemo, useState } from 'react';
import { Clock3, Folder, LayoutGrid, List, Plus, Search, Terminal, X } from 'lucide-react';
import { AGENTS, type Agent, type Run, type RunStatus } from '../../shared/types';
import { AgentBadge, Button, EmptyState, IconButton, PageHeading, ProviderMark, StatusBadge } from '../components/ui';
import { RunActions } from '../features/runs/RunActions';
import { AGENT_META, dateTime, duration, isActiveRun, number, relativeTime } from '../lib/format';
import { useApp, useData } from '../state/AppProvider';

const COLUMNS: Array<{ title: string; statuses: RunStatus[]; className: string }> = [
  { title: '대기 중', statuses: ['queued'], className: 'queued' },
  { title: '실행 중', statuses: ['running'], className: 'running' },
  { title: '완료', statuses: ['completed'], className: 'completed' },
  { title: '확인 필요', statuses: ['failed', 'cancelled', 'interrupted'], className: 'attention' },
];

function RunCard({ run }: { run: Run }) {
  const { openRun } = useApp();
  return <article className={`run-card ${run.status === 'running' ? 'run-card-running' : ''}`}>
    <button className="run-card-main" onClick={() => openRun(run.id)}>
      <div className="run-card-top"><ProviderMark agent={run.agent} size="small" /><span>{AGENT_META[run.agent].name}</span><StatusBadge status={run.status} /></div>
      <h3>{run.title}</h3><p className="run-card-prompt">{run.prompt}</p>
      <span className="run-card-project"><Folder size={13} aria-hidden />{run.projectName}</span>
      {run.status === 'running' && <span className="running-indicator"><i /><i /><i /><span>로그 확인하기</span></span>}
      {run.error && <span className="run-card-error">{run.error}</span>}
      <div className="run-card-time"><Clock3 size={12} aria-hidden /><time dateTime={run.createdAt} title={dateTime(run.createdAt)}>{relativeTime(run.createdAt)}</time>
        <span>{run.startedAt && run.finishedAt ? duration(Date.parse(run.finishedAt) - Date.parse(run.startedAt)) : run.policy === 'read-only' ? '읽기 전용' : '쓰기 허용'}</span></div>
    </button>
    {run.status !== 'completed' && <div className="run-card-actions"><RunActions run={run} small /></div>}
  </article>;
}

export function Runs() {
  const data = useData();
  const { openNewRun, openRun } = useApp();
  const [view, setView] = useState<'board' | 'list'>('board');
  const [q, setQ] = useState('');
  const [agent, setAgent] = useState<Agent | ''>('');
  const [project, setProject] = useState('');
  const [status, setStatus] = useState('');
  const filtered = useMemo(() => data.runs.filter(run => (!agent || run.agent === agent) && (!project || run.projectId === project)
    && (!status || run.status === status) && (!q || `${run.title} ${run.prompt} ${run.projectName}`.toLocaleLowerCase().includes(q.toLocaleLowerCase())))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [data.runs, agent, project, status, q]);
  const active = data.runs.filter(run => isActiveRun(run.status)).length;
  return <>
    <PageHeading title="실행 보드" description="작업을 시작하고, 진행 상황을 확인하고, 다음 작업으로 이어가세요." eyebrow="RUN CONTROL"
      actions={<Button variant="primary" icon={Plus} onClick={() => openNewRun()}>새 실행 만들기</Button>} />
    <div className="run-board-summary"><span><span className={active ? 'live-dot' : 'idle-dot'} /><strong>{active}개</strong> 작업 진행 중</span>
      <span>동시 실행 한도 <strong>{data.settings.concurrency}개</strong></span><span>같은 프로젝트의 작업은 순서대로 실행됩니다.</span></div>
    <div className="run-filters panel">
      <div className="search-input"><Search size={17} aria-hidden /><input aria-label="실행 검색" value={q} onChange={event => setQ(event.target.value)} placeholder="실행 제목, 프롬프트 검색…" />
        {q && <IconButton label="실행 검색 지우기" icon={X} onClick={() => setQ('')} />}</div>
      <select aria-label="실행 에이전트 필터" value={agent} onChange={event => setAgent(event.target.value as typeof agent)}><option value="">모든 에이전트</option>
        {AGENTS.map(item => <option value={item} key={item}>{AGENT_META[item].name}</option>)}</select>
      <select aria-label="실행 프로젝트 필터" value={project} onChange={event => setProject(event.target.value)}><option value="">모든 프로젝트</option>
        {data.projects.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select>
      <select aria-label="실행 상태 필터" value={status} onChange={event => setStatus(event.target.value)}><option value="">모든 상태</option>
        <option value="queued">대기 중</option><option value="running">실행 중</option><option value="completed">완료</option>
        <option value="failed">실패</option><option value="cancelled">취소됨</option><option value="interrupted">중단됨</option></select>
      <div className="view-switch" aria-label="실행 보기 방식"><IconButton icon={LayoutGrid} label="보드 보기" aria-pressed={view === 'board'} className={view === 'board' ? 'active' : ''} onClick={() => setView('board')} />
        <IconButton icon={List} label="목록 보기" aria-pressed={view === 'list'} className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} /></div>
    </div>
    {!data.runs.length ? <div className="panel"><EmptyState icon={Terminal} title="첫 번째 작업을 실행해 보세요"
      description="프로젝트와 에이전트를 선택하고, 실행할 명령을 먼저 확인합니다." action={<Button icon={Plus} variant="primary" onClick={() => openNewRun()}>새 실행 만들기</Button>} /></div>
      : !filtered.length ? <div className="panel"><EmptyState icon={Search} title="조건에 맞는 실행이 없습니다" description="검색어나 필터를 바꿔보세요."
        action={<Button onClick={() => { setQ(''); setAgent(''); setProject(''); setStatus(''); }}>필터 초기화</Button>} /></div>
        : view === 'board' ? <div className="run-board">
          {COLUMNS.filter(column => !status || column.statuses.includes(status as RunStatus)).map(column => {
            const runs = filtered.filter(run => column.statuses.includes(run.status));
            return <section key={column.title} className={`run-column column-${column.className}`} aria-label={column.title}>
              <div className="run-column-heading"><i /><h2>{column.title}</h2><span>{runs.length}</span></div>
              <div className="run-column-cards">{runs.map(run => <RunCard key={run.id} run={run} />)}
                {!runs.length && <div className="run-column-empty">이 상태의 작업이 없습니다.</div>}</div>
            </section>;
          })}
        </div> : <div className="panel run-list-panel"><div className="table-scroll"><table className="data-table run-list-table">
          <thead><tr><th>실행</th><th>에이전트</th><th>상태</th><th>프로젝트</th><th>생성 시간</th><th><span className="sr-only">실행 작업</span></th></tr></thead>
          <tbody>{filtered.map(run => <tr key={run.id}><td><button className="table-title-button" onClick={() => openRun(run.id)}>{run.title}</button></td>
            <td><AgentBadge agent={run.agent} compact /></td><td><StatusBadge status={run.status} /></td><td>{run.projectName}</td>
            <td><time dateTime={run.createdAt}>{relativeTime(run.createdAt)}</time></td><td><RunActions run={run} small /></td></tr>)}</tbody>
        </table></div></div>}
    <p className="page-footnote">{number(filtered.length)}개 실행 표시 · 완료된 작업은 다시 시작되지 않습니다. 실패·취소·중단된 작업은 같은 설정으로 다시 시도할 수 있습니다.</p>
  </>;
}
