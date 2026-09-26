import type { Agent, Bootstrap, Policy, PromptTemplate, RunRequest } from '../../../shared/types';
import type { TemplateRevision } from '../../../shared/template-fields';
import type { NewRunDraft } from '../../state/AppProvider';
import { captureTemplateSnapshot } from '../template-fields/editor';
import {
  assertRunContextIds, runContextInputSignature, type RunContextApplication, type RunContextInput,
} from './RunContextCompile';

export interface RunContextFields {
  agent: Agent;
  projectId: string;
  title: string;
  model: string;
  policy: Policy;
  allowShell: boolean;
  prompt: string;
}

export interface RunContextDraft {
  fields: RunContextFields;
  origin: Pick<NewRunDraft, 'resumeSessionId' | 'sourceSessionId' | 'workItemId' | 'workItemVersion' | 'projectId'> & { agent: Agent };
  template: TemplateRevision | null;
  templateId: string;
  templatePending: boolean;
  templateInputsOpen: boolean;
  templateTitle: string;
  contextPackIds: string[];
  /** IDs already appended, including references subsequently removed by the operator. */
  appliedContextIds: string[];
  generation: number;
}

export function beginLibraryTemplate(
  template: PromptTemplate,
  actions: { openInputs: (template: PromptTemplate) => void; openRun: (draft: NewRunDraft) => void },
  renderedPrompt?: string,
): void {
  if (template.variables?.length && renderedPrompt === undefined) {
    actions.openInputs(captureTemplateSnapshot(template));
    return;
  }
  actions.openRun({
    templateResolved: true, templateId: template.id, title: template.name,
    prompt: renderedPrompt ?? template.prompt, policy: template.policy,
    ...(template.agent !== 'any' ? { agent: template.agent } : {}),
  });
}

export function createRunDraft(draft: NewRunDraft, data: Pick<Bootstrap, 'templates' | 'projects'>): RunContextDraft {
  const source = data.templates.find(template => template.id === draft.templateId);
  const template = source ? captureTemplateSnapshot(source) : null;
  const parameterized = !!template?.variables?.length;
  const agent = draft.agent ?? 'codex';
  const contextPackIds = [...new Set(draft.contextPackIds ?? [])];
  return {
    fields: {
      agent, projectId: draft.projectId ?? data.projects.find(project => project.executionEnabled)?.id ?? data.projects[0]?.id ?? '',
      title: draft.title ?? '', model: draft.model ?? '', policy: draft.policy ?? 'read-only', allowShell: false,
      prompt: draft.prompt ?? (!parameterized ? template?.prompt ?? '' : ''),
    },
    origin: {
      agent, projectId: draft.projectId, resumeSessionId: draft.resumeSessionId, sourceSessionId: draft.sourceSessionId,
      workItemId: draft.workItemId, workItemVersion: draft.workItemVersion,
    },
    template, templateId: draft.templateId ?? '', templateTitle: template?.name ?? '',
    templatePending: !!draft.templateId && !draft.templateResolved && (parameterized || !template),
    templateInputsOpen: parameterized && !draft.templateResolved,
    contextPackIds,
    // Both prepared-work and context-library drafts include their compiled context.
    appliedContextIds: draft.prompt !== undefined ? [...contextPackIds] : [],
    generation: 0,
  };
}

export function updateRunFields(draft: RunContextDraft, patch: Partial<RunContextFields>): RunContextDraft {
  const fields = { ...draft.fields, ...patch };
  if (draft.origin.resumeSessionId) fields.agent = draft.origin.agent;
  if (draft.origin.projectId && (draft.origin.resumeSessionId || draft.origin.workItemId)) fields.projectId = draft.origin.projectId;
  if (fields.agent === 'codex' || fields.policy === 'read-only') fields.allowShell = false;
  return { ...draft, fields, generation: draft.generation + 1 };
}

export function chooseRunTemplate(draft: RunContextDraft, source: PromptTemplate | null): RunContextDraft {
  const template = source ? captureTemplateSnapshot(source) : null;
  const selected = {
    ...draft, template, templateId: template?.id ?? '',
    templatePending: !!template?.variables?.length, templateInputsOpen: !!template?.variables?.length,
    generation: draft.generation + 1,
  };
  return template && !template.variables?.length ? applyRunTemplate(selected, template.id, template.prompt) : selected;
}

export function changeRunTemplateInputs(draft: RunContextDraft): RunContextDraft {
  if (!draft.template?.variables?.length) return draft;
  return { ...draft, templatePending: true, templateInputsOpen: true, generation: draft.generation + 1 };
}

export function applyRunTemplate(draft: RunContextDraft, templateId: string, prompt: string): RunContextDraft {
  const template = draft.template;
  if (!template || template.id !== templateId) return draft;
  if (prompt.length > 64_000) throw new Error('프롬프트는 64,000자 이하여야 합니다.');
  const next = updateRunFields(draft, {
    prompt, policy: template.policy,
    ...(!draft.fields.title || draft.fields.title === draft.templateTitle ? { title: template.name } : {}),
    ...(template.agent !== 'any' && !draft.origin.resumeSessionId ? { agent: template.agent, model: '' } : {}),
  });
  // Applying a template replaces the body, so selected context must be appended
  // again. Keep the selection, but never claim removed text is still present.
  return { ...next, templatePending: false, templateTitle: template.name, appliedContextIds: [] };
}

export function selectRunContextPacks(draft: RunContextDraft, ids: string[]): RunContextDraft {
  assertRunContextIds(ids);
  return { ...draft, contextPackIds: [...ids], generation: draft.generation + 1 };
}

export function runContextInput(draft: RunContextDraft): RunContextInput {
  return { prompt: draft.fields.prompt, selectedIds: draft.contextPackIds, appliedIds: draft.appliedContextIds };
}

export function commitRunContext(draft: RunContextDraft, input: RunContextInput, application: RunContextApplication): RunContextDraft {
  if (runContextInputSignature(runContextInput(draft)) !== runContextInputSignature(input)) {
    throw new Error('초안이 변경되었습니다. 현재 내용을 유지한 채 컨텍스트를 다시 조합하세요.');
  }
  assertRunContextIds(application.selectedIds);
  if (application.prompt.length > 64_000 || !application.prompt.startsWith(input.prompt)
    || JSON.stringify(application.selectedIds) !== JSON.stringify(input.selectedIds)
    || [...input.appliedIds, ...input.selectedIds].some(id => !application.appliedIds.includes(id))) {
    throw new Error('조합한 컨텍스트 응답을 확인할 수 없습니다. 다시 시도하세요.');
  }
  return {
    ...draft, fields: { ...draft.fields, prompt: application.prompt },
    contextPackIds: [...application.selectedIds], appliedContextIds: [...new Set(application.appliedIds)],
    generation: draft.generation + 1,
  };
}

/** Explicit allowlist: UI preparation markers never become execution API fields. */
export function buildRunRequest(draft: RunContextDraft): RunRequest {
  const { agent, projectId, prompt, title, model, policy, allowShell } = draft.fields;
  const origin = draft.origin;
  return {
    agent, projectId, prompt: prompt.trim(), policy,
    ...(title.trim() ? { title: title.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}),
    ...(origin.resumeSessionId ? { resumeSessionId: origin.resumeSessionId } : {}),
    ...(origin.sourceSessionId ? { sourceSessionId: origin.sourceSessionId } : {}),
    ...(draft.templateId ? { templateId: draft.templateId } : {}),
    ...(origin.workItemId ? { workItemId: origin.workItemId } : {}),
    ...(origin.workItemVersion !== undefined ? { workItemVersion: origin.workItemVersion } : {}),
    ...(draft.contextPackIds.length ? { contextPackIds: [...draft.contextPackIds] } : {}),
    ...(agent !== 'codex' && policy === 'workspace-write' ? { allowShell } : {}),
  };
}

export function canPreviewRun(draft: RunContextDraft): boolean {
  const { prompt, projectId } = draft.fields;
  const { workItemId, workItemVersion } = draft.origin;
  const validWork = workItemId
    ? Number.isSafeInteger(workItemVersion) && Number(workItemVersion) > 0
    : workItemVersion === undefined;
  try { assertRunContextIds(draft.contextPackIds); } catch { return false; }
  return !!projectId && !!prompt.trim() && prompt.length <= 64_000 && validWork && !draft.templatePending
    && draft.contextPackIds.every(id => draft.appliedContextIds.includes(id));
}

export function canStartRun(
  draft: RunContextDraft, previewSignature: string | undefined,
  data: Pick<Bootstrap, 'demo' | 'projects' | 'connectors'>,
): boolean {
  return previewSignature === runDraftSignature(draft) && canPreviewRun(draft) && !data.demo
    && !!data.projects.find(project => project.id === draft.fields.projectId)?.executionEnabled
    && !!data.connectors.find(connector => connector.agent === draft.fields.agent)?.installed;
}

export function runDraftSignature(draft: RunContextDraft): string {
  return `${draft.generation}:${JSON.stringify(buildRunRequest(draft))}`;
}
