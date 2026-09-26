import { useEffect, useId, useRef, useState } from 'react';
import type { PromptTemplate } from '../../../shared/types';
import { TEMPLATE_FIELD_LIMITS, type TemplateRevision } from '../../../shared/template-fields';
import { Button, Field, InlineNotice } from '../../components/ui';
import { AGENT_META, errorMessage, TEMPLATE_CATEGORIES } from '../../lib/format';
import { useFormat } from '../../i18n/useFormat';
import { templateFieldsApi } from './api';
import { captureTemplateSnapshot } from './editor';
import { useTemplateFieldsI18n } from './i18n';
import './template-fields.css';

export interface TemplateHistoryViewProps {
  template: PromptTemplate;
  revisions: TemplateRevision[];
  selectedRevision: number | null;
  onSelect: (revision: number) => void;
  onRestore: (revision: number) => void;
  busy?: boolean;
  loading?: boolean;
  error?: string;
  onReload?: () => void;
}

export interface TemplateHistoryPanelProps {
  template: PromptTemplate;
  onRestored: (template: TemplateRevision) => void | Promise<void>;
  disabled?: boolean;
}

export function TemplateHistoryPanel(props: TemplateHistoryPanelProps) {
  return <TemplateHistoryLoader key={props.template.id} {...props} />;
}

function TemplateHistoryLoader({ template, onRestored, disabled }: TemplateHistoryPanelProps) {
  const [snapshot, setSnapshot] = useState(() => captureTemplateSnapshot(template));
  const [revisions, setRevisions] = useState<TemplateRevision[]>([]);
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const mounted = useRef(true);
  const saving = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError('');
    // Only initial load or an explicit reload can replace the editing baseline.
    // Background template refreshes must not advance a pending restore's version.
    void templateFieldsApi.history(snapshot.id, controller.signal).then(items => {
      if (!active) return;
      setRevisions(items);
      const loaded = items[0] && items[0].revision >= snapshot.revision
        ? captureTemplateSnapshot(items[0]) : snapshot;
      setSnapshot(loaded);
      const currentRevision = loaded.revision;
      setSelectedRevision(previous => items.some(item => item.revision === previous) ? previous
        : items.find(item => item.revision < currentRevision)?.revision ?? items[0]?.revision ?? null);
    }).catch(cause => {
      if (active && !controller.signal.aborted) setError(errorMessage(cause));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [snapshot.id, reload]);
  async function restore(revision: number) {
    if (saving.current || loading || disabled) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const restored = await templateFieldsApi.restore(snapshot.id, revision, snapshot.revision);
      if (!mounted.current) return;
      setSnapshot(captureTemplateSnapshot(restored));
      setRevisions(items => [restored, ...items.filter(item => item.revision !== restored.revision)]
        .slice(0, TEMPLATE_FIELD_LIMITS.historyPerTemplate));
      setSelectedRevision(restored.revision);
      await onRestored(restored);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return <TemplateHistoryView template={snapshot} revisions={revisions} selectedRevision={selectedRevision}
    onSelect={setSelectedRevision} onRestore={revision => { void restore(revision); }}
    busy={busy || disabled} loading={loading} error={error} onReload={() => setReload(value => value + 1)} />;
}

export function TemplateRevisionPreview({ revision }: { revision: TemplateRevision }) {
  const { t } = useTemplateFieldsI18n();
  const types = { text: t('한 줄 텍스트'), multiline: t('여러 줄 텍스트'), select: t('선택 목록') };
  return <article className="form-stack template-revision-preview">
    <div><h3>{revision.name}</h3>{revision.description && <p className="field-hint template-user-text">{revision.description}</p>}</div>
    <dl className="template-revision-metadata">
      <div><dt>{t('분류')}</dt><dd>{t(TEMPLATE_CATEGORIES[revision.category])}</dd></div>
      <div><dt>{t('기본 에이전트')}</dt><dd>{revision.agent === 'any' ? t('모든 에이전트') : AGENT_META[revision.agent].name}</dd></div>
      <div><dt>{t('기본 작업 권한')}</dt><dd>{t(revision.policy === 'read-only' ? '읽기 전용' : '쓰기 허용')}</dd></div>
    </dl>
    <pre className="template-revision-prompt" aria-label={t('프롬프트')}>{revision.prompt}</pre>
    {!!revision.variables?.length && <div className="form-stack">
      <h4>{t('변수 정의')}</h4>
      {revision.variables.map(variable => <section key={variable.name} className="template-definition">
        <strong>{variable.label}</strong> <code>{`{{${variable.name}}}`}</code>
        <p className="field-hint">{types[variable.type]} · {t(variable.required ? '필수 입력' : '선택 입력')}</p>
        {variable.description && <p className="template-user-text">{variable.description}</p>}
        {variable.defaultValue !== undefined && <dl>
          <dt className="field-hint">{t('기본값')}</dt><dd className="template-user-text">{variable.defaultValue}</dd>
        </dl>}
        {variable.options && <ul className="template-revision-options">
          {variable.options.map(option => <li key={option} className="template-user-text">{option}</li>)}
        </ul>}
      </section>)}
    </div>}
  </article>;
}

export function TemplateHistoryView({
  template, revisions, selectedRevision, onSelect, onRestore, busy, loading, error, onReload,
}: TemplateHistoryViewProps) {
  const { t, notice } = useTemplateFieldsI18n();
  const { dateTime } = useFormat();
  const id = useId();
  const selected = revisions.find(item => item.revision === selectedRevision);
  const canRestore = !!selected && selected.revision < (template.revision ?? 1) && !busy && !loading;
  return <div className="form-stack">
    <p className="field-hint">{t('템플릿별 최근 20개, 전체 1,000개 개정까지 보관합니다. 복원하면 새 개정이 만들어집니다.')}</p>
    {loading && <p role="status">{t('개정 이력을 불러오는 중…')}</p>}
    {error && <InlineNotice tone="error">{notice(error)}</InlineNotice>}
    {onReload && <div><Button size="small" disabled={busy || loading} onClick={onReload}>{t('이력 다시 불러오기')}</Button></div>}
    {revisions.length ? <Field label={t('미리 볼 개정')} htmlFor={id}>
      <select id={id} value={selectedRevision ?? ''} disabled={busy || loading}
        onChange={event => onSelect(Number(event.target.value))}>
        <option value="" disabled>{t('미리 볼 개정을 선택하세요.')}</option>
        {revisions.map(item => <option key={item.revision} value={item.revision}>
          {t(item.revision === (template.revision ?? 1) ? '개정 {0} · 현재' : '개정 {0}', { 0: item.revision })} · {dateTime(item.updatedAt)}
        </option>)}
      </select>
    </Field> : !loading && <p className="field-hint">{t('보관된 개정이 없습니다.')}</p>}
    {selected && <TemplateRevisionPreview revision={selected} />}
    <div><Button variant="primary" busy={busy} disabled={!canRestore}
      onClick={() => { if (canRestore && selected) onRestore(selected.revision); }}>{t('새 개정으로 복원')}</Button></div>
  </div>;
}
