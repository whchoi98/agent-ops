import { CONTEXT_PACK_LIMITS as limits } from '../../../shared/context-packs';
import type { Project } from '../../../shared/types';
import { Field } from '../../components/ui';
import { useContextPackI18n } from './i18n';

export interface ContextPackFieldsValue {
  name: string;
  description: string;
  projectId: string | null;
  instructions: string;
}
export function ContextPackFields({ value, projects, onChange, disabled = false, idPrefix }: {
  value: ContextPackFieldsValue; projects: Project[];
  onChange: (value: ContextPackFieldsValue) => void; disabled?: boolean; idPrefix: string;
}) {
  const { t } = useContextPackI18n();
  return <div className="form-stack">
    <div className="form-grid">
      <Field label={t('묶음 이름')} htmlFor={`${idPrefix}-name`}>
        <input id={`${idPrefix}-name`} maxLength={limits.nameChars} required data-autofocus
          disabled={disabled} value={value.name} onChange={event => onChange({ ...value, name: event.target.value })} />
      </Field>
      <Field label={t('프로젝트')} htmlFor={`${idPrefix}-project`}>
        <select id={`${idPrefix}-project`} disabled={disabled} value={value.projectId ?? ''}
          onChange={event => onChange({ ...value, projectId: event.target.value || null })}>
          <option value="">{t('프로젝트 없음')}</option>
          {value.projectId && !projects.some(project => project.id === value.projectId)
            && <option value={value.projectId}>{t('사용할 수 없는 프로젝트')} ({value.projectId})</option>}
          {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </Field>
    </div>
    <Field label={t('묶음 설명')} htmlFor={`${idPrefix}-description`}>
      <textarea id={`${idPrefix}-description`} maxLength={limits.descriptionChars} rows={2} disabled={disabled}
        value={value.description} onChange={event => onChange({ ...value, description: event.target.value })} />
    </Field>
    <Field label={t('사용자 지시사항')} htmlFor={`${idPrefix}-instructions`}>
      <textarea id={`${idPrefix}-instructions`} maxLength={limits.instructionsChars} rows={5} disabled={disabled}
        value={value.instructions} onChange={event => onChange({ ...value, instructions: event.target.value })} />
    </Field>
  </div>;
}
