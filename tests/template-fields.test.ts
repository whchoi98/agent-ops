import { describe, expect, it } from 'vitest';
import {
  renderTemplate, templateVariables, validateTemplateVariables, type TemplateVariable,
} from '../shared/template-fields.js';

const text = (name = 'target', extra: Partial<TemplateVariable> = {}): TemplateVariable => ({
  name, label: '사용자 제목', type: 'text', required: true, ...extra,
});
const template = (prompt = 'Review {{target}}', variables = [text()]) => ({ prompt, variables });

describe('literal template rendering', () => {
  it('keeps legacy braces and whitespace literal even when values are supplied', () => {
    const prompt = ' \r\n{{target}} / {{bad.name}} / {{nested {{target}}}}\t\n';
    expect(renderTemplate({ prompt }, { target: 'replacement' })).toBe(prompt);
    expect(renderTemplate({ prompt, variables: [] }, {})).toBe(prompt);
  });

  it('substitutes only the original placeholders without interpreting replacement text', () => {
    expect(renderTemplate(template('{{target}} | {{other}} | {{target}}', [text(), text('other')]), {
      target: '{{other}} $& $` $\' `echo nope` $(echo nope) \\n',
      other: '한국어 <script>literal</script>',
    })).toBe('{{other}} $& $` $\' `echo nope` $(echo nope) \\n | 한국어 <script>literal</script> | {{other}} $& $` $\' `echo nope` $(echo nope) \\n');
  });

  it('preserves input whitespace and uses defaults only for omitted inputs', () => {
    const source = template('{{target}}/{{note}}', [
      text('target', { defaultValue: '기본 원문' }),
      text('note', { required: false, type: 'multiline', defaultValue: 'default note' }),
    ]);
    expect(renderTemplate(source, {})).toBe('기본 원문/default note');
    expect(renderTemplate(source, { target: '  값\n', note: '' })).toBe('  값\n/');
  });

  it.each([{}, { target: '' }, { target: ' \t\n' }])('rejects an unfilled required input: %j', values => {
    expect(() => renderTemplate(template(), values)).toThrow();
  });

  it('leaves an optional omitted value empty and validates select choices literally', () => {
    const source = template('{{target}}/{{mode}}', [
      text('target', { required: false }),
      text('mode', { type: 'select', options: ['리뷰', '$& {{target}}'] }),
    ]);
    expect(renderTemplate(source, { mode: '$& {{target}}' })).toBe('/$& {{target}}');
    expect(() => renderTemplate(source, { mode: 'not a choice' })).toThrow();
  });

  it.each([null, [], 'text', { target: 12 }, { target: false }, { target: 'ok', unknown: 'bad' }])(
    'rejects malformed or unknown input values: %j', values => {
      expect(() => renderTemplate(template(), values)).toThrow();
    },
  );

  it('never resolves an inherited input or a prototype key', () => {
    expect(() => renderTemplate(template(), Object.create({ target: 'inherited' }))).toThrow();
    expect(() => renderTemplate(template(), JSON.parse('{"target":"ok","__proto__":"bad"}'))).toThrow();
    expect(() => renderTemplate(template(), JSON.parse('{"target":"ok","constructor":"bad"}'))).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('accepts exactly 8,000 characters per value and refuses to truncate a longer one', () => {
    expect(renderTemplate(template('{{target}}'), { target: '가'.repeat(8_000) })).toHaveLength(8_000);
    expect(() => renderTemplate(template(), { target: '가'.repeat(8_001) })).toThrow();
  });

  it('counts repeated values toward the 64,000-character result bound', () => {
    const source = template('{{target}}'.repeat(8));
    expect(renderTemplate(source, { target: 'x'.repeat(8_000) })).toHaveLength(64_000);
    expect(() => renderTemplate({ ...source, prompt: `${source.prompt}!` }, { target: 'x'.repeat(8_000) })).toThrow();
    expect(renderTemplate({ prompt: 'x'.repeat(64_000) }, {})).toHaveLength(64_000);
    expect(() => renderTemplate({ prompt: 'x'.repeat(64_001) }, {})).toThrow();
  });

  it('bounds the final result after empty placeholders shrink a long source', () => {
    expect(renderTemplate(template('{{target}}' + '{{empty}}'.repeat(7_000), [
      text(), text('empty', { required: false }),
    ]), { target: 'x'.repeat(8_000) })).toBe('x'.repeat(8_000));
  });

  it.each([
    ['{"outer":{"value":"{{target}}"}}', '{"outer":{"value":"literal"}}'],
    ['{"outer":{"value":1}}\n{{target}}', '{"outer":{"value":1}}\nliteral'],
    ['{{target}}}}', 'literal}}'],
  ])('keeps ordinary closing braces literal in a parameterized prompt: %s', (prompt, expected) => {
    expect(renderTemplate(template(prompt), { target: 'literal' })).toBe(expected);
  });
});

describe('template variable definitions', () => {
  it('discovers distinct placeholders in source order without treating repeated uses as duplicate definitions', () => {
    expect(templateVariables('{{ target }} {{note}}\n{{target}}')).toEqual(['target', 'note']);
    expect(renderTemplate(template('{{ target }}'), { target: 'original' })).toBe('original');
  });

  it.each(['{{target.name}}', '{{target()}}', '{{target', '{{outer {{target}}}}', '{{}}'])(
    'rejects malformed or nested expressions in parameterized templates: %s', prompt => {
      expect(() => renderTemplate(template(prompt), { target: 'value' })).toThrow();
    },
  );

  it.each(['__proto__', 'constructor', 'prototype', '1name', '한글', 'a-b', 'a.b', 'a'.repeat(41)])(
    'rejects unsafe variable names: %s', name => {
      expect(() => validateTemplateVariables(`{{${name}}}`, [text(name)])).toThrow();
    },
  );

  it('accepts 20 definitions and a 40-character ASCII identifier, then rejects a 21st', () => {
    const names = ['a'.repeat(40), ...Array.from({ length: 19 }, (_, i) => `field_${i}`)];
    const variables = names.map(name => text(name, { required: false }));
    const prompt = names.map(name => `{{${name}}}`).join('');
    expect(renderTemplate({ prompt, variables }, {})).toBe('');
    expect(() => validateTemplateVariables(`${prompt}{{extra}}`, [...variables, text('extra')])).toThrow();
  });

  it('rejects duplicate, unused, and missing definitions before asking for values', () => {
    expect(() => validateTemplateVariables('{{target}}', [text(), text()])).toThrow();
    expect(() => validateTemplateVariables('{{target}}', [text(), text('unused')])).toThrow();
    expect(() => validateTemplateVariables('{{target}} {{missing}}', [text()])).toThrow();
  });

  it.each([
    null,
    {},
    [{ name: 'target', label: 'Title', type: 'text' }],
    [text('target', { type: 'number' as 'text' })],
    [text('target', { type: { toString: () => 'text' } as unknown as 'text' })],
    [text('target', { label: '' })],
    [text('target', { label: 'x'.repeat(201) })],
    [text('target', { description: 'x'.repeat(501) })],
    [text('target', { defaultValue: 'x'.repeat(8_001) })],
    [text('target', { options: ['not a select'] })],
    [text('target', { type: 'select', options: [] })],
    [text('target', { type: 'select', options: new Array<string>(1) })],
    [text('target', { type: 'select', options: ['same', 'same'] })],
    [text('target', { type: 'select', options: ['valid'], defaultValue: 'invalid' })],
    [text('target', { type: 'select', options: [''] })],
    [text('target', { type: 'select', options: ['x'.repeat(8_001)] })],
    [text('target', { type: 'select', options: Array.from({ length: 51 }, (_, i) => String(i)) })],
    [{ ...text(), script: 'anything' }],
  ])('rejects malformed definition metadata: %#', definitions => {
    expect(() => validateTemplateVariables('{{target}}', definitions)).toThrow();
  });

  it('preserves labels, descriptions, defaults and option text as user content', () => {
    const definitions = [text('target', {
      label: '  미리보기  ', description: '취소\n{{other}}', type: 'select',
      options: ['새 실행', '$& $(keep)'], defaultValue: '새 실행',
    })];
    expect(validateTemplateVariables('{{target}}', definitions)).toEqual(definitions);
    expect(renderTemplate(template('{{target}}', definitions), {})).toBe('새 실행');
  });
});
