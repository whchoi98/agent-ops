import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { I18nContext, createI18n } from '../../i18n/I18nProvider';
import { McpClientStates } from './McpConfigurationView';

it('shows per-client applicability instead of applying Desktop shadowing to the CLI', () => {
  const html = renderToStaticMarkup(<I18nContext.Provider value={{ ...createI18n('en'), setLanguage: () => {} }}>
    <McpClientStates states={[
      { client: 'claude-code-cli', status: 'enabled', shadowedBy: null, statusReason: 'Standalone CLI precedence: local > project > user. It does not read the Desktop Chat file.' },
      { client: 'claude-code-desktop', status: 'shadowed', shadowedBy: 'mcp-opaque', statusReason: 'Local Code Desktop sessions prefer the duplicate name from Desktop Chat configuration. Standalone CLI precedence is unchanged.' },
    ]} />
  </I18nContext.Provider>);
  expect(html).toContain('Claude Code CLI');
  expect(html).toContain('Enabled in configuration');
  expect(html).toContain('Claude Code Desktop');
  expect(html).toContain('Shadowed by another declaration');
  expect(html).toContain('not current connection states');
  expect(html).not.toContain('mcp-opaque');
});
