import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, Eye, FilePenLine, FlaskConical, Play, ShieldCheck, Terminal } from 'lucide-react';
import { AGENTS, type Agent, type CommandPreview, type Policy, type RunRequest } from '../../../shared/types';
import { Dialog } from '../../components/Dialog';
import { Button, CopyButton, Field, InlineNotice, ProviderMark } from '../../components/ui';
import { api } from '../../lib/api';
import { AGENT_META, errorMessage, number } from '../../lib/format';
import { useApp, useData, type NewRunDraft } from '../../state/AppProvider';

export function NewRunDialog({ draft }: { draft: NewRunDraft }) {
  const data = useData();
  const { closeModal, openRun, refresh, notify, navigate } = useApp();
  const [agent, setAgent] = useState<Agent>(draft.agent ?? 'codex');
  const [projectId, setProjectId] = useState(draft.projectId ?? data.projects.find(project => project.executionEnabled)?.id ?? data.projects[0]?.id ?? '');
  const [templateId, setTemplateId] = useState(draft.templateId ?? '');
  const [title, setTitle] = useState(draft.title ?? '');
  const [model, setModel] = useState(draft.model ?? '');
  const [policy, setPolicy] = useState<Policy>(draft.policy ?? 'read-only');
  const [allowShell, setAllowShell] = useState(false);
  const [prompt, setPrompt] = useState(draft.prompt ?? '');
  const [preview, setPreview] = useState<{ command: CommandPreview; request: RunRequest; signature: string } | null>(null);
  const [busy, setBusy] = useState<'preview' | 'execute' | null>(null);
  const [error, setError] = useState('');
  const previewRef = useRef<HTMLDivElement>(null);
  const project = data.projects.find(item => item.id === projectId);
  const connector = data.connectors.find(item => item.agent === agent);
  const models = [...new Set([
    ...data.sessions.filter(session => session.agent === agent).map(session => session.model),
    ...data.runs.filter(run => run.agent === agent).map(run => run.model),
  ].filter((value): value is string => !!value && value !== 'unknown'))].sort();
  const request: RunRequest = {
    agent, projectId, prompt: prompt.trim(), policy,
    ...(title.trim() ? { title: title.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}),
    ...(draft.resumeSessionId ? { resumeSessionId: draft.resumeSessionId } : {}),
    ...(draft.sourceSessionId ? { sourceSessionId: draft.sourceSessionId } : {}),
    ...(templateId ? { templateId } : {}),
    ...(agent !== 'codex' && policy === 'workspace-write' ? { allowShell } : {}),
  };
  const signature = JSON.stringify(request);
  const previewValid = preview?.signature === signature;
  const validForm = !!projectId && !!prompt.trim() && prompt.trim().length <= 64_000;
  const executeAllowed = previewValid && !data.demo && project?.executionEnabled && connector?.installed && validForm;
  useEffect(() => { setPreview(null); setError(''); }, [signature]);
  useEffect(() => { if (agent === 'codex' || policy === 'read-only') setAllowShell(false); }, [agent, policy]);
  useEffect(() => { if (preview) previewRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }, [preview]);

  function applyTemplate(id: string) {
    setTemplateId(id);
    if (!id) return;
    const template = data.templates.find(item => item.id === id);
    if (!template) return;
    setPrompt(template.prompt); setPolicy(template.policy);
    if (!title || data.templates.some(item => item.name === title)) setTitle(template.name);
    if (template.agent !== 'any' && !draft.resumeSessionId) { setAgent(template.agent); setModel(''); }
  }
  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (!validForm) { setError('프로젝트를 선택하고 실행할 프롬프트를 입력하세요.'); return; }
    setBusy('preview'); setError('');
    const submitted = request;
    const submittedSignature = signature;
    try {
      const command = await api.previewRun(submitted);
      setPreview({ command, request: submitted, signature: submittedSignature });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(null); }
  }
  async function execute() {
    if (!executeAllowed || !preview || busy) return;
    setBusy('execute'); setError('');
    try {
      const run = await api.createRun(preview.request);
      await refresh(true);
      notify('작업을 실행 대기열에 등록했습니다.');
      navigate('runs');
      openRun(run.id);
    } catch (cause) { setError(errorMessage(cause)); setBusy(null); }
  }
  function projects() { closeModal(); navigate('projects'); }
  return <Dialog title={draft.resumeSessionId ? '세션 이어가기' : draft.sourceSessionId ? '전달받은 맥락으로 새 실행' : '새 실행'}
    description="작업을 준비하고, 실행할 명령을 확인하세요." size="large" onClose={closeModal} className="new-run-dialog"
    footer={<div className="new-run-footer">
      <span>{data.demo ? '데모에서는 명령 미리보기까지만 가능합니다.' : previewValid ? '확인한 명령으로 CLI를 시작합니다.' : '실행 전에 명령 미리보기가 필요합니다.'}</span>
      <div><Button onClick={closeModal} disabled={!!busy}>닫기</Button>
        <Button type="submit" form="new-run-form" icon={Eye} busy={busy === 'preview'} disabled={busy === 'execute' || !validForm}>명령 미리보기</Button>
        <Button variant="primary" icon={Play} busy={busy === 'execute'} disabled={!executeAllowed || busy === 'preview'}
          onClick={() => void execute()} aria-describedby={data.demo ? 'demo-execute-explanation' : undefined}>실행 시작</Button></div>
    </div>}>
    <form id="new-run-form" onSubmit={prepare} className="form-stack">
      {data.demo && <InlineNotice tone="warning"><strong id="demo-execute-explanation"><FlaskConical size={15} aria-hidden /> 데모 모드 · 실제 실행은 비활성화되어 있습니다.</strong><p>프로젝트와 프롬프트를 바꾸고 생성된 명령을 확인할 수 있습니다.</p></InlineNotice>}
      {draft.resumeSessionId && <InlineNotice>선택한 CLI 세션의 맥락을 이어갑니다. 에이전트와 프로젝트는 원래 세션을 따릅니다.</InlineNotice>}
      {draft.sourceSessionId && <InlineNotice>전달받은 프롬프트를 검토하고 다음 작업에 맞게 수정하세요. 아직 실행되지 않았습니다.</InlineNotice>}
      <fieldset disabled={!!busy} className="form-stack form-reset">
        <fieldset className="field"><legend>에이전트</legend><div className="agent-picker">
          {AGENTS.map(item => <button type="button" key={item} className={`agent-option ${agent === item ? 'selected' : ''}`}
            aria-pressed={agent === item} disabled={!!draft.resumeSessionId && agent !== item}
            onClick={() => { setAgent(item); setModel(''); }}><ProviderMark agent={item} /><span>{AGENT_META[item].name}</span>{agent === item && <Check size={15} className="agent-option-check" aria-hidden />}</button>)}
        </div></fieldset>
        <div className="form-grid">
          <Field label="프로젝트" htmlFor="run-project"><select id="run-project" required value={projectId} disabled={!!draft.resumeSessionId && !!draft.projectId}
            onChange={event => setProjectId(event.target.value)}>
            <option value="" disabled>프로젝트 선택</option>{data.projects.map(item => <option key={item.id} value={item.id}>{item.name}{item.executionEnabled ? '' : ' · 실행 허용 필요'}</option>)}
          </select></Field>
          <Field label="템플릿 (선택)" htmlFor="run-template"><select id="run-template" value={templateId} onChange={event => applyTemplate(event.target.value)}>
            <option value="">직접 작성</option>{data.templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
          </select></Field>
        </div>
        {project ? <div className="selected-project"><code>{project.path}</code><span className={project.executionEnabled ? 'permission-enabled' : 'permission-disabled'}>
          <ShieldCheck size={13} aria-hidden />{project.executionEnabled ? '실행 허용됨' : '실행 비허용'}</span></div>
          : <InlineNotice>실행할 프로젝트가 없습니다. <button type="button" className="text-button" onClick={projects}>프로젝트 추가<ArrowRight size={13} aria-hidden /></button></InlineNotice>}
        {project && !project.executionEnabled && <InlineNotice tone="warning">이 프로젝트는 실행을 허용하지 않았습니다. <button type="button" className="text-button" onClick={projects}>프로젝트에서 실행 허용</button></InlineNotice>}
        {!data.demo && connector && !connector.installed && <InlineNotice tone="warning">{AGENT_META[agent].name} CLI가 설치되어 있지 않습니다. CLI를 설치한 뒤 설정에서 다시 확인하세요.</InlineNotice>}
        <div className="form-grid">
          <Field label="실행 제목 (선택)" htmlFor="run-title"><input id="run-title" value={title} maxLength={200} placeholder="어떤 작업인가요?"
            onChange={event => setTitle(event.target.value)} /></Field>
          <Field label="모델 (선택)" htmlFor="run-model" hint="비워두면 CLI의 기본 모델을 사용합니다."><input id="run-model" value={model} list="run-models"
            maxLength={160} placeholder="CLI 기본 모델" onChange={event => setModel(event.target.value)} /><datalist id="run-models">{models.map(item => <option value={item} key={item} />)}</datalist></Field>
        </div>
        <fieldset className="field"><legend>작업 권한</legend><div className="policy-picker">
          <label className={`policy-option ${policy === 'read-only' ? 'selected' : ''}`}><input type="radio" name="run-policy" value="read-only" checked={policy === 'read-only'} onChange={() => setPolicy('read-only')} />
            <ShieldCheck size={19} aria-hidden /><span><strong>읽기 전용<code>read-only</code></strong><small>파일 변경을 제한하고 살펴봅니다.</small></span></label>
          <label className={`policy-option ${policy === 'workspace-write' ? 'selected' : ''}`}><input type="radio" name="run-policy" value="workspace-write" checked={policy === 'workspace-write'} onChange={() => setPolicy('workspace-write')} />
            <FilePenLine size={19} aria-hidden /><span><strong>워크스페이스 쓰기<code>workspace-write</code></strong><small>프로젝트 파일 변경을 허용합니다.</small></span></label>
        </div></fieldset>
        {agent !== 'codex' && policy === 'workspace-write' && <label className={`execution-permission ${allowShell ? 'permission-checked' : ''}`}>
          <input type="checkbox" checked={allowShell} onChange={event => setAllowShell(event.target.checked)} />
          <span><strong>터미널 명령 허용</strong><small>테스트·빌드 명령을 자동 실행합니다. CLI 도구 권한이며 운영체제 샌드박스는 아닙니다.</small></span>
        </label>}
        <Field label="프롬프트" htmlFor="run-prompt"><textarea id="run-prompt" className="prompt-textarea" required rows={7} maxLength={64_000}
          value={prompt} onChange={event => setPrompt(event.target.value)}
          placeholder={draft.resumeSessionId ? '이어서 진행할 작업과 원하는 결과를 적어주세요.' : '에이전트가 수행할 작업, 범위, 원하는 결과를 구체적으로 적어주세요.'} />
          <div className="prompt-meta"><span>{draft.sourceSessionId ? '전달된 맥락을 자유롭게 수정할 수 있습니다.' : '구체적인 목표와 범위가 좋은 실행의 시작입니다.'}</span><span className="numeric">{number(prompt.length)} / 64,000</span></div>
        </Field>
      </fieldset>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {preview && previewValid && <div className="command-preview" ref={previewRef}>
        <div className="command-preview-heading"><span><Terminal size={17} aria-hidden /><strong>실행 명령 확인</strong></span><CopyButton text={preview.command.displayCommand} compact label="실행 명령 복사" /></div>
        <pre><code>{preview.command.displayCommand}</code></pre>
        <dl><div><dt>작업 디렉터리</dt><dd><code>{preview.command.cwd}</code></dd></div><div><dt>적용 권한</dt><dd>{preview.command.policyDescription}</dd></div></dl>
        {preview.command.warnings.map((warning, index) => <InlineNotice key={index} tone="warning">{warning}</InlineNotice>)}
      </div>}
    </form>
  </Dialog>;
}
