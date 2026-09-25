import { useState, type FormEvent } from 'react';
import { Eye, FilePenLine, Save } from 'lucide-react';
import { AGENTS, type PromptTemplate } from '../../../shared/types';
import { Dialog } from '../../components/Dialog';
import { Markdown } from '../../components/Markdown';
import { Button, Field, InlineNotice } from '../../components/ui';
import { api } from '../../lib/api';
import { AGENT_META, errorMessage, TEMPLATE_CATEGORIES as CATEGORIES } from '../../lib/format';
import { useApp } from '../../state/AppProvider';

export function TemplateEditor({ template, onClose }: { template?: PromptTemplate; onClose: () => void }) {
  const { refresh, notify } = useApp();
  const [name, setName] = useState(template?.name ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [category, setCategory] = useState<PromptTemplate['category']>(template?.category ?? 'custom');
  const [agent, setAgent] = useState<PromptTemplate['agent']>(template?.agent ?? 'any');
  const [policy, setPolicy] = useState<PromptTemplate['policy']>(template?.policy ?? 'read-only');
  const [prompt, setPrompt] = useState(template?.prompt ?? '');
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !prompt.trim()) { setError('템플릿 이름과 프롬프트를 입력하세요.'); setPreview(false); return; }
    setBusy(true); setError('');
    try {
      const fields = { name: name.trim(), description: description.trim(), category, agent, policy, prompt: prompt.trim() };
      if (template) await api.updateTemplate(template.id, fields);
      else await api.createTemplate(fields);
      await refresh(true); notify(template ? '템플릿을 저장했습니다.' : '템플릿을 만들었습니다.'); onClose();
    } catch (cause) { setError(errorMessage(cause)); setBusy(false); }
  }
  return <Dialog title={template ? '템플릿 편집' : '새 템플릿'} description="반복하는 작업을 프롬프트로 저장하세요." onClose={onClose} size="large"
    footer={<><Button onClick={onClose} disabled={busy}>취소</Button><Button type="submit" form="template-editor" variant="primary" icon={Save} busy={busy}>템플릿 저장</Button></>}>
    <form id="template-editor" className="form-stack" onSubmit={save}>
      <div className="form-grid"><Field label="템플릿 이름" htmlFor="template-name"><input id="template-name" autoFocus data-autofocus required maxLength={200}
        value={name} onChange={event => setName(event.target.value)} placeholder="반복해서 사용할 작업 이름" /></Field>
      <Field label="분류" htmlFor="template-category"><select id="template-category" value={category} onChange={event => setCategory(event.target.value as typeof category)}>
        {Object.entries(CATEGORIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field></div>
      <Field label="설명" htmlFor="template-description"><input id="template-description" maxLength={500} value={description}
        onChange={event => setDescription(event.target.value)} placeholder="어떤 상황에서 사용하는 템플릿인가요?" /></Field>
      <div className="form-grid"><Field label="기본 에이전트" htmlFor="template-agent"><select id="template-agent" value={agent} onChange={event => setAgent(event.target.value as typeof agent)}>
        <option value="any">모든 에이전트</option>{AGENTS.map(item => <option key={item} value={item}>{AGENT_META[item].name}</option>)}</select></Field>
      <Field label="기본 작업 권한" htmlFor="template-policy"><select id="template-policy" value={policy} onChange={event => setPolicy(event.target.value as typeof policy)}>
        <option value="read-only">읽기 전용 · read-only</option><option value="workspace-write">워크스페이스 쓰기 · workspace-write</option></select></Field></div>
      <div className="template-prompt-heading"><label htmlFor="template-prompt">프롬프트</label><Button size="small" icon={preview ? FilePenLine : Eye}
        disabled={!prompt.trim() && !preview} onClick={() => setPreview(value => !value)}>{preview ? '편집하기' : '미리보기'}</Button></div>
      {preview ? <div className="template-markdown-preview"><Markdown content={prompt} /></div>
        : <textarea id="template-prompt" required rows={11} maxLength={32_000} value={prompt} onChange={event => setPrompt(event.target.value)}
          className="prompt-textarea" placeholder="목표, 작업 범위, 확인할 항목과 결과 형식을 적어주세요." />}
      <p className="field-hint">템플릿을 사용할 때 프로젝트와 프롬프트를 다시 수정할 수 있습니다.</p>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </form>
  </Dialog>;
}
