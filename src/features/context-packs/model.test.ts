import { expect, test } from 'vitest';
import {
  captureInput, contextPackItemPatch, contextPackReorderInput, contextPackRunDraft, moveContextPackItem,
  reconcileItemDrafts, reconcileItemOrder, toggleContextPack,
} from './model';
import { contextCompilation, contextPack } from './testFixtures';

test('message capture sends source IDs, range and version without reader preview text', () => {
  const source = { sessionId: 'codex:fixture', messageId: 'message-fixture', previewText: 'not a trusted source' };
  expect(captureInput(3, source, 4, 8)).toEqual({
    version: 3, kind: 'message', sessionId: 'codex:fixture', messageId: 'message-fixture', offset: 4, length: 8,
  });
});

test.each([[-1, 1], [0, 0], [0, 8001], [1.5, 1], [0, Number.NaN], [Number.MAX_SAFE_INTEGER, 2]])(
  'invalid capture ranges fail before submitting (%s + %s)', (offset, length) => {
    expect(() => captureInput(3, { sessionId: 's', messageId: 'm' }, offset, length)).toThrow();
  },
);

test('selection keeps order, allows removal at capacity and never silently drops saved IDs', () => {
  expect(toggleContextPack(['a', 'b'], 'c', 3)).toEqual(['a', 'b', 'c']);
  expect(toggleContextPack(['a', 'b', 'c'], 'b', 3)).toEqual(['a', 'c']);
  expect(toggleContextPack(['a', 'b', 'c'], 'd', 3)).toEqual(['a', 'b', 'c']);
  expect(toggleContextPack(['a', 'b', 'c', 'd', 'e'], 'f', 10)).toEqual(['a', 'b', 'c', 'd', 'e']);
});

test('prepare-run returns an editable read-only draft with provenance links and no execution', () => {
  expect(contextPackRunDraft(contextPack(), contextCompilation())).toEqual({
    title: '원문 pack', prompt: '# Context pack\n\nOriginal source and instructions\n',
    projectId: 'project-fixture', policy: 'read-only', contextPackIds: ['pack-fixture'],
  });
  expect(contextPackRunDraft(contextPack({ projectId: null }), contextCompilation()).projectId).toBeUndefined();
});

test.each([
  { packId: 'pack-other' }, { version: 2 }, { itemCount: 1 },
  { prompt: 'x'.repeat(64001), characters: 64001 }, { characters: 1 },
])('a stale or inconsistent compilation cannot become a prepared run (case %#)', patch => {
  expect(() => contextPackRunDraft(contextPack(), contextCompilation(patch))).toThrow();
});

test('saving a source label omits source text even if an editor draft contains changed text', () => {
  const pack = contextPack();
  expect(contextPackItemPatch(pack.version, pack.items[0], { title: 'New label', text: 'forged draft' }))
    .toEqual({ version: 3, title: 'New label' });
  expect(contextPackItemPatch(pack.version, pack.items[1], { title: 'Note label', text: 'Edited note' }))
    .toEqual({ version: 3, title: 'Note label', text: 'Edited note' });
});

test('accepting one item edit preserves other unsaved drafts and forgets removed items', () => {
  const pack = contextPack();
  const drafts = {
    'pack-item-source': { title: 'Unsaved source label', text: pack.items[0].text },
    'pack-item-note': { title: 'Unsaved note label', text: 'Unsaved note body' },
    removed: { title: 'Removed', text: 'Gone' },
  };
  const result = reconcileItemDrafts(pack, drafts, 'pack-item-note');
  expect(result).toEqual({
    'pack-item-source': { title: 'Unsaved source label', text: pack.items[0].text },
    'pack-item-note': { title: 'Operator note', text: '메모 원문' },
  });
});

test('a reordered draft retains the loaded version and order while newer list metadata arrives', () => {
  const loaded = contextPack();
  const order = moveContextPackItem(loaded.items.map(item => item.id), 'pack-item-note', -1);
  const newer = { ...loaded, version: 9 };
  const summaryPage = { items: [newer], total: 1, offset: 0, limit: 25 };
  // A page refresh is display metadata. The mutation is built from the editable snapshot.
  expect(summaryPage.items[0].version).toBe(9);
  expect(contextPackReorderInput(loaded, order)).toEqual({
    version: 3, itemIds: ['pack-item-note', 'pack-item-source'],
  });
  expect(loaded.items.map(item => item.id)).toEqual(['pack-item-source', 'pack-item-note']);
  expect(moveContextPackItem(order, 'pack-item-note', -1)).toEqual(order);
});

test('saving a note does not discard a pending order and adding or removing items reconciles that order', () => {
  const pack = contextPack();
  const order = ['pack-item-note', 'pack-item-source', 'pack-item-removed'];
  expect(reconcileItemOrder(pack, order)).toEqual(['pack-item-note', 'pack-item-source']);
  const next = { ...pack, items: [...pack.items, { ...pack.items[1], id: 'pack-item-new' }] };
  expect(reconcileItemOrder(next, order)).toEqual(['pack-item-note', 'pack-item-source', 'pack-item-new']);
});
