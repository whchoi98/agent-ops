import { expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '../../../shared/types';
import { getFindTarget, getLastMessageOffset } from './SessionReader';
import { FullMessageMarkdown, MessageBody, messagePreview } from './MessageBody';

test('last-page navigation jumps directly to the final page of large or filtered results', () => {
  expect(getLastMessageOffset(20_000)).toBe(19_950);
  expect(getLastMessageOffset(180)).toBe(150);
  expect(getLastMessageOffset(103)).toBe(100);
});

test('last-page navigation handles empty results and exact fifty-message boundaries', () => {
  expect(getLastMessageOffset(0)).toBe(0);
  expect(getLastMessageOffset(1)).toBe(0);
  expect(getLastMessageOffset(50)).toBe(0);
  expect(getLastMessageOffset(100)).toBe(50);
});

test('find navigation crosses a fifty-message page boundary in either direction', () => {
  expect(getFindTarget(49, 120, 1)).toEqual({ index: 50, offset: 50 });
  expect(getFindTarget(50, 120, -1)).toEqual({ index: 49, offset: 0 });
});

test('find navigation wraps across the last partial page without skipping a result', () => {
  expect(getFindTarget(102, 103, 1)).toEqual({ index: 0, offset: 0 });
  expect(getFindTarget(0, 103, -1)).toEqual({ index: 102, offset: 100 });
  expect(getFindTarget(0, 0, 1)).toBeNull();
});

test('a shrinking search result cannot produce an out-of-range page', () => {
  expect(getFindTarget(99, 5, 1)).toEqual({ index: 0, offset: 0 });
  expect(getFindTarget(99, 5, -1)).toEqual({ index: 3, offset: 0 });
});

test('initial message content is bounded even if a response omits its truncated flag', () => {
  const message: Message = {
    id: 'long-message', role: 'assistant', timestamp: '2026-09-25T00:00:00Z',
    content: '가'.repeat(20_000),
  };
  expect(messagePreview(message)).toEqual({
    content: '가'.repeat(16_000), truncated: true, contentLength: 20_000,
  });
});

test('a server-generated match preview retains its original content length', () => {
  const message: Message = {
    id: 'matched-message', role: 'assistant', timestamp: '2026-09-25T00:00:00Z',
    content: '후반부 검색 결과', truncated: true, contentLength: 80_000,
  };
  expect(messagePreview(message)).toEqual({
    content: '후반부 검색 결과', truncated: true, contentLength: 80_000,
  });
});

test('an initial long-message render stays bounded until the user requests its full content', () => {
  const html = renderToStaticMarkup(<MessageBody sessionId="session-with-long-output" find="" message={{
    id: 'large-output', role: 'assistant', timestamp: '2026-09-25T00:00:00Z',
    content: `${'x'.repeat(1_000_000)}FULL-CONTENT-TAIL`,
  }} />);
  expect(html.length).toBeLessThan(19_000);
  expect(html).not.toContain('FULL-CONTENT-TAIL');
  expect(html).toContain('전체 메시지 보기');
});

test('explicit full-message rendering includes content beyond the ordinary Markdown preview', () => {
  const content = `${'기록된 내용\n\n'.repeat(6000)}마지막-메시지-검증-표식`;
  expect(content.length).toBeGreaterThan(32_000);
  const html = renderToStaticMarkup(<FullMessageMarkdown content={content} />);
  expect(html).toContain('마지막-메시지-검증-표식');
});

test('expanded full-message Markdown retains HTML and external-image protection', () => {
  const html = renderToStaticMarkup(<FullMessageMarkdown content={
    '<script>alert(1)</script>\n\n<img src="https://example.com/tracker">\n\n![외부 이미지](https://example.com/tracker.png)\n\n[위험](javascript:alert(1))\n\n[문서](https://example.com/docs)'
  } />);
  expect(html).not.toMatch(/<script|<img\b|javascript:|src="https:/i);
  expect(html).toContain('외부 이미지');
  expect(html).toContain('rel="noreferrer noopener"');
});
