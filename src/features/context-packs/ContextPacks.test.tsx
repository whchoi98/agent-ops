import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { expect, test } from 'vitest';
import { I18nContext, createI18n } from '../../i18n/I18nProvider';
import { ContextPackFields } from './ContextPackFields';
import { ContextPackItemEditor } from './ContextPackItemEditor';
import { ContextPackSelection } from './ContextPackPicker';
import { ContextPackOutput } from './ContextPackOutput';
import { CaptureContextFields } from './CaptureContextDialog';
import { contextCompilation, contextPack, contextPackPage } from './testFixtures';

function render(children: ReactNode, language: 'ko' | 'en' = 'en') {
  return renderToStaticMarkup(<I18nContext.Provider value={{ ...createI18n(language), setLanguage: () => {} }}>
    {children}
  </I18nContext.Provider>);
}
const noop = () => {};

test('metadata fields use existing accessible controls and preserve user content in both languages', () => {
  const value = { name: '설정', description: '원문 description', instructions: '원문 instructions', projectId: null };
  const fields = <ContextPackFields value={value} projects={[]} onChange={noop} idPrefix="fixture" />;
  const english = render(fields);
  expect(english).toContain('Pack name');
  expect(english).toContain('Operator instructions');
  expect(english).toContain('설정');
  expect(english).toContain('원문 instructions');
  expect(english).toMatch(/for="fixture-name"/);
  expect(english).toMatch(/id="fixture-name"[^>]*maxLength="200"/i);
  expect(english).toMatch(/id="fixture-description"[^>]*maxLength="500"/i);
  expect(english).toMatch(/id="fixture-instructions"[^>]*maxLength="8000"/i);
  const korean = render(fields, 'ko');
  expect(korean).toContain('묶음 이름');
  expect(korean).toContain('사용자 지시사항');
  expect(korean).toContain('원문 instructions');
});

test('a missing project is displayed without silently clearing the stored reference', () => {
  const html = render(<ContextPackFields value={{
    name: 'Pack', description: '', instructions: '', projectId: 'project-missing',
  }} projects={[]} onChange={noop} idPrefix="fixture" />);
  expect(html).toContain('Unavailable project');
  expect(html).toContain('value="project-missing" selected=""');
});

test('captured bodies are read-only, unavailable sources stay visible, and boundary reorder controls are disabled', () => {
  const item = contextPack().items[0];
  const html = render(<ContextPackItemEditor item={item} draft={{ title: item.title, text: item.text }}
    index={0} total={2} onChange={noop} onSave={noop} onRemove={noop} onMove={noop} onOpenSource={noop} />);
  expect(html).toContain('Source unavailable');
  expect(html).toContain('Captured message');
  expect(html).toContain('저장한 원문');
  expect(html).toContain('설정');
  expect(html).toContain('codex:fixture');
  expect(html).toContain('message-fixture');
  expect(html).toContain('2026-09-25T10:01:00.000Z');
  expect(html).toMatch(/<textarea[^>]*readOnly=""/i);
  expect(html).not.toContain('<script>');
  expect(html).toMatch(/<button[^>]*aria-label="Move Source label up"[^>]*disabled=""/);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Open source session/);
});

test('operator notes can edit original text while captured-label changes never make source text editable', () => {
  const item = contextPack().items[1];
  const html = render(<ContextPackItemEditor item={item} draft={{ title: item.title, text: item.text + ' changed' }}
    index={1} total={2} onChange={noop} onSave={noop} onRemove={noop} onMove={noop} onOpenSource={noop} />);
  expect(html).toContain('Operator note');
  expect(html).toContain('메모 원문 changed');
  expect(html).not.toMatch(/readOnly=""/i);
  expect(html).toMatch(/maxLength="8000"/i);
  expect(html).toContain('Save note');
});

test('picker renders only paginated metadata and keeps selected IDs removable across pages', () => {
  const html = render(<ContextPackSelection page={contextPackPage()} selectedIds={['pack-on-another-page']}
    maxSelected={1} loading={false} error={null} onToggle={noop} onReload={noop} onPage={noop} />);
  expect(html).toContain('원문 pack');
  expect(html).toContain('pack-on-another-page');
  expect(html).toContain('Remove selected pack');
  expect(html).toContain('Next');
  expect(html).toMatch(/type="checkbox"[^>]*disabled=""/);
  expect(html).not.toContain('저장한 원문');
  expect(html).not.toContain('Keep original instructions');
});

test('picker load errors are translated locally with a retry and cannot be mistaken for an empty list', () => {
  const props = {
    page: null, selectedIds: [], maxSelected: 5, loading: false,
    error: 'Context pack not found.', onToggle: noop, onReload: noop, onPage: noop,
  };
  expect(render(<ContextPackSelection {...props} />)).toContain('role="alert"');
  expect(render(<ContextPackSelection {...props} />)).toContain('Reload packs');
  expect(render(<ContextPackSelection {...props} />, 'ko')).toContain('컨텍스트 묶음을 찾을 수 없습니다.');
  expect(render(<ContextPackSelection {...props} />)).not.toContain('No context packs');
});

test('output includes the full compiled prompt and explicit review, copy and local export actions', () => {
  const prompt = 'complete excerpt\n'.repeat(2500) + 'PROMPT-END';
  const compilation = contextCompilation({ prompt, characters: prompt.length });
  const html = render(<ContextPackOutput compilation={compilation} busy={false} dirty={false}
    onCompile={noop} onPrepareRun={noop} onExport={noop} />);
  expect(html).toContain('PROMPT-END');
  expect(html).toContain('Copy compiled context');
  expect(html).toContain('Markdown');
  expect(html).toContain('JSON');
  expect(html).toContain('Prepare run');
  expect(html).toContain('Review the prompt and command');
  expect(html).toContain('characters');
  expect(html).not.toMatch(/\b\d+\s+tokens\b|AI-generated summary/i);
});

test('unsaved edits invalidate copy and prepared-run actions instead of using an old compilation', () => {
  const html = render(<ContextPackOutput compilation={contextCompilation()} busy={false} dirty
    onCompile={noop} onPrepareRun={noop} onExport={noop} />);
  expect(html).toContain('Save your edits');
  expect(html).not.toContain('Copy compiled context');
  expect(html).not.toContain('Original source and instructions');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Prepare run/);
});

test('capture fields explain source-ID capture and keep the selected preview read-only', () => {
  const html = render(<CaptureContextFields sessionId="codex:fixture" messageId="message-fixture"
    offset="0" length="8" onOffset={noop} onLength={noop} previewText="원문 선택" />);
  expect(html).toContain('codex:fixture');
  expect(html).toContain('message-fixture');
  expect(html).toContain('원문 선택');
  expect(html).toContain('Start character');
  expect(html).toContain('Characters to capture');
  expect(html).toMatch(/max="8000"/);
  expect(html).toContain('captures the selected range from the local message');
  expect(html).not.toMatch(/<textarea[^>]*(?<!readOnly="")name="text"/i);
});
