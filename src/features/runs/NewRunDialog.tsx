import { Trans, AppNotice } from '../../i18n/I18nProvider';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, Eye, FilePenLine, FlaskConical, Play, ShieldCheck, Terminal } from 'lucide-react';
import { AGENTS, type CommandPreview, type RunRequest } from '../../../shared/types';
import { Dialog } from '../../components/Dialog';
import { Button, CopyButton, Field, InlineNotice, ProviderMark } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { AGENT_META, errorMessage, number } from '../../lib/format';
import { useApp, useData, type NewRunDraft } from '../../state/AppProvider';
import {
  applyRunTemplate, buildRunRequest, canPreviewRun, canStartRun, changeRunTemplateInputs, chooseRunTemplate,
  commitRunContext, createRunDraft, runContextInput, runDraftSignature, selectRunContextPacks,
  updateRunFields, type RunContextDraft, type RunContextFields,
} from './RunContextModel';
import { RunContextAttachment } from './RunContextAttachment';
import { RunContextTemplate } from './RunContextTemplate';
import { RunContextRequestGate, runPreparationApi, type RunContextRequest } from './RunContextRequests';
import { useRunContextI18n } from './RunContextI18n';

export function NewRunDialog({ draft }: { draft: NewRunDraft }) {
  const { t, notice } = useRunContextI18n();
  const data = useData();
  const { closeModal, openRun, refresh, notify, navigate } = useApp();
  const [form, setForm] = useState(() => createRunDraft(draft, data));
  const formRef = useRef(form);
  const dataRef = useRef(data);
  dataRef.current = data;
  const [gate] = useState(() => new RunContextRequestGate());
  const mounted = useRef(true);
  const { agent, projectId, title, model, policy, allowShell, prompt } = form.fields;
  const { templateId, origin } = form;
  const [preview, setPreview] = useState<{ command: CommandPreview; request: RunRequest; signature: string } | null>(null);
  const acceptedPreview = useRef(preview);
  const [busy, setBusy] = useState<'preview' | 'execute' | 'context' | null>(null);
  const busyRef = useRef(busy);
  const activeRequest = useRef<{ operation: RunContextRequest; kind: 'preview' | 'execute' } | null>(null);
  const [error, setError] = useState('');
  const [previewCancelled, setPreviewCancelled] = useState(false);
  const [workConflict, setWorkConflict] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const project = data.projects.find(item => item.id === projectId);
  const connector = data.connectors.find(item => item.agent === agent);
  const projectLocked = !!origin.projectId && !!(origin.resumeSessionId || origin.workItemId);
  const templates = data.templates.map(item => form.template && item.id === form.template.id ? form.template : item);
  if (form.template && !templates.some(item => item.id === form.template!.id)) templates.push(form.template);
  const models = [...new Set([
    ...data.sessions.filter(session => session.agent === agent).map(session => session.model),
    ...data.runs.filter(run => run.agent === agent).map(run => run.model),
  ].filter((value): value is string => !!value && value !== 'unknown'))].sort();
  const signature = runDraftSignature(form);
  const previewValid = preview?.signature === signature;
  const validForm = canPreviewRun(form) && !!project;
  const executeAllowed = canStartRun(form, preview?.signature, data) && !busy;
  useEffect(() => {
    mounted.current = true;
    gate.activate();
    return () => { mounted.current = false; gate.dispose(); };
  }, [gate]);
  useEffect(() => { if (preview) previewRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }, [preview]);

  function markBusy(value: typeof busy) {
    busyRef.current = value;
    setBusy(value);
  }
  function invalidatePreview() { acceptedPreview.current = null; setPreview(null); }
  function edit(action: (current: RunContextDraft) => RunContextDraft) {
    const next = action(formRef.current);
    if (next === formRef.current) return;
    formRef.current = next;
    setForm(next);
    invalidatePreview();
    setError(''); setWorkConflict(false); setPreviewCancelled(false);
  }
  function change(patch: Partial<RunContextFields>) {
    if (!busyRef.current) edit(current => updateRunFields(current, patch));
  }
  function chooseTemplate(id: string) {
    if (busyRef.current) return;
    edit(current => chooseRunTemplate(current, dataRef.current.templates.find(item => item.id === id) ?? null));
  }
  async function prepare(event: FormEvent) {
    event.preventDefault();
    const current = formRef.current;
    if (busyRef.current) return;
    if (!canPreviewRun(current) || !dataRef.current.projects.some(item => item.id === current.fields.projectId)) {
      setError('프로젝트를 선택하고 실행할 프롬프트를 입력하세요.'); return;
    }
    const operation = gate.start();
    if (!operation) return;
    activeRequest.current = { operation, kind: 'preview' };
    markBusy('preview'); setError(''); setWorkConflict(false); setPreviewCancelled(false); invalidatePreview();
    const submitted = buildRunRequest(current);
    const submittedSignature = runDraftSignature(current);
    try {
      const command = await runPreparationApi.preview(submitted, operation.signal);
      if (!mounted.current || !operation.current() || runDraftSignature(formRef.current) !== submittedSignature) return;
      const result = { command, request: submitted, signature: submittedSignature };
      acceptedPreview.current = result; setPreview(result);
    } catch (cause) {
      if (mounted.current && operation.current()) setError(errorMessage(cause));
    } finally {
      if (operation.finish()) {
        activeRequest.current = null;
        if (mounted.current) markBusy(null);
      }
    }
  }
  async function execute() {
    const current = formRef.current;
    const accepted = acceptedPreview.current;
    const latest = dataRef.current;
    if (busyRef.current || !accepted || !canStartRun(current, accepted.signature, latest)) return;
    const operation = gate.start();
    if (!operation) return;
    activeRequest.current = { operation, kind: 'execute' };
    markBusy('execute'); setError(''); setWorkConflict(false); setPreviewCancelled(false);
    try {
      const run = await runPreparationApi.start(accepted.request, operation.signal);
      if (!mounted.current || !operation.current()) return;
      await refresh(true);
      if (!mounted.current || !operation.current()) return;
      notify('작업을 실행 대기열에 등록했습니다.');
      navigate('runs');
      openRun(run.id);
    } catch (cause) {
      if (mounted.current && operation.current()) {
        setError(errorMessage(cause)); invalidatePreview();
        setWorkConflict(!!current.origin.workItemId && cause instanceof ApiError && cause.status === 409);
      }
    } finally {
      if (operation.finish()) {
        activeRequest.current = null;
        if (mounted.current) markBusy(null);
      }
    }
  }
  function cancelPreview() {
    const active = activeRequest.current;
    if (active?.kind !== 'preview' || !active.operation.cancel()) return;
    activeRequest.current = null; markBusy(null); invalidatePreview();
    setError(''); setPreviewCancelled(true);
  }
  function close() {
    if (busyRef.current === 'execute') return;
    gate.dispose();
    closeModal();
  }
  function projects() { close(); navigate('projects'); }
  return <Dialog title={origin.resumeSessionId ? t("세션 이어가기") : origin.sourceSessionId ? t("전달받은 맥락으로 새 실행") : t("새 실행")}
    description={t("작업을 준비하고, 실행할 명령을 확인하세요.")} size="large" onClose={close} className="new-run-dialog"
    footer={<div className="new-run-footer">
      <span>{data.demo ? t("데모에서는 명령 미리보기까지만 가능합니다.") : previewValid ? t("확인한 명령으로 CLI를 시작합니다.") : t("실행 전에 명령 미리보기가 필요합니다.")}</span>
      <div><Button onClick={busy === 'preview' ? cancelPreview : close} disabled={busy === 'execute' || busy === 'context'}>
        {busy === 'preview' ? t('미리보기 취소') : t('닫기')}</Button>
        <Button type="submit" form="new-run-form" icon={Eye} busy={busy === 'preview'} disabled={busy === 'execute' || busy === 'context' || !validForm}><Trans message={"명령 미리보기"} /></Button>
        <Button variant="primary" icon={Play} busy={busy === 'execute'} disabled={!executeAllowed || busy === 'preview'}
          onClick={() => void execute()} aria-describedby={data.demo ? 'demo-execute-explanation' : undefined}><Trans message={"실행 시작"} /></Button></div>
    </div>}>
    <form id="new-run-form" onSubmit={prepare} className="form-stack">
      {data.demo && <InlineNotice tone="warning"><strong id="demo-execute-explanation"><FlaskConical size={15} aria-hidden /><Trans message={" 데모 모드 · 실제 실행은 비활성화되어 있습니다."} /></strong><p><Trans message={"프로젝트와 프롬프트를 바꾸고 생성된 명령을 확인할 수 있습니다."} /></p></InlineNotice>}
      {origin.resumeSessionId && <InlineNotice><Trans message={"선택한 CLI 세션의 맥락을 이어갑니다. 에이전트와 프로젝트는 원래 세션을 따릅니다."} /></InlineNotice>}
      {origin.sourceSessionId && <InlineNotice><Trans message={"전달받은 프롬프트를 검토하고 다음 작업에 맞게 수정하세요. 아직 실행되지 않았습니다."} /></InlineNotice>}
      {origin.workItemId && <InlineNotice>{t('작업에서 준비한 실행입니다. 준비한 작업 버전으로 결과를 연결합니다.')}</InlineNotice>}
      <fieldset disabled={!!busy} className="form-stack form-reset">
        <fieldset className="field"><legend><Trans message={"에이전트"} /></legend><div className="agent-picker">
          {AGENTS.map(item => <button type="button" key={item} className={`agent-option ${agent === item ? 'selected' : ''}`}
            aria-pressed={agent === item} disabled={!!origin.resumeSessionId && agent !== item}
            onClick={() => change({ agent: item, model: '' })}><ProviderMark agent={item} /><span>{AGENT_META[item].name}</span>{agent === item && <Check size={15} className="agent-option-check" aria-hidden />}</button>)}
        </div></fieldset>
        <div className="form-grid">
          <Field label={t("프로젝트")} htmlFor="run-project"><select id="run-project" required value={projectId} disabled={projectLocked}
            onChange={event => change({ projectId: event.target.value })}>
            {projectId && !project && <option value={projectId} disabled>{projectId}</option>}
            <option value="" disabled><Trans message={"프로젝트 선택"} /></option>{data.projects.map(item => <option key={item.id} value={item.id}>{item.name}{item.executionEnabled ? '' : t(" · 실행 허용 필요")}</option>)}
          </select></Field>
          <Field label={t("템플릿 (선택)")} htmlFor="run-template"><select id="run-template" value={templateId} onChange={event => chooseTemplate(event.target.value)}>
            <option value=""><Trans message={"직접 작성"} /></option>
            {templateId && !templates.some(item => item.id === templateId) && <option value={templateId} disabled>{templateId}</option>}
            {templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
          </select></Field>
        </div>
        {projectLocked && origin.workItemId && <p className="field-hint">{t('프로젝트가 지정된 작업은 원래 프로젝트에 연결됩니다.')}</p>}
        <RunContextTemplate template={form.template} templateId={templateId} pending={form.templatePending}
          inputsOpen={form.templateInputsOpen} disabled={!!busy}
          onEditInputs={() => { if (!busyRef.current) edit(changeRunTemplateInputs); }}
          onInputsChange={() => { if (!busyRef.current) edit(changeRunTemplateInputs); }}
          onApply={rendered => { if (!busyRef.current) edit(current => applyRunTemplate(current, templateId, rendered)); }} />
        {project ? <div className="selected-project"><code>{project.path}</code><span className={project.executionEnabled ? 'permission-enabled' : 'permission-disabled'}>
          <ShieldCheck size={13} aria-hidden />{project.executionEnabled ? t("실행 허용됨") : t("실행 비허용")}</span></div>
          : <InlineNotice><Trans message={"실행할 프로젝트가 없습니다. "} /><button type="button" className="text-button" onClick={projects}><Trans message={"프로젝트 추가"} /><ArrowRight size={13} aria-hidden /></button></InlineNotice>}
        {project && !project.executionEnabled && <InlineNotice tone="warning"><Trans message={"이 프로젝트는 실행을 허용하지 않았습니다. "} /><button type="button" className="text-button" onClick={projects}><Trans message={"프로젝트에서 실행 허용"} /></button></InlineNotice>}
        {!data.demo && connector && !connector.installed && <InlineNotice tone="warning"><Trans message={"{0} CLI가 설치되어 있지 않습니다. CLI를 설치한 뒤 설정에서 다시 확인하세요."} values={{ "0": AGENT_META[agent].name }} /></InlineNotice>}
        <div className="form-grid">
          <Field label={t("실행 제목 (선택)")} htmlFor="run-title"><input id="run-title" value={title} maxLength={200} placeholder={t("어떤 작업인가요?")}
            onChange={event => change({ title: event.target.value })} /></Field>
          <Field label={t("모델 (선택)")} htmlFor="run-model" hint={t("비워두면 CLI의 기본 모델을 사용합니다.")}><input id="run-model" value={model} list="run-models"
            maxLength={160} placeholder={t("CLI 기본 모델")} onChange={event => change({ model: event.target.value })} /><datalist id="run-models">{models.map(item => <option value={item} key={item} />)}</datalist></Field>
        </div>
        <fieldset className="field"><legend><Trans message={"작업 권한"} /></legend><div className="policy-picker">
          <label className={`policy-option ${policy === 'read-only' ? 'selected' : ''}`}><input type="radio" name="run-policy" value="read-only" checked={policy === 'read-only'} onChange={() => change({ policy: 'read-only' })} />
            <ShieldCheck size={19} aria-hidden /><span><strong><Trans message={"읽기 전용"} /><code>read-only</code></strong><small><Trans message={"파일 변경을 제한하고 살펴봅니다."} /></small></span></label>
          <label className={`policy-option ${policy === 'workspace-write' ? 'selected' : ''}`}><input type="radio" name="run-policy" value="workspace-write" checked={policy === 'workspace-write'} onChange={() => change({ policy: 'workspace-write' })} />
            <FilePenLine size={19} aria-hidden /><span><strong><Trans message={"워크스페이스 쓰기"} /><code>workspace-write</code></strong><small><Trans message={"프로젝트 파일 변경을 허용합니다."} /></small></span></label>
        </div></fieldset>
        {agent !== 'codex' && policy === 'workspace-write' && <label className={`execution-permission ${allowShell ? 'permission-checked' : ''}`}>
          <input type="checkbox" checked={allowShell} onChange={event => change({ allowShell: event.target.checked })} />
          <span><strong><Trans message={"터미널 명령 허용"} /></strong><small><Trans message={"테스트·빌드 명령을 자동 실행합니다. CLI 도구 권한이며 운영체제 샌드박스는 아닙니다."} /></small></span>
        </label>}
        <Field label={t("프롬프트")} htmlFor="run-prompt"><textarea id="run-prompt" className="prompt-textarea" required rows={7} maxLength={64_000}
          value={prompt} onChange={event => change({ prompt: event.target.value })}
          placeholder={origin.resumeSessionId ? t("이어서 진행할 작업과 원하는 결과를 적어주세요.") : t("에이전트가 수행할 작업, 범위, 원하는 결과를 구체적으로 적어주세요.")} />
          <div className="prompt-meta"><span>{origin.sourceSessionId ? t("전달된 맥락을 자유롭게 수정할 수 있습니다.") : t("구체적인 목표와 범위가 좋은 실행의 시작입니다.")}</span><span className="numeric">{number(prompt.length)} / 64,000</span></div>
        </Field>
      </fieldset>
      <RunContextAttachment value={runContextInput(form)} projectId={projectId || undefined} gate={gate}
        disabled={busy === 'preview' || busy === 'execute'}
        onSelect={ids => { if (!busyRef.current) edit(current => selectRunContextPacks(current, ids)); }}
        onApply={(application, input) => edit(current => commitRunContext(current, input, application))}
        onBusyChange={active => {
          if (!mounted.current) return;
          if (active) { markBusy('context'); invalidatePreview(); setError(''); setPreviewCancelled(false); }
          else if (busyRef.current === 'context') markBusy(null);
        }} />
      {previewCancelled && <InlineNotice>{t('미리보기를 취소했습니다. 작성 중인 초안은 그대로 유지됩니다.')}</InlineNotice>}
      {error && <InlineNotice tone="error">{notice(error)}
        {workConflict && <p>{t('작업이 변경되었을 수 있습니다. 초안은 유지되며, 작업의 최신 상태를 확인한 뒤 다시 준비할 수 있습니다.')}</p>}
      </InlineNotice>}
      {preview && previewValid && <div className="command-preview" ref={previewRef}>
        <div className="command-preview-heading"><span><Terminal size={17} aria-hidden /><strong><Trans message={"실행 명령 확인"} /></strong></span><CopyButton text={preview.command.displayCommand} compact label={t("실행 명령 복사")} /></div>
        <pre><code>{preview.command.displayCommand}</code></pre>
        <dl><div><dt><Trans message={"작업 디렉터리"} /></dt><dd><code>{preview.command.cwd}</code></dd></div><div><dt><Trans message={"적용 권한"} /></dt><dd><AppNotice message={preview.command.policyDescription} /></dd></div></dl>
        {preview.command.warnings.map((warning, index) => <InlineNotice key={index} tone="warning"><AppNotice message={warning} /></InlineNotice>)}
      </div>}
    </form>
  </Dialog>;
}
