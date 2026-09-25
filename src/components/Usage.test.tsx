import { expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AggregateTokenValue } from './ui';

test('a group with sessions but no recorded usage never presents measured zero', () => {
  const html = renderToStaticMarkup(<AggregateTokenValue tokens={0} knownTokenSessions={0} sessions={4} />);
  expect(html).toContain('토큰 기록 없음');
  expect(html).toContain('—');
});

test('a genuinely recorded zero remains visible as zero', () => {
  const html = renderToStaticMarkup(<AggregateTokenValue tokens={0} knownTokenSessions={4} sessions={4} />);
  expect(html).toMatch(/>0<\/span>/);
  expect(html).not.toContain('토큰 기록 없음');
});

test('a partially recorded group discloses its coverage beside the subtotal', () => {
  const html = renderToStaticMarkup(<AggregateTokenValue tokens={1200} knownTokenSessions={2} sessions={5} />);
  expect(html).toContain('1.2K');
  expect(html).toContain('2/5개 기록');
  expect(html).toContain('부분 합계');
});
