import { afterEach, expect, test, vi } from 'vitest';
import type { WorkItemQuery } from '../shared/work-items.js';
import {
  captureWorkItemDraft, changeWorkItemFilters, createWorkItemDraft, localWorkDate,
  nextWorkDayDelay, preparedWorkItemDraft, readWorkItemId, requestWorkItemQuery, toggleWorkSession,
  workItemColumns, workItemDueState, workItemInput, workItemLink, workItemPageOffset, workItemPatch, workItemRange, workSessionQuery,
} from '../src/features/work-items/model.js';
import { sourceSession, workDetail, workPage, workProject, workSummary } from '../src/features/work-items/testFixtures.js';

afterEach(() => vi.unstubAllEnvs());

test.each([
  ['America/New_York', '2026-03-08T04:30:00Z', '2026-03-07'],
  ['America/New_York', '2026-03-08T16:30:00Z', '2026-03-08'],
  ['Asia/Seoul', '2026-12-31T16:00:00Z', '2027-01-01'],
])('due queries use the local calendar in %s at %s', (zone, now, today) => {
  vi.stubEnv('TZ', zone);
  expect(localWorkDate(new Date(now))).toBe(today);
  expect(requestWorkItemQuery({ due: 'today', today: '1999-01-01' }, new Date(now)).today).toBe(today);
});

test.each([
  ['2026-03-08T05:00:00Z', 23 * 60 * 60 * 1000],
  ['2026-11-01T04:00:00Z', 25 * 60 * 60 * 1000],
])('the next local calendar refresh follows the DST day length at %s', (now, delay) => {
  vi.stubEnv('TZ', 'America/New_York');
  expect(nextWorkDayDelay(new Date(now))).toBe(delay);
});

test('list requests are bounded, preserve literal searches, and omit irrelevant dates', () => {
  const query = requestWorkItemQuery({
    q: '설정 [x]?* % _ & review', projectId: 'project & one', status: 'open',
    priority: 'high', archived: false, sort: 'due', limit: 1000, offset: -5, today: '1999-01-01',
  });
  expect(query).toEqual({
    q: '설정 [x]?* % _ & review', projectId: 'project & one', status: 'open',
    priority: 'high', archived: false, sort: 'due', limit: 100, offset: 0,
  });
  expect(requestWorkItemQuery({ q: 'x'.repeat(201), limit: Number.NaN }).q).toHaveLength(200);
  expect(requestWorkItemQuery({ limit: Number.NaN }).limit).toBe(25);
  expect(requestWorkItemQuery({ due: 'none' })).not.toHaveProperty('today');
});

test('changing any filter or ordering resets pagination without mutating the current query', () => {
  const before: WorkItemQuery = { q: 'old', status: 'open', sort: 'priority', offset: 50, limit: 25 };
  expect(changeWorkItemFilters(before, { q: 'new' })).toEqual({ ...before, q: 'new', offset: 0 });
  expect(changeWorkItemFilters(before, { archived: true, status: undefined })).toMatchObject({ archived: true, status: undefined, offset: 0 });
  expect(before.offset).toBe(50);
});

test('displayed rows and totals remain distinct on a partial page and after deletion', () => {
  expect(workItemRange(workPage({ items: [workSummary()], total: 26, offset: 25, limit: 25 }))).toEqual({
    from: 26, to: 26, visible: 1, total: 26,
  });
  const empty = workPage({ items: [], total: 24, offset: 25, limit: 25 });
  expect(workItemRange(empty)).toEqual({ from: 0, to: 0, visible: 0, total: 24 });
  expect(workItemPageOffset(empty)).toBe(0);
  expect(workItemPageOffset(workPage({ items: [], total: 0, offset: 75 }))).toBe(0);
  expect(workItemPageOffset(workPage({ total: 76, offset: 50 }))).toBe(50);
});

test('board columns show page-local counts beside filtered totals and honor the status filter', () => {
  const page = workPage({
    items: [workSummary(), workSummary({ id: 'work-blocked', status: 'blocked' })],
    counts: { todo: 12, in_progress: 9, blocked: 6, done: 30 }, total: 27,
  });
  expect(workItemColumns(page, 'open').map(column => [column.status, column.visible, column.total])).toEqual([
    ['todo', 1, 12], ['in_progress', 0, 9], ['blocked', 1, 6],
  ]);
  expect(workItemColumns(page, 'blocked').map(column => [column.status, column.visible, column.total])).toEqual([
    ['blocked', 1, 6],
  ]);
});

test('overdue feedback follows work status and never derives completion from the last CLI result', () => {
  expect(workItemDueState(workSummary({ dueDate: '2026-09-25', status: 'blocked', lastRunStatus: 'completed' }), '2026-09-26'))
    .toBe('overdue');
  expect(workItemDueState(workSummary({ dueDate: '2026-09-26' }), '2026-09-26')).toBe('today');
  expect(workItemDueState(workSummary({ dueDate: '2026-09-27' }), '2026-09-26')).toBe('upcoming');
  expect(workItemDueState(workSummary({ dueDate: '2026-09-25', status: 'done' }), '2026-09-26')).toBe('inactive');
  expect(workItemDueState(workSummary({ dueDate: null }), '2026-09-26')).toBe('none');
});

test('palette and widget links round-trip only a bounded item identifier', () => {
  expect(workItemLink('work:a & 한글')).toBe('#/work-items?id=work%3Aa+%26+%ED%95%9C%EA%B8%80');
  expect(readWorkItemId('id=work%3Aa+%26+%ED%95%9C%EA%B8%80')).toBe('work:a & 한글');
  expect(readWorkItemId('id=first&id=second')).toBeNull();
  expect(readWorkItemId(`id=${'x'.repeat(201)}`)).toBeNull();
  expect(readWorkItemId('id=%00bad')).toBeNull();
});

test('editor input owns its original version and copied fields across metadata changes', () => {
  const source = workDetail();
  const draft = createWorkItemDraft(source);
  draft.fields.title = 'Local title';
  draft.fields.nextAction = 'Local next step';
  source.version = 2;
  source.title = 'Remote title';
  source.sessionIds.push('claude:other');
  source.sessions[0].title = 'Changed source metadata';
  const patch = workItemPatch(draft);
  expect(patch).toMatchObject({ version: 1, title: 'Local title', nextAction: 'Local next step', sessionIds: ['codex:synthetic'] });
  expect(draft.sessions[0].title).toBe('Original session title');
  expect(patch).not.toHaveProperty('original');
  expect(patch).not.toHaveProperty('sessions');
});

test('session capture copies a title and source identity without transcript, notes, usage or inferred completion', () => {
  const session = {
    ...sourceSession({ status: 'completed', title: 'Source title' }),
    messages: [{ content: 'PRIVATE FULL TRANSCRIPT'.repeat(10000) }],
  };
  const draft = captureWorkItemDraft(session, [workProject]);
  expect(workItemInput(draft)).toEqual({
    title: 'Source title', description: '', nextAction: '', projectId: workProject.id,
    dueDate: null, status: 'todo', priority: 'normal',
    sessionIds: ['codex:synthetic'], contextPackIds: [],
  });
  expect(draft.sessions).toEqual([{ id: 'codex:synthetic', title: 'Source title', agent: 'codex', available: true }]);
  expect(JSON.stringify(draft)).not.toContain('PRIVATE FULL TRANSCRIPT');
  expect(JSON.stringify(draft)).not.toContain('Private operator note');
  expect(captureWorkItemDraft(sourceSession(), []).fields.projectId).toBeNull();
});

test('capture titles remain within the input limit without splitting an emoji', () => {
  const draft = captureWorkItemDraft(sourceSession({ title: `${'x'.repeat(199)}🙂` }), []);
  expect(draft.fields.title).toBe('x'.repeat(199));
});

test('session selection preserves human names and other-page selections while enforcing twenty references', () => {
  let draft = createWorkItemDraft();
  for (let index = 0; index < 20; index++) {
    draft = toggleWorkSession(draft, { id: `session-${index}`, title: `Human title ${index}`, agent: 'codex', available: true });
  }
  expect(() => toggleWorkSession(draft, { id: 'extra', title: 'Extra', agent: 'claude', available: true })).toThrow();
  expect(draft.fields.sessionIds).toHaveLength(20);
  draft = toggleWorkSession(draft, { id: 'session-0', title: 'Human title 0', agent: 'codex', available: true });
  expect(draft.fields.sessionIds).toHaveLength(19);
  expect(draft.sessions[0].title).toBe('Human title 1');
});

test('a session picker resets an old project page and uses native project-path search keys', () => {
  expect(workSessionQuery({ q: '설정 [x]?*', agent: 'kiro', projectPath: '/tmp/new project' },
    { projectPath: '/tmp/previous project', offset: 40 })).toEqual({
    q: '설정 [x]?*', agent: 'kiro', project: '/tmp/new project', limit: 10, offset: 0,
  });
  expect(workSessionQuery({ q: 'literal', projectPath: '/tmp/current' },
    { projectPath: '/tmp/current', offset: 20 }).offset).toBe(20);
  expect(workSessionQuery({ q: 'any project' }, { projectPath: '/tmp/current', offset: 20 })).toMatchObject({ offset: 0 });
});

test.each([
  { title: '' }, { title: 'x'.repeat(201) }, { description: 'x'.repeat(8001) },
  { nextAction: 'x'.repeat(8001) }, { dueDate: '2026-02-29' }, { dueDate: '2026-09-31' },
  { sessionIds: ['same', 'same'] }, { contextPackIds: Array.from({ length: 6 }, (_, i) => `pack-${i}`) },
])('invalid editor values cannot produce a mutation, case %#', fields => {
  const draft = createWorkItemDraft();
  draft.fields = { ...draft.fields, title: 'Valid', ...fields };
  expect(() => workItemInput(draft)).toThrow();
});

test('prepare-run passes through reviewed server metadata and does not mark work done', () => {
  const draft = createWorkItemDraft(workDetail({ status: 'blocked' }));
  const prepared = {
    workItem: workDetail({ status: 'blocked' }),
    draft: {
      agent: 'kiro' as const, policy: 'read-only' as const, prompt: 'Literal 원문 {{value}}',
      projectId: workProject.id, workItemId: draft.original!.id, workItemVersion: 1, contextPackIds: ['pack-synthetic'],
    },
  };
  expect(preparedWorkItemDraft(draft, prepared)).toEqual(prepared.draft);
  expect(draft.fields.status).toBe('blocked');
  expect(() => preparedWorkItemDraft(draft, { ...prepared, draft: { ...prepared.draft, workItemVersion: 2 } })).toThrow();
  expect(() => preparedWorkItemDraft(draft, { ...prepared, workItem: workDetail({ version: 2 }) })).toThrow();
});
