import { expect, test } from 'vitest';
import { applyWorkItemLocation, type WorkItemsPageState } from '../src/features/work-items/model.js';

test('initial palette search and item links initialize the advertised q and editor', () => {
  const page = applyWorkItemLocation(null, 'q=%EC%84%A4%EC%A0%95+%5Bx%5D%3F*&id=work-target');
  expect(page.query).toEqual({
    q: '설정 [x]?*', status: 'open', archived: false, sort: 'priority', limit: 25, offset: 0,
  });
  expect(page.editor).toEqual({ itemId: 'work-target' });
});

test('ordinary renders and SSE retain typed filters and locally opened editors when the hash is unchanged', () => {
  const typed: WorkItemsPageState = {
    search: 'q=original',
    query: { q: 'typed locally', status: 'blocked', priority: 'high', projectId: 'project-one', limit: 50, offset: 100 },
    editor: { itemId: 'work-local' },
  };
  expect(applyWorkItemLocation(typed, 'q=original')).toEqual(typed);
});

test('an external search that drops id closes the editor, applies q and resets only the page position', () => {
  const current: WorkItemsPageState = {
    search: 'id=work-open&q=old',
    query: { q: 'typed locally', projectId: 'project-one', status: 'blocked', priority: 'high', limit: 50, offset: 100 },
    editor: { itemId: 'work-open' },
  };
  const next = applyWorkItemLocation(current, 'q=new+search');
  expect(next.query).toEqual({
    q: 'new search', projectId: 'project-one', status: 'blocked', priority: 'high', limit: 50, offset: 0,
  });
  expect(next.editor).toBeNull();
  expect(current.query.q).toBe('typed locally');
});

test('clearing navigation q removes the old URL filter and an id link still selects the right editor', () => {
  const current = applyWorkItemLocation(null, 'q=old&id=work-one');
  const next = applyWorkItemLocation(current, 'id=work-two');
  expect(next.query.q).toBeUndefined();
  expect(next.editor).toEqual({ itemId: 'work-two' });
  const cleared = applyWorkItemLocation(next, '');
  expect(cleared.query.q).toBeUndefined();
  expect(cleared.editor).toBeNull();
});

test('navigation search bounds match the work search input and an empty q clears it', () => {
  const current = applyWorkItemLocation(null, `q=${'x'.repeat(201)}`);
  expect(current.query.q).toHaveLength(200);
  expect(applyWorkItemLocation(current, 'q=').query.q).toBeUndefined();
});
