import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PromptTemplate } from '../../../shared/types';
import type { TemplateRevision, TemplateVariable } from '../../../shared/template-fields';
import { I18nContext, createI18n } from '../../i18n/I18nProvider';
import { TemplateVariableInputs } from './TemplateVariableInputs';
import { TemplateApplyPanel } from './TemplateApplyPanel';
import { TemplateDefinitionEditor, discoverTemplateDefinitions } from './TemplateDefinitionEditor';
import { TemplateHistoryView, TemplateRevisionPreview } from './TemplateHistory';

const variables: TemplateVariable[] = [
  { name: 'target', label: '새 실행', description: '취소', type: 'text', required: true, defaultValue: '사용자 기본값' },
  { name: 'note', label: '사용자 메모', type: 'multiline', required: false },
  { name: 'mode', label: '사용자 선택', type: 'select', required: true, options: ['미리보기', '$& {{target}}'], defaultValue: '미리보기' },
];
const template: PromptTemplate = {
  id: 'template-fixture', name: '프롬프트', description: '템플릿 사용',
  category: 'review', agent: 'codex', policy: 'read-only', prompt: '{{target}}\n{{note}}\n{{mode}}',
  variables, revision: 2, updatedAt: '2026-09-25T10:00:00.000Z',
};
const revision: TemplateRevision = {
  ...template, revision: 1, name: '새 실행', description: '취소', prompt: '<script>literal</script> {{target}}\n{{note}}\n{{mode}}',
};
function html(children: ReactNode, language: 'en' | 'ko' = 'en') {
  return renderToStaticMarkup(<I18nContext.Provider value={{ ...createI18n(language), setLanguage: () => {} }}>
    {children}
  </I18nContext.Provider>);
}

describe('reusable template inputs', () => {
  it('renders text, multiline and select inputs with associated labels, bounds and defaults', () => {
    const result = html(<TemplateVariableInputs variables={variables} values={{ note: '첫 줄\n둘째 줄' }}
      onChange={() => {}} idPrefix="fixture" />);
    expect(result).toContain('for="fixture-target">새 실행</label>');
    expect(result).toMatch(/<input[^>]*id="fixture-target"[^>]*required=""[^>]*maxLength="8000"[^>]*value="사용자 기본값"/);
    expect(result).toContain('aria-describedby="fixture-target-help"');
    expect(result).toContain('id="fixture-target-help"');
    expect(result).toContain('취소');
    expect(result).toMatch(/<textarea[^>]*id="fixture-note"[^>]*>첫 줄\n둘째 줄<\/textarea>/);
    expect(result).toContain('<option value="미리보기" selected="">미리보기</option>');
    expect(result).toContain('Input variables');
    expect(result).toContain('Choose an option');
    expect(result).not.toContain('>New run</label>');
    expect(result).not.toContain('>Preview</option>');
  });

  it('keeps an explicit empty input empty instead of redisplaying its default', () => {
    const result = html(<TemplateVariableInputs variables={[variables[0]]} values={{ target: '' }} onChange={() => {}} idPrefix="empty" />);
    expect(result).toMatch(/<input[^>]*id="empty-target"[^>]*value=""/);
    expect(result).not.toContain('value="사용자 기본값"');
  });

  it('disables the whole input group while its parent is busy', () => {
    const result = html(<TemplateVariableInputs variables={variables} values={{}} disabled onChange={() => {}} />);
    expect(result).toMatch(/<fieldset[^>]*disabled=""/);
  });

  it('uses Korean interface copy without changing user content', () => {
    const result = html(<TemplateVariableInputs variables={variables} values={{}} onChange={() => {}} />, 'ko');
    expect(result).toContain('입력 변수');
    expect(result).toContain('선택 항목을 고르세요');
    expect(result).toContain('사용자 기본값');
    expect(result).not.toContain('Input variables');
  });

  it('renders no input group for a plain legacy template', () => {
    expect(html(<TemplateVariableInputs variables={[]} values={{}} onChange={() => {}} />)).toBe('');
  });
});

describe('explicit template application', () => {
  it('shows a literal preview without applying it during render', () => {
    const applied: string[] = [];
    const result = html(<TemplateApplyPanel template={{
      ...template, prompt: '{{target}}', variables: [{ ...variables[0], defaultValue: '{{other}} $& $(literal)' }],
    }} onApply={prompt => { applied.push(prompt); }} />);
    expect(result).toContain('{{other}} $&amp; $(literal)');
    expect(result).toContain('Prompt to apply');
    expect(result).toContain('readOnly=""');
    expect(result).toContain('Apply prompt');
    expect(result).not.toMatch(/<button[^>]*disabled=""[^>]*>Apply prompt/);
    expect(applied).toEqual([]);
  });

  it('disables application and reports an untranslated required variable name in English', () => {
    const result = html(<TemplateApplyPanel template={{
      ...template, prompt: '{{target}}', variables: [{ ...variables[0], defaultValue: undefined }],
    }} onApply={() => {}} />);
    expect(result).toContain('Enter a required variable value: target');
    expect(result).toMatch(/<button[^>]*disabled=""[^>]*>Apply prompt<\/button>/);
  });

  it('keeps legacy braces in the preview and permits explicitly applying the unchanged text', () => {
    const result = html(<TemplateApplyPanel template={{ ...template, variables: undefined, prompt: ' \n{{target}} {{bad.name}}\n' }}
      onApply={() => {}} />);
    expect(result).toContain(' \n{{target}} {{bad.name}}\n');
    expect(result).not.toContain('Input variables');
    expect(result).not.toMatch(/<button[^>]*disabled=""[^>]*>Apply prompt/);
  });

  it('surfaces definition errors before allowing application', () => {
    const result = html(<TemplateApplyPanel template={{ ...template, prompt: '{{missing}}' }} onApply={() => {}} />);
    expect(result).toContain('Missing variable definition: missing');
    expect(result).toMatch(/<button[^>]*disabled=""[^>]*>Apply prompt<\/button>/);
  });
});

describe('definition editing', () => {
  it('discovers names explicitly while retaining existing labels, choices and defaults', () => {
    expect(discoverTemplateDefinitions('{{target}} {{new_value}} {{target}}', [variables[0]])).toEqual([
      variables[0], { name: 'new_value', label: 'new_value', type: 'text', required: true },
    ]);
  });

  it('does not silently delete an unused definition or exceed the combined definition limit', () => {
    expect(discoverTemplateDefinitions('plain text', [variables[0]])).toEqual([variables[0]]);
    const existing = Array.from({ length: 20 }, (_, i) => ({ ...variables[0], name: `existing_${i}` }));
    expect(() => discoverTemplateDefinitions('{{extra}}', existing)).toThrow();
  });

  it('renders every editable definition property while preserving user text in English', () => {
    const result = html(<TemplateDefinitionEditor prompt={template.prompt} variables={variables} onChange={() => {}} />);
    expect(result).toContain('Variable definitions');
    expect(result).toContain('Find variables in prompt');
    expect(result).toContain('Variable name');
    expect(result).toContain('Display label');
    expect(result).toContain('Help text');
    expect(result).toContain('Default value');
    expect(result).toContain('Choices (one per line)');
    expect(result).toContain('value="새 실행"');
    expect(result).toContain('value="취소"');
    expect(result).toContain('미리보기\n$&amp; {{target}}');
  });
});

describe('history preview and restore controls', () => {
  it('previews literal source, definition metadata and saved defaults without translating user text', () => {
    const result = html(<TemplateRevisionPreview revision={revision} />);
    expect(result).toContain('&lt;script&gt;literal&lt;/script&gt; {{target}}');
    expect(result).not.toContain('<script>');
    expect(result).toContain('새 실행');
    expect(result).toContain('취소');
    expect(result).toContain('사용자 기본값');
    expect(result).toContain('미리보기');
    expect(result).toContain('Default value');
    expect(result).toContain('Read-only');
  });

  it('enables restore only for an available earlier revision and never for the current revision', () => {
    const props = { template, revisions: [{ ...template, revision: 2 }, revision], onSelect: () => {}, onRestore: () => {} };
    const current = html(<TemplateHistoryView {...props} selectedRevision={2} />);
    expect(current).toMatch(/<button[^>]*disabled=""[^>]*>Restore as new revision<\/button>/);
    const previous = html(<TemplateHistoryView {...props} selectedRevision={1} />);
    expect(previous).toContain('&lt;script&gt;literal&lt;/script&gt;');
    expect(previous).not.toMatch(/<button[^>]*disabled=""[^>]*>Restore as new revision/);
    const missing = html(<TemplateHistoryView {...props} selectedRevision={99} />);
    expect(missing).toMatch(/<button[^>]*disabled=""[^>]*>Restore as new revision<\/button>/);
  });

  it('preserves the selected preview when a conflict is reported and provides a reload action', () => {
    const result = html(<TemplateHistoryView template={template} revisions={[revision]} selectedRevision={1}
      onSelect={() => {}} onRestore={() => {}} onReload={() => {}}
      error="템플릿이 변경되었습니다. 최신 내용을 다시 불러온 뒤 시도하세요." />);
    expect(result).toContain('The template changed. Reload the latest version and try again.');
    expect(result).toContain('&lt;script&gt;literal&lt;/script&gt;');
    expect(result).toContain('Reload history');
  });

  it('explains an empty retained history and disables restoration in both languages', () => {
    const props = { template, revisions: [], selectedRevision: null, onSelect: () => {}, onRestore: () => {} };
    expect(html(<TemplateHistoryView {...props} />)).toContain('No retained revisions are available.');
    const result = html(<TemplateHistoryView {...props} />, 'ko');
    expect(result).toContain('보관된 개정이 없습니다.');
    expect(result).toMatch(/<button[^>]*disabled=""[^>]*>새 개정으로 복원<\/button>/);
  });
});
