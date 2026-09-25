import { expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExtensionContent } from '../../../shared/extensions';
import { ExtensionContentView } from './ExtensionContentView';
import { ExtensionFiles } from './ExtensionFiles';

function content(overrides: Partial<ExtensionContent>): ExtensionContent {
  return {
    fileId: 'opaque-file', path: 'SKILL.md', language: 'markdown',
    content: '회귀 테스트', bytes: 100, truncated: false, redacted: false, ...overrides,
  };
}

test('instruction Markdown cannot inject HTML, script links, or automatically loaded images', () => {
  const html = renderToStaticMarkup(<ExtensionContentView content={content({
    content: '<script>alert(1)</script>\n\n<img src="https://example.com/tracker">\n\n![참고 이미지](https://example.com/image.png)\n\n[스크립트](javascript:alert(1))\n\n[문서](https://example.com/docs)',
  })} />);
  expect(html).not.toMatch(/<script|<img\b|javascript:|src="https:/i);
  expect(html).toContain('참고 이미지');
  expect(html).toContain('href="https://example.com/docs"');
  expect(html).toContain('rel="noreferrer noopener"');
});

test('a script file is rendered as escaped text even when it contains HTML', () => {
  const html = renderToStaticMarkup(<ExtensionContentView content={content({
    path: 'scripts/example.sh', language: 'bash', content: 'echo "<script>window.bad = true</script>"',
  })} />);
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('scripts/example.sh 내용');
});

test('a bounded, redacted response discloses both limitations beside the returned content', () => {
  const html = renderToStaticMarkup(<ExtensionContentView content={content({
    content: 'token: [REDACTED]\n\n회귀 테스트', truncated: true, redacted: true,
  })} />);
  expect(html).toContain('마스킹');
  expect(html).toContain('앞부분만');
  expect(html).toContain('[REDACTED]');
  expect(html).toContain('회귀 테스트');
});

test('unreadable inventory files are disabled and never exposed as path links', () => {
  const html = renderToStaticMarkup(<ExtensionFiles extensionId="opaque-extension" files={[
    { id: 'opaque-reference', path: 'references/checklist.md', kind: 'reference', bytes: 80, readable: true },
    { id: 'opaque-binary', path: 'assets/example.bin', kind: 'other', bytes: 1024, readable: false },
  ]} />);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="assets\/example\.bin 파일 보기"/);
  expect(html).toContain('미리보기 제한');
  expect(html).toContain('references/checklist.md 파일 보기');
  expect(html).not.toMatch(/<a\b|href=/i);
});
