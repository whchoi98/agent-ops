import { useId, useState } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import { TEMPLATE_FIELD_LIMITS, templateVariables, type TemplateVariable } from '../../../shared/template-fields';
import { Button, Field, IconButton, InlineNotice } from '../../components/ui';
import { errorMessage } from '../../lib/format';
import { useTemplateFieldsI18n } from './i18n';
import './template-fields.css';

export interface TemplateDefinitionEditorProps {
  prompt: string;
  variables: TemplateVariable[];
  onChange: (variables: TemplateVariable[]) => void;
  disabled?: boolean;
}

export function discoverTemplateDefinitions(prompt: string, variables: TemplateVariable[]): TemplateVariable[] {
  const existing = new Set(variables.map(variable => variable.name));
  const additions = templateVariables(prompt).filter(name => !existing.has(name))
    .map(name => ({ name, label: name, type: 'text' as const, required: true }));
  if (variables.length + additions.length > TEMPLATE_FIELD_LIMITS.variables) {
    throw new Error('변수는 최대 20개까지 정의할 수 있습니다.');
  }
  return [...variables, ...additions];
}

export function TemplateDefinitionEditor({ prompt, variables, onChange, disabled }: TemplateDefinitionEditorProps) {
  const { t, notice } = useTemplateFieldsI18n();
  const prefix = useId();
  const [error, setError] = useState('');
  function change(next: TemplateVariable[]) { setError(''); onChange(next); }
  function update(index: number, patch: Partial<TemplateVariable>) {
    change(variables.map((variable, position) => position === index ? { ...variable, ...patch } : variable));
  }
  function discover() {
    try { change(discoverTemplateDefinitions(prompt, variables)); }
    catch (cause) { setError(errorMessage(cause)); }
  }
  function add() {
    if (variables.length >= TEMPLATE_FIELD_LIMITS.variables) return;
    const names = new Set(variables.map(variable => variable.name));
    let index = 1;
    while (names.has(`input_${index}`)) index++;
    change([...variables, { name: `input_${index}`, label: `input_${index}`, type: 'text', required: true }]);
  }
  return <fieldset className="form-stack form-reset template-definitions" disabled={disabled}>
    <legend>{t('변수 정의')}</legend>
    <p className="field-hint">{t('프롬프트에 {{name}}을 넣고 같은 이름의 변수를 정의하세요. 최대 20개까지 사용할 수 있습니다.')}</p>
    <div className="template-field-actions">
      <Button size="small" icon={Search} onClick={discover}>{t('프롬프트에서 변수 찾기')}</Button>
      <Button size="small" icon={Plus} onClick={add} disabled={variables.length >= TEMPLATE_FIELD_LIMITS.variables}>{t('변수 추가')}</Button>
      <span className="field-hint numeric">{variables.length} / 20</span>
    </div>
    {!variables.length && <p className="field-hint">{t('변수를 정의하지 않으면 중괄호도 원문 그대로 사용합니다.')}</p>}
    {variables.map((variable, index) => {
      const id = `${prefix}-${index}`;
      return <div key={index} className="form-stack template-definition">
        <div className="template-field-actions">
          <code>{`{{${variable.name}}}`}</code>
          <IconButton icon={Trash2} label={t('{0} 변수 삭제', { 0: variable.name })}
            onClick={() => change(variables.filter((_, position) => position !== index))} />
        </div>
        <div className="form-grid">
          <Field label={t('변수 이름')} htmlFor={`${id}-name`}>
            <input id={`${id}-name`} required maxLength={TEMPLATE_FIELD_LIMITS.name}
              pattern="[A-Za-z_][A-Za-z0-9_]{0,39}" value={variable.name}
              onChange={event => update(index, { name: event.target.value })} />
          </Field>
          <Field label={t('표시 이름')} htmlFor={`${id}-label`}>
            <input id={`${id}-label`} required maxLength={TEMPLATE_FIELD_LIMITS.label} value={variable.label}
              onChange={event => update(index, { label: event.target.value })} />
          </Field>
        </div>
        <div className="form-grid">
          <Field label={t('입력 유형')} htmlFor={`${id}-type`}>
            <select id={`${id}-type`} value={variable.type} onChange={event => {
              const type = event.target.value as TemplateVariable['type'];
              update(index, { type, options: type === 'select' ? variable.options ?? [''] : undefined });
            }}>
              <option value="text">{t('한 줄 텍스트')}</option>
              <option value="multiline">{t('여러 줄 텍스트')}</option>
              <option value="select">{t('선택 목록')}</option>
            </select>
          </Field>
          <label className="template-required">
            <input type="checkbox" checked={variable.required} onChange={event => update(index, { required: event.target.checked })} />
            <span>{t('필수 입력')}</span>
          </label>
        </div>
        <Field label={t('도움말')} htmlFor={`${id}-description`}>
          <input id={`${id}-description`} maxLength={TEMPLATE_FIELD_LIMITS.description} value={variable.description ?? ''}
            onChange={event => update(index, { description: event.target.value })} />
        </Field>
        {variable.type === 'select' && <Field label={t('선택 항목 (한 줄에 하나씩)')} htmlFor={`${id}-options`}>
          <textarea id={`${id}-options`} rows={3} value={(variable.options ?? []).join('\n')}
            maxLength={TEMPLATE_FIELD_LIMITS.options * (TEMPLATE_FIELD_LIMITS.value + 1)}
            onChange={event => update(index, { options: event.target.value.split('\n') })} />
        </Field>}
        <Field label={t('기본값')} htmlFor={`${id}-default`}>
          {variable.type === 'select' ? <select id={`${id}-default`} value={variable.defaultValue ?? ''}
            onChange={event => update(index, { defaultValue: event.target.value })}>
            <option value="">{t('기본값 없음')}</option>
            {variable.options?.map((option, position) => <option key={position} value={option}>{option}</option>)}
          </select> : variable.type === 'multiline'
            ? <textarea id={`${id}-default`} rows={3} maxLength={TEMPLATE_FIELD_LIMITS.value} value={variable.defaultValue ?? ''}
              onChange={event => update(index, { defaultValue: event.target.value })} />
            : <input id={`${id}-default`} maxLength={TEMPLATE_FIELD_LIMITS.value} value={variable.defaultValue ?? ''}
              onChange={event => update(index, { defaultValue: event.target.value })} />}
        </Field>
      </div>;
    })}
    {error && <InlineNotice tone="error">{notice(error)}</InlineNotice>}
  </fieldset>;
}
