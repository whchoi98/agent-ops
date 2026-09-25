import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { McpClient, McpConfigStatus, McpScope, McpSource } from '../../shared/mcp.js';
import { AGENTS, type Agent } from '../../shared/types.js';
import { within } from '../extensions/io.js';
import { configure } from './configuration.js';
import { assignClientStates } from './client-states.js';
import { McpReader } from './io.js';
import { redactor } from './redaction.js';
import { bounded, finding, object, strings, type Declaration, type Dictionary, type DiscoveryOptions, type McpSnapshot } from './types.js';

function merge(base: Dictionary, override: Dictionary): Dictionary {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(object(result[key]), object(value)) : value;
  }
  return result;
}
const pathList = (value: unknown) => typeof value === 'string' ? [value] : strings(value);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function configuredStatus(agent: Agent, raw: Dictionary): McpConfigStatus {
  return (agent === 'codex' ? raw.enabled === false : raw.disabled === true) ? 'disabled' : 'enabled';
}
function configurationClients(agent: Agent, context: DiscoveryOptions, kind: McpSource['kind'] = 'config'): McpClient[] {
  if (agent === 'codex') return ['codex-app', 'codex-cli'];
  if (agent === 'kiro') return kind === 'agent' ? ['kiro-cli'] : kind === 'power' ? ['kiro-ide'] : ['kiro-ide', 'kiro-cli'];
  return ['darwin', 'win32'].includes(context.options.platform ?? process.platform)
    ? ['claude-code-cli', 'claude-code-desktop'] : ['claude-code-cli'];
}

/**
 * Source semantics:
 * https://learn.chatgpt.com/docs/extend/mcp?surface=cli
 * https://code.claude.com/docs/en/mcp
 * https://code.claude.com/docs/en/desktop (Code/Chat file sharing and distinct precedence)
 * https://modelcontextprotocol.io/docs/develop/connect-local-servers (Desktop Chat file location)
 * https://kiro.dev/docs/mcp/configuration/
 * Installed plugin registry v2/cache conventions follow the local extensions providers.
 * Profiles, managed policies, remote account catalogs and running clients are not inferred.
 */
export async function discoverMcp(context: DiscoveryOptions): Promise<McpSnapshot> {
  const { project, codexHome, claudeHome, claudeConfigPath, claudeDesktopConfigPath, kiroHome } = context;
  const claudeConfigOwner = dirname(claudeConfigPath);
  const maxServers = bounded(context.options.maxServers, 512, 1, 1000);
  const reader = new McpReader(
    [codexHome, claudeHome, claudeConfigOwner, kiroHome, ...(claudeDesktopConfigPath ? [dirname(claudeDesktopConfigPath)] : []), ...(project ? [project.path] : [])],
    bounded(context.options.maxDiscoveryBytes, 4 * 1024 * 1024, 1024, 8 * 1024 * 1024), context.options.maxConfigBytes,
  );
  const declarations: Declaration[] = [];
  const warnings: string[] = [];
  const warn = (message: string) => { if (!warnings.includes(message) && warnings.length < 32) warnings.push(message); };
  function add(agent: Agent, path: string, ownerRoot: string, scope: McpScope, servers: unknown, extra: Partial<Declaration> = {}) {
    if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
      warn(`${agent} MCP declarations must use an object keyed by server name.`);
      return;
    }
    for (const [name, value] of Object.entries(object(servers))) {
      if (declarations.length >= maxServers) { warn('MCP declaration count reached the discovery limit.'); break; }
      const raw = object(value);
      const status = configuredStatus(agent, raw);
      const source: McpSource = {
        path, format: path.endsWith('.toml') ? 'toml' : path.endsWith('.md') ? 'yaml' : 'json',
        kind: 'config', pluginName: null, agentName: null, clients: configurationClients(agent, context),
      };
      const declaration: Declaration = {
        key: `${agent}\0${scope}\0${path}\0${name}`, agent, name, scope, source, ownerRoot,
        raw, status, statusReason: status === 'disabled' ? 'Explicitly disabled in local configuration.' : 'Declared in local configuration; native client connectivity is unknown.',
        findings: value === null || typeof value !== 'object' || Array.isArray(value)
          ? [finding('invalid-declaration', 'The server declaration must be an object.', 'error')] : [],
        ...extra,
      };
      declaration.source = { ...source, ...extra.source };
      // A disabled parent never enables a child; explicit server-level disable is also preserved.
      if (status === 'disabled' && declaration.status !== 'shadowed') declaration.status = 'disabled';
      declaration.configuredStatus = declaration.status;
      declarations.push(declaration);
    }
  }
  function shadow(agent: Agent, names: Set<string>, exceptPath: string) {
    for (const declaration of declarations) {
      if (declaration.agent === agent && declaration.source.kind === 'config'
        && declaration.source.path !== exceptPath && names.has(declaration.name)) {
        declaration.status = 'shadowed';
        declaration.statusReason = 'Replaced by a higher-precedence declaration for the selected project.';
      }
    }
  }

  const codexPath = join(codexHome, 'config.toml');
  const codexUser = await reader.document(codexPath, codexHome, 'toml') ?? {};
  add('codex', codexPath, codexHome, 'user', codexUser.mcp_servers);
  let codexEffective = codexUser;
  if (project) {
    const path = join(project.path, '.codex/config.toml');
    const config = await reader.document(path, project.path, 'toml');
    if (config) {
      const trust = Object.entries(object(codexUser.projects))
        .filter(([root]) => isAbsolute(root) && within(resolve(root), resolve(project.path)))
        .sort(([a], [b]) => b.length - a.length)[0]?.[1];
      const trusted = object(trust).trust_level === 'trusted';
      const merged = merge(codexUser, config);
      const servers = Object.fromEntries(Object.keys(object(config.mcp_servers)).map(name => [name, object(merged.mcp_servers)[name]]));
      if (trusted) { shadow('codex', new Set(Object.keys(servers)), path); codexEffective = merged; }
      add('codex', path, project.path, 'project', servers, trusted ? {} : {
        status: 'unknown', statusReason: 'Project configuration is present, but Codex project trust is not evidenced.',
        findings: [finding('project-trust-unverified', 'Codex does not load this project configuration until the project is trusted.', 'error')],
      });
    }
  }

  const claudeConfig = await reader.document(claudeConfigPath, claudeConfigOwner) ?? {};
  const claudeUserSettings = await reader.document(join(claudeHome, 'settings.json'), claudeHome) ?? {};
  const claudeSettings: Dictionary[] = [claudeUserSettings];
  const claudeLocal = project ? object(object(claudeConfig.projects)[project.path]) : {};
  add('claude', claudeConfigPath, claudeConfigOwner, 'user', claudeConfig.mcpServers);
  if (project) {
    const path = join(project.path, '.mcp.json');
    const projectSettings = await reader.document(join(project.path, '.claude/settings.json'), project.path) ?? {};
    const localSettings = await reader.document(join(project.path, '.claude/settings.local.json'), project.path) ?? {};
    claudeSettings.push(projectSettings, localSettings);
    const projectConfig = await reader.document(path, project.path);
    const names = Object.keys(object(projectConfig?.mcpServers));
    shadow('claude', new Set(names), path);
    add('claude', path, project.path, 'project', projectConfig?.mcpServers);
    const approved = new Set([...strings(claudeUserSettings.enabledMcpjsonServers), ...strings(claudeLocal.enabledMcpjsonServers)]);
    const denied = new Set([...claudeSettings.flatMap(settings => strings(settings.disabledMcpjsonServers)), ...strings(claudeLocal.disabledMcpjsonServers)]);
    const enableAll = claudeUserSettings.enableAllProjectMcpServers === true || claudeLocal.enableAllProjectMcpServers === true;
    for (const declaration of declarations.filter(item => item.agent === 'claude' && item.source.path === path)) {
      if (denied.has(declaration.name)) {
        declaration.status = 'disabled';
        declaration.configuredStatus = 'disabled';
        declaration.statusReason = 'Project server approval was explicitly rejected.';
      } else if (declaration.configuredStatus !== 'disabled' && !approved.has(declaration.name) && !enableAll) {
        declaration.status = 'unknown';
        declaration.configuredStatus = 'unknown';
        declaration.statusReason = 'A project server approval was not evidenced in user-owned settings.';
        declaration.findings.push(finding('project-approval-unverified', 'Native Claude project approval is unknown. This preview concerns an independent workbench check.', 'warning'));
      }
    }
    const localNames = new Set(Object.keys(object(claudeLocal.mcpServers)));
    // The same .claude.json file contains both user and project-local declarations.
    for (const declaration of declarations) if (declaration.agent === 'claude' && localNames.has(declaration.name)) {
      declaration.status = 'shadowed';
      declaration.statusReason = 'Replaced by the local declaration stored for the selected project.';
    }
    add('claude', claudeConfigPath, claudeConfigOwner, 'local', claudeLocal.mcpServers);
    const disabled = new Set(strings(claudeLocal.disabledMcpServers));
    for (const declaration of declarations) if (declaration.agent === 'claude' && declaration.status !== 'shadowed' && disabled.has(declaration.name)) {
      declaration.status = 'disabled';
      declaration.statusReason = 'Disabled for the selected project in Claude local settings.';
    }
  }

  for (const location of [
    { root: kiroHome, scope: 'user' as const },
    ...(project ? [{ root: join(project.path, '.kiro'), scope: 'project' as const }] : []),
  ]) {
    const owner = location.scope === 'user' ? kiroHome : project!.path;
    const path = join(location.root, 'settings/mcp.json');
    const config = await reader.document(path, owner);
    if (location.scope === 'project') shadow('kiro', new Set(Object.keys(object(config?.mcpServers))), path);
    add('kiro', path, owner, location.scope, config?.mcpServers);
    const agentRoot = join(location.root, 'agents');
    for (const entry of await reader.children(agentRoot, owner, false)) {
      if (!/\.(?:json|md)$/.test(entry)) continue;
      const agent = await reader.document(entry, agentRoot, entry.endsWith('.md') ? 'yaml' : 'json');
      if (!agent) continue;
      const agentName = typeof agent.name === 'string' ? agent.name : basename(entry).replace(/\.(?:json|md)$/, '');
      add('kiro', entry, agentRoot, location.scope, agent.mcpServers, {
        source: { path: entry, format: entry.endsWith('.md') ? 'yaml' : 'json', kind: 'agent', agentName, pluginName: null, clients: ['kiro-cli'] },
        status: 'unknown', statusReason: 'Agent-specific declaration; the active Kiro agent is unknown.',
        findings: [finding('agent-selection-unknown', `Agent selection is not observed. includeMcpJson is ${agent.includeMcpJson === false ? 'false' : 'not disabled'}; agent servers override matching shared servers only when that agent is selected.`, 'info')],
      });
    }
  }

  if (claudeDesktopConfigPath) {
    const desktopOwner = dirname(claudeDesktopConfigPath);
    const desktop = await reader.document(claudeDesktopConfigPath, desktopOwner);
    // Chat is a separate configuration family, not another CLI scope. Do not shadow across these files.
    add('claude', claudeDesktopConfigPath, desktopOwner, 'user', desktop?.mcpServers, {
      source: { path: claudeDesktopConfigPath, format: 'json', kind: 'config', pluginName: null, agentName: null, clients: ['claude-desktop-chat'] },
      statusReason: 'Declared in Claude Desktop Chat configuration, separately from Claude Code settings.',
      findings: [finding('desktop-chat-source', 'This is Claude Desktop Chat configuration. Local Code Desktop sessions can also consume it; the standalone Code CLI does not read this file. Client selection is not observed.', 'info')],
    });
  }
  async function plugin(
    agent: Agent, root: string, manifestPath: string, manifest: Dictionary,
    scope: McpScope, status: McpConfigStatus, overrides: Dictionary = {}, kind: 'plugin' | 'power' = 'plugin',
  ) {
    const name = typeof manifest.name === 'string' ? manifest.name : basename(root);
    const declarationsByName = new Map<string, { raw: unknown; path: string; ambiguous: boolean }>();
    const collect = (servers: unknown, path: string) => {
      for (const [key, value] of Object.entries(object(servers))) {
        const previous = declarationsByName.get(key);
        declarationsByName.set(key, { raw: value, path, ambiguous: Boolean(previous && JSON.stringify(previous.raw) !== JSON.stringify(value)) || previous?.ambiguous === true });
      }
    };
    const files = new Set([join(root, '.mcp.json')]);
    for (const part of pathList(manifest.mcpServers).slice(0, 8)) {
      const path = resolve(root, part);
      if (isAbsolute(part) || part.includes('\0') || !within(root, path) || !path.endsWith('.json')) {
        warn('A declared plugin MCP file was outside its owner root or had an unsupported format.');
      } else files.add(path);
    }
    for (const path of files) {
      const config = await reader.document(path, root);
      if (config) collect(config.mcpServers ?? config, path);
    }
    if (manifest.mcpServers && typeof manifest.mcpServers === 'object' && !Array.isArray(manifest.mcpServers)) {
      collect(object(manifest.mcpServers).mcpServers ?? manifest.mcpServers, manifestPath);
    }
    for (const [serverName, entry] of declarationsByName) {
      const override = object(overrides[serverName]);
      const raw = { ...object(entry.raw) };
      // Codex plugin settings override tool policy/enabled state, never the manifest's executable/URL.
      if (agent === 'codex') for (const key of ['enabled', 'enabled_tools', 'disabled_tools', 'tools']) {
        if (Object.hasOwn(override, key)) raw[key] = override[key];
      }
      const currentStatus = entry.ambiguous ? 'unknown' : status;
      const extra: Partial<Declaration> = {
        pluginRoot: root, status: currentStatus,
        statusReason: currentStatus === 'enabled' ? 'Plugin configuration and a single installed version are evidenced; native connectivity is unknown.'
          : currentStatus === 'disabled' ? 'The parent plugin is explicitly disabled.' : 'The active plugin/Power installation cannot be determined safely.',
        source: { path: entry.path, format: entry.path.endsWith('.md') ? 'yaml' : 'json', kind, pluginName: name, agentName: null, clients: configurationClients(agent, context, kind) },
        findings: currentStatus === 'unknown' ? [finding('plugin-activation-unverified', 'An active unambiguous plugin version is not evidenced. This cached target cannot be probed.', 'error')] : [],
      };
      add(agent, entry.path, root, scope, { [serverName]: raw }, extra);
    }
  }

  const codexCache = join(codexHome, 'plugins/cache');
  for (const market of await reader.children(codexCache, codexHome, true)) {
    for (const directory of await reader.children(market, codexHome, true)) {
      if (declarations.length >= maxServers) break;
      const versions: Array<{ root: string; path: string; manifest: Dictionary }> = [];
      for (const root of await reader.children(directory, codexHome, true)) {
        const path = join(root, '.codex-plugin/plugin.json');
        const manifest = await reader.document(path, root);
        if (manifest) versions.push({ root, path, manifest });
      }
      const id = `${basename(directory)}@${basename(market)}`;
      const configuration = object(object(codexEffective.plugins)[id]);
      const status = configuration.enabled === false ? 'disabled'
        : configuration.enabled === true && versions.length === 1 ? 'enabled' : 'unknown';
      for (const version of versions) await plugin(
        'codex', version.root, version.path, version.manifest, 'user', status, object(configuration.mcp_servers),
      );
    }
  }

  const claudeCache = join(claudeHome, 'plugins/cache');
  const installed = await reader.document(join(claudeHome, 'plugins/installed_plugins.json'), claudeHome);
  const pluginSettings = Object.assign({}, ...claudeSettings.map(settings => object(settings.enabledPlugins))) as Dictionary;
  if (installed && installed.version !== 2) warn('Claude plugin registry version is unsupported; no active plugin targets were inferred.');
  if (installed?.version === 2) {
    for (const [id, values] of Object.entries(object(installed.plugins)).slice(0, 128)) {
      if (!Array.isArray(values)) continue;
      const eligible: Array<{ root: string; scope: McpScope; rank: number }> = [];
      for (const value of values.slice(0, 16)) {
        const entry = object(value);
        if (typeof entry.installPath !== 'string' || !isAbsolute(entry.installPath)
          || !within(claudeCache, resolve(entry.installPath)) || resolve(entry.installPath) === claudeCache) {
          warn('A Claude plugin registry path was outside the owned installation cache.');
          continue;
        }
        if (entry.scope === 'user') eligible.push({ root: resolve(entry.installPath), scope: 'user', rank: 1 });
        else if (['project', 'local'].includes(String(entry.scope)) && project
          && typeof entry.projectPath === 'string' && resolve(entry.projectPath) === resolve(project.path)) {
          eligible.push({ root: resolve(entry.installPath), scope: entry.scope as McpScope, rank: entry.scope === 'local' ? 3 : 2 });
        }
      }
      const rank = Math.max(...eligible.map(entry => entry.rank));
      const preferred = eligible.filter(entry => entry.rank === rank);
      for (const entry of eligible) {
        // Validate the plugin root against the cache as well as its own component owner.
        if (!(await reader.children(join(entry.root, '..'), claudeHome, true)).includes(entry.root)) continue;
        const path = join(entry.root, '.claude-plugin/plugin.json');
        const manifest = await reader.document(path, entry.root);
        if (!manifest) continue;
        const status = pluginSettings[id] === false ? 'disabled'
          : pluginSettings[id] === true && preferred.length === 1 && entry.rank === rank ? 'enabled' : 'unknown';
        await plugin('claude', entry.root, path, manifest, entry.scope, status);
      }
    }
  }
  const disabledClaude = new Set(strings(claudeLocal.disabledMcpServers));
  for (const declaration of declarations) if (declaration.agent === 'claude' && declaration.source.kind === 'plugin'
    && (disabledClaude.has(declaration.name) || disabledClaude.has(`plugin:${declaration.source.pluginName}:${declaration.name}`))) {
    declaration.status = 'disabled';
    declaration.statusReason = 'This plugin server is disabled for the selected project.';
  }

  const powerRoot = join(kiroHome, 'powers/installed');
  for (const root of await reader.children(powerRoot, kiroHome, true)) {
    const path = join(root, 'plugin.json');
    const manifest = await reader.document(path, root);
    if (manifest) await plugin('kiro', root, path, manifest, 'user', 'unknown', {}, 'power');
    else {
      const legacyPath = join(root, 'POWER.md');
      const legacy = await reader.document(legacyPath, root, 'yaml');
      if (legacy) await plugin('kiro', root, legacyPath, legacy, 'user', 'unknown', {}, 'power');
    }
  }

  assignClientStates(declarations, context, disabledClaude);
  const snapshot: McpSnapshot = {
    records: new Map(), warnings: [], scannedAt: new Date().toISOString(), projectId: project?.id ?? null,
  };
  for (const declaration of declarations) {
    const record = await configure(declaration, context);
    snapshot.records.set(record.item.id, record);
  }
  // Include all safely read control files, not just the target, in preview invalidation.
  const digest = reader.digest();
  const allSecrets = [...snapshot.records.values()].flatMap(record => record.secrets);
  const clean = redactor(allSecrets);
  for (const record of snapshot.records.values()) {
    record.fingerprint = hash(`${digest}\0${JSON.stringify(record.target)}\0${record.item.status}\0${project?.path ?? ''}\0${project?.executionEnabled ?? ''}`);
    record.item.name = clean(record.item.name, 240);
    record.item.source.path = clean(record.item.source.path, 4096);
    if (record.item.source.pluginName) record.item.source.pluginName = clean(record.item.source.pluginName, 240);
    if (record.item.source.agentName) record.item.source.agentName = clean(record.item.source.agentName, 240);
    const configuration = record.item.configuration;
    for (const key of ['command', 'cwd', 'url'] as const) if (configuration[key]) configuration[key] = clean(configuration[key]!, 4096);
    for (const key of ['environmentNames', 'inheritedEnvironmentNames', 'headerNames', 'missingEnvironmentNames', 'disabledTools'] as const) {
      configuration[key] = configuration[key].map(value => clean(value, 240));
    }
    if (configuration.enabledTools) configuration.enabledTools = configuration.enabledTools.map(value => clean(value, 240));
  }
  const sorted = [...snapshot.records.values()].sort((a, b) =>
    AGENTS.indexOf(a.item.agent) - AGENTS.indexOf(b.item.agent) || a.item.name.localeCompare(b.item.name) || a.declaration.key.localeCompare(b.declaration.key));
  snapshot.records = new Map(sorted.map(record => [record.item.id, record]));
  snapshot.warnings = [...new Set([...warnings, ...reader.warnings])].slice(0, 64).map(message => clean(message, 1000));
  // These layers cannot be inferred from a running CLI; no network/config-helper discovery is attempted.
  snapshot.warnings.push('Discovery covers user files and the selected project only. CLI flags, active profiles, managed policies, account connectors and native live connection state are not observed.');
  return snapshot;
}

export function demoMcp(context: DiscoveryOptions): McpSnapshot {
  const records: McpSnapshot['records'] = new Map();
  for (const [index, agent] of AGENTS.entries()) {
    const id = context.id(`demo:${agent}`);
    const source: McpSource = { path: `/demo/${agent}/synthetic-mcp.json`, format: 'json', kind: 'config', pluginName: null, agentName: null, clients: configurationClients(agent, context) };
    const declaration: Declaration = {
      key: id, agent, name: `Synthetic ${agent} MCP`, scope: 'user', source, ownerRoot: '/demo',
      raw: {}, status: index === 2 ? 'disabled' : 'enabled', statusReason: 'Synthetic demo declaration.', findings: [],
    };
    records.set(id, {
      declaration, fingerprint: id, secrets: [],
      target: { transport: index === 1 ? 'http' : 'stdio', command: null, args: [], cwd: '/demo', env: {}, url: null, headers: {}, executionIdentity: '' },
      item: {
        id, agent, name: declaration.name, scope: 'user', projectId: context.project?.id ?? null,
        transport: index === 1 ? 'http' : 'stdio', status: declaration.status, statusReason: declaration.statusReason, source,
        configuration: { command: index === 1 ? null : 'synthetic-mcp-server', args: [], cwd: '/demo', url: index === 1 ? 'https://example.invalid/[redacted]' : null,
          environmentNames: [], inheritedEnvironmentNames: [], headerNames: [], missingEnvironmentNames: [], hasOAuth: false, hasHeadersHelper: false, enabledTools: null, disabledTools: [], redacted: true },
        findings: [finding('demo-disabled', 'Synthetic demo declarations cannot start processes or network probes.', 'error')],
        checkSupport: 'blocked', lastCheck: null,
        clientStates: source.clients?.map(client => ({
          client, status: declaration.status, statusReason: 'Synthetic demo configuration evidence.', shadowedBy: null,
        })),
      },
    });
  }
  return { records, warnings: ['Synthetic demo data; no native configuration was read.'], scannedAt: new Date().toISOString(), projectId: context.project?.id ?? null };
}
