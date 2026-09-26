import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { ContextPacksView } from '../../pages/ContextPacks';
import { I18nContext, createI18n } from '../../i18n/I18nProvider';
import { contextPackPage } from './testFixtures';

const props = {
  page: contextPackPage(), projects: [], loading: false, error: null, busy: false,
  query: { q: '', projectId: '', offset: 0 }, onQuery: () => {},
  onNew: () => {}, onOpen: () => {}, onDelete: () => {}, onReload: () => {},
};
function render(patch: Partial<typeof props> = {}, language: 'en' | 'ko' = 'en') {
  return renderToStaticMarkup(<I18nContext.Provider value={{ ...createI18n(language), setLanguage: () => {} }}>
    <ContextPacksView {...props} {...patch} />
  </I18nContext.Provider>);
}

test('the context-packs page lists metadata and offers explicit open, create and delete actions in both languages', () => {
  const html = render();
  expect(html).toContain('Context packs');
  expect(html).toContain('New context pack');
  expect(html).toContain('Open pack 원문 pack');
  expect(html).toContain('Delete pack 원문 pack');
  expect(html).toContain('Original description');
  expect(html).not.toContain('Keep original instructions');
  expect(html).not.toContain('저장한 원문');
  expect(html.replaceAll('원문 pack', '')).not.toMatch(/[가-힣]/u);
  expect(render({}, 'ko')).toContain('컨텍스트 묶음');
  expect(render({}, 'ko')).toContain('새 컨텍스트 묶음');
});

test('an empty page and a load failure remain distinct and each offers the relevant recovery action', () => {
  const empty = render({ page: { items: [], total: 0, offset: 0, limit: 25 } });
  expect(empty).toContain('No context packs');
  expect(empty).toContain('New context pack');
  const failed = render({ error: 'Context pack not found.' as never });
  expect(failed).toContain('role="alert"');
  expect(failed).toContain('Reload packs');
  expect(failed).not.toContain('No context packs');
});

test('the page disables creating pack 201 and withholds stale actions during a pending request', () => {
  const capped = render({ page: { ...contextPackPage(), total: 200 } });
  expect(capped).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?New context pack/);
  const pending = render({ busy: true });
  expect(pending).toMatch(/<button[^>]*aria-label="Open pack 원문 pack"[^>]*disabled=""/);
});
