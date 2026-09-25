import { expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { createI18n, I18nContext } from '../../i18n/I18nProvider';
import { McpServerList } from './McpCatalog';
import { McpActiveCheck, McpCheckResult, McpLastCheck } from './McpCheckView';
import { McpConfigurationView, McpConfigurationAnalysis } from './McpConfigurationView';
import { McpPreviewActions, McpPreviewView } from './McpPreview';
import { mcpCheck, mcpConfiguration, mcpDetail, mcpPreview, mcpServer } from './testFixtures';

function render(children: ReactNode, language: 'en' | 'ko' = 'en') {
  return renderToStaticMarkup(<I18nContext.Provider value={{ ...createI18n(language), setLanguage: () => {} }}>
    {children}
  </I18nContext.Provider>);
}

test('enabled configuration and an unperformed check never imply a connected assistant', () => {
  const html = render(<McpServerList items={[mcpServer()]} projects={[]} pending={false} onSelect={() => {}} />);
  expect(html).toContain('Enabled in configuration');
  expect(html).toContain('Assistant connection');
  expect(html).toContain('Unknown');
  expect(html).toContain('Not checked');
  expect(html).not.toMatch(/>Connected<|>Disconnected<|>Reachable<|>연결됨</);
});

test('a successful past check is timestamped as a workbench response, not live connectivity', () => {
  const result = mcpCheck({ status: 'reachable', finishedAt: '2026-09-25T10:00:01Z' });
  const html = render(<McpLastCheck check={result} />);
  expect(html).toContain('Responded at check time');
  expect(html).toContain('Last workbench check');
  expect(html).toMatch(/datetime="2026-09-25T10:00:01Z"/i);
  expect(html).not.toMatch(/>Connected<|>Live<|>연결됨</);
});

test('masked configuration shows names but never argument values, URL credentials, or unknown fields', () => {
  const configuration = {
    ...mcpConfiguration({
      args: ['--key', 'fixture-argument-secret'],
      url: 'https://fixture-user:fixture-password@example.invalid/private-token?key=fixture-query-secret',
      headerNames: ['Authorization'], hasOAuth: true,
    }),
    env: { MCP_ACCESS_KEY: 'fixture-env-secret' },
    headers: { Authorization: 'Bearer fixture-header-secret' },
  };
  const html = render(<McpConfigurationView configuration={configuration} />);
  expect(html).toContain('MCP_ACCESS_KEY');
  expect(html).toContain('Authorization');
  expect(html).toContain('example.invalid');
  expect(html).toContain('[redacted]');
  for (const value of ['fixture-user', 'fixture-password', 'private-token', 'fixture-query-secret',
    'fixture-argument-secret', 'fixture-env-secret', 'fixture-header-secret']) expect(html).not.toContain(value);
  expect(html).not.toMatch(/<a\b|href=/);
});

test('application findings translate while source labels and tool descriptions stay original', () => {
  const detail = mcpDetail({
    name: '설정', findings: [{
      code: 'configuration-disabled', level: 'error', message: 'This MCP declaration is disabled in its configuration.',
    }],
  });
  const english = render(<McpConfigurationAnalysis detail={detail} projects={[]} />);
  expect(english).toContain('Configuration analysis');
  expect(english).toContain('This MCP declaration is disabled in its configuration.');
  const korean = render(<McpConfigurationAnalysis detail={detail} projects={[]} />, 'ko');
  expect(korean).toContain('이 MCP 선언은 설정에서 비활성화되어 있습니다.');
  const result = mcpCheck({
    status: 'reachable',
    tools: {
      status: 'ok', count: 1, truncated: true,
      items: [{ name: '설정', title: '원문', description: '<script>설정</script>\n![원문](https://example.invalid/pixel)' }],
    },
    resources: { status: 'unsupported', items: [], count: 0, truncated: false },
    prompts: { status: 'ok', items: [], count: 0, truncated: false },
  });
  const html = render(<McpCheckResult result={result} />);
  expect(html).toContain('설정');
  expect(html).toContain('원문');
  expect(html).toContain('Returned: 1');
  expect(html).toContain('Partial list');
  expect(html).toContain('Total on the server is unknown');
  expect(html).toContain('Not supported');
  expect(html).toContain('No items returned');
  expect(html).not.toMatch(/<script|<img|<a\b/);
});

test('metadata that was never requested has an unknown count, not a measured zero', () => {
  const html = render(<McpCheckResult result={mcpCheck()} />);
  expect(html).toContain('Not requested');
  expect(html).not.toContain('Returned: 0');
  expect(html).not.toContain('No items returned');
});

test('stdio previews explain process startup, exact metadata methods and their expiry', () => {
  const html = render(<McpPreviewView preview={mcpPreview()} />);
  expect(html).toContain('starts the configured process');
  expect(html).toContain('side effects');
  expect(html).toContain('tools/list');
  expect(html).toContain('resources/list');
  expect(html).toContain('prompts/list');
  expect(html).toContain('notifications/initialized');
  expect(html).toContain('No tools are invoked');
  expect(html).toMatch(/datetime="2099-01-01T00:00:00Z"/i);
});

test.each(['demo', 'blocked', 'unsupported', 'disabled', 'shadowed', 'active'] as const)(
  '%s declarations cannot prepare or start a new check', condition => {
    const detail = mcpDetail({
      demo: condition === 'demo',
      checkSupport: condition === 'blocked' ? 'blocked' : condition === 'unsupported' ? 'unsupported' : 'supported',
      status: condition === 'disabled' || condition === 'shadowed' ? condition : 'enabled',
    });
    const html = render(<McpPreviewActions detail={detail} preview={null} projectId={undefined}
      demo={false} activeCheck={condition === 'active' ? mcpCheck() : null} busy={null} visible={true}
      now={Date.parse('2026-09-25T10:00:00Z')} onPreview={() => {}} onCheck={() => {}} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Preview check/);
    expect(html).not.toContain('Start workbench check');
  },
);

test.each(['expired', 'not-allowed', 'demo', 'wrong-server', 'wrong-project'] as const)(
  'a %s preview cannot authorize a check', condition => {
    const preview = mcpPreview({
      expiresAt: condition === 'expired' ? '2020-01-01T00:00:00Z' : '2099-01-01T00:00:00Z',
      canCheck: condition !== 'not-allowed', demo: condition === 'demo',
      serverId: condition === 'wrong-server' ? 'mcp-aaaaaaaaaaaaaaaaaaaaaaaa' : mcpServer().id,
      projectId: condition === 'wrong-project' ? 'another-project' : null,
    });
    const html = render(<McpPreviewActions detail={mcpDetail()} preview={preview} projectId={undefined}
      demo={false} activeCheck={null} busy={null} visible={true}
      now={Date.parse('2026-09-25T10:00:00Z')} onPreview={() => {}} onCheck={() => {}} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Start workbench check/);
  },
);

test('an eligible unknown declaration still needs a current preview before explicit probing', () => {
  const props = {
    detail: mcpDetail({ status: 'unknown' }), projectId: undefined, demo: false,
    activeCheck: null, busy: null, visible: true, now: Date.parse('2026-09-25T10:00:00Z'),
    onPreview: () => {}, onCheck: () => {},
  };
  const before = render(<McpPreviewActions {...props} preview={null} />);
  expect(before).toContain('Preview check');
  expect(before).not.toContain('Start workbench check');
  const after = render(<McpPreviewActions {...props} preview={mcpPreview()} />);
  expect(after).toContain('Start workbench check');
  expect(after).not.toContain('disabled=""');
});

test('provider names stay compact while configuration clients distinguish IDE, Code and Chat', () => {
  const html = render(<McpServerList projects={[]} pending={false} onSelect={() => {}} items={[
    mcpServer({ agent: 'kiro', source: { ...mcpServer().source, clients: ['kiro-ide', 'kiro-cli'] } }),
    mcpServer({ id: 'mcp-aaaaaaaaaaaaaaaaaaaaaaaa', agent: 'claude',
      source: { ...mcpServer().source, clients: ['claude-desktop-chat'] } }),
    mcpServer({ id: 'mcp-bbbbbbbbbbbbbbbbbbbbbbbb', agent: 'claude',
      source: { ...mcpServer().source, clients: ['claude-code-cli', 'claude-code-desktop'] } }),
  ]} />);
  expect(html).toContain('Kiro IDE');
  expect(html).toContain('Kiro CLI');
  expect(html).toContain('Claude Desktop Chat');
  expect(html).toContain('Claude Code Desktop');
  expect(html).toContain('Claude Code CLI');
  expect(html).toContain('Configuration clients');
  expect(html).toMatch(/agent-badge provider-kiro[\s\S]*?<span>Kiro<\/span>/);
});

test('missing client evidence stays unknown and shared settings never imply installation', () => {
  const html = render(<McpConfigurationAnalysis detail={mcpDetail()} projects={[]} />);
  expect(html).toContain('Client not identified');
  expect(html).not.toContain('Codex App');
  const shared = render(<McpConfigurationAnalysis projects={[]} detail={mcpDetail({
    source: { ...mcpServer().source, clients: ['codex-app', 'codex-cli'] },
  })} />);
  expect(shared).toContain('Codex App');
  expect(shared).toContain('Codex CLI');
  expect(shared).toContain('does not establish installation');
  expect(shared).not.toContain('Installed');
});

test('only an active check offers cancellation and a demo observer cannot cancel it', () => {
  const props = {
    active: mcpCheck(), result: mcpCheck(), projects: [], error: null, cancelError: null,
    cancelling: false, disabled: false, onCancel: () => {}, onRetry: () => {},
  };
  expect(render(<McpActiveCheck {...props} />)).toContain('Cancel check');
  expect(render(<McpActiveCheck {...props} active={null} />)).toBe('');
  expect(render(<McpActiveCheck {...props} active={mcpCheck({ status: 'cancelled' })} />)).toBe('');
  expect(render(<McpActiveCheck {...props} disabled />)).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Cancel check/);
});

test('HTTP previews describe endpoint/header access without claiming that a local process will start', () => {
  const html = render(<McpPreviewView preview={mcpPreview({
    startsProcess: false, transport: 'http', configuration: mcpConfiguration({
      command: null, args: [], cwd: null, url: 'https://fixture.invalid/[redacted]',
    }),
  })} />);
  expect(html).toContain('connects to the configured endpoint');
  expect(html).toContain('sends its configured headers');
  expect(html).not.toContain('starts the configured process');
});

test('a submitted preview remains visibly busy while its start response is pending', () => {
  const html = render(<McpPreviewActions detail={mcpDetail()} preview={null} projectId={undefined}
    demo={false} activeCheck={null} busy="check" visible now={Date.parse('2026-09-25T10:00:00Z')}
    onPreview={() => {}} onCheck={() => {}} />);
  expect(html).toContain('Requesting workbench check');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"[^>]*>[\s\S]*?Start workbench check/);
});
