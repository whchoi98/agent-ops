import { useState, type FormEvent } from 'react';
import { Check, FolderPlus, Save } from 'lucide-react';
import type { Project } from '../../../shared/types';
import { Dialog } from '../../components/Dialog';
import { Button, Field, InlineNotice } from '../../components/ui';
import { api } from '../../lib/api';
import { errorMessage, projectColor } from '../../lib/format';
import { useApp } from '../../state/AppProvider';

const COLORS = ['#3564e8', '#0e9f8f', '#8b5cf6', '#c57455', '#c9962b', '#64748b'];

export function ProjectDialog({ project, onClose }: { project?: Project; onClose: () => void }) {
  const { refresh, notify } = useApp();
  const [name, setName] = useState(project?.name ?? '');
  const [path, setPath] = useState(project?.path ?? '');
  const [color, setColor] = useState(projectColor(project?.color));
  const [enabled, setEnabled] = useState(project?.executionEnabled ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !path.trim()) { setError('프로젝트 이름과 경로를 입력하세요.'); return; }
    setBusy(true); setError('');
    try {
      if (project) await api.updateProject(project.id, { name: name.trim(), color, executionEnabled: enabled });
      else await api.createProject({ name: name.trim(), path: path.trim(), color, executionEnabled: enabled });
      await refresh(true);
      notify(project ? '프로젝트를 저장했습니다.' : '프로젝트를 추가했습니다.');
      onClose();
    } catch (cause) { setError(errorMessage(cause)); setBusy(false); }
  }
  return <Dialog title={project ? '프로젝트 편집' : '프로젝트 추가'} description="대화를 정리하고 에이전트를 실행할 작업 디렉터리를 등록하세요."
    onClose={onClose} size="medium" footer={<><Button onClick={onClose} disabled={busy}>취소</Button>
      <Button variant="primary" type="submit" form="project-form" icon={project ? Save : FolderPlus} busy={busy}>{project ? '프로젝트 저장' : '프로젝트 추가'}</Button></>}>
    <form id="project-form" className="form-stack" onSubmit={save}>
      <Field label="프로젝트 이름" htmlFor="project-name"><input id="project-name" autoFocus data-autofocus required maxLength={200}
        value={name} onChange={event => setName(event.target.value)} placeholder="프로젝트 이름" /></Field>
      <Field label="프로젝트 경로" htmlFor="project-path" hint={project ? '등록된 작업 디렉터리입니다.' : '이 컴퓨터에 존재하는 디렉터리의 전체 경로를 입력하세요.'}>
        <input id="project-path" required maxLength={4096} readOnly={!!project} value={path} onChange={event => setPath(event.target.value)}
          className="mono" placeholder="/home/user/projects/my-project" /></Field>
      <fieldset className="field"><legend>프로젝트 색상</legend><div className="color-picker">
        {COLORS.map(value => <button type="button" key={value} aria-label={`${value} 색상`} aria-pressed={color === value}
          style={{ background: value }} onClick={() => setColor(value)} className={color === value ? 'selected' : ''}>{color === value && <Check size={16} aria-hidden />}</button>)}
        <label className="custom-color"><span>직접 선택</span><input type="color" aria-label="프로젝트 색상 직접 선택" value={color} onChange={event => setColor(event.target.value)} /></label>
      </div></fieldset>
      <label className={`execution-permission ${enabled ? 'permission-checked' : ''}`}><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
        <span><strong>이 프로젝트에서 에이전트 실행 허용</strong><small>허용하면 선택한 디렉터리에서 CLI 작업을 시작할 수 있습니다. 실행할 때마다 명령을 먼저 확인합니다.</small></span></label>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </form>
  </Dialog>;
}
