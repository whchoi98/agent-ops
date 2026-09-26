import { describe, expect, it } from 'vitest';
import type { ConnectorStatus, Project, PromptTemplate } from '../../../shared/types';
import type { NewRunDraft } from '../../state/AppProvider';
import {
  applyRunTemplate, beginLibraryTemplate, buildRunRequest, canPreviewRun, canStartRun, changeRunTemplateInputs,
  chooseRunTemplate, commitRunContext, createRunDraft, runDraftSignature,
  selectRunContextPacks, updateRunFields,
} from './RunContextModel';

const projects: Project[] = [
  { id: 'project-first', name: 'First', path: '/tmp/first', color: '#fff', executionEnabled: true, createdAt: '2026-09-26T00:00:00Z' },
  { id: 'project-work', name: 'Work', path: '/tmp/work', color: '#000', executionEnabled: true, createdAt: '2026-09-26T00:00:00Z' },
];
const parameterized: PromptTemplate = {
  id: 'template-fields', name: '사용자 제목', description: '원문', category: 'review',
  agent: 'claude', policy: 'workspace-write', prompt: 'Review {{target}}', revision: 4,
  variables: [{ name: 'target', label: '새 실행', type: 'text', required: true }],
  updatedAt: '2026-09-26T00:00:00Z',
};
const plain: PromptTemplate = { ...parameterized, id: 'template-plain', variables: undefined, prompt: ' \n{{target}} {{bad.name}}\n' };
const data = { projects, templates: [parameterized, plain] };
const connector: ConnectorStatus = {
  agent: 'codex', installed: true, version: 'fixture', executable: '/tmp/fixture-cli', roots: [], existingRoots: [],
  sessionCount: 0, error: null, supportsResume: true, supportsStreaming: true,
};

describe('frozen run template preparation', () => {
  it('opens a plain library template directly as a resolved draft without an empty input dialog', () => {
    const runs: NewRunDraft[] = [];
    const inputs: PromptTemplate[] = [];
    beginLibraryTemplate(plain, { openRun: draft => { runs.push(draft); }, openInputs: template => { inputs.push(template); } });
    expect(inputs).toEqual([]);
    expect(runs).toEqual([{
      templateResolved: true, templateId: 'template-plain', title: '사용자 제목',
      prompt: ' \n{{target}} {{bad.name}}\n', policy: 'workspace-write', agent: 'claude',
    }]);
  });

  it('opens variable inputs first and marks the completed library application as resolved', () => {
    const runs: NewRunDraft[] = [];
    const inputs: PromptTemplate[] = [];
    const actions = { openRun: (draft: NewRunDraft) => { runs.push(draft); }, openInputs: (template: PromptTemplate) => { inputs.push(template); } };
    beginLibraryTemplate(parameterized, actions);
    expect(runs).toEqual([]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ id: 'template-fields', revision: 4 });
    beginLibraryTemplate(inputs[0], actions, 'Review literal $& {{other}}');
    expect(inputs).toHaveLength(1);
    expect(runs).toEqual([{
      templateResolved: true, templateId: 'template-fields', title: '사용자 제목',
      prompt: 'Review literal $& {{other}}', policy: 'workspace-write', agent: 'claude',
    }]);
  });

  it('requires explicit variable application even when a draft already contains prompt text', () => {
    const draft = createRunDraft({ templateId: parameterized.id, prompt: 'My existing draft' }, data);
    expect(draft.template?.revision).toBe(4);
    expect(draft.templatePending).toBe(true);
    expect(draft.templateInputsOpen).toBe(true);
    expect(draft.fields.prompt).toBe('My existing draft');
    expect(canPreviewRun(draft)).toBe(false);
    const applied = applyRunTemplate(draft, parameterized.id, 'Review literal $& {{other}}');
    expect(canPreviewRun(applied)).toBe(true);
    expect(buildRunRequest(applied)).toMatchObject({
      templateId: 'template-fields', prompt: 'Review literal $& {{other}}', agent: 'claude', policy: 'workspace-write', allowShell: false,
    });
  });

  it('honors a resolved library draft without leaking its UI marker into the API request', () => {
    const draft = createRunDraft({
      templateId: parameterized.id, prompt: 'Review my actual value', templateResolved: true,
      title: 'Operator title', policy: 'read-only',
    }, data);
    expect(draft.templatePending).toBe(false);
    expect(draft.templateInputsOpen).toBe(false);
    expect(canPreviewRun(draft)).toBe(true);
    expect(buildRunRequest(draft)).toEqual({
      agent: 'codex', projectId: 'project-first', title: 'Operator title', prompt: 'Review my actual value',
      policy: 'read-only', templateId: 'template-fields',
    });
  });

  it('reopening or changing inputs invalidates a resolved template without overwriting the prompt', () => {
    const original = createRunDraft({ templateId: parameterized.id, prompt: 'Operator edit', templateResolved: true }, data);
    const changed = changeRunTemplateInputs(original);
    expect(changed.templateInputsOpen).toBe(true);
    expect(changed.templatePending).toBe(true);
    expect(changed.fields.prompt).toBe('Operator edit');
    expect(runDraftSignature(changed)).not.toBe(runDraftSignature(original));
    expect(canPreviewRun(changed)).toBe(false);
  });

  it('copies the selected template so background changes cannot alter its inputs or revision', () => {
    const source = { ...parameterized, variables: parameterized.variables!.map(variable => ({ ...variable })) };
    const draft = chooseRunTemplate(createRunDraft({ prompt: 'My text' }, data), source);
    source.revision = 5;
    source.prompt = 'Background replacement';
    source.variables[0].label = 'Background label';
    expect(draft.template).toMatchObject({
      revision: 4, prompt: 'Review {{target}}', variables: [{ name: 'target', label: '새 실행' }],
    });
    expect(draft.fields.prompt).toBe('My text');
    expect(canPreviewRun(draft)).toBe(false);
  });

  it('preserves legacy literal braces when selecting a plain template', () => {
    const draft = chooseRunTemplate(createRunDraft({ prompt: 'Old' }, data), plain);
    expect(draft.fields.prompt).toBe(' \n{{target}} {{bad.name}}\n');
    expect(draft.templatePending).toBe(false);
    expect(draft.templateInputsOpen).toBe(false);
    expect(canPreviewRun(draft)).toBe(true);
  });

  it.each([plain, parameterized])('requires selected context to be reapplied when $id replaces the prompt', template => {
    const original = createRunDraft({ prompt: 'Operator goal\nPreviously compiled context', contextPackIds: ['pack-selected'] }, data);
    const selected = chooseRunTemplate(original, template);
    const applied = template.variables?.length ? applyRunTemplate(selected, template.id, 'Review filled target') : selected;
    expect(applied.contextPackIds).toEqual(['pack-selected']);
    expect(applied.appliedContextIds).toEqual([]);
    expect(applied.fields.prompt).not.toContain('Previously compiled context');
    expect(canPreviewRun(applied)).toBe(false);
    expect(original.appliedContextIds).toEqual(['pack-selected']);
  });

  it('keeps custom titles while applying template defaults', () => {
    const draft = chooseRunTemplate(createRunDraft({ title: 'My title', prompt: 'My text', model: 'old-model' }, data), parameterized);
    const applied = applyRunTemplate(draft, parameterized.id, 'Review filled');
    expect(applied.fields.title).toBe('My title');
    expect(applied.fields.model).toBe('');
    expect(applied.fields.agent).toBe('claude');
  });

  it('ignores an obsolete template apply callback after another template was chosen', () => {
    const first = chooseRunTemplate(createRunDraft({ prompt: 'Original' }, data), parameterized);
    const next = chooseRunTemplate(first, plain);
    expect(applyRunTemplate(next, parameterized.id, 'Stale result')).toBe(next);
  });

  it('deselects a missing or pending template without discarding operator text', () => {
    const initial = createRunDraft({ templateId: 'template-missing', prompt: 'Keep my draft' }, data);
    expect(canPreviewRun(initial)).toBe(false);
    const direct = chooseRunTemplate(initial, null);
    expect(direct.fields.prompt).toBe('Keep my draft');
    expect(buildRunRequest(direct).templateId).toBeUndefined();
    expect(canPreviewRun(direct)).toBe(true);
  });

  it('cannot revive a command preview by editing a prompt away and back to the same text', () => {
    const original = createRunDraft({ prompt: 'Original' }, data);
    const changed = updateRunFields(original, { prompt: 'Changed' });
    const restored = updateRunFields(changed, { prompt: 'Original' });
    expect(buildRunRequest(restored)).toEqual(buildRunRequest(original));
    expect(runDraftSignature(restored)).not.toBe(runDraftSignature(original));
  });
});

describe('work item, resume and permission contracts', () => {
  it('requires a current preview, a permitted project, an installed CLI and live mode before explicit start', () => {
    const draft = createRunDraft({ prompt: 'Inspect' }, data);
    const current = { demo: false, projects, connectors: [connector] };
    const signature = runDraftSignature(draft);
    expect(canStartRun(draft, signature, current)).toBe(true);
    expect(canStartRun(draft, undefined, current)).toBe(false);
    expect(canStartRun(updateRunFields(draft, { prompt: 'New instructions' }), signature, current)).toBe(false);
    expect(canStartRun(draft, signature, { ...current, demo: true })).toBe(false);
    expect(canStartRun(draft, signature, { ...current, projects: projects.map(project => ({ ...project, executionEnabled: false })) })).toBe(false);
    expect(canStartRun(draft, signature, { ...current, projects: [] })).toBe(false);
    expect(canStartRun(draft, signature, { ...current, connectors: [{ ...connector, installed: false }] })).toBe(false);
  });

  it('retains the intended work project and sends the original work version and context references', () => {
    const source = {
      workItemId: 'work-fixture', workItemVersion: 7, projectId: 'project-work',
      contextPackIds: ['pack-existing'], prompt: 'Already compiled work and context',
    };
    const draft = createRunDraft(source, data);
    source.workItemVersion = 8;
    source.contextPackIds.push('pack-background');
    const changed = updateRunFields(draft, { projectId: 'project-first' });
    expect(buildRunRequest(changed)).toEqual({
      agent: 'codex', projectId: 'project-work', policy: 'read-only',
      prompt: 'Already compiled work and context', workItemId: 'work-fixture', workItemVersion: 7,
      contextPackIds: ['pack-existing'],
    });
    expect(changed.appliedContextIds).toEqual(['pack-existing']);
  });

  it('never changes a resumed session agent or project when a template is applied', () => {
    const original = createRunDraft({
      resumeSessionId: 'codex:original', agent: 'codex', projectId: 'project-work', prompt: 'Continue',
    }, data);
    const selected = chooseRunTemplate(original, parameterized);
    const applied = applyRunTemplate(selected, parameterized.id, 'Continue with a filled prompt');
    const changed = updateRunFields(applied, { agent: 'kiro', projectId: 'project-first' });
    expect(buildRunRequest(changed)).toMatchObject({
      agent: 'codex', projectId: 'project-work', resumeSessionId: 'codex:original',
    });
    expect(buildRunRequest(changed).allowShell).toBeUndefined();
  });

  it('keeps explicit shell consent scoped to supported writable policies', () => {
    let draft = createRunDraft({ agent: 'claude', policy: 'workspace-write', allowShell: true, prompt: 'Inspect' }, data);
    expect(buildRunRequest(draft).allowShell).toBe(false);
    draft = updateRunFields(draft, { allowShell: true });
    expect(buildRunRequest(draft).allowShell).toBe(true);
    draft = updateRunFields(draft, { policy: 'read-only' });
    expect(draft.fields.allowShell).toBe(false);
    expect(buildRunRequest(draft).allowShell).toBeUndefined();
    draft = updateRunFields(draft, { agent: 'codex', policy: 'workspace-write', allowShell: true });
    expect(draft.fields.allowShell).toBe(false);
    expect(buildRunRequest(draft).allowShell).toBeUndefined();
  });

  it('preserves source-session metadata and rejects incomplete work links before preview', () => {
    expect(buildRunRequest(createRunDraft({ sourceSessionId: 'claude:source', prompt: 'Handoff' }, data)).sourceSessionId)
      .toBe('claude:source');
    expect(canPreviewRun(createRunDraft({ workItemId: 'work-fixture', prompt: 'Work' }, data))).toBe(false);
    expect(canPreviewRun(createRunDraft({ workItemVersion: 2, prompt: 'Work' }, data))).toBe(false);
    expect(canPreviewRun(createRunDraft({ workItemId: 'work-fixture', workItemVersion: 0, prompt: 'Work' }, data))).toBe(false);
  });
});

describe('context composition in an editable run draft', () => {
  it('blocks preview for new references until their context has been appended', () => {
    const draft = selectRunContextPacks(createRunDraft({ prompt: 'Instructions' }, data), ['pack-a']);
    expect(canPreviewRun(draft)).toBe(false);
    const attached = commitRunContext(draft, { prompt: 'Instructions', selectedIds: ['pack-a'], appliedIds: [] }, {
      prompt: 'Instructions\n\nContext A', selectedIds: ['pack-a'], appliedIds: ['pack-a'],
    });
    expect(canPreviewRun(attached)).toBe(true);
    expect(buildRunRequest(attached)).toMatchObject({ prompt: 'Instructions\n\nContext A', contextPackIds: ['pack-a'] });
  });

  it('removes an unavailable reference without removing edited context text or forgetting it was appended', () => {
    const initial = createRunDraft({ prompt: 'Edited context text', contextPackIds: ['pack-unavailable'] }, data);
    const removed = selectRunContextPacks(initial, []);
    expect(removed.fields.prompt).toBe('Edited context text');
    expect(buildRunRequest(removed).contextPackIds).toBeUndefined();
    expect(removed.appliedContextIds).toEqual(['pack-unavailable']);
    const reselected = selectRunContextPacks(removed, ['pack-unavailable']);
    expect(canPreviewRun(reselected)).toBe(true);
    expect(reselected.fields.prompt).toBe('Edited context text');
  });

  it('rejects late composition after the operator changes the prompt or selected references', () => {
    const draft = selectRunContextPacks(createRunDraft({ prompt: 'Original' }, data), ['pack-a']);
    const input = { prompt: 'Original', selectedIds: ['pack-a'], appliedIds: [] };
    const result = { prompt: 'Original\n\nContext A', selectedIds: ['pack-a'], appliedIds: ['pack-a'] };
    expect(() => commitRunContext(updateRunFields(draft, { prompt: 'My newer edit' }), input, result)).toThrow();
    expect(() => commitRunContext(selectRunContextPacks(draft, []), input, result)).toThrow();
    expect(draft.fields.prompt).toBe('Original');
  });

  it('bounds references and raw prompt length instead of trimming away an oversized draft', () => {
    const original = createRunDraft({ prompt: 'x'.repeat(64_000) }, data);
    expect(canPreviewRun(original)).toBe(true);
    expect(canPreviewRun(updateRunFields(original, { prompt: `${original.fields.prompt} ` }))).toBe(false);
    expect(() => selectRunContextPacks(original, Array.from({ length: 6 }, (_, i) => `pack-${i}`))).toThrow();
    expect(() => selectRunContextPacks(original, ['pack-a', 'pack-a'])).toThrow();
    expect(() => selectRunContextPacks(original, ['../invalid'])).toThrow();
  });
});
