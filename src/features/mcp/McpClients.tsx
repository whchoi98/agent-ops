import type { McpClient, McpSource } from '../../../shared/mcp';
import { useMcpI18n } from './i18n';

export const CLIENT_NAMES: Record<McpClient, string> = {
  'codex-app': 'Codex App', 'codex-cli': 'Codex CLI',
  'claude-code-desktop': 'Claude Code Desktop', 'claude-code-cli': 'Claude Code CLI',
  'claude-desktop-chat': 'Claude Desktop Chat', 'kiro-ide': 'Kiro IDE', 'kiro-cli': 'Kiro CLI',
};

/** The backend identifies configuration families; never infer clients from the provider or a path. */
export function McpClientNames({ source }: { source: McpSource }) {
  const { t } = useMcpI18n();
  return source.clients?.length ? <ul className="mcp-client-names">{[...new Set(source.clients)].map(client =>
    <li key={client}>{CLIENT_NAMES[client] ?? client}</li>)}</ul> : <span className="text-muted">{t('클라이언트 미확인')}</span>;
}
