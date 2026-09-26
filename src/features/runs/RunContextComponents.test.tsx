import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { PromptTemplate } from '../../../shared/types';
import { I18nContext, createI18n } from '../../i18n/I18nProvider';
import { RunContextActions } from './RunContextAttachment';
import { RunContextTemplate } from './RunContextTemplate';

const template: PromptTemplate = {
  id: 'template-fixture', name: '새 실행', description: '취소', category: 'review', agent: 'any', policy: 'read-only',
  prompt: 'Review {{target}}', variables: [{ name: 'target', label: '사용자 입력', type: 'text', required: true }],
  revision: 2, updatedAt: '2026-09-26T00:00:00Z',
};
function html(children: ReactNode, language: 'en' | 'ko' = 'en') {
  return renderToStaticMarkup(<I18nContext.Provider value={{ ...createI18n(language), setLanguage: () => {} }}>
    {children}
  </I18nContext.Provider>);
}
const templateActions = { onApply: () => {}, onInputsChange: () => {}, onEditInputs: () => {} };

it('requires explicit variable application while retaining the selected template name as user text', () => {
  const result = html(<RunContextTemplate template={template} templateId={template.id} pending inputsOpen {...templateActions} />);
  expect(result).toContain('Apply template inputs before previewing the command.');
  expect(result).toContain('사용자 입력');
  expect(result).toContain('새 실행');
  expect(result).toContain('Apply prompt');
  expect(result).toMatch(/<input[^>]*required=""/);
});

it('does not mount empty required fields for an already-resolved library draft', () => {
  const result = html(<RunContextTemplate template={template} templateId={template.id} pending={false}
    inputsOpen={false} {...templateActions} />);
  expect(result).toContain('The template is already applied. You can edit the prompt directly.');
  expect(result).toContain('Enter variables again');
  expect(result).not.toContain('required=""');
  expect(result).not.toContain('Apply prompt');
});

it('reports an unavailable unresolved template instead of silently treating it as applied', () => {
  const result = html(<RunContextTemplate template={null} templateId="template-missing" pending inputsOpen={false} {...templateActions} />);
  expect(result).toContain('The selected template is unavailable.');
});

it('leaves ordinary legacy templates on the direct editable-prompt path', () => {
  expect(html(<RunContextTemplate template={{ ...template, variables: undefined }} templateId={template.id}
    pending={false} inputsOpen={false} {...templateActions} />)).toBe('');
});

it('shows new-context readiness and explicitly preserves prompt text when references are removed', () => {
  const result = html(<RunContextActions selectedCount={2} pendingCount={1} busy={false}
    onCompile={() => {}} onCancel={() => {}} />);
  expect(result).toContain('2 references · 1 awaiting insertion');
  expect(result).toContain('Removing a reference keeps the prompt text. Edit the text yourself if needed.');
  expect(result).toContain('Previously inserted packs are not appended again when reselected.');
  expect(result).toContain('Add selected context');
  expect(result).not.toMatch(/<button[^>]*disabled=""[^>]*>Add selected context/);
});

it('keeps cancellation available during compilation while disabling another compile request', () => {
  const result = html(<RunContextActions selectedCount={1} pendingCount={1} busy onCompile={() => {}} onCancel={() => {}} />);
  expect(result).toContain('Compiling context');
  expect(result).toContain('Cancel compilation');
  expect(result).toMatch(/<button[^>]*disabled=""[^>]*>/);
  expect(result).not.toMatch(/<button[^>]*disabled=""[^>]*>Cancel compilation/);
});

it('disables redundant insertion but still explains how references and prompt text differ', () => {
  const result = html(<RunContextActions selectedCount={1} pendingCount={0} busy={false}
    onCompile={() => {}} onCancel={() => {}} />);
  expect(result).toMatch(/<button[^>]*disabled=""[^>]*>Add selected context/);
  expect(result).toContain('Removing a reference keeps the prompt text.');
});

it('translates cancellation and errors without changing the operator draft', () => {
  const english = html(<RunContextActions selectedCount={1} pendingCount={1} busy={false} cancelled
    error="컨텍스트를 포함한 프롬프트는 64,000자 이하여야 합니다." onCompile={() => {}} onCancel={() => {}} />);
  expect(english).toContain('Cancelled. Your prompt and selected references are unchanged.');
  expect(english).toContain('The prompt including context must be at most 64,000 characters.');
  const korean = html(<RunContextActions selectedCount={1} pendingCount={1} busy={false} cancelled
    onCompile={() => {}} onCancel={() => {}} />, 'ko');
  expect(korean).toContain('취소했습니다. 프롬프트와 선택한 연결은 그대로 유지됩니다.');
});
