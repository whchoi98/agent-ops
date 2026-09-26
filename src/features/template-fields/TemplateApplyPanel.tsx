import { useId, useState } from 'react';
import type { PromptTemplate } from '../../../shared/types';
import { renderTemplate, type TemplateValues } from '../../../shared/template-fields';
import { Button, Field, InlineNotice } from '../../components/ui';
import { errorMessage } from '../../lib/format';
import { TemplateVariableInputs } from './TemplateVariableInputs';
import { useTemplateFieldsI18n } from './i18n';

export interface TemplateApplyPanelProps {
  template: PromptTemplate;
  onApply: (prompt: string) => void;
  onInputsChange?: (values: TemplateValues) => void;
  disabled?: boolean;
  applyLabel?: string;
}

export function TemplateApplyPanel(props: TemplateApplyPanelProps) {
  return <TemplateApplication key={`${props.template.id}:${props.template.revision ?? 1}`} {...props} />;
}

function TemplateApplication({ template, onApply, onInputsChange, disabled, applyLabel }: TemplateApplyPanelProps) {
  const { t, notice } = useTemplateFieldsI18n();
  const [values, setValues] = useState<TemplateValues>({});
  const id = useId();
  let prompt: string | null = null;
  let error = '';
  try { prompt = renderTemplate(template, values); }
  catch (cause) { error = errorMessage(cause); }
  function change(next: TemplateValues) {
    setValues(next);
    onInputsChange?.(next);
  }
  return <section className="form-stack" aria-label={t('입력하고 템플릿 사용')}>
    <TemplateVariableInputs variables={template.variables ?? []} values={values} onChange={change} disabled={disabled} />
    {error && <InlineNotice tone="error">{notice(error)}</InlineNotice>}
    {prompt !== null && <Field label={t('적용할 프롬프트')} htmlFor={id}>
      <textarea id={id} className="prompt-textarea" readOnly rows={7} value={prompt} />
    </Field>}
    <p className="field-hint">{t('적용한 뒤에도 실행 창에서 프롬프트를 수정할 수 있습니다.')}</p>
    <div><Button variant="primary" disabled={disabled || prompt === null}
      onClick={() => { if (prompt !== null) onApply(prompt); }}>{applyLabel ?? t('프롬프트 적용')}</Button></div>
  </section>;
}
