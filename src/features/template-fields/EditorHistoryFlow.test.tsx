import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { TemplateInput } from '../../../shared/template-fields';
import type { PromptTemplate } from '../../../shared/types';
import { I18nContext, createI18n } from '../../i18n/I18nProvider';
import { captureTemplateSnapshot, saveTemplateDraft } from './editor';
import { templateFieldsApi } from './api';
import { TemplateHistoryPanel } from './TemplateHistory';

const input: TemplateInput = {
  name: '  사용자 제목  ', description: '취소\n', category: 'custom', agent: 'any', policy: 'read-only',
  prompt: ' \r\n{{target}}\n', variables: [{ name: 'target', label: '새 실행', type: 'text', required: true }],
};
const template: PromptTemplate = {
  ...input, id: 'template-legacy', updatedAt: '2026-09-25T10:00:00.000Z',
};
afterEach(() => vi.unstubAllGlobals());

function captureRequest() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/' });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ...template, revision: 2 }));
  });
  return calls;
}

it('the editor sends revision 1 for a legacy template while preserving prompt and metadata whitespace', async () => {
  const calls = captureRequest();
  await saveTemplateDraft(template, input);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://workbench.invalid/api/templates/template-legacy');
  expect(calls[0].init.method).toBe('PATCH');
  expect(JSON.parse(String(calls[0].init.body))).toEqual({
    name: '  사용자 제목  ', description: '취소\n', category: 'custom', agent: 'any', policy: 'read-only',
    prompt: ' \r\n{{target}}\n', variables: [{ name: 'target', label: '새 실행', type: 'text', required: true }],
    expectedRevision: 1,
  });
});

it('the editor uses the revision it opened, including when definitions are removed', async () => {
  const calls = captureRequest();
  await saveTemplateDraft({ ...template, revision: 8 }, { ...input, variables: [] });
  expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
    variables: [], prompt: ' \r\n{{target}}\n', expectedRevision: 8,
  });
});

it('background changes cannot advance the saved editor snapshot or replace its variable text', async () => {
  const calls = captureRequest();
  const source = { ...template, revision: 5, variables: input.variables!.map(variable => ({ ...variable })) };
  const snapshot = captureTemplateSnapshot(source);
  source.revision = 6;
  source.prompt = 'Background replacement';
  source.variables[0].label = 'Background label';
  await saveTemplateDraft(snapshot, { ...input, prompt: snapshot.prompt, variables: snapshot.variables });
  expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
    expectedRevision: 5, prompt: ' \r\n{{target}}\n',
    variables: [{ name: 'target', label: '새 실행', type: 'text', required: true }],
  });
});

it('restoration uses the loaded snapshot until the operator explicitly reloads it', async () => {
  const calls = captureRequest();
  const source = { ...template, revision: 5 };
  const snapshot = captureTemplateSnapshot(source);
  source.revision = 6;
  await templateFieldsApi.restore(snapshot.id, 2, snapshot.revision);
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ revision: 2, expectedRevision: 5 });
  const reloaded = captureTemplateSnapshot(source);
  await templateFieldsApi.restore(reloaded.id, 2, reloaded.revision);
  expect(JSON.parse(String(calls[1].init.body))).toEqual({ revision: 2, expectedRevision: 6 });
});

it('a new template is created without a client-assigned revision or identity', async () => {
  const calls = captureRequest();
  await saveTemplateDraft(undefined, input);
  expect(calls[0].url).toBe('https://workbench.invalid/api/templates');
  expect(calls[0].init.method).toBe('POST');
  expect(JSON.parse(String(calls[0].init.body))).toEqual({
    name: '  사용자 제목  ', description: '취소\n', category: 'custom', agent: 'any', policy: 'read-only',
    prompt: ' \r\n{{target}}\n', variables: [{ name: 'target', label: '새 실행', type: 'text', required: true }],
  });
});

it('the editor rejects invalid definitions and blank required fields before sending a save', async () => {
  const calls = captureRequest();
  await expect(saveTemplateDraft(template, { ...input, prompt: '{{missing}}' })).rejects.toThrow();
  await expect(saveTemplateDraft(template, { ...input, name: '  ' })).rejects.toThrow();
  await expect(saveTemplateDraft(template, { ...input, prompt: '  ', variables: [] })).rejects.toThrow();
  expect(calls).toEqual([]);
});

it('the history loader starts with a disabled restore action and localized loading feedback', () => {
  const result = renderToStaticMarkup(<I18nContext.Provider value={{ ...createI18n('en'), setLanguage: () => {} }}>
    <TemplateHistoryPanel template={template} onRestored={() => {}} />
  </I18nContext.Provider>);
  expect(result).toContain('Loading revision history');
  expect(result).toMatch(/<button[^>]*disabled=""[^>]*>Restore as new revision<\/button>/);
});
