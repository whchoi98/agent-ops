import { afterEach, expect, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { createI18n, I18nContext } from '../../i18n/I18nProvider';
import { SavedViewsBar, SavedViewsToolbar, type SavedViewsToolbarProps } from './SavedViewsBar';
import { SavedViewForm } from './SavedViewForm';
import { createSavedViewDraft } from './editor';
import { useSavedViews } from './useSavedViews';
import { savedView } from './testFixtures';

afterEach(() => vi.unstubAllGlobals());

function render(children: ReactNode, language: 'en' | 'ko' = 'en') {
  return renderToStaticMarkup(<I18nContext.Provider value={{ ...createI18n(language), setLanguage: () => {} }}>
    {children}
  </I18nContext.Provider>);
}

function button(html: string, label: string): string {
  const control = (html.match(/<button\b[\s\S]*?<\/button>/g) ?? []).find(candidate => candidate.includes(label));
  expect(control, `${label} button`).toBeDefined();
  return control!;
}

function toolbar(patch: Partial<SavedViewsToolbarProps> = {}) {
  const props: SavedViewsToolbarProps = {
    views: [savedView()], loading: false, saving: false, error: null, writeError: null,
    selectedId: savedView().id, onSelect: () => {}, onOpen: () => {}, onSave: () => {},
    onEdit: () => {}, onPin: () => {}, onDelete: () => {}, onReload: () => {},
    ...patch,
  };
  return <SavedViewsToolbar {...props} />;
}

test('saved-view controls translate locally while saved names remain literal, escaped user content', () => {
  const view = savedView({ name: '설정 <script>literal</script>' });
  const english = render(toolbar({ views: [view] }));
  expect(english).toContain('Saved views');
  expect(english).toContain('Save current view');
  expect(english).toContain('Open view');
  expect(english).toContain('Edit view');
  expect(english).toContain('Delete view');
  expect(english).toContain('Unpin view');
  expect(english).toContain('설정 &lt;script&gt;literal&lt;/script&gt;');
  expect(english).not.toContain('<script>');
  expect(english).not.toContain('Matching sessions');
  const korean = render(toolbar({ views: [view] }), 'ko');
  expect(korean).toContain('저장 검색');
  expect(korean).toContain('현재 조건 저장');
  expect(korean).toContain('저장 검색 열기');
  expect(korean).toContain('설정 &lt;script&gt;literal&lt;/script&gt;');
});

test('pinning exposes the selected state to assistive technology and no selection disables view actions', () => {
  const pinned = render(toolbar());
  expect(button(pinned, 'Unpin view')).toContain('aria-pressed="true"');
  const unpinned = render(toolbar({ views: [savedView({ pinned: false })] }));
  expect(button(unpinned, 'Pin view')).toContain('aria-pressed="false"');
  const empty = render(toolbar({ views: [], selectedId: '' }));
  for (const label of ['Open view', 'Edit view', 'Delete view', 'Pin view']) {
    expect(button(empty, label)).toContain('disabled=""');
  }
  expect(empty).toContain('No saved views yet');
});

test('loading and saving are accessible states that prevent duplicate actions', () => {
  const loading = render(toolbar({ views: [], loading: true }));
  expect(loading).toContain('Loading saved views');
  expect(loading).toContain('role="status"');
  expect(button(loading, 'Save current view')).toContain('disabled=""');
  const saving = render(toolbar({ saving: true }));
  expect(saving).toContain('aria-busy="true"');
  expect(button(saving, 'Delete view')).toContain('disabled=""');
});

test('a full list disables only new saves and keeps edit and deletion available', () => {
  const views = Array.from({ length: 50 }, (_, index) => savedView({ id: `view-${index}`, name: `View ${index}` }));
  const html = render(toolbar({ views, selectedId: views[0].id }));
  expect(html).toContain('You can save up to 50 views.');
  expect(button(html, 'Save current view')).toContain('disabled=""');
  expect(button(html, 'Edit view')).not.toContain('disabled=""');
  expect(button(html, 'Delete view')).not.toContain('disabled=""');
});

test('load and write errors remain visible with a metadata retry and local translation', () => {
  const english = render(toolbar({
    error: '저장 검색 요청 시간이 초과되었습니다. 새로고침 후 다시 시도하세요.',
    writeError: '저장 검색이 변경되었습니다. 새로고침 후 다시 시도하세요.',
  }));
  expect(english).toContain('role="alert"');
  expect(english).toContain('The saved-view request timed out.');
  expect(english).toContain('This saved view has changed.');
  expect(english).toContain('Reload saved views');
  const korean = render(toolbar({ writeError: '저장 검색이 변경되었습니다. 새로고침 후 다시 시도하세요.' }), 'ko');
  expect(korean).toContain('저장 검색이 변경되었습니다.');
});

test('the editor provides named, bounded inputs and all relative/custom period options in both languages', () => {
  const draft = createSavedViewDraft({ q: '설정 <script>literal</script>', since: '2026-11-01', until: '2026-11-01', offset: 120 });
  const element = <SavedViewForm id="fixture-form" draft={{ ...draft, name: '설정' }} busy={false} stale={false}
    error={null} onChange={() => {}} onSubmit={event => event.preventDefault()} onUseCurrent={() => {}} />;
  const english = render(element);
  expect(english).toContain('View name');
  expect(english).toMatch(/<input[^>]*maxLength="120"/i);
  expect(english).toContain('All time');
  expect(english).toContain('Today');
  expect(english).toContain('Last 7 days');
  expect(english).toContain('Last 30 days');
  expect(english).toContain('Custom range');
  expect(english).toMatch(/<input[^>]*type="date"[^>]*value="2026-11-01"/);
  expect(english).toContain('Use current session filters');
  expect(english).toContain('설정 &lt;script&gt;literal&lt;/script&gt;');
  expect(english).not.toContain('<script>');
  const korean = render(element, 'ko');
  expect(korean).toContain('검색 이름');
  expect(korean).toContain('최근 7일');
  expect(korean).toContain('직접 지정');
});

test('a stale editor explains that the current draft cannot overwrite a newer version', () => {
  const html = render(<SavedViewForm id="fixture-form" draft={createSavedViewDraft({}, savedView())}
    busy={false} stale error={null} onChange={() => {}} onSubmit={event => event.preventDefault()} />);
  expect(html).toContain('This view changed elsewhere.');
  expect(html).toContain('Close the editor and review the latest view before editing again.');
  expect(html).toContain('role="alert"');
});

test('the integration hook and bar initially render a loading state without fetching during render', () => {
  const fetch = vi.fn(() => { throw new Error('Requests must start in the effect.'); });
  vi.stubGlobal('fetch', fetch);
  function PaletteConsumer() {
    const state = useSavedViews(4);
    return <div data-loading={state.loading} data-views={state.views.length} data-pinned={state.pinnedViews.length} />;
  }
  const html = render(<><PaletteConsumer /><SavedViewsBar query={{ q: 'current', offset: 120 }}
    revision={4} onApply={() => {}} /></>);
  expect(html).toContain('data-loading="true"');
  expect(html).toContain('data-views="0"');
  expect(html).toContain('data-pinned="0"');
  expect(html).toContain('Loading saved views');
  expect(fetch).not.toHaveBeenCalled();
});
