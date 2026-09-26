import { afterEach, expect, it } from 'vitest';
import { Store } from '../server/store.js';
import { ContextPackService } from '../server/productivity/context-packs.js';
import { emptyUsage } from '../shared/types.js';

const stores: Store[] = [];
function fixture(content: string) {
  const store = new Store(':memory:');
  stores.push(store);
  store.upsertSession({
    id: 'reader-session', nativeId: 'native-reader', agent: 'codex', title: 'Reader example',
    projectPath: '', projectName: '', model: 'fixture', status: 'completed',
    startedAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:00:01Z',
    sourcePath: '/synthetic/source', usage: emptyUsage(), toolCallCount: 0, messageCount: 1,
    messages: [{ id: 'long-message', role: 'assistant', content, timestamp: '2026-09-26T00:00:01Z' }],
  });
  return { store, packs: new ContextPackService(store) };
}
afterEach(() => stores.splice(0).forEach(store => store.close()));

it('captures the displayed search excerpt from its true source offset', () => {
  const content = 'before '.repeat(4000) + 'find-this-marker' + ' after'.repeat(4000);
  const { store, packs } = fixture(content);
  const preview = store.listMessages('reader-session', { q: 'find-this-marker' }).items[0];
  expect(preview.contentOffset).toBe(27_000);
  const pack = packs.create({ name: 'Selected evidence' });
  const captured = packs.addItem(pack.id, {
    version: pack.version, kind: 'message', sessionId: 'reader-session', messageId: 'long-message',
    offset: preview.contentOffset!, length: 1200,
  });
  expect(captured.items[0].text).toBe(preview.content.slice(0, 1200));
  expect(captured.items[0].text).toContain('find-this-marker');
  expect(store.getMessage('reader-session', 'long-message')?.content).toBe(content);
});

it('keeps preview boundaries on whole UTF-16 characters so the default capture range is valid', () => {
  const start = '😀' + 'y'.repeat(999) + 'needle';
  const content = 'x'.repeat(5000) + start + 'z'.repeat(15_999 - start.length) + '😀' + 'tail'.repeat(2000);
  const { store, packs } = fixture(content);
  const preview = store.listMessages('reader-session', { q: 'needle' }).items[0];
  expect(preview.contentOffset).toBe(5000);
  expect(preview.content.startsWith('😀')).toBe(true);
  expect(preview.content.length).toBeLessThanOrEqual(16_000);
  expect(preview.content).not.toMatch(/[\uD800-\uDBFF]$/);
  const pack = packs.create({ name: 'Unicode evidence' });
  expect(packs.addItem(pack.id, {
    version: 1, kind: 'message', sessionId: 'reader-session', messageId: 'long-message',
    offset: preview.contentOffset!, length: 8000,
  }).items[0].text).toBe(preview.content.slice(0, 8000));
});
