import { useId } from 'react';
import { FileText, Plus, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import type { HarnessPolicySummary, HarnessValidation } from '../../../shared/harness';
import { Button, CopyButton, EmptyState, Field, InlineNotice, Panel, Skeleton } from '../../components/ui';
import { useFormat } from '../../i18n/useFormat';
import { useHarnessI18n } from './i18n';
import { HARNESS_TEXT_LIMIT, isEditablePolicy, SCOPE_LABELS, textBytes } from './model';
import { policyDirty, type HarnessPolicySnapshot } from './policy-resource';
import { HarnessBadge, HarnessError, HarnessNotices } from './ui';

export function HarnessValidationResult({ validation }: { validation: HarnessValidation }) {
  const { t } = useHarnessI18n();
  return <section className="harness-stack" aria-label={t('구조 검증 결과')} aria-live="polite">
    <div className="harness-actions">
      <HarnessBadge tone={validation.valid ? 'success' : 'danger'}>{t(validation.valid ? '구조 검증 통과' : '구조 검증 실패')}</HarnessBadge>
      {validation.engineValidated && <HarnessBadge tone={validation.valid ? 'success' : 'danger'}>
        {t(validation.valid ? '실제 엔진 검증 완료' : '실제 엔진 검증 실패')}
      </HarnessBadge>}
    </div>
    {!validation.engineValidated && <p className="harness-hint">
      {t('실제 엔진 검증은 수행하지 않았습니다. 구조 검증 통과만으로 도구 호출이 허용되지는 않습니다.')}
    </p>}
    <dl className="harness-properties">
      <div><dt>{t('정책 모드')}</dt><dd>{validation.mode ?? '—'}</dd></div>
      <div><dt>{t('규칙 수')}</dt><dd>{validation.ruleCount}</dd></div>
    </dl>
    <HarnessNotices messages={validation.errors} label={t('검증 오류')} />
    <HarnessNotices messages={validation.warnings} label={t('정책 경고')} />
  </section>;
}

export interface HarnessPolicyEditorProps {
  state: HarnessPolicySnapshot; projectId?: string;
  onEdit: (content: string) => void; onSave: () => void; onValidate: () => void;
  onReload: () => void; onAdopt: () => void;
}
export function HarnessPolicyEditor({ state, projectId, onEdit, onSave, onValidate, onReload, onAdopt }: HarnessPolicyEditorProps) {
  const { t } = useHarnessI18n();
  const { number } = useFormat();
  const id = useId();
  const { detail, draft } = state;
  const busy = !!state.busy;
  const editable = !!draft && (!detail || isEditablePolicy(detail, projectId));
  const conflict = !!detail && !!draft && draft.expectedRevision !== detail.revision;
  const bytes = draft ? textBytes(draft.content) : 0;
  const dirty = policyDirty(draft);
  return <div className="harness-policy-editor harness-stack" aria-busy={state.loading || busy}>
    {state.loading && <Skeleton rows={2} />}
    {detail && <>
      <div className="harness-section-heading">
        <h3 translate="no">{detail.name}</h3>
        <HarnessBadge tone={detail.valid ? 'success' : 'warning'}>{t(detail.valid ? '구조 유효' : '구조 확인 필요')}</HarnessBadge>
      </div>
      <dl className="harness-properties">
        <div><dt>{t('범위')}</dt><dd>{t(SCOPE_LABELS[detail.scope])}</dd></div>
        <div><dt>{t('정책 개정')}</dt><dd><code translate="no">{detail.revision}</code></dd></div>
        <div><dt>{t('정책 모드')}</dt><dd>{detail.mode ?? '—'}</dd></div>
        <div><dt>{t('규칙 수')}</dt><dd>{number(detail.ruleCount)}</dd></div>
        <div><dt>{t('정책 크기')}</dt><dd>{number(detail.bytes)} B</dd></div>
      </dl>
      {detail.path && <p className="harness-source-path"><span>{t('소스 경로')}</span><code translate="no">{detail.path}</code></p>}
      <HarnessNotices messages={detail.warnings} label={t('정책 경고')} />
      {detail.redacted && <InlineNotice tone="warning">{t('비밀 값이 가려진 정책은 편집할 수 없습니다. 가려진 원문을 덮어쓰지 않습니다.')}</InlineNotice>}
      {!editable && <p className="harness-hint">{t(detail.scope === 'managed' && detail.projectId !== (projectId ?? null)
        ? '다른 범위의 앱 관리 정책입니다. 해당 프로젝트 또는 전역 범위를 선택해 편집하세요.'
        : '기존 정책은 읽기 전용입니다. 이 화면에서는 앱이 관리하는 정책만 편집합니다.')}</p>}
      {!draft && <pre className="harness-code" aria-label={t('정책 원문')} tabIndex={0} translate="no"><code>{detail.content}</code></pre>}
    </>}
    {draft && <form className="harness-stack" onSubmit={event => { event.preventDefault(); if (editable && !conflict && dirty && bytes <= HARNESS_TEXT_LIMIT) onSave(); }}>
      <Field label={t('앱 관리 정책 초안')} htmlFor={`${id}-draft`} hint={t('선택한 범위에만 저장합니다. 최대 64 KiB의 YAML 정책을 입력하세요.')}>
        <textarea id={`${id}-draft`} className="harness-policy-input" rows={15} spellCheck={false} translate="no"
          value={draft.content} maxLength={HARNESS_TEXT_LIMIT} disabled={busy} readOnly={!editable}
          aria-invalid={bytes > HARNESS_TEXT_LIMIT} aria-describedby={`${id}-bytes`}
          onChange={event => onEdit(event.target.value)} />
      </Field>
      <p id={`${id}-bytes`} className="harness-hint">{t('현재 초안 {bytes} / 65,536바이트', { bytes: number(bytes) })}</p>
      {bytes > HARNESS_TEXT_LIMIT && <InlineNotice tone="error">{t('정책은 UTF-8 기준 64 KiB 이하여야 합니다.')}</InlineNotice>}
      <p className="harness-hint">{t('예상 저장 개정')}: <code translate="no">{draft.expectedRevision ?? t('아직 저장되지 않음')}</code>
        {dirty ? ` · ${t('저장하지 않은 변경 내용')}` : ''}</p>
      <div className="harness-actions">
        <Button type="submit" icon={Save} variant="primary" busy={state.busy === 'save'}
          disabled={busy || state.loading || !editable || conflict || !dirty || !draft.content.trim() || bytes > HARNESS_TEXT_LIMIT}>
          {t('정책 저장')}
        </Button>
      </div>
    </form>}
    {(detail || draft) && <div className="harness-actions">
      <Button icon={ShieldCheck} busy={state.busy === 'validate'} disabled={busy || state.loading || bytes > HARNESS_TEXT_LIMIT}
        onClick={onValidate}>{t('구조 검증')}</Button>
      <Button icon={RefreshCw} disabled={busy || state.loading} onClick={onReload}>{t('정책 다시 읽기')}</Button>
      {detail && <CopyButton text={detail.content} label={t('원문 복사')} />}
    </div>}
    <HarnessError problem={state.error} busy={busy || state.loading} onRetry={onReload} retryLabel={t('정책 다시 읽기')} />
    {(conflict || state.error?.status === 409) && <InlineNotice tone="warning">
      <p>{t('서버에 새 개정이 있습니다. 초안과 원래 예상 개정은 유지했습니다.')}</p>
      <p>{t('최신 원문을 읽어도 초안을 바꾸지 않습니다. 원문을 검토한 뒤 새 개정을 명시적으로 선택하세요.')}</p>
    </InlineNotice>}
    {detail && draft && <details className="harness-details" open={conflict}>
      <summary>{t('저장된 원문 검토')}</summary>
      <div className="harness-stack">
        <pre className="harness-code" tabIndex={0} translate="no"><code>{detail.content}</code></pre>
        {conflict && editable && <>
          <p className="harness-hint">{t('초안 내용은 그대로 유지됩니다. 다음 저장은 검토한 서버 개정을 내 초안으로 교체합니다.')}</p>
          <div className="harness-actions"><Button disabled={busy || state.loading} onClick={onAdopt}>{t('이 개정으로 내 초안 저장 준비')}</Button></div>
        </>}
      </div>
    </details>}
    {state.saved && <p className="harness-hint" role="status">{t('정책을 저장했습니다.')}</p>}
    {state.validation && <HarnessValidationResult validation={state.validation} />}
    {!detail && !draft && !state.loading && !state.error && <EmptyState compact icon={FileText}
      title={t('정책을 선택하세요')} description={t('원문을 읽거나 앱 관리 정책 초안을 작성하세요.')} />}
  </div>;
}

export function HarnessPolicies({ policies, loading, state, projectId, onSelect, onNew, ...actions }: HarnessPolicyEditorProps & {
  policies: HarnessPolicySummary[]; loading: boolean; onSelect: (id: string) => void; onNew: () => void;
}) {
  const { t } = useHarnessI18n();
  const managed = policies.some(item => item.scope === 'managed' && item.projectId === (projectId ?? null));
  return <Panel title={t('정책')} className="harness-policies"
    actions={<Button size="small" icon={Plus} disabled={!!state.busy || loading} onClick={onNew}>
      {t(managed ? '앱 관리 정책 열기' : '앱 관리 정책 만들기')}
    </Button>}>
    <div className="harness-policy-layout">
      <div className="harness-policy-catalog">
        {loading && !policies.length ? <Skeleton rows={3} /> : policies.length ? <ul className="harness-policy-list" aria-label={t('정책 목록')}>
          {policies.map(item => <li key={item.id}>
            <button type="button" className={`harness-policy-option ${state.selectedId === item.id ? 'is-selected' : ''}`}
              aria-pressed={state.selectedId === item.id} disabled={!!state.busy} onClick={() => onSelect(item.id)}>
              <strong translate="no">{item.name}</strong>
              <span className="harness-policy-tags"><span className="tag">{t(SCOPE_LABELS[item.scope])}</span>
                <span>{t(item.valid ? '구조 유효' : '구조 확인 필요')}</span></span>
              {item.path && <code translate="no">{item.path}</code>}
            </button>
            <HarnessNotices messages={item.warnings} label={t('정책 경고')} />
          </li>)}
        </ul> : <EmptyState compact icon={FileText} title={t('정책이 없습니다')}
          description={t('목록을 새로고침하거나 이 범위의 앱 관리 정책을 만드세요.')} />}
      </div>
      <HarnessPolicyEditor state={state} projectId={projectId} {...actions} />
    </div>
  </Panel>;
}
