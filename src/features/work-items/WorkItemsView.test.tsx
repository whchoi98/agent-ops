import { expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { createI18n, I18nContext } from '../../i18n/I18nProvider';
import { WorkItemsView, type WorkItemsViewProps } from './WorkItemsView';
import { WorkItemForm, WorkItemEditorActions } from './WorkItemForm';
import { WorkItemEditorNotice } from './WorkItemEditor';
import { OpenWorkItemsView } from './OpenWorkItems';
import { SessionSelection } from './SessionPicker';
import { createWorkItemDraft } from './model';
import { workDetail, workPage, workProject, workSummary, sourceSession } from './testFixtures';

function render(children: ReactNode, language: 'en' | 'ko' = 'en') {
  return renderToStaticMarkup(<I18nContext.Provider value={{ ...createI18n(language), setLanguage: () => {} }}>
    {children}
  </I18nContext.Provider>);
}
function control(html: string, label: string) {
  const button = (html.match(/<button\b[\s\S]*?<\/button>/g) ?? []).find(value => value.includes(label));
  expect(button, label).toBeDefined();
  return button!;
}
function page(patch: Partial<WorkItemsViewProps> = {}) {
  return <WorkItemsView page={workPage()} query={{ status: 'open', limit: 25, offset: 0 }} projects={[workProject]}
    mode="list" today="2026-09-26" loading={false} error={null} onFilters={() => {}} onPage={() => {}}
    onMode={() => {}} onNew={() => {}} onOpen={() => {}} onOpenRun={() => {}} onReload={() => {}} {...patch} />;
}

test('list copy is bilingual while work titles, previews and project names remain literal', () => {
  const item = workSummary({ title: '설정 <script>task</script>', nextActionPreview: '원문 {{value}}', descriptionPreview: 'User description' });
  const english = render(page({ page: workPage({ items: [item] }) }));
  expect(english).toContain('Work items');
  expect(english).toContain('New work item');
  expect(english).toContain('Next action');
  expect(english).toContain('설정 &lt;script&gt;task&lt;/script&gt;');
  expect(english).toContain('원문 {{value}}');
  expect(english).toContain('Synthetic project');
  expect(english).not.toContain('<script>');
  const korean = render(page({ page: workPage({ items: [item] }) }), 'ko');
  expect(korean).toContain('작업센터');
  expect(korean).toContain('새 작업');
  expect(korean).toContain('다음 할 일');
  expect(korean).toContain('원문 {{value}}');
});

test('board headers distinguish visible cards from total matches instead of claiming the whole board is loaded', () => {
  const html = render(page({
    mode: 'board',
    page: workPage({ items: [workSummary()], total: 37, counts: { todo: 12, in_progress: 15, blocked: 10, done: 8 } }),
  }));
  expect(html).toContain('Shown 1 / Total 12');
  expect(html).toContain('Shown 0 / Total 15');
  expect(html).toContain('Shown 0 / Total 10');
  expect(html).toContain('1–1 / 37');
  expect(html).toContain('No work items on this page.');
  expect(html).not.toContain('Shown 0 / Total 8');
});

test('a status-filtered board contains only the requested column', () => {
  const html = render(page({
    mode: 'board', query: { status: 'blocked' },
    page: workPage({ items: [workSummary({ status: 'blocked' })], total: 5, counts: { todo: 10, in_progress: 20, blocked: 5, done: 30 } }),
  }));
  expect(html).toContain('Shown 1 / Total 5');
  expect(html).not.toContain('Shown 0 / Total 10');
  expect(html).not.toContain('Shown 0 / Total 30');
});

test('completed CLI output is labeled separately and leaves blocked work in the blocked state', () => {
  const html = render(page({ page: workPage({ items: [workSummary({
    status: 'blocked', lastRunId: 'run-fixture', lastRunStatus: 'completed', dueDate: '2026-09-25',
  })] }) }));
  expect(html).toContain('Blocked');
  expect(html).toContain('Last run');
  expect(html).toContain('Completed');
  expect(html).toContain('Overdue');
  expect(html).toContain('A finished run does not automatically complete the work item.');
});

test('pagination reports the actual last partial page and disables only impossible directions', () => {
  const html = render(page({ page: workPage({ items: [workSummary()], total: 26, offset: 25, limit: 25 }) }));
  expect(html).toContain('26–26 / 26');
  expect(control(html, 'Previous page')).not.toContain('disabled=""');
  expect(control(html, 'Next page')).toContain('disabled=""');
});

test('an out-of-range page does not claim the workspace is empty while matches still exist', () => {
  const html = render(page({ page: workPage({ items: [], total: 24, offset: 25 }) }));
  expect(html).toContain('0–0 / 24');
  expect(html).not.toContain('No work items yet');
  expect(control(html, 'Previous page')).not.toContain('disabled=""');
});

test('filters expose project, work status, priority, due dates, archive, sorting and list/board controls', () => {
  const html = render(page());
  for (const label of ['Search work items', 'Work status', 'Priority', 'Due date', 'Project filter', 'Sort work items', 'Items per page']) {
    expect(html).toContain(label);
  }
  expect(html).toContain('Next 7 days');
  expect(html).toContain('Archived');
  expect(control(html, 'List view')).toContain('aria-pressed="true"');
  expect(control(html, 'Board view')).toContain('aria-pressed="false"');
});

test('load errors retain an explicit retry and loading prevents pagination through stale results', () => {
  const html = render(page({ loading: true, error: 'This work item changed. Reload it before continuing.' }));
  expect(html).toContain('role="alert"');
  expect(html).toContain('Reload work items');
  expect(control(html, 'Next page')).toContain('disabled=""');
});

test('the Overview widget shows five summaries and the open total without requiring detail bodies', () => {
  const items = Array.from({ length: 5 }, (_, index) => workSummary({ id: `work-${index}`, title: `Task ${index}` }));
  const html = render(<OpenWorkItemsView page={workPage({ items, total: 32, limit: 5 })} projects={[workProject]}
    today="2026-09-26" loading={false} error={null} onReload={() => {}} />);
  expect(html).toContain('Open work items');
  expect(html).toContain('Showing 5 of 32 open work items');
  expect(html).toContain('href="#/work-items?id=work-0"');
  expect(html).not.toContain('Original full description');
});

test('the Overview widget distinguishes a missing project from an intentionally unassigned one', () => {
  const html = render(<OpenWorkItemsView page={workPage()} projects={[]} today="2026-09-26"
    loading={false} error={null} onReload={() => {}} />);
  expect(html).toContain('Unavailable project');
});

test('an editor renders the full loaded fields, bounded controls and readable available/unavailable sources', () => {
  const draft = createWorkItemDraft(workDetail({
    title: 'Local draft', description: 'Full description '.repeat(40), nextAction: 'Local next action',
    sessionIds: ['codex:synthetic', 'lost-session'],
    sessions: [
      { id: 'codex:synthetic', title: 'Readable source name', agent: 'codex', available: true },
      { id: 'lost-session', title: 'Lost source', agent: null, available: false },
    ],
    packs: [{ id: 'pack-synthetic', name: 'Readable pack name', available: false }],
  }));
  const html = render(<WorkItemForm id="work-form" draft={draft} projects={[workProject]} disabled={false}
    onEdit={() => {}} onToggleSession={() => {}} onPickSessions={() => {}} onPickPacks={() => {}}
    onOpenSession={() => {}} onOpenPack={() => {}} />);
  expect(html).toContain('Local draft');
  expect(html).toContain('Full description '.repeat(40));
  expect(html).toContain('Local next action');
  expect(html).toMatch(/maxLength="200"/i);
  expect((html.match(/maxLength="8000"/gi) ?? [])).toHaveLength(2);
  expect(html).toContain('Readable source name');
  expect(html).toContain('Readable pack name');
  expect(html).toContain('Unavailable source');
  expect(control(html, 'Lost source')).toContain('disabled=""');
});

test('a conflict keeps edited text visible and offers an explicit reload in either language', () => {
  const draft = createWorkItemDraft(workDetail());
  draft.fields.title = '내 수정 제목';
  draft.fields.description = '내가 입력한 원문 <script>';
  const content = <>
    <WorkItemForm id="conflict-form" draft={draft} projects={[workProject]} disabled={false}
      onEdit={() => {}} onToggleSession={() => {}} onPickSessions={() => {}} onPickPacks={() => {}}
      onOpenSession={() => {}} onOpenPack={() => {}} />
    <WorkItemEditorNotice error="This work item changed. Reload it before continuing." saved busy={false} onReload={() => {}} />
  </>;
  const english = render(content);
  expect(english).toContain('This work item changed. Reload it before continuing.');
  expect(english).toContain('Reload latest work item');
  expect(english).toContain('내 수정 제목');
  expect(english).toContain('내가 입력한 원문 &lt;script&gt;');
  const korean = render(content, 'ko');
  expect(korean).toContain('다른 곳에서 이 작업을 수정했습니다.');
  expect(korean).toContain('최신 내용 다시 불러오기');
  expect(korean).toContain('내가 입력한 원문 &lt;script&gt;');
  expect(draft.original?.version).toBe(1);
});

test('preparation requires a saved clean active record and reopening remains an explicit action', () => {
  const props = { formId: 'work-form', busy: null, loading: false, onPrepare: () => {}, onArchive: () => {}, onReopen: () => {}, onDelete: () => {}, onClose: () => {} };
  const dirty = render(<WorkItemEditorActions {...props} draft={createWorkItemDraft(workDetail())} dirty />);
  expect(control(dirty, 'Prepare run')).toContain('disabled=""');
  expect(dirty).toContain('Save your changes first.');
  const done = render(<WorkItemEditorActions {...props} draft={createWorkItemDraft(workDetail({ status: 'done' }))} dirty={false} />);
  expect(control(done, 'Prepare run')).toContain('disabled=""');
  expect(control(done, 'Reopen work item')).not.toContain('disabled=""');
});

test('session linking displays names and provider metadata with bounded selection rather than an ID-entry field', () => {
  const html = render(<SessionSelection page={{ items: [sourceSession()], total: 50 }} selected={[
    { id: 'previous-page', title: 'Already selected by name', agent: 'claude', available: true },
  ]} loading={false} error={null} offset={0} limit={10} disabled={false}
    onToggle={() => {}} onPage={() => {}} onReload={() => {}} />);
  expect(html).toContain('Original session title');
  expect(html).toContain('Already selected by name');
  expect(html).toContain('1 / 20 selected');
  expect(html).toContain('type="checkbox"');
  expect(html).not.toContain('Paste session ID');
  expect(html).toContain('1–1 / 50');
});

test('twenty selected sessions disable further choices but allow removal', () => {
  const selected = Array.from({ length: 20 }, (_, index) => ({
    id: `chosen-${index}`, title: `Selected ${index}`, agent: 'codex', available: true,
  }));
  const html = render(<SessionSelection page={{ items: [sourceSession()], total: 1 }} selected={selected}
    loading={false} error={null} offset={0} limit={10} disabled={false}
    onToggle={() => {}} onPage={() => {}} onReload={() => {}} />);
  expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled=""/);
  expect(control(html, 'Selected 0')).not.toContain('disabled=""');
});
