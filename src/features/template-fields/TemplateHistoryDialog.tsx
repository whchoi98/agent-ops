import { Dialog } from '../../components/Dialog';
import { Button } from '../../components/ui';
import { TemplateHistoryPanel, type TemplateHistoryPanelProps } from './TemplateHistory';
import { useTemplateFieldsI18n } from './i18n';

export interface TemplateHistoryDialogProps extends TemplateHistoryPanelProps {
  onClose: () => void;
}

export function TemplateHistoryDialog({ onClose, ...props }: TemplateHistoryDialogProps) {
  const { t } = useTemplateFieldsI18n();
  return <Dialog title={t('{0} 템플릿 이력', { 0: props.template.name })} onClose={onClose} size="large"
    footer={<Button onClick={onClose}>{t('닫기')}</Button>}>
    <TemplateHistoryPanel {...props} />
  </Dialog>;
}
