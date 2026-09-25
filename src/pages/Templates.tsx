import { lazy, Suspense, useState } from 'react';
import { ArrowRight, BookOpen, Code2, FileText, Pencil, Plus, Search, ShieldCheck, Trash2 } from 'lucide-react';
import type { PromptTemplate } from '../../shared/types';
import { Dialog } from '../components/Dialog';
import { AgentBadge, Button, EmptyState, IconButton, InlineNotice, PageHeading } from '../components/ui';
import { api } from '../lib/api';
import { dateTime, errorMessage, relativeTime, TEMPLATE_CATEGORIES as CATEGORIES } from '../lib/format';
import { useApp, useData } from '../state/AppProvider';

const TemplateEditor = lazy(() => import('../features/templates/TemplateEditor').then(module => ({ default: module.TemplateEditor })));

export function Templates() {
  const data = useData();
  const { openNewRun, refresh, notify } = useApp();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<PromptTemplate['category'] | ''>('');
  const [editor, setEditor] = useState<PromptTemplate | 'new' | null>(null);
  const [deleting, setDeleting] = useState<PromptTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const templates = data.templates.filter(template => (!category || template.category === category) &&
    `${template.name} ${template.description} ${template.prompt}`.toLocaleLowerCase().includes(q.toLocaleLowerCase()));
  async function remove() {
    if (!deleting) return;
    setBusy(true); setError('');
    try {
      await api.deleteTemplate(deleting.id);
      await refresh(true); notify('템플릿을 삭제했습니다.'); setDeleting(null);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  function useTemplate(template: PromptTemplate) {
    openNewRun({ templateId: template.id, title: template.name, prompt: template.prompt, policy: template.policy,
      ...(template.agent !== 'any' ? { agent: template.agent } : {}) });
  }
  return <>
    <PageHeading title="프롬프트 템플릿" description="잘 작동하는 지시를 저장하고, 반복되는 작업에 다시 사용하세요." eyebrow="PROMPT LIBRARY"
      actions={<Button variant="primary" icon={Plus} onClick={() => setEditor('new')}>새 템플릿</Button>} />
    <div className="template-toolbar"><div className="category-tabs" aria-label="템플릿 분류">
      <button aria-pressed={!category} className={!category ? 'active' : ''} onClick={() => setCategory('')}>전체<span>{data.templates.length}</span></button>
      {Object.entries(CATEGORIES).map(([value, label]) => <button key={value} aria-pressed={category === value} className={category === value ? 'active' : ''}
        onClick={() => setCategory(value as PromptTemplate['category'])}>{label}</button>)}</div>
      <div className="search-input"><Search size={16} aria-hidden /><input aria-label="템플릿 검색" value={q} onChange={event => setQ(event.target.value)} placeholder="템플릿 검색…" /></div>
    </div>
    {templates.length ? <div className="template-grid">{templates.map(template => <article className="template-card" key={template.id}>
      <div className="template-card-heading"><span className={`template-category-icon category-${template.category}`}>{template.category === 'docs' ? <FileText size={20} aria-hidden /> : template.category === 'build' ? <Code2 size={20} aria-hidden /> : <BookOpen size={20} aria-hidden />}</span>
        <span className="category-label">{CATEGORIES[template.category]}</span><div>
          <IconButton icon={Pencil} label={`${template.name} 템플릿 편집`} onClick={() => setEditor(template)} />
          <IconButton icon={Trash2} label={`${template.name} 템플릿 삭제`} onClick={() => { setDeleting(template); setError(''); }} /></div></div>
      <h2>{template.name}</h2><p className="template-description">{template.description || '저장한 프롬프트를 새 작업에 사용하세요.'}</p>
      <pre className="template-prompt-preview">{template.prompt}</pre>
      <div className="template-card-meta">{template.agent === 'any' ? <span className="any-agent-label">모든 에이전트</span> : <AgentBadge agent={template.agent} compact />}
        <span><ShieldCheck size={12} aria-hidden />{template.policy === 'read-only' ? '읽기 전용' : '쓰기 허용'}</span></div>
      <div className="template-card-footer"><time dateTime={template.updatedAt} title={dateTime(template.updatedAt)}>{relativeTime(template.updatedAt)} 수정</time>
        <Button size="small" onClick={() => useTemplate(template)}>템플릿 사용<ArrowRight size={14} aria-hidden /></Button></div>
    </article>)}</div> : <div className="panel"><EmptyState icon={BookOpen} title={q || category ? '조건에 맞는 템플릿이 없습니다' : '첫 템플릿을 만들어 보세요'}
      description={q || category ? '검색어나 분류를 바꿔보세요.' : '리뷰, 구현, 디버깅처럼 자주 하는 작업을 저장해 두세요.'}
      action={q || category ? <Button onClick={() => { setQ(''); setCategory(''); }}>필터 초기화</Button> : <Button icon={Plus} variant="primary" onClick={() => setEditor('new')}>새 템플릿</Button>} /></div>}
    {editor && <Suspense fallback={<div className="modal-loading" role="status">템플릿 편집기 불러오는 중…</div>}>
      <TemplateEditor template={editor === 'new' ? undefined : editor} onClose={() => setEditor(null)} />
    </Suspense>}
    {deleting && <Dialog title="템플릿을 삭제할까요?" onClose={() => setDeleting(null)} size="small"
      footer={<><Button disabled={busy} onClick={() => setDeleting(null)}>취소</Button><Button variant="danger" icon={Trash2} busy={busy} onClick={() => void remove()}>템플릿 삭제</Button></>}>
      <p className="delete-description"><strong>{deleting.name}</strong> 템플릿을 삭제합니다. 이 템플릿으로 시작한 기존 실행은 유지됩니다.</p>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </Dialog>}
  </>;
}
