import { describe, expect, it } from 'vitest';
import type { ExtensionContent, ExtensionSummary } from '../shared/extensions.js';
import { analyzeExtension, parseSkillDocument, sanitizeMetadata, sanitizeText } from '../server/extensions/analysis.js';

const skill: ExtensionSummary = Object.freeze({
  id: 'claude:skill:review-guide', agent: 'claude', kind: 'skill', name: 'review-guide', description: '',
  version: null, scope: 'user', path: '/fixtures/review-guide', status: 'enabled',
  statusReason: 'Configured in a synthetic fixture', evidence: [], pluginId: null, pluginName: null,
  childCount: 0, warnings: [],
});

function content(path: string, text: string, truncated = false): ExtensionContent {
  return {
    fileId: path, path, content: text, bytes: Buffer.byteLength(text), truncated, redacted: false,
    language: path.endsWith('.json') ? 'json' : /\.ya?ml$/.test(path) ? 'yaml' : path.endsWith('.toml') ? 'toml' : 'markdown',
  };
}

describe('parseSkillDocument', () => {
  it('parses YAML folded/literal scalars, quoted colons, lists and typed nested values', () => {
    const result = parseSkillDocument(`---
name: review-guide
description: >-
  Review changes safely.
  Use when reviewing a patch.
allowed-tools:
  - Read
  - "Bash(git diff:*)"
disable-model-invocation: true
metadata:
  revision: 2
  optional: null
  note: |
    Keep this line.
    And this line.
---
# Review guide

Inspect the patch.
`);
    expect(result).toEqual({
      metadata: {
        name: 'review-guide',
        description: 'Review changes safely. Use when reviewing a patch.',
        'allowed-tools': ['Read', 'Bash(git diff:*)'],
        'disable-model-invocation': true,
        metadata: { revision: 2, optional: null, note: 'Keep this line.\nAnd this line.\n' },
      },
      body: '# Review guide\n\nInspect the patch.\n',
      warnings: [],
    });
  });

  it('accepts a BOM and CRLF without rewriting the remaining body', () => {
    expect(parseSkillDocument('\uFEFF---\r\nname: sample\r\ndescription: "Read: inspect"\r\n---\r\n# Guide\r\n'))
      .toEqual({ metadata: { name: 'sample', description: 'Read: inspect' }, body: '# Guide\r\n', warnings: [] });
  });

  it('leaves ordinary Markdown horizontal rules in the body', () => {
    expect(parseSkillDocument('# Plain\n\n---\nKeep reading.\n')).toEqual({
      metadata: {}, body: '# Plain\n\n---\nKeep reading.\n', warnings: [],
    });
    expect(parseSkillDocument('')).toEqual({ metadata: {}, body: '', warnings: [] });
    expect(parseSkillDocument('---\n---\nBody')).toEqual({ metadata: {}, body: 'Body', warnings: [] });
  });

  it.each([
    'description: [fixture-parser-secret',
    'description: first\ndescription: second',
    'description: !unsafe fixture-parser-secret',
    '- fixture-parser-secret',
    'fixture-parser-secret',
  ])('returns a generic warning for invalid or unsupported mapping metadata: %s', (frontmatter) => {
    const result = parseSkillDocument(`---\n${frontmatter}\n---\n# Still readable\n`);
    expect(result).toEqual({
      metadata: {},
      body: '# Still readable\n',
      warnings: ['YAML 메타데이터를 안전하게 해석할 수 없습니다.'],
    });
  });

  it.each([
    'value: &loop [*loop]',
    'a: &a [one, two]\nb: &b [*a, *a, *a]\nc: [*b, *b, *b]',
    'description: *fixture-parser-secret',
  ])('rejects YAML aliases without expanding them or exposing parser errors', (frontmatter) => {
    expect(parseSkillDocument(`---\n${frontmatter}\n---\nBody`)).toEqual({
      metadata: {}, body: 'Body', warnings: ['YAML 메타데이터를 안전하게 해석할 수 없습니다.'],
    });
  });

  it('reports unterminated frontmatter while keeping readable text', () => {
    expect(parseSkillDocument('---\nname: sample\nNo closing delimiter')).toEqual({
      metadata: {},
      body: '---\nname: sample\nNo closing delimiter',
      warnings: ['YAML 메타데이터의 닫는 구분자가 없습니다.'],
    });
  });

  it('bounds frontmatter parsing while retaining the body after a large header', () => {
    const result = parseSkillDocument(`---\ndescription: ${'a'.repeat(70 * 1024)}\n---\n# Body`);
    expect(result).toEqual({
      metadata: {}, body: '# Body', warnings: ['YAML 메타데이터가 분석 크기 제한(64 KiB)을 초과했습니다.'],
    });
  });

  it('rejects excessive YAML nesting before converting the document to JavaScript', () => {
    expect(parseSkillDocument(`---\nmetadata: ${'['.repeat(80)}leaf${']'.repeat(80)}\n---\nBody`)).toEqual({
      metadata: {}, body: 'Body', warnings: ['YAML 메타데이터를 안전하게 해석할 수 없습니다.'],
    });
  });

  it('redacts both parsed metadata and the returned Markdown body', () => {
    expect(parseSkillDocument(`---
description: Inspect documents.
env:
  REGION: arbitrary-fixture-value
api_key: x
---
# Guide
password: body-fixture-value
`)).toEqual({
      metadata: { description: 'Inspect documents.', env: { REGION: '[REDACTED]' }, api_key: '[REDACTED]' },
      body: '# Guide\npassword: "[REDACTED]"\n',
      warnings: [],
    });
  });
});

describe('sanitizeText', () => {
  it('retains the existing privacy redactor for credential-shaped text', () => {
    expect(sanitizeText('Example sk-proj-abcdefghijklmnopqrstuv and ghp_12345678901234567890.'))
      .toBe('Example [REDACTED] and [REDACTED].');
  });

  it('redacts JSON secrets including short values, escapes and structured credentials', () => {
    expect(sanitizeText('{"api\\u005fkey":"x","PASSWORD":1,"credentials":{"user":"fixture-user","value":"opaque"},"note":"safe"}'))
      .toBe('{"api\\u005fkey":"[REDACTED]","PASSWORD":"[REDACTED]","credentials":"[REDACTED]","note":"safe"}');
    expect(sanitizeText('{"clientSecret":"fixture \\"quoted\\" value","enabled":true}'))
      .toBe('{"clientSecret":"[REDACTED]","enabled":true}');
  });

  it('redacts every environment value even when its name does not suggest a secret', () => {
    expect(sanitizeText('{"mcpServers":{"docs":{"env":{"REGION":"fixture-west","LABEL":{"value":"private"}}}},"ok":true}'))
      .toBe('{"mcpServers":{"docs":{"env":"[REDACTED]"}},"ok":true}');
    expect(sanitizeText('env:\n  REGION: fixture-west\n  LABEL: private\nname: docs\n'))
      .toBe('env: "[REDACTED]"\nname: docs\n');
    expect(sanitizeText('environment: [PLAIN=fixture-one, MODE=fixture-two]\nname: docs'))
      .toBe('environment: "[REDACTED]"\nname: docs');
  });

  it('redacts YAML block scalars, multiline quoted values and inline comments on env blocks', () => {
    expect(sanitizeText('password: |-\n  first fixture line\n  second fixture line\nname: safe\n'))
      .toBe('password: "[REDACTED]"\nname: safe\n');
    expect(sanitizeText('token: "first fixture line\n  second fixture line"\nname: safe'))
      .toBe('token: "[REDACTED]"\nname: safe');
    expect(sanitizeText('env: # a configuration comment\n  INNOCENT: fixture-private-value\nname: safe'))
      .toBe('env: "[REDACTED]"\nname: safe');
  });

  it('redacts arbitrary exported, inline and quoted shell environment assignments', () => {
    expect(sanitizeText('export PLAIN_NAME="arbitrary-opaque"\nOTHER_VALUE=x node tool.js\nexport lower_name=private'))
      .toBe('export PLAIN_NAME=[REDACTED]\nOTHER_VALUE=[REDACTED] node tool.js\nexport lower_name=[REDACTED]');
    expect(sanitizeText('{"args":["-e","PLAIN_NAME=arbitrary-opaque","reader.js"]}'))
      .toBe('{"args":["-e","PLAIN_NAME=[REDACTED]","reader.js"]}');
  });

  it.each([
    '-----BEGIN PRIVATE KEY-----\nfixture-key-material\n-----END PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-key-material',
    '-----BEGIN RSA PRIVATE KEY--\nfixture-key-material',
    '-----BEGIN ENCRYPTED PRIVATE KEY-----\\nfixture-key-material\\n-----END ENCRYPTED PRIVATE KEY-----',
  ])('redacts complete, escaped, truncated and unclosed private keys', (key) => {
    expect(sanitizeText(`Before\n${key}`)).toBe('Before\n[REDACTED PRIVATE KEY]');
  });

  it('redacts URL userinfo and secret query/fragment values while retaining ordinary parameters', () => {
    expect(sanitizeText('See https://user:pass@docs.example.test/help?token=opaque&lang=ko#access_token=fragment'))
      .toBe('See https://[REDACTED]@docs.example.test/help?token=[REDACTED]&lang=ko#access_token=[REDACTED]');
    expect(sanitizeText('postgres://user@db.example.test/data?password=x&ssl=true'))
      .toBe('postgres://[REDACTED]@db.example.test/data?password=[REDACTED]&ssl=true');
    expect(sanitizeText('https://docs.example.test/?api%5Fkey=x&X-Amz-Signature=signed&q=guide'))
      .toBe('https://docs.example.test/?api%5Fkey=[REDACTED]&X-Amz-Signature=[REDACTED]&q=guide');
  });

  it.each([
    ['{"env":{"PLAIN":"fixture-secret",', '{"env":"[REDACTED]"'],
    ['{"password":"fixture-secret', '{"password":"[REDACTED]"'],
    ['env:\n  PLAIN: fixture-secret', 'env: "[REDACTED]"'],
  ])('fails closed for truncated secret-bearing text', (input, expected) => {
    expect(sanitizeText(input)).toBe(expected);
  });

  it('keeps non-secret instructions readable and is idempotent', () => {
    const safe = '# Guide\n\nUse when reviewing a patch.\n`Bash(git diff:*)`\n[Guide](https://docs.example.test/help?q=read)\n';
    expect(sanitizeText(safe)).toBe(safe);
    expect(sanitizeText('{"password":"[REDACTED]","env":"[REDACTED]"}'))
      .toBe('{"password":"[REDACTED]","env":"[REDACTED]"}');
  });

  it('redacts explicitly keyed YAML and YAML-escaped sensitive key names', () => {
    expect(sanitizeText('? api_key\n: tiny\nname: safe'))
      .toBe('? api_key\n: "[REDACTED]"\nname: safe');
    expect(sanitizeText('"api\\x5fkey": tiny\nname: safe'))
      .toBe('"api\\x5fkey": "[REDACTED]"\nname: safe');
  });

  it('withholds aliased environment documents instead of leaking values from their anchors', () => {
    expect(sanitizeText('shared: &shared\n  REGION: fixture-alias-secret\nenv: *shared\n')).toBe('[REDACTED]');
    expect(sanitizeText('shared: &shared fixture-alias-secret\nenv: {PLAIN: *shared}\n')).toBe('[REDACTED]');
  });

  it.each([
    {
      name: 'a later YAML document',
      input: 'description: Public first document.\n---\nshared: &s fixture-later-secret\nenv: {PLAIN: *s}\n',
    },
    {
      name: 'a third document after an explicit document end',
      input: 'name: first\n...\n---\nname: second\n---\nshared: &s fixture-third-secret\nenv: {PLAIN: *s}\n',
    },
    {
      name: 'a YAML fence after skill frontmatter',
      input: '---\ndescription: Public guide.\n---\n# Guide\n```yaml\nshared: &s fixture-fenced-secret\nenv: {PLAIN: *s}\n```\n',
    },
    {
      name: 'a tilde fence after prose',
      input: '# Guide\n\n~~~yml\nshared: &s fixture-tilde-secret\nenv: {PLAIN: *s}\n~~~\n',
    },
    {
      name: 'an unclosed unlabelled fence',
      input: '# Guide\n```\nshared: &s fixture-unclosed-secret\nenv: {PLAIN: *s}\n',
    },
    {
      name: 'a YAML block-scalar example',
      input: 'example: |\n  shared: &s fixture-scalar-secret\n  env: {PLAIN: *s}\n',
    },
    {
      name: 'an environment sequence alias',
      input: 'shared: &s fixture-sequence-secret\nenv:\n  - *s\n',
    },
    {
      name: 'a later secret map using a merge alias',
      input: 'name: first\n---\nshared: &s {PLAIN: fixture-merge-secret}\nenv: {<<: *s}\n',
    },
    {
      name: 'a malformed prefix before a secret-bearing alias',
      input: 'description: [incomplete\nshared: &s fixture-malformed-alias-secret\nenv: {PLAIN: *s}\n',
    },
  ])('withholds uninspected alias anchors in $name', ({ input }) => {
    expect(sanitizeText(input)).toBe('[REDACTED]');
  });

  it('preserves fully inspected non-secret alias documents and ordinary Markdown emphasis', () => {
    expect(sanitizeText('name: first\n---\nshared: &s public-value\ncopy: *s\n'))
      .toBe('name: first\n---\nshared: &s public-value\ncopy: *s\n');
    expect(sanitizeText('# Guide\nUse *care* and **review** [the docs](https://docs.example.test/?a=1&b=2).\n'))
      .toBe('# Guide\nUse *care* and **review** [the docs](https://docs.example.test/?a=1&b=2).\n');
  });

  it('redacts escaped JSON string payloads and escaped credential-shaped tokens', () => {
    expect(sanitizeText('{"payload":"{\\"env\\":{\\"PLAIN\\":\\"fixture-escaped\\"}}","ok":true}'))
      .toBe('{"payload":"{\\"env\\":\\"[REDACTED]\\"}","ok":true}');
    expect(sanitizeText('{"note":"\\u0073k-proj-abcdefghijklmnopqrstuv"}'))
      .toBe('{"note":"[REDACTED]"}');
  });

  it('redacts lowercase shell assignments and protocol-relative credential URLs', () => {
    expect(sanitizeText('env plain_name=fixture-lower node tool.js\nplain_name=another-fixture'))
      .toBe('env plain_name=[REDACTED] node tool.js\nplain_name=[REDACTED]');
    expect(sanitizeText('//user:pass@docs.example.test/?api_key=x&lang=ko'))
      .toBe('//[REDACTED]@docs.example.test/?api_key=[REDACTED]&lang=ko');
  });

  it('redacts raw Markdown private regions including unclosed markers', () => {
    expect(sanitizeText('# Guide\n<!-- private -->\nfixture-markdown-private\n<!-- /private -->\nPublic instructions.'))
      .toBe('# Guide\n[REDACTED]\nPublic instructions.');
    expect(sanitizeText('# Guide\n<!-- BEGIN PRIVATE -->fixture-markdown-private<!-- END PRIVATE -->\nPublic instructions.'))
      .toBe('# Guide\n[REDACTED]\nPublic instructions.');
    expect(sanitizeText('# Guide\n<!-- private -->\nfixture-markdown-private'))
      .toBe('# Guide\n[REDACTED]');
  });

  it('redacts PEM markers inside Markdown fences and secrets in whole YAML previews', () => {
    expect(sanitizeText('# Guide\n```pem\n-----BEGIN PRIVATE KEY-----\nfixture-material\n-----END PRIVATE KEY-----\n```\nPublic instructions.'))
      .toBe('# Guide\n```pem\n[REDACTED PRIVATE KEY]\n```\nPublic instructions.');
    expect(sanitizeText('interface:\n  display_name: Guide\nenv:\n  PLAIN: fixture-env-secret\nauth:\n  credential: fixture-auth-secret\npolicy:\n  allow_implicit_invocation: false\n'))
      .toBe('interface:\n  display_name: Guide\nenv: "[REDACTED]"\nauth: "[REDACTED]"\npolicy:\n  allow_implicit_invocation: false\n');
  });

  it('redacts plural secret containers in raw configuration', () => {
    expect(sanitizeText('{"secrets":{"PLAIN":"fixture-one"},"tokens":["fixture-two"],"name":"safe"}'))
      .toBe('{"secrets":"[REDACTED]","tokens":"[REDACTED]","name":"safe"}');
  });

  it('redacts complete shell environment expressions without evaluating substitutions', () => {
    expect(sanitizeText('PLAIN=$(printf "fixture-substitution") node tool.js\nOTHER=`printf fixture-backtick`\nTHIRD=first\\ second'))
      .toBe('PLAIN=[REDACTED] node tool.js\nOTHER=[REDACTED]\nTHIRD=[REDACTED]');
  });

  it('withholds a truncated escaped JSON payload when its remaining string cannot be decoded safely', () => {
    expect(sanitizeText('{"payload":"{\\"env\\":{\\"PLAIN\\":\\"fixture-truncated'))
      .toBe('{"payload":"[REDACTED]"');
  });
});

describe('sanitizeText TOML environment tables', () => {
  it('masks lowercase spaced environment values while preserving other tables and formatting', () => {
    const input = 'title = "Public"\n[mcp_servers.docs.env]\nplain = "fixture-toml-environment"\ncount = 1\n[mcp_servers.docs]\ncommand = "node"\n';
    const expected = 'title = "Public"\n[mcp_servers.docs.env]\nplain = "[REDACTED]"\ncount = "[REDACTED]"\n[mcp_servers.docs]\ncommand = "node"\n';
    expect(sanitizeText(input)).toBe(expected);
    expect(sanitizeText(expected)).toBe(expected);
  });

  it.each([
    '[mcp_servers."docs.with.dots".env]',
    '[mcp_servers."docs](link)".env]',
    '[ "mcp_servers" . \'docs.id\' . "env" ] # public note',
    "['mcp_servers'.'docs.env'.'env']",
    '[mcp_servers."docs"."e\\u006ev"]',
    '[[mcp_servers."docs".env]]',
    '[mcp_servers.docs.environment_variables]',
    '[mcp_servers.docs.env.nested]',
    '[credentials.docs]',
  ])('recognizes actual table components in %s', (header) => {
    expect(sanitizeText(`${header}\n"plain.name" = "fixture-quoted-secret"\n`))
      .toBe(`${header}\n"plain.name" = "[REDACTED]"\n`);
  });

  it('does not treat dots inside one quoted table ID as an environment path', () => {
    const input = '[mcp_servers."docs.env"]\nplain = "public"\n["mcp_servers.docs.env"]\nvalue = 2026-09-25\n';
    expect(sanitizeText(input)).toBe(input);
  });

  it('does not mistake JSON arrays or ordinary Markdown links for TOML table headers', () => {
    expect(sanitizeText('["public", "values"]')).toBe('["public", "values"]');
    expect(sanitizeText('[Guide](https://docs.example.test/?q=guide)\n')).toBe('[Guide](https://docs.example.test/?q=guide)\n');
  });

  it('masks root and relative dotted assignments and inline environment containers', () => {
    expect(sanitizeText('mcp_servers.docs.env.plain = "fixture-root-secret"\n'))
      .toBe('mcp_servers.docs.env.plain = "[REDACTED]"\n');
    expect(sanitizeText('[mcp_servers.docs]\n"env".plain = \'fixture-relative-secret\'\ncommand = "node"\n'))
      .toBe('[mcp_servers.docs]\n"env".plain = "[REDACTED]"\ncommand = "node"\n');
    expect(sanitizeText('[mcp_servers.docs]\nenv = { plain = "fixture-inline-secret" }\n'))
      .toBe('[mcp_servers.docs]\nenv = "[REDACTED]"\n');
    expect(sanitizeText('config = { docs = { env = { plain = "fixture-nested-secret" }, enabled = true } }\n'))
      .toBe('config = "[REDACTED]"\n');
  });

  it('consumes complete TOML values without interpreting apparent headers inside multiline strings', () => {
    const input = '[mcp_servers.docs.env]\nplain = """fixture-first\n[public]\nfixture-second"""\nother = \'\'\'fixture-third\nfixture-fourth\'\'\'\nitems = ["fixture-fifth", { nested = "fixture-sixth" }]\n[public]\nvisible = true\n';
    expect(sanitizeText(input)).toBe('[mcp_servers.docs.env]\nplain = "[REDACTED]"\nother = "[REDACTED]"\nitems = "[REDACTED]"\n[public]\nvisible = true\n');
  });

  it('honors literal-string backslashes and preserves later public settings', () => {
    expect(sanitizeText('[mcp_servers.docs.env]\nplain = \'fixture-literal\\\'\n[public]\nvisible = "safe"\n'))
      .toBe('[mcp_servers.docs.env]\nplain = "[REDACTED]"\n[public]\nvisible = "safe"\n');
  });

  it('sanitizes fenced and quoted Markdown TOML examples without carrying table context outside the fence', () => {
    expect(sanitizeText('# Guide\n```toml\n[mcp_servers.docs.env]\nplain = "fixture-fenced-toml"\n```\n\noutside = "public"\n'))
      .toBe('# Guide\n```toml\n[mcp_servers.docs.env]\nplain = "[REDACTED]"\n```\n\noutside = "public"\n');
    expect(sanitizeText('> ```toml\n> [mcp_servers."docs".env]\n> plain = "fixture-quoted-toml"\n> ```\n'))
      .toBe('> ```toml\n> [mcp_servers."docs".env]\n> plain = "[REDACTED]"\n> ```\n');
  });

  it('redacts TOML examples contained in a multiline TOML string', () => {
    expect(sanitizeText('example = \'\'\'[mcp_servers.docs.env]\nplain = "fixture-nested-example"\n\'\'\'\n'))
      .toBe('example = "[mcp_servers.docs.env]\\nplain = \\"[REDACTED]\\"\\n"\n');
  });

  it('withholds malformed uncertain headers and unclosed values with generic placeholders', () => {
    expect(sanitizeText('[mcp_servers."docs.env]\nplain = "fixture-malformed-header"\n[public]\nvisible = "safe"\n'))
      .toBe('[REDACTED]');
    expect(sanitizeText('[mcp_servers.docs.env]\nplain = """fixture-unclosed-value\n[public]\nvisible = "still-secret"\n'))
      .toBe('[mcp_servers.docs.env]\nplain = "[REDACTED]"');
    expect(sanitizeText('[mcp_servers.docs.env]\nplain = @fixture-invalid-value\n'))
      .toBe('[mcp_servers.docs.env]\nplain = "[REDACTED]"');
  });
});

describe('sanitizeMetadata', () => {
  it('preserves useful nested metadata while redacting secret keys and arbitrary environment values', () => {
    const input = {
      description: 'Inspect docs.',
      count: 2,
      flags: [true, null, 'safe'],
      mcpServers: {
        docs: {
          command: 'node', args: ['reader.js'],
          env: { REGION: 'fixture-west', PLAIN: { value: 'private' }, ENABLED: true },
          headers: { Authorization: 'Bearer fixture-value', 'X-API-Key': 'x', Accept: 'application/json' },
          refresh_token: 'opaque',
        },
      },
      environment: ['PLAIN=fixture', 'MODE=fixture'],
      privateKey: 'short-fixture',
    };
    const before = JSON.stringify(input);
    expect(sanitizeMetadata(input)).toEqual({
      description: 'Inspect docs.',
      count: 2,
      flags: [true, null, 'safe'],
      mcpServers: {
        docs: {
          command: 'node', args: ['reader.js'],
          env: { REGION: '[REDACTED]', PLAIN: '[REDACTED]', ENABLED: '[REDACTED]' },
          headers: { Authorization: '[REDACTED]', 'X-API-Key': '[REDACTED]', Accept: 'application/json' },
          refresh_token: '[REDACTED]',
        },
      },
      environment: ['[REDACTED]', '[REDACTED]'],
      privateKey: '[REDACTED]',
    });
    expect(JSON.stringify(input)).toBe(before);
  });

  it('returns an empty record for non-mappings and removes prototype-related fields', () => {
    expect(sanitizeMetadata(null)).toEqual({});
    expect(sanitizeMetadata(['fixture'])).toEqual({});
    expect(sanitizeMetadata('fixture')).toEqual({});
    expect(sanitizeMetadata(JSON.parse('{"__proto__":{"polluted":true},"constructor":{"password":"x"},"metadata":{"prototype":"x","name":"safe"}}')))
      .toEqual({ metadata: { name: 'safe' } });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('does not invoke getters or serialization methods supplied as metadata', () => {
    let executed = false;
    const metadata = {
      name: 'safe',
      get description() { executed = true; throw new Error('Imported getter must not execute'); },
      toJSON() { executed = true; throw new Error('Imported serializer must not execute'); },
    };
    expect(sanitizeMetadata(metadata)).toEqual({ name: 'safe' });
    expect(executed).toBe(false);
  });

  it('bounds cyclic metadata without leaking the skipped value', () => {
    const metadata: Record<string, unknown> = { name: 'safe' };
    metadata.self = metadata;
    expect(sanitizeMetadata(metadata)).toEqual({ name: 'safe', self: '[OMITTED]' });
  });

  it('redacts plural containers without relying on credential-shaped values', () => {
    expect(sanitizeMetadata({ secrets: { PLAIN: 'arbitrary' }, tokens: ['short'], name: 'safe' }))
      .toEqual({ secrets: '[REDACTED]', tokens: '[REDACTED]', name: 'safe' });
  });
});

describe('analyzeExtension', () => {
  it('extracts declared purpose, triggers, tools, resources and real headings in source order', () => {
    const metadata = {
      description: 'Review code safely. Use when reviewing a pull request.',
      'allowed-tools': ['Read', 'Grep', 'Bash(git diff:*, git status:*)'],
      resources: ['skill://shared/review', 'references/common.md'],
    };
    const entry = content('SKILL.md', [
      '# Review guide',
      '',
      'Use when a patch needs review.',
      '',
      '## Workflow',
      'Read [reference](references/review.md).',
      'Run `scripts/check.sh` only after review.',
      '## When to use',
      '- A reviewer asks for help.',
      '- 변경 검토를 요청할 때 사용합니다.',
      '```md',
      '# Example heading',
      'Use when this is only a quoted example.',
      '```',
      '',
    ].join('\n'));
    const analysis = analyzeExtension(skill, [entry], metadata, ['review-agent', 'review-agent']);
    expect(analysis).toMatchObject({
      purpose: 'Review code safely. Use when reviewing a pull request.',
      triggers: [
        'Use when reviewing a pull request.', 'Use when a patch needs review.',
        'A reviewer asks for help.', '변경 검토를 요청할 때 사용합니다.',
      ],
      tools: ['Read', 'Grep', 'Bash(git diff:*, git status:*)'],
      mcpServers: [], hooks: [],
      resources: ['skill://shared/review', 'references/common.md', 'references/review.md', 'scripts/check.sh'],
      sections: ['Review guide', 'Workflow', 'When to use'],
      links: [], usedBy: ['review-agent'], lineCount: 14,
    });
    expect(analysis.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '참조된 스크립트', detail: expect.stringContaining('실행하지 않았습니다') }),
      expect.objectContaining({ title: '선언된 도구·권한', detail: expect.stringContaining('런타임 격리를 보장하지 않습니다') }),
    ]));
  });

  it('reads MCP names and hook event names from JSON objects, without running their commands', () => {
    const analysis = analyzeExtension({ ...skill, kind: 'plugin', description: 'Synthetic plugin.' }, [
      content('.mcp.json', '{"mcpServers":{"docs":{"command":"node","args":["reader.js"],"env":{"PLAIN":"private"}},"search":{"url":"https://mcp.example.test/"}}}'),
      content('hooks/hooks.json', '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/check.sh"}]}],"Stop":[{"hooks":[{"type":"command","command":"node -e \\"throw new Error(\'must never execute\')\\""}]}]}}'),
    ], { mcpServers: '.mcp.json', hooks: 'hooks/hooks.json', permissions: ['network'] });
    expect(analysis).toMatchObject({
      purpose: 'Synthetic plugin.', tools: [], mcpServers: ['docs', 'search'], hooks: ['PreToolUse', 'Stop'],
      resources: ['.mcp.json', 'hooks/hooks.json', 'reader.js', '${CLAUDE_PLUGIN_ROOT}/scripts/check.sh'],
      lineCount: 2, usedBy: [],
    });
    expect(analysis.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '선언된 도구·권한' }),
      expect.objectContaining({ title: '참조된 스크립트' }),
    ]));
  });

  it('preserves parenthesized tool arguments and only interprets explicit declarations', () => {
    const analysis = analyzeExtension(skill, [
      content('SKILL.md', '# Guide\nBash can be mentioned without permission. PreToolUse and mcpServers are examples.'),
    ], {
      description: 'Inspection helper.',
      'allowed-tools': 'Read, Bash(git log --format=%H, git diff:*), Grep',
      triggers: ['review requested', '변경 검토 요청'],
    });
    expect(analysis.tools).toEqual(['Read', 'Bash(git log --format=%H, git diff:*)', 'Grep']);
    expect(analysis.triggers).toEqual(['review requested', '변경 검토 요청']);
    expect(analysis.hooks).toEqual([]);
    expect(analysis.mcpServers).toEqual([]);
  });

  it('reports a declared manual invocation requirement without inferring actual invocation', () => {
    const analysis = analyzeExtension(skill, [], { description: 'Helper.', 'disable-model-invocation': true });
    expect(analysis.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '수동 호출 선언', detail: expect.stringContaining('disable-model-invocation: true') }),
      expect.objectContaining({ title: '정적 분석 범위', detail: expect.stringContaining('실제 호출') }),
    ]));
    expect(analysis.usedBy).toEqual([]);
    expect(analyzeExtension(skill, [], { description: 'Helper.', 'disable-model-invocation': false, 'user-invocable': false })
      .findings.some(finding => finding.title === '수동 호출 선언')).toBe(false);
  });

  it('uses a prose fallback and reports missing description without treating mentions as usage', () => {
    const analysis = analyzeExtension(skill, [content('SKILL.md', [
      '# Guide', '', 'Read repository files before drafting a change.', '',
      'review-agent was mentioned in a conversation.', '',
    ].join('\n'))], {});
    expect(analysis.purpose).toBe('Read repository files before drafting a change.');
    expect(analysis.usedBy).toEqual([]);
    expect(analysis.lineCount).toBe(5);
    expect(analysis.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'warning', title: '설명 누락' }),
    ]));
    expect(analyzeExtension(skill, [], {}).purpose).toBe('설명이 없습니다.');
    expect(analyzeExtension(skill, [], {}).lineCount).toBe(0);
  });

  it('collects safe external links and local references without exposing credentials or active schemes', () => {
    const analysis = analyzeExtension(skill, [content('SKILL.md', [
      '# Guide',
      '[Guide](https://docs.example.test/help?q=read#usage)',
      '[Local](references/guide.md#part)',
      '<https://other.example.test/guide>',
      'See https://third.example.test/guide.',
      '[Duplicate](https://docs.example.test/help?q=read#usage)',
      '[Unsafe](javascript:alert(1)) [Inline](data:text/plain,private)',
      '[Private](https://user:pass@private.example.test/)',
      '[Token](https://private.example.test/?token=fixture-secret)',
      '',
    ].join('\n'))], { description: 'Guide.' });
    expect(analysis.links).toEqual([
      'https://docs.example.test/help?q=read#usage',
      'https://other.example.test/guide',
      'https://third.example.test/guide',
    ]);
    expect(analysis.resources).toEqual(['references/guide.md#part']);
    expect(JSON.stringify(analysis)).not.toContain('fixture-secret');
    expect(JSON.stringify(analysis)).not.toContain('user:pass');
  });

  it('makes malformed/truncated content visible with generic diagnostics and no parser snippets', () => {
    const analysis = analyzeExtension(skill, [
      content('.mcp.json', '{"api_key":"fixture-malformed-secret","mcpServers":{"parser-secret-name":', true),
      content('SKILL.md', '---\ndescription: [fixture-frontmatter-secret\n---\n# Guide'),
    ], {});
    expect(analysis.mcpServers).toEqual([]);
    expect(analysis.lineCount).toBe(5);
    const findings = JSON.stringify(analysis.findings);
    expect(findings).toContain('JSON');
    expect(findings).toContain('YAML');
    expect(findings).toContain('잘렸');
    expect(findings).not.toContain('fixture-malformed-secret');
    expect(findings).not.toContain('parser-secret-name');
    expect(findings).not.toContain('fixture-frontmatter-secret');
  });

  it('extracts frontmatter declarations and setext headings when metadata was not pre-parsed', () => {
    const analysis = analyzeExtension(skill, [content('SKILL.md', [
      '---', 'description: Inspect text.', 'allowed-tools: [Read]', '---',
      'Guide', '=====', '', 'Triggers', '--------', '- Use for a requested text review.', '',
    ].join('\n'))], {});
    expect(analysis.purpose).toBe('Inspect text.');
    expect(analysis.tools).toEqual(['Read']);
    expect(analysis.triggers).toEqual(['Use for a requested text review.']);
    expect(analysis.sections).toEqual(['Guide', 'Triggers']);
    expect(analysis.lineCount).toBe(10);
  });

  it('returns deterministic redacted findings without mutating caller-owned content or metadata', () => {
    const metadata = Object.freeze({ description: 'Use when token=fixture-description-secret', 'allowed-tools': Object.freeze(['Read']) });
    const entry = Object.freeze(content('SKILL.md', '# Guide\nRead `scripts/check.sh`.\n'));
    const item = Object.freeze({ ...skill, warnings: ['password=fixture-warning-secret'] });
    const first = analyzeExtension(item, [entry], metadata, ['review-agent', 'token=fixture-agent-secret']);
    expect(first.tools).toEqual(['Read']);
    expect(first.sections).toEqual(['Guide']);
    expect(first.resources).toEqual(['scripts/check.sh']);
    expect(first.usedBy).toEqual(['review-agent', 'token=[REDACTED]']);
    expect(JSON.stringify(first)).not.toContain('fixture-description-secret');
    expect(JSON.stringify(first)).not.toContain('fixture-warning-secret');
    expect(JSON.stringify(first)).not.toContain('fixture-agent-secret');
    expect(analyzeExtension(item, [entry], metadata, ['review-agent', 'token=fixture-agent-secret'])).toEqual(first);
    expect(entry.content).toBe('# Guide\nRead `scripts/check.sh`.\n');
    expect(metadata.description).toBe('Use when token=fixture-description-secret');
  });

  it('takes the purpose from the skill entry even if a reference file was supplied first', () => {
    const analysis = analyzeExtension(skill, [
      content('references/detail.md', '# Reference\n\nThis is a reference appendix.'),
      content('SKILL.md', '# Skill\n\nInspect code changes.'),
    ], {});
    expect(analysis.purpose).toBe('Inspect code changes.');
  });

  it('keeps heading links and frontmatter documentation links visible', () => {
    const analysis = analyzeExtension(skill, [content('SKILL.md', [
      '---', 'description: Inspect code.', 'homepage: https://docs.example.test/home', '---',
      '# [Guide](https://docs.example.test/guide)', '',
    ].join('\n'))], {});
    expect(analysis.sections).toEqual(['Guide']);
    expect(analysis.links).toEqual(['https://docs.example.test/home', 'https://docs.example.test/guide']);
  });

  it('reads a plugin manifest purpose and explicit event arrays without inferring event names from command types', () => {
    const analysis = analyzeExtension({ ...skill, kind: 'plugin' }, [
      content('plugin.json', '{"description":"Plugin declared purpose.","hooks":[{"event":"userPromptSubmit","command":"scripts/check.sh"},{"type":"command","command":"echo static"}]}'),
      content('skills/child/SKILL.md', '---\ndescription: Child skill purpose.\n---\n# Child'),
    ], {});
    expect(analysis.purpose).toBe('Plugin declared purpose.');
    expect(analysis.hooks).toEqual(['userPromptSubmit']);
  });

  it('analyzes OpenAI YAML policy and tool dependencies without treating declarations as runtime permissions', () => {
    const analysis = analyzeExtension({ ...skill, agent: 'codex' }, [
      content('SKILL.md', '---\ndescription: Review changes.\nallowed-tools: [Read]\n---\n# Review'),
      content('agents/openai.yaml', [
        'interface:',
        '  display_name: Review helper',
        'policy:',
        '  allow_implicit_invocation: false',
        'dependencies:',
        '  tools:',
        '    - type: mcp',
        '      value: docs',
        '      description: Search reference documents',
        '      transport: streamable_http',
        '      url: https://mcp.example.test/docs',
        '    - type: shell',
        '      value: Bash',
        '',
      ].join('\n')),
    ], {});
    expect(analysis.purpose).toBe('Review changes.');
    expect(analysis.tools).toEqual(['Read', 'docs', 'Bash']);
    expect(analysis.mcpServers).toEqual(['docs']);
    expect(analysis.links).toEqual(['https://mcp.example.test/docs']);
    expect(analysis.usedBy).toEqual([]);
    expect(analysis.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '수동 호출 선언', detail: expect.stringContaining('policy.allow_implicit_invocation: false') }),
      expect.objectContaining({ title: '선언된 도구·권한', detail: expect.stringContaining('런타임 격리를 보장하지 않습니다') }),
    ]));
  });

  it('reports an explicit implicit-invocation allowance as configuration, and ignores a non-boolean policy', () => {
    const enabled = analyzeExtension(skill, [
      content('agents/openai.yaml', 'policy:\n  allow_implicit_invocation: true\n'),
    ], { description: 'Helper.' });
    expect(enabled.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '암시적 호출 허용 선언', detail: expect.stringContaining('policy.allow_implicit_invocation: true') }),
    ]));
    expect(enabled.findings.some(finding => finding.title === '수동 호출 선언')).toBe(false);
    expect(analyzeExtension(skill, [
      content('agents/openai.yaml', 'policy:\n  allow_implicit_invocation: "false"\n'),
    ], { description: 'Helper.' }).findings.some(finding => finding.title === '수동 호출 선언')).toBe(false);
  });

  it('redacts raw YAML config declarations and reports malformed YAML without disclosing parser snippets', () => {
    const analysis = analyzeExtension(skill, [
      content('agents/openai.yaml', 'dependencies:\n  tools:\n    - type: mcp\n      value: docs\n      env:\n        PLAIN: fixture-config-secret\n      url: https://user:pass@host.example.test/?token=fixture-query-secret\n'),
      content('agents/broken.yaml', 'dependencies: [fixture-yaml-parser-secret'),
    ], { description: 'Helper.' });
    expect(analysis.tools).toEqual(['docs']);
    expect(analysis.mcpServers).toEqual(['docs']);
    expect(analysis.links).toEqual([]);
    expect(JSON.stringify(analysis.findings)).toContain('YAML');
    expect(JSON.stringify(analysis)).not.toContain('fixture-config-secret');
    expect(JSON.stringify(analysis)).not.toContain('fixture-query-secret');
    expect(JSON.stringify(analysis)).not.toContain('fixture-yaml-parser-secret');
    expect(JSON.stringify(analysis)).not.toContain('user:pass');
  });

  it('keeps aliased example secrets out of raw previews, parsed skill bodies and analysis output', () => {
    const input = '---\ndescription: Public guide.\n---\n# Guide\n```yaml\nshared: &s fixture-draft-alias-secret\nenv: {PLAIN: *s}\n```\n';
    expect(sanitizeText(input)).toBe('[REDACTED]');
    expect(parseSkillDocument(input)).toEqual({
      metadata: { description: 'Public guide.' }, body: '[REDACTED]', warnings: [],
    });
    const analysis = analyzeExtension(skill, [content('SKILL.md', input)], {});
    expect(analysis.purpose).toBe('Public guide.');
    expect(analysis.sections).toEqual([]);
    expect(analysis.resources).toEqual([]);
    expect(JSON.stringify(analysis)).not.toContain('fixture-draft-alias-secret');
  });

  it('keeps TOML environment values out of raw previews, Markdown bodies and analysis output', () => {
    const input = '[mcp_servers.docs.env]\nplain = "fixture-toml-draft"\n';
    expect(sanitizeText(input)).toBe('[mcp_servers.docs.env]\nplain = "[REDACTED]"\n');
    expect(parseSkillDocument(input).body).toBe('[mcp_servers.docs.env]\nplain = "[REDACTED]"\n');
    const analysis = analyzeExtension(skill, [content('settings.toml', input)], { description: 'Public guide.' });
    expect(analysis.purpose).toBe('Public guide.');
    expect(JSON.stringify(analysis)).not.toContain('fixture-toml-draft');
  });
});
