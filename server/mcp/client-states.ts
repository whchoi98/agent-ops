import type { McpClient, McpClientState, McpConfigStatus } from '../../shared/mcp.js';
import { finding, type Declaration, type DiscoveryOptions } from './types.js';

const scopeRank = { user: 1, project: 2, local: 3 };
const isCode = (item: Declaration) => item.agent === 'claude' && item.source.kind === 'config'
  && item.source.clients?.includes('claude-code-cli');
const isChat = (item: Declaration) => item.agent === 'claude' && item.source.kind === 'config'
  && item.source.clients?.includes('claude-desktop-chat');

/**
 * The source family is not the set of consuming clients. In particular, local
 * Code Desktop imports Chat declarations without making them CLI declarations.
 * https://code.claude.com/docs/en/desktop — Shared configuration and Chat MCP servers.
 */
export function assignClientStates(declarations: Declaration[], context: DiscoveryOptions, disabledCode: Set<string>) {
  const code = declarations.filter(isCode);
  const chat = declarations.filter(isChat);
  const base = (item: Declaration): McpConfigStatus => item.configuredStatus ?? item.status;
  const state = (client: McpClient, item: Declaration, status: McpConfigStatus, reason?: string, winner?: Declaration): McpClientState => ({
    client, status, statusReason: reason ?? (
      status === 'disabled' ? 'Disabled by the applicable client configuration.'
        : status === 'unknown' ? 'The applicable configuration or approval is not fully evidenced.'
          : 'Eligible in the observed configuration; live client connectivity is not observed.'
    ),
    shadowedBy: winner ? context.id(winner.key) : null,
  });
  const selected = (client: McpClient, item: Declaration, winner: Declaration, reason: string): McpClientState =>
    item === winner ? state(client, item, disabledCode.has(item.name) ? 'disabled' : base(item), reason)
      : state(client, item, 'shadowed', reason, winner);

  for (const item of declarations) {
    let states: McpClientState[];
    if (isChat(item)) {
      states = [
        state('claude-desktop-chat', item, base(item), 'Source: Desktop Chat configuration. Native Chat connectivity is not observed.'),
        state('claude-code-desktop', item, disabledCode.has(item.name) ? 'disabled' : base(item),
          'Local Code Desktop sessions also load this Chat declaration; it takes precedence over duplicate Code configuration names.'),
      ];
    } else if (isCode(item)) {
      const peers = code.filter(other => other.name === item.name)
        .sort((a, b) => scopeRank[b.scope] - scopeRank[a.scope]);
      const cliWinner = peers[0];
      states = [selected('claude-code-cli', item, cliWinner, 'Standalone CLI precedence: local > project > user. It does not read the Desktop Chat file.')];
      if (item.source.clients?.includes('claude-code-desktop')) {
        const chatWinner = chat.find(other => other.name === item.name);
        const userStdio = peers.find(other => other.scope === 'user'
          && (other.raw.type === undefined || other.raw.type === 'stdio') && typeof other.raw.command === 'string');
        const project = peers.find(other => other.scope === 'project');
        const local = peers.find(other => other.scope === 'local');
        if (chatWinner) {
          states.push(state('claude-code-desktop', item, 'shadowed',
            'Local Code Desktop sessions prefer the duplicate name from Desktop Chat configuration. Standalone CLI precedence is unchanged.', chatWinner));
        } else if (disabledCode.has(item.name)) {
          states.push(state('claude-code-desktop', item, 'disabled'));
        } else if (userStdio && local) {
          states.push(state('claude-code-desktop', item, 'unknown',
            'A local override overlaps a re-delivered user stdio declaration. This adapter does not infer undocumented Desktop precedence.'));
        } else if (userStdio && project) {
          states.push(selected('claude-code-desktop', item, userStdio,
            'Local Code Desktop re-delivers user-scope stdio declarations and prefers them over duplicate project entries.'));
        } else {
          states.push(selected('claude-code-desktop', item, cliWinner,
            'Shared Code configuration precedence applies where no documented Desktop override is present.'));
        }
      }
    } else {
      states = (item.source.clients ?? []).map(client => {
        const winner = item.status === 'shadowed' ? declarations.find(other =>
          other !== item && other.agent === item.agent && other.name === item.name
          && other.source.kind === item.source.kind && other.source.clients?.includes(client)
          && other.status !== 'shadowed' && scopeRank[other.scope] > scopeRank[item.scope]) : undefined;
        return state(client, item, item.status, item.statusReason, winner);
      });
    }
    item.clientStates = states;
    if (!states.length) continue;
    const uniform = states.every(entry => entry.status === states[0].status);
    item.status = uniform ? states[0].status : 'unknown';
    if (isCode(item) || isChat(item)) {
      item.statusReason = uniform ? states[0].statusReason
        : 'Consumer clients have different configuration states. Review clientStates; native connectivity is not observed.';
      if (!uniform) item.findings.push(finding('client-precedence-differs',
        'Client-specific applicability and precedence differ. No consumer-specific shadowing or disable flag is applied to the entire provider.', 'warning'));
    }
    if (states.every(entry => entry.status === 'shadowed' || entry.status === 'disabled') && item.status === 'unknown') {
      item.findings.push(finding('all-consumers-inactive', 'All observed consumers disable or shadow this declaration.', 'error'));
    }
  }
}
