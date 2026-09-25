import { useMemo, useState, type CSSProperties } from 'react';
import { ArrowRight, Folder, FolderPlus, Layers3, MessageSquare, Pencil, Play, Search, ShieldCheck } from 'lucide-react';
import type { Project } from '../../shared/types';
import { AggregateTokenValue, Button, EmptyState, IconButton, InlineNotice, PageHeading, ProviderMark, Switch } from '../components/ui';
import { ProjectDialog } from '../features/projects/ProjectDialog';
import { api } from '../lib/api';
import { errorMessage, number, projectColor } from '../lib/format';
import { useApp, useData } from '../state/AppProvider';

function ProjectCard({ project, onEdit }: { project: Project; onEdit: () => void }) {
  const data = useData();
  const { navigate, openNewRun, refresh, notify } = useApp();
  const [busy, setBusy] = useState(false);
  const analytics = data.analytics.projects.find(item => item.path === project.path);
  const agents = [...new Set(data.sessions.filter(session => session.projectPath === project.path).map(session => session.agent))];
  async function toggle() {
    setBusy(true);
    try {
      await api.updateProject(project.id, { executionEnabled: !project.executionEnabled });
      await refresh(true);
      notify(project.executionEnabled ? '프로젝트의 실행 허용을 껐습니다.' : '프로젝트에서 에이전트를 실행할 수 있습니다.');
    } catch (error) { notify(errorMessage(error), 'error'); }
    finally { setBusy(false); }
  }
  return <article className="project-card" style={{ '--project-color': projectColor(project.color) } as CSSProperties}>
    <div className="project-card-heading"><span className="project-folder"><Folder size={23} strokeWidth={1.7} aria-hidden /></span>
      <IconButton icon={Pencil} label={`${project.name} 프로젝트 편집`} onClick={onEdit} /></div>
    <h2>{project.name}</h2><code className="project-path">{project.path}</code>
    <div className="project-card-metrics"><span><MessageSquare size={14} aria-hidden /><strong>{number(analytics?.sessions ?? 0)}</strong>세션</span>
      <span><Layers3 size={14} aria-hidden /><AggregateTokenValue tokens={analytics?.tokens ?? 0} knownTokenSessions={analytics?.knownTokenSessions ?? 0}
        sessions={analytics?.sessions ?? 0} showCoverage={false} />토큰</span>
      <span className="project-agents" title="최근 세션에 기록된 에이전트">{agents.map(agent => <ProviderMark agent={agent} size="small" key={agent} />)}</span></div>
    {!!analytics && analytics.knownTokenSessions > 0 && analytics.knownTokenSessions < analytics.sessions && <p className="project-usage-coverage">
      토큰은 {analytics.knownTokenSessions}/{analytics.sessions}개 세션의 부분 기록입니다.</p>}
    <div className={`project-execution ${project.executionEnabled ? 'enabled' : ''}`}><div><ShieldCheck size={15} aria-hidden />
      <span><strong>에이전트 실행 {project.executionEnabled ? '허용' : '비허용'}</strong><small>{project.executionEnabled ? '이 디렉터리에서 CLI를 시작할 수 있습니다.' : '켜면 이 디렉터리에서 CLI를 실행할 수 있습니다.'}</small></span></div>
      <Switch checked={project.executionEnabled} label={`${project.name} 에이전트 실행 허용`} disabled={busy} onChange={() => void toggle()} /></div>
    <div className="project-card-footer"><button className="text-button" onClick={() => navigate('sessions', { project: project.path })}>세션 보기<ArrowRight size={14} aria-hidden /></button>
      <Button size="small" icon={Play} onClick={() => openNewRun({ projectId: project.id })}>새 실행</Button></div>
  </article>;
}

export function Projects() {
  const data = useData();
  const [q, setQ] = useState('');
  const [editor, setEditor] = useState<Project | 'new' | null>(null);
  const projects = useMemo(() => data.projects.filter(project => `${project.name} ${project.path}`.toLocaleLowerCase().includes(q.toLocaleLowerCase())), [data.projects, q]);
  return <>
    <PageHeading title="프로젝트" description="작업 디렉터리별로 대화를 정리하고, 실행할 수 있는 범위를 관리하세요." eyebrow="PROJECT WORKSPACES"
      actions={<Button variant="primary" icon={FolderPlus} onClick={() => setEditor('new')}>프로젝트 추가</Button>} />
    <div className="project-page-toolbar"><span><strong>{data.projects.length}개</strong> 프로젝트<span className="meta-separator">·</span>{data.projects.filter(project => project.executionEnabled).length}개 실행 허용</span>
      <div className="search-input"><Search size={16} aria-hidden /><input aria-label="프로젝트 검색" placeholder="이름 또는 경로 검색" value={q} onChange={event => setQ(event.target.value)} /></div></div>
    {projects.length ? <div className="project-grid">{projects.map(project => <ProjectCard key={project.id} project={project} onEdit={() => setEditor(project)} />)}</div>
      : <div className="panel"><EmptyState icon={Folder} title={q ? '찾는 프로젝트가 없습니다' : '프로젝트를 추가해 보세요'}
        description={q ? '다른 이름이나 경로로 검색해 보세요.' : '기존 디렉터리를 등록하면 해당 프로젝트의 세션과 실행을 한곳에서 볼 수 있습니다.'}
        action={q ? <Button onClick={() => setQ('')}>검색 초기화</Button> : <Button icon={FolderPlus} variant="primary" onClick={() => setEditor('new')}>프로젝트 추가</Button>} /></div>}
    <div className="project-guidance"><InlineNotice>세션에서 가져온 프로젝트는 기본적으로 실행을 허용하지 않습니다. 실행 허용을 꺼도 기존 기록은 유지되며, 진행 중인 작업의 취소는 실행 보드에서 할 수 있습니다.</InlineNotice></div>
    {editor && <ProjectDialog project={editor === 'new' ? undefined : editor} onClose={() => setEditor(null)} />}
  </>;
}
