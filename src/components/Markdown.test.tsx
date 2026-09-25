import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown';

test('conversation Markdown never emits raw HTML or an automatically loaded image', () => {
  const result = renderToStaticMarkup(
    <Markdown content={'<script>alert(1)</script>\n\n<img src="https://example.com/tracker">\n\n![외부 이미지](https://example.com/tracker.png)\n\n[위험](javascript:alert(1))'} />,
  );
  assert.doesNotMatch(result, /<script|<img\b|javascript:|src="https:/i);
  assert.match(result, /외부 이미지/);
});

test('explicit external links use isolation and GFM tables remain readable', () => {
  const result = renderToStaticMarkup(
    <Markdown content={'[문서](https://example.com)\n\n| 이름 | 값 |\n| --- | --- |\n| 토큰 | 12 |'} />,
  );
  assert.match(result, /rel="noreferrer noopener"/);
  assert.match(result, /<table/);
  assert.match(result, /<td>12<\/td>/);
});
