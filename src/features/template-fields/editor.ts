import { validateTemplateVariables, type TemplateInput, type TemplateRevision } from '../../../shared/template-fields';
import type { PromptTemplate } from '../../../shared/types';
import { templateFieldsApi } from './api';

export function captureTemplateSnapshot(template: PromptTemplate): TemplateRevision {
  return {
    ...template, revision: template.revision ?? 1,
    ...(template.variables !== undefined ? {
      variables: template.variables.map(variable => ({
        ...variable, ...(variable.options !== undefined ? { options: [...variable.options] } : {}),
      })),
    } : {}),
  };
}

export async function saveTemplateDraft(template: PromptTemplate | undefined, input: TemplateInput): Promise<TemplateRevision> {
  if (!input.name.trim() || !input.prompt.trim()) throw new Error('템플릿 이름과 프롬프트를 입력하세요.');
  const variables = validateTemplateVariables(input.prompt, input.variables);
  const fields = { ...input, ...(variables !== undefined ? { variables } : {}) };
  return template
    ? templateFieldsApi.update(template.id, { ...fields, expectedRevision: template.revision ?? 1 })
    : templateFieldsApi.create(fields);
}
