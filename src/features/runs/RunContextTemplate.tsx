import type { PromptTemplate } from '../../../shared/types';
import { Button, InlineNotice } from '../../components/ui';
import { TemplateApplyPanel } from '../template-fields/TemplateApplyPanel';
import { useRunContextI18n } from './RunContextI18n';
import './RunContext.css';

export interface RunContextTemplateProps {
  template: PromptTemplate | null;
  templateId: string;
  pending: boolean;
  inputsOpen: boolean;
  disabled?: boolean;
  onApply: (prompt: string) => void;
  onInputsChange: () => void;
  onEditInputs: () => void;
}

export function RunContextTemplate({
  template, templateId, pending, inputsOpen, disabled, onApply, onInputsChange, onEditInputs,
}: RunContextTemplateProps) {
  const { t } = useRunContextI18n();
  if (!templateId) return null;
  if (!template) return <InlineNotice tone="warning">
    {t('선택한 템플릿을 찾을 수 없습니다. 직접 작성을 선택하거나 다른 템플릿을 고르세요.')}
  </InlineNotice>;
  if (!template.variables?.length) return null;
  return <section className="run-context-template form-stack">
    <strong>{template.name}</strong>
    {pending && <InlineNotice>{t('템플릿 입력을 먼저 적용한 뒤 명령을 미리 보세요.')}</InlineNotice>}
    {inputsOpen ? <TemplateApplyPanel template={template} onApply={onApply}
      onInputsChange={onInputsChange} disabled={disabled} /> : <>
      <p className="field-hint">{t('템플릿이 적용된 프롬프트입니다. 내용을 직접 수정할 수 있습니다.')}</p>
      <div><Button size="small" disabled={disabled} onClick={onEditInputs}>{t('변수 값 다시 입력')}</Button></div>
    </>}
  </section>;
}
