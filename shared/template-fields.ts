import type { PromptTemplate } from './types.js';

export interface TemplateVariable {
  name: string;
  label: string;
  type: 'text' | 'multiline' | 'select';
  required: boolean;
  description?: string;
  defaultValue?: string;
  options?: string[];
}

export interface TemplateContent {
  prompt: string;
  variables?: TemplateVariable[];
}

export type TemplateValues = Record<string, string>;
export type TemplateRevision = PromptTemplate & TemplateContent & { revision: number };
export type TemplateInput = Omit<PromptTemplate, 'id' | 'updatedAt' | 'revision'> & TemplateContent;
export type TemplatePatch = Partial<TemplateInput> & { expectedRevision?: number };

export const TEMPLATE_FIELD_LIMITS = {
  variables: 20, name: 40, label: 200, description: 500, options: 50,
  value: 8_000, sourcePrompt: 32_000, renderedPrompt: 64_000,
  historyPerTemplate: 20, historyTotal: 1_000,
} as const;

const variableName = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const forbiddenNames = new Set(['__proto__', 'constructor', 'prototype']);
const definitionKeys = new Set(['name', 'label', 'type', 'required', 'description', 'defaultValue', 'options']);

function invalid(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [null, Object.prototype].includes(Object.getPrototypeOf(value));
}

function safeName(value: unknown): value is string {
  return typeof value === 'string' && variableName.test(value) && !forbiddenNames.has(value);
}

function checkPrompt(prompt: string) {
  if (typeof prompt !== 'string' || prompt.length > TEMPLATE_FIELD_LIMITS.renderedPrompt) {
    invalid('완성한 프롬프트는 64,000자 이하여야 합니다.');
  }
}

interface Placeholder { name: string; start: number; end: number }

function placeholders(prompt: string): Placeholder[] {
  checkPrompt(prompt);
  const result: Placeholder[] = [];
  let cursor = 0;
  while (cursor < prompt.length) {
    const start = prompt.indexOf('{{', cursor);
    if (start < 0) break;
    const close = prompt.indexOf('}}', start + 2);
    if (close < 0) invalid('변수 자리에는 {{name}} 형식만 사용할 수 있습니다.');
    const name = prompt.slice(start + 2, close).trim();
    if (!safeName(name)) invalid('변수 자리에는 {{name}} 형식만 사용할 수 있습니다.');
    result.push({ name, start, end: close + 2 });
    cursor = close + 2;
  }
  return result;
}

/** Distinct names, in source order. Never inspect substituted values. */
export function templateVariables(prompt: string): string[] {
  const names = [...new Set(placeholders(prompt).map(item => item.name))];
  if (names.length > TEMPLATE_FIELD_LIMITS.variables) invalid('변수는 최대 20개까지 정의할 수 있습니다.');
  return names;
}

/** Validate definitions independently of required runtime inputs, preserving all user text. */
export function validateTemplateVariables(prompt: string, variables: unknown): TemplateVariable[] | undefined {
  checkPrompt(prompt);
  if (variables === undefined) return undefined;
  if (!Array.isArray(variables) || variables.length > TEMPLATE_FIELD_LIMITS.variables) {
    invalid('변수는 최대 20개까지 정의할 수 있습니다.');
  }
  if (!variables.length) return [];
  const names = new Set<string>();
  const definitions: TemplateVariable[] = [];
  for (const value of variables) {
    if (!isRecord(value) || Object.keys(value).some(key => !definitionKeys.has(key))) {
      invalid('변수 정의 형식을 확인하세요.');
    }
    if (!safeName(value.name)) invalid('변수 이름은 영문자 또는 밑줄로 시작하는 40자 이하 ASCII 식별자여야 합니다. 예약된 이름은 사용할 수 없습니다.');
    if (names.has(value.name)) invalid(`변수 이름이 중복되었습니다: ${value.name}`);
    names.add(value.name);
    if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > TEMPLATE_FIELD_LIMITS.label) {
      invalid('변수 표시 이름은 1~200자여야 합니다.');
    }
    if (typeof value.type !== 'string' || !['text', 'multiline', 'select'].includes(value.type) || typeof value.required !== 'boolean') {
      invalid('변수 입력 유형과 필수 여부를 확인하세요.');
    }
    if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > TEMPLATE_FIELD_LIMITS.description)) {
      invalid('변수 도움말은 500자 이하여야 합니다.');
    }
    if (value.defaultValue !== undefined && (typeof value.defaultValue !== 'string' || value.defaultValue.length > TEMPLATE_FIELD_LIMITS.value)) {
      invalid('변수 기본값은 8,000자 이하 문자열이어야 합니다.');
    }
    if (value.type === 'select') {
      if (!Array.isArray(value.options) || !value.options.length || value.options.length > TEMPLATE_FIELD_LIMITS.options
        || Array.from(value.options).some(option => typeof option !== 'string' || !option.trim() || option.length > TEMPLATE_FIELD_LIMITS.value)
        || new Set(value.options).size !== value.options.length) {
        invalid('선택 항목은 중복 없이 1~50개이며 각각 8,000자 이하여야 합니다.');
      }
      if (value.defaultValue !== undefined && value.defaultValue !== '' && !value.options.includes(value.defaultValue)) {
        invalid(`기본값이 선택 항목에 없습니다: ${value.name}`);
      }
    } else if (value.options !== undefined) invalid('선택 입력에만 선택 항목을 지정할 수 있습니다.');
    definitions.push({
      name: value.name, label: value.label, type: value.type as TemplateVariable['type'], required: value.required,
      ...(value.description !== undefined ? { description: value.description as string } : {}),
      ...(value.defaultValue !== undefined ? { defaultValue: value.defaultValue as string } : {}),
      ...(value.type === 'select' ? { options: [...value.options as string[]] } : {}),
    });
  }
  const used = new Set(templateVariables(prompt));
  for (const name of used) if (!names.has(name)) invalid(`변수 정의가 없습니다: ${name}`);
  for (const name of names) if (!used.has(name)) invalid(`프롬프트에서 사용하지 않는 변수입니다: ${name}`);
  return definitions;
}

/** One pass over the original prompt; values are never evaluated or rescanned. */
export function renderTemplate(template: TemplateContent, values: unknown = {}): string {
  const definitions = validateTemplateVariables(template.prompt, template.variables);
  if (!isRecord(values) || Object.keys(values).length > TEMPLATE_FIELD_LIMITS.variables) {
    invalid('변수 값은 최대 20개의 이름과 문자열로 입력하세요.');
  }
  for (const [name, value] of Object.entries(values)) {
    if (!safeName(name) || typeof value !== 'string' || value.length > TEMPLATE_FIELD_LIMITS.value) {
      invalid('변수 값은 안전한 이름과 8,000자 이하 문자열이어야 합니다.');
    }
  }
  // An empty definition list is also a plain template, including any braces.
  if (!definitions?.length) return template.prompt;
  const names = new Set(definitions.map(variable => variable.name));
  for (const name of Object.keys(values)) if (!names.has(name)) invalid(`정의되지 않은 변수 값입니다: ${name}`);
  const resolved = new Map<string, string>();
  for (const variable of definitions) {
    const value = Object.hasOwn(values, variable.name) ? values[variable.name] as string : variable.defaultValue ?? '';
    if (variable.required && !value.trim()) invalid(`필수 변수 값을 입력하세요: ${variable.name}`);
    if (variable.type === 'select' && value !== '' && !variable.options!.includes(value)) {
      invalid(`선택 항목에 없는 값입니다: ${variable.name}`);
    }
    resolved.set(variable.name, value);
  }
  const parts: string[] = [];
  let cursor = 0;
  let length = 0;
  for (const item of placeholders(template.prompt)) {
    const value = resolved.get(item.name)!;
    length += item.start - cursor + value.length;
    if (length > TEMPLATE_FIELD_LIMITS.renderedPrompt) invalid('완성한 프롬프트는 64,000자 이하여야 합니다.');
    parts.push(template.prompt.slice(cursor, item.start), value);
    cursor = item.end;
  }
  if (length + template.prompt.length - cursor > TEMPLATE_FIELD_LIMITS.renderedPrompt) {
    invalid('완성한 프롬프트는 64,000자 이하여야 합니다.');
  }
  parts.push(template.prompt.slice(cursor));
  return parts.join('');
}
