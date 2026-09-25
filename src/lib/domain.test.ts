import assert from 'node:assert/strict';
import { test } from 'vitest';
import { tokenUsage, recordedDuration, parseTags, safeMarkdownUrl } from './format';
import { toQueryString } from './query';

test('missing usage stays unknown and a recorded zero remains zero', () => {
  assert.deepEqual(tokenUsage({ inputTokens: null, outputTokens: null }), { total: null, complete: false });
  assert.deepEqual(tokenUsage({ inputTokens: 0, outputTokens: 0 }), { total: 0, complete: true });
  assert.deepEqual(tokenUsage({ inputTokens: 120, outputTokens: null }), { total: 120, complete: false });
  assert.deepEqual(tokenUsage({ inputTokens: 120, outputTokens: 30 }), { total: 150, complete: true });
});

test('recorded timing never invents an elapsed duration for invalid records', () => {
  assert.equal(recordedDuration('2026-09-24T01:00:00Z', '2026-09-24T01:02:30Z'), 150_000);
  assert.equal(recordedDuration('invalid', '2026-09-24T01:00:00Z'), null);
  assert.equal(recordedDuration('2026-09-24T02:00:00Z', '2026-09-24T01:00:00Z'), null);
});

test('query serialization preserves Korean content, opaque paths and offset zero', () => {
  const query = new URLSearchParams(toQueryString({
    q: '오류 & 복구', project: '/workspace/a b?#', bookmarked: true, limit: 20, offset: 0,
  }));
  assert.equal(query.get('q'), '오류 & 복구');
  assert.equal(query.get('project'), '/workspace/a b?#');
  assert.equal(query.get('bookmarked'), 'true');
  assert.equal(query.get('offset'), '0');
  assert.equal(new URLSearchParams(toQueryString({ bookmarked: false, q: '' })).size, 0);
});

test('tag editing trims duplicate tags without splitting Korean or spaces inside a tag', () => {
  assert.deepEqual(parseTags(' #검토, 긴급 수정,검토,\n API '), ['검토', '긴급 수정', 'API']);
});

test('transcript URLs cannot execute script or trigger local API navigation', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>', '/api/sync', '//example.com', 'file:///secret', '\njavascript:alert(1)']) {
    assert.equal(safeMarkdownUrl(url), '');
  }
  assert.equal(safeMarkdownUrl('https://example.com/docs?q=한국어'), 'https://example.com/docs?q=한국어');
  assert.equal(safeMarkdownUrl('mailto:operator@example.com'), 'mailto:operator@example.com');
});
