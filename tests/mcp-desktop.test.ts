import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finished, mcpFixture, type McpFixture } from './fixtures/mcp-test-helpers.js';
import { McpService } from '../server/mcp/service.js';

const fixtures: McpFixture[] = [];
async function setup() {
  const fixture = await mcpFixture({ platform: 'darwin' });
  fixtures.push(fixture);
  return { ...fixture, desktopPath: join(fixture.homeDir, 'Library/Application Support/Claude/claude_desktop_config.json') };
}
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose())); });

describe('macOS MCP configuration client identity', () => {
  it('labels the shared Codex App/CLI and Kiro IDE/CLI paths without inventing live client state', async () => {
    const { service, homeDir, projectPath, projects, put } = await setup();
    await put(join(homeDir, '.codex/config.toml'), `[mcp_servers.docs]\ncommand = ${JSON.stringify(process.execPath)}`);
    await put(join(homeDir, '.kiro/settings/mcp.json'), { mcpServers: { docs: { command: process.execPath } } });
    await put(join(projectPath, '.kiro/settings/mcp.json'), { mcpServers: { workspace: { command: process.execPath } } });
    const catalog = await service.list({ projectId: projects[0].id });
    expect(catalog.items.find(item => item.agent === 'codex')?.source.clients).toEqual(['codex-app', 'codex-cli']);
    expect(catalog.items.filter(item => item.agent === 'kiro').map(item => item.source.clients)).toEqual([
      ['kiro-ide', 'kiro-cli'], ['kiro-ide', 'kiro-cli'],
    ]);
    expect(catalog.items.every(item => item.lastCheck === null)).toBe(true);
  });

  it('uses CODEX_HOME for the shared App/CLI store without scanning a second default store', async () => {
    const { homeDir, base, projects, put } = await setup();
    const codexHome = join(base, 'custom-codex-home');
    await put(join(codexHome, 'config.toml'), `[mcp_servers.selected]\ncommand = ${JSON.stringify(process.execPath)}`);
    await put(join(homeDir, '.codex/config.toml'), `[mcp_servers.unselected]\ncommand = ${JSON.stringify(process.execPath)}`);
    const service = new McpService({ homeDir, platform: 'darwin', env: { CODEX_HOME: codexHome } }, () => projects);
    try {
      const catalog = await service.list({ agent: 'codex' });
      expect(catalog.items.map(item => item.name)).toEqual(['selected']);
      expect(catalog.items[0].source.clients).toEqual(['codex-app', 'codex-cli']);
    } finally { await service.close(); }
  });

  it('discovers Desktop Chat separately from shared Claude Code CLI/Desktop settings with the same name', async () => {
    const { service, desktopPath, config, put } = await setup();
    await config({ same: { command: process.execPath, args: ['code-config'] } });
    await put(desktopPath, { mcpServers: { same: { command: process.execPath, args: ['chat-config'] } },
      otherAppSetting: 'unrelated-desktop-private' });
    const catalog = await service.list();
    expect(catalog.total).toBe(2);
    const chat = catalog.items.find(item => item.source.clients?.includes('claude-desktop-chat'))!;
    const code = catalog.items.find(item => item.source.clients?.includes('claude-code-cli'))!;
    expect(chat).toBeTruthy();
    expect(code).toBeTruthy();
    expect(chat.id).not.toBe(code.id);
    expect(chat.status).toBe('enabled');
    expect(code.status).toBe('unknown');
    expect(chat.source.clients).toEqual(['claude-desktop-chat']);
    expect(code.source.clients).toEqual(['claude-code-cli', 'claude-code-desktop']);
    expect(chat.source.path).toContain('claude_desktop_config.json');
    expect(chat.findings.some(finding => finding.code === 'desktop-chat-source')).toBe(true);
    expect(code.clientStates?.find(state => state.client === 'claude-code-cli')).toMatchObject({ status: 'enabled', shadowedBy: null });
    expect(code.clientStates?.find(state => state.client === 'claude-code-desktop')).toMatchObject({ status: 'shadowed', shadowedBy: chat.id });
    expect(chat.clientStates?.map(state => [state.client, state.status])).toEqual([
      ['claude-desktop-chat', 'enabled'], ['claude-code-desktop', 'enabled'],
    ]);
    expect(chat.clientStates?.some(state => state.client === 'claude-code-cli')).toBe(false);
    expect(JSON.stringify(catalog)).not.toContain('unrelated-desktop-private');
  });

  it('does not flatten differing CLI and Code Desktop scope precedence into a false shadowed state', async () => {
    const { service, config, desktopPath, homeDir, projectPath, projects, put } = await setup();
    await config({ same: { command: process.execPath } });
    await put(join(homeDir, '.claude/settings.json'), { enabledMcpjsonServers: ['same'] });
    await put(join(projectPath, '.mcp.json'), { mcpServers: { same: { command: process.execPath } } });
    await put(desktopPath, { mcpServers: { same: { command: process.execPath } } });
    const catalog = await service.list({ projectId: projects[0].id });
    expect(catalog.items).toHaveLength(3);
    const chat = catalog.items.find(item => item.source.clients?.includes('claude-desktop-chat'))!;
    expect(chat.status).toBe('enabled');
    const code = catalog.items.filter(item => item.source.clients?.includes('claude-code-cli'));
    expect(code).toHaveLength(2);
    const user = code.find(item => item.scope === 'user')!;
    const project = code.find(item => item.scope === 'project')!;
    expect(user.status).toBe('shadowed');
    expect(project.status).toBe('unknown');
    expect(user.clientStates?.find(state => state.client === 'claude-code-cli')).toMatchObject({ status: 'shadowed', shadowedBy: project.id });
    expect(project.clientStates?.find(state => state.client === 'claude-code-cli')).toMatchObject({ status: 'enabled', shadowedBy: null });
    expect(code.every(item => item.clientStates?.find(state => state.client === 'claude-code-desktop')?.shadowedBy === chat.id)).toBe(true);
  });

  it('applies the documented user-stdio Desktop exception without changing CLI project precedence', async () => {
    const { service, config, homeDir, projectPath, projects, put } = await setup();
    await config({ same: { command: process.execPath } });
    await put(join(homeDir, '.claude/settings.json'), { enabledMcpjsonServers: ['same'] });
    await put(join(projectPath, '.mcp.json'), { mcpServers: { same: { command: process.execPath } } });
    const catalog = await service.list({ projectId: projects[0].id });
    const user = catalog.items.find(item => item.scope === 'user')!;
    const project = catalog.items.find(item => item.scope === 'project')!;
    expect(user.status).toBe('unknown');
    expect(project.status).toBe('unknown');
    expect(user.clientStates?.find(state => state.client === 'claude-code-cli')).toMatchObject({ status: 'shadowed', shadowedBy: project.id });
    expect(user.clientStates?.find(state => state.client === 'claude-code-desktop')).toMatchObject({ status: 'enabled', shadowedBy: null });
    expect(project.clientStates?.find(state => state.client === 'claude-code-cli')).toMatchObject({ status: 'enabled', shadowedBy: null });
    expect(project.clientStates?.find(state => state.client === 'claude-code-desktop')).toMatchObject({ status: 'shadowed', shadowedBy: user.id });
  });

  it('keeps Code project disable flags effective without disabling the separate Chat source', async () => {
    const { service, desktopPath, homeDir, projectPath, projects, put } = await setup();
    projects[0].executionEnabled = true;
    await put(join(projectPath, '.mcp.json'), { mcpServers: { same: { command: process.execPath } } });
    await put(join(homeDir, '.claude.json'), {
      mcpServers: { same: { command: process.execPath } },
      projects: { [projectPath]: { disabledMcpServers: ['same'] } },
    });
    await put(desktopPath, { mcpServers: { same: { command: process.execPath } } });
    const catalog = await service.list({ projectId: projects[0].id });
    const code = catalog.items.filter(item => item.source.clients?.includes('claude-code-cli'));
    expect(code.every(item => item.checkSupport === 'blocked')).toBe(true);
    const chat = catalog.items.find(item => item.source.clients?.includes('claude-desktop-chat'))!;
    expect(chat.clientStates?.find(state => state.client === 'claude-desktop-chat')?.status).toBe('enabled');
    expect(chat.clientStates?.find(state => state.client === 'claude-code-desktop')?.status).toBe('disabled');
    expect(chat.status).toBe('unknown');
  });

  it('labels agent-file MCP declarations as Kiro CLI instead of Kiro IDE', async () => {
    const { service, homeDir, put } = await setup();
    await put(join(homeDir, '.kiro/agents/review.json'), {
      name: 'review', mcpServers: { agentOnly: { command: process.execPath } },
    });
    const item = (await service.list()).items[0];
    expect(item.source.clients).toEqual(['kiro-cli']);
    expect(item.source.agentName).toBe('review');
  });

  it('keeps Desktop Chat configuration inside its own canonical owner directory', async () => {
    const { service, desktopPath, projectPath, projects, put } = await setup();
    const privatePath = join(projectPath, 'outside.json');
    await put(privatePath, { mcpServers: { outside: { command: process.execPath } } });
    await mkdir(join(desktopPath, '..'), { recursive: true });
    await symlink(privatePath, desktopPath);
    const catalog = await service.list({ projectId: projects[0].id });
    expect(catalog.items).toEqual([]);
    expect(catalog.warnings.some(message => /owner|outside/i.test(message))).toBe(true);
  });

  it('performs the same explicit bounded protocol check for a synthetic Desktop Chat declaration', async () => {
    const { service, desktopPath, base, put } = await setup();
    const log = join(base, 'desktop-fake.jsonl');
    const script = fileURLToPath(new URL('./fixtures/mcp-stdio.cjs', import.meta.url));
    await put(desktopPath, { mcpServers: { local: {
      command: process.execPath, args: [script, log], env: { FIXTURE_TOKEN: 'synthetic-desktop-private' },
    } } });
    const item = (await service.list()).items[0];
    const preview = await service.preview(item.id);
    expect(await readFile(log, 'utf8').catch(() => '')).toBe('');
    expect(preview.canCheck).toBe(true);
    const result = await finished(service, (await service.check(item.id, preview.previewId)).id);
    expect(result.status).toBe('reachable');
    expect(result.tools.count).toBe(2);
    expect(JSON.stringify(result)).not.toContain('synthetic-desktop-private');
  });
});
