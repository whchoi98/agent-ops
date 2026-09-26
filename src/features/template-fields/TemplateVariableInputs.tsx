import { useId } from 'react';
import { TEMPLATE_FIELD_LIMITS, type TemplateValues, type TemplateVariable } from '../../../shared/template-fields';
import { Field } from '../../components/ui';
import { useTemplateFieldsI18n } from './i18n';

export interface TemplateVariableInputsProps {
  variables: readonly TemplateVariable[];
  values: TemplateValues;
  onChange: (values: TemplateValues) => void;
  disabled?: boolean;
  idPrefix?: string;
}

export function TemplateVariableInputs({ variables, values, onChange, disabled, idPrefix }: TemplateVariableInputsProps) {
  const { t } = useTemplateFieldsI18n();
  const generatedId = useId();
  const prefix = idPrefix ?? generatedId;
  if (!variables.length) return null;
  return <fieldset className="form-stack form-reset" disabled={disabled}>
    <legend>{t('입력 변수')}</legend>
    {variables.map(variable => {
      const id = `${prefix}-${variable.name}`;
      const value = Object.hasOwn(values, variable.name) ? values[variable.name] : variable.defaultValue ?? '';
      const common = {
        id, required: variable.required, maxLength: TEMPLATE_FIELD_LIMITS.value,
        value, 'aria-describedby': variable.description ? `${id}-help` : undefined,
        onChange: (event: { target: { value: string } }) => onChange({ ...values, [variable.name]: event.target.value }),
      };
      return <Field key={variable.name} label={variable.label} htmlFor={id}>
        {variable.type === 'multiline' ? <textarea {...common} rows={4} />
          : variable.type === 'select' ? <select id={id} required={common.required} value={value}
            aria-describedby={common['aria-describedby']} onChange={common.onChange}>
            <option value="">{t('선택 항목을 고르세요')}</option>
            {variable.options?.map(option => <option key={option} value={option}>{option}</option>)}
          </select> : <input type="text" {...common} />}
        <span className="field-hint">{t(variable.required ? '필수 입력' : '선택 입력')}</span>
        {variable.description && <p id={`${id}-help`} className="field-hint">{variable.description}</p>}
      </Field>;
    })}
  </fieldset>;
}
