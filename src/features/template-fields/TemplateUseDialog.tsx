import type { PromptTemplate } from '../../../shared/types';
import { Dialog } from '../../components/Dialog';
import { Button } from '../../components/ui';
import { TemplateApplyPanel } from './TemplateApplyPanel';
import { useTemplateFieldsI18n } from './i18n';
import './template-fields.css';

export interface TemplateUseDialogProps {
  template: PromptTemplate;
  onApply: (prompt: string) => void;
  onClose: () => void;
}

export function TemplateUseDialog({ template, onApply, onClose }: TemplateUseDialogProps) {
  const { t } = useTemplateFieldsI18n();
  return <Dialog title={t('입력하고 템플릿 사용')} description={template.name} onClose={onClose} size="large"
    footer={<Button onClick={onClose}>{t('닫기')}</Button>}>
    <div className="form-stack">
      {template.description && <p className="field-hint template-user-text">{template.description}</p>}
      <TemplateApplyPanel template={template} onApply={onApply} />
    </div>
  </Dialog>;
}
