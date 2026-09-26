import { useFormat } from '../i18n/useFormat';
import { Trans, AppNotice } from '../i18n/I18nProvider';
import { lazy, Suspense, useState } from 'react';
import { ArrowRight, BookOpen, Code2, FileText, History, Pencil, Plus, Search, ShieldCheck, Trash2 } from 'lucide-react';
import type { PromptTemplate } from '../../shared/types';
import { Dialog } from '../components/Dialog';
import { AgentBadge, Button, EmptyState, IconButton, InlineNotice, PageHeading } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, TEMPLATE_CATEGORIES as CATEGORIES } from '../lib/format';
import { useApp, useData } from '../state/AppProvider';
import { useTemplateFieldsI18n } from '../features/template-fields/i18n';
import { beginLibraryTemplate } from '../features/runs/RunContextModel';

const TemplateEditor = lazy(() => import('../features/templates/TemplateEditor').then(module => ({ default: module.TemplateEditor })));
const TemplateUseDialog = lazy(() => import('../features/template-fields/TemplateUseDialog').then(module => ({ default: module.TemplateUseDialog })));
const TemplateHistoryDialog = lazy(() => import('../features/template-fields/TemplateHistoryDialog').then(module => ({ default: module.TemplateHistoryDialog })));

export function Templates() {
  const { dateTime, relativeTime } = useFormat();
  const { t } = useTemplateFieldsI18n();
  const data = useData();
  const { openNewRun, refreshTemplates, notify } = useApp();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<PromptTemplate['category'] | ''>('');
  const [editor, setEditor] = useState<PromptTemplate | 'new' | null>(null);
  const [deleting, setDeleting] = useState<PromptTemplate | null>(null);
  const [applying, setApplying] = useState<PromptTemplate | null>(null);
  const [history, setHistory] = useState<PromptTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const templates = data.templates.filter(template => (!category || template.category === category) &&
    `${template.name} ${template.description} ${template.prompt}`.toLocaleLowerCase().includes(q.toLocaleLowerCase()));
  async function remove() {
    if (!deleting) return;
    setBusy(true); setError('');
    try {
      await api.deleteTemplate(deleting.id);
      await refreshTemplates(); notify('템플릿을 삭제했습니다.'); setDeleting(null);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  function applyTemplate(template: PromptTemplate, prompt: string) {
    setApplying(null);
    beginLibraryTemplate(template, { openInputs: setApplying, openRun: openNewRun }, prompt);
  }
  return <>
    <PageHeading title={t("프롬프트 템플릿")} description={t("잘 작동하는 지시를 저장하고, 반복되는 작업에 다시 사용하세요.")} eyebrow="PROMPT LIBRARY"
      actions={<Button variant="primary" icon={Plus} onClick={() => setEditor('new')}><Trans message={"새 템플릿"} /></Button>} />
    <div className="template-toolbar"><div className="category-tabs" aria-label={t("템플릿 분류")}>
      <button aria-pressed={!category} className={!category ? 'active' : ''} onClick={() => setCategory('')}><Trans message={"전체"} /><span>{data.templates.length}</span></button>
      {Object.entries(CATEGORIES).map(([value, label]) => <button key={value} aria-pressed={category === value} className={category === value ? 'active' : ''}
        onClick={() => setCategory(value as PromptTemplate['category'])}>{t(label)}</button>)}</div>
      <div className="search-input"><Search size={16} aria-hidden /><input aria-label={t("템플릿 검색")} value={q} onChange={event => setQ(event.target.value)} placeholder={t("템플릿 검색…")} /></div>
    </div>
    {templates.length ? <div className="template-grid">{templates.map(template => <article className="template-card" key={template.id}>
      <div className="template-card-heading"><span className={`template-category-icon category-${template.category}`}>{template.category === 'docs' ? <FileText size={20} aria-hidden /> : template.category === 'build' ? <Code2 size={20} aria-hidden /> : <BookOpen size={20} aria-hidden />}</span>
        <span className="category-label">{t(CATEGORIES[template.category])}</span><div>
          <IconButton icon={History} label={t('{0} 템플릿 이력', { 0: template.name })} onClick={() => setHistory(template)} />
          <IconButton icon={Pencil} label={t("{0} 템플릿 편집", { "0": template.name })} onClick={() => setEditor(template)} />
          <IconButton icon={Trash2} label={t("{0} 템플릿 삭제", { "0": template.name })} onClick={() => { setDeleting(template); setError(''); }} /></div></div>
      <h2>{template.name}</h2><p className="template-description">{template.description || t("저장한 프롬프트를 새 작업에 사용하세요.")}</p>
      <pre className="template-prompt-preview">{template.prompt}</pre>
      <div className="template-card-meta">{template.agent === 'any' ? <span className="any-agent-label"><Trans message={"모든 에이전트"} /></span> : <AgentBadge agent={template.agent} compact />}
        {!!template.variables?.length && <span>{t('{0}개 변수', { 0: template.variables.length })}</span>}
        <span><ShieldCheck size={12} aria-hidden />{template.policy === 'read-only' ? t("읽기 전용") : t("쓰기 허용")}</span></div>
      <div className="template-card-footer"><time dateTime={template.updatedAt} title={dateTime(template.updatedAt)}><Trans message={"{0} 수정"} values={{ "0": relativeTime(template.updatedAt) }} /></time>
        <Button size="small" onClick={() => beginLibraryTemplate(template, { openInputs: setApplying, openRun: openNewRun })}><Trans message={"템플릿 사용"} /><ArrowRight size={14} aria-hidden /></Button></div>
    </article>)}</div> : <div className="panel"><EmptyState icon={BookOpen} title={q || category ? t("조건에 맞는 템플릿이 없습니다") : t("첫 템플릿을 만들어 보세요")}
      description={q || category ? t("검색어나 분류를 바꿔보세요.") : t("리뷰, 구현, 디버깅처럼 자주 하는 작업을 저장해 두세요.")}
      action={q || category ? <Button onClick={() => { setQ(''); setCategory(''); }}><Trans message={"필터 초기화"} /></Button> : <Button icon={Plus} variant="primary" onClick={() => setEditor('new')}><Trans message={"새 템플릿"} /></Button>} /></div>}
    {editor && <Suspense fallback={<div className="modal-loading" role="status"><Trans message={"템플릿 편집기 불러오는 중…"} /></div>}>
      <TemplateEditor template={editor === 'new' ? undefined : editor} onClose={() => setEditor(null)} />
    </Suspense>}
    {applying && <Suspense fallback={<div className="modal-loading" role="status"><Trans message={"불러오는 중입니다."} /></div>}>
      <TemplateUseDialog template={applying} onApply={prompt => applyTemplate(applying, prompt)} onClose={() => setApplying(null)} />
    </Suspense>}
    {history && <Suspense fallback={<div className="modal-loading" role="status">{t('개정 이력을 불러오는 중…')}</div>}>
      <TemplateHistoryDialog template={history}
        onClose={() => setHistory(null)} onRestored={async () => {
          await refreshTemplates(); notify(t('템플릿을 새 개정으로 복원했습니다.')); setHistory(null);
        }} />
    </Suspense>}
    {deleting && <Dialog title={t("템플릿을 삭제할까요?")} onClose={() => setDeleting(null)} size="small"
      footer={<><Button disabled={busy} onClick={() => setDeleting(null)}><Trans message={"취소"} /></Button><Button variant="danger" icon={Trash2} busy={busy} onClick={() => void remove()}><Trans message={"템플릿 삭제"} /></Button></>}>
      <p className="delete-description"><strong>{deleting.name}</strong><Trans message={" 템플릿을 삭제합니다. 이 템플릿으로 시작한 기존 실행은 유지됩니다."} /></p>
      {error && <InlineNotice tone="error"><AppNotice message={error} /></InlineNotice>}
    </Dialog>}
  </>;
}
