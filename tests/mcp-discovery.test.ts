import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpService, type McpServiceOptions } from '../server/mcp/service.js';
import type { Project } from '../shared/types.js';

const services: McpService[] = [];
const directories: string[] = [];
async function fixture(options: McpServiceOptions = {}) {
  const base = await mkdtemp(join(tmpdir(), 'agent-ops-mcp-discovery-'));
  directories.push(base);
  const homeDir = join(base, 'home');
  const projectPath = join(base, 'project');
  await mkdir(homeDir);
  await mkdir(projectPath);
  const projects: Project[] = [{
    id: 'project-fixture', name: 'Synthetic workspace', path: projectPath,
    executionEnabled: false, color: '#000000', createdAt: '2026-09-25T00:00:00.000Z',
  }];
  const service = new McpService({ homeDir, env: { PATH: dirname(process.execPath) }, ...options }, () => projects);
  services.push(service);
  const put = async (path: string, value: string | object) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  return { base, homeDir, projectPath, projects, service, put };
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('MCP declaration discovery', () => {
  it('discovers standard user formats without claiming a live native connection', async () => {
    const { service, homeDir, put } = await fixture();
    await put(join(homeDir, '.codex/config.toml'), `
[mcp_servers.docs]
command = ${JSON.stringify(process.execPath)}
args = ["--version"]
[mcp_servers.off]
url = "https://example.invalid/mcp"
enabled = false
`);
    await put(join(homeDir, '.claude.json'), { mcpServers: {
      remote: { type: 'http', url: 'https://example.invalid/mcp' },
    } });
    await put(join(homeDir, '.kiro/settings/mcp.json'), { mcpServers: {
      legacy: { type: 'sse', url: 'http://127.0.0.1:54321/sse', disabled: true },
    } });
    const catalog = await service.list();
    expect(catalog.items.map(item => [item.agent, item.name, item.transport, item.status])).toEqual([
      ['codex', 'docs', 'stdio', 'enabled'],
      ['codex', 'off', 'http', 'disabled'],
      ['claude', 'remote', 'http', 'enabled'],
      ['kiro', 'legacy', 'sse', 'disabled'],
    ]);
    expect(catalog.items.every(item => item.lastCheck === null)).toBe(true);
    expect(catalog.usageNotice).toMatch(/independent|native/i);
  });

  it('only discovers the explicitly selected registered project, including Claude local scope', async () => {
    const { service, homeDir, projectPath, projects, put } = await fixture();
    await put(join(homeDir, '.claude.json'), {
      projects: {
        [projectPath]: { mcpServers: { local: { command: process.execPath } } },
        '/unregistered/private': { mcpServers: { hidden: { command: 'hidden-value' } } },
      },
    });
    await put(join(projectPath, '.mcp.json'), { mcpServers: { team: { command: process.execPath } } });
    await put(join(projectPath, '.kiro/settings/mcp.json'), { mcpServers: { workspace: { command: process.execPath } } });
    expect((await service.list()).total).toBe(0);
    const catalog = await service.list({ projectId: projects[0].id });
    expect(catalog.items.map(item => [item.name, item.scope]).sort()).toEqual([
      ['local', 'local'], ['team', 'project'], ['workspace', 'project'],
    ]);
    expect(JSON.stringify(catalog)).not.toContain('hidden-value');
    await expect(service.list({ projectId: 'unregistered' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('preserves Codex trust and nested override semantics, and marks overridden declarations', async () => {
    const { service, homeDir, projectPath, projects, put } = await fixture();
    await put(join(homeDir, '.codex/config.toml'), `
[mcp_servers.shared]
command = ${JSON.stringify(process.execPath)}
args = ["global-argument"]
[mcp_servers.shared.env]
BASE = "fixture-base-secret"
`);
    await put(join(projectPath, '.codex/config.toml'), `
[mcp_servers.shared]
args = ["project-argument"]
[mcp_servers.shared.env]
LOCAL = "fixture-local-secret"
`);
    let catalog = await service.list({ projectId: projects[0].id });
    const untrusted = catalog.items.find(item => item.scope === 'project')!;
    expect(untrusted.status).toBe('unknown');
    expect(untrusted.findings.some(item => item.code === 'project-trust-unverified')).toBe(true);
    expect(catalog.items.find(item => item.scope === 'user')?.status).toBe('enabled');
    await put(join(homeDir, '.codex/config.toml'), `
[projects.${JSON.stringify(projectPath)}]
trust_level = "trusted"
[mcp_servers.shared]
command = ${JSON.stringify(process.execPath)}
args = ["global-argument"]
[mcp_servers.shared.env]
BASE = "fixture-base-secret"
`);
    service.refresh(projects[0].id);
    catalog = await service.list({ projectId: projects[0].id });
    const project = catalog.items.find(item => item.scope === 'project')!;
    expect(project.configuration.command).toBeTruthy();
    expect(project.configuration.environmentNames).toEqual(['BASE', 'LOCAL']);
    expect(project.status).toBe('enabled');
    expect(catalog.items.find(item => item.scope === 'user')?.status).toBe('shadowed');
  });

  it('honors Claude approval/disable lists and local > project > user precedence', async () => {
    const { service, homeDir, projectPath, projects, put } = await fixture();
    await put(join(homeDir, '.claude.json'), {
      mcpServers: { collision: { command: process.execPath } },
      projects: { [projectPath]: {
        mcpServers: { collision: { command: process.execPath } },
        disabledMcpServers: ['collision'],
        enabledMcpjsonServers: ['team'],
        disabledMcpjsonServers: ['refused'],
      } },
    });
    await put(join(projectPath, '.mcp.json'), { mcpServers: {
      collision: { command: process.execPath }, team: { command: process.execPath },
      pending: { command: process.execPath }, refused: { command: process.execPath },
    } });
    const catalog = await service.list({ projectId: projects[0].id });
    expect(catalog.items.find(item => item.name === 'collision' && item.scope === 'local')?.status).toBe('disabled');
    expect(catalog.items.filter(item => item.name === 'collision' && item.scope !== 'local').every(item => item.status === 'shadowed')).toBe(true);
    expect(catalog.items.find(item => item.name === 'team')?.status).toBe('enabled');
    expect(catalog.items.find(item => item.name === 'pending')?.status).toBe('unknown');
    expect(catalog.items.find(item => item.name === 'refused')?.status).toBe('disabled');
  });

  it('reports Kiro agent declarations separately and preserves workspace overrides and disabled flags', async () => {
    const { service, homeDir, projectPath, projects, put } = await fixture();
    await put(join(homeDir, '.kiro/settings/mcp.json'), { mcpServers: { docs: { command: process.execPath } } });
    await put(join(projectPath, '.kiro/settings/mcp.json'), { mcpServers: { docs: { command: process.execPath, disabled: true } } });
    await put(join(homeDir, '.kiro/agents/review.json'), {
      name: 'review', includeMcpJson: false,
      mcpServers: { private: { command: process.execPath, timeout: 2000 } },
    });
    const catalog = await service.list({ projectId: projects[0].id });
    expect(catalog.items.find(item => item.name === 'docs' && item.scope === 'user')?.status).toBe('shadowed');
    expect(catalog.items.find(item => item.name === 'docs' && item.scope === 'project')?.status).toBe('disabled');
    const agent = catalog.items.find(item => item.name === 'private')!;
    expect(agent.source.kind).toBe('agent');
    expect(agent.source.agentName).toBe('review');
    expect(agent.findings.some(item => item.code === 'agent-selection-unknown')).toBe(true);
  });

  it('redacts values even when they appear in names, URLs, arguments or static error messages', async () => {
    const { service, homeDir, put } = await fixture();
    const secret = 'fixture-super-private-927';
    await put(join(homeDir, '.claude.json'), { mcpServers: {
      [secret]: { type: 'http', url: `https://user:${secret}@example.invalid/${secret}?key=${secret}`,
        headers: { Authorization: `Bearer ${secret}`, 'X-Custom': secret }, env: { PLAIN: secret } },
      local: { command: process.execPath, args: ['--token', secret, `password=${secret}`], env: { PLAIN: secret } },
    } });
    const catalog = await service.list();
    expect(JSON.stringify(catalog)).not.toContain(secret);
    const local = catalog.items.find(item => item.name === 'local')!;
    expect(local.configuration.args).toEqual(['[redacted]', '[redacted]', '[redacted]']);
    expect(local.configuration.environmentNames).toEqual(['PLAIN']);
    expect(local.configuration.redacted).toBe(true);
    const detail = await service.detail(local.id);
    expect(JSON.stringify(detail)).not.toContain(secret);
  });

  it('performs static executable and environment checks without executing config helpers', async () => {
    const { service, homeDir, put } = await fixture();
    await put(join(homeDir, '.claude.json'), { mcpServers: {
      missing: { command: 'mcp-fixture-does-not-exist', args: ['${REQUIRED_ARG}'], env: { TOKEN: '${REQUIRED_TOKEN}' } },
      helper: { type: 'http', url: 'https://example.invalid/mcp', headersHelper: 'never-execute-fixture' },
    } });
    const catalog = await service.list();
    const missing = catalog.items.find(item => item.name === 'missing')!;
    expect(missing.configuration.missingEnvironmentNames).toEqual(['REQUIRED_ARG', 'REQUIRED_TOKEN']);
    expect(missing.findings.some(item => item.code === 'missing-executable')).toBe(true);
    expect(missing.checkSupport).toBe('blocked');
    const helper = catalog.items.find(item => item.name === 'helper')!;
    expect(helper.configuration.hasHeadersHelper).toBe(true);
    expect(helper.checkSupport).toBe('unsupported');
  });

  it('uses bounded cached discovery, explicit refresh and selection-bound opaque IDs', async () => {
    const { service, homeDir, projects, put } = await fixture();
    const path = join(homeDir, '.kiro/settings/mcp.json');
    await put(path, { mcpServers: { first: { command: process.execPath } } });
    const original = await readFile(path, 'utf8');
    const first = await service.list();
    expect(first.items[0].id).toMatch(/^mcp-[a-f0-9]{24,}$/);
    expect(first.items[0].id).not.toContain(homeDir);
    await put(path, { mcpServers: { second: { command: process.execPath } } });
    expect((await service.list()).items[0].name).toBe('first');
    expect(service.refresh()).toEqual({ ok: true });
    expect((await service.list()).items[0].name).toBe('second');
    const selected = await service.list({ projectId: projects[0].id });
    expect(selected.items[0].id).not.toBe((await service.list()).items[0].id);
    await expect(service.detail(selected.items[0].id)).rejects.toMatchObject({ statusCode: 404 });
    expect(original).toContain('first');
    expect(await readFile(path, 'utf8')).toContain('second');
  });

  it('rejects owner-root escapes even if the symlink points into another selected root', async () => {
    const { service, homeDir, projectPath, projects, put } = await fixture();
    await put(join(projectPath, 'private.json'), { mcpServers: { private: { command: process.execPath } } });
    await mkdir(join(homeDir, '.kiro/settings'), { recursive: true });
    await symlink(join(projectPath, 'private.json'), join(homeDir, '.kiro/settings/mcp.json'));
    const catalog = await service.list({ projectId: projects[0].id });
    expect(catalog.items).toEqual([]);
    expect(catalog.warnings.length).toBeGreaterThan(0);
  });

  it('bounds files and declarations and emits safe diagnostics for malformed input', async () => {
    const { service, homeDir, put } = await fixture({ maxConfigBytes: 1024, maxServers: 2 });
    await put(join(homeDir, '.claude.json'), `{"mcpServers":${' '.repeat(2048)} "private-malformed-secret"`);
    await put(join(homeDir, '.kiro/settings/mcp.json'), { mcpServers: Object.fromEntries(
      ['a', 'b', 'c', 'd'].map(name => [name, { command: process.execPath }]),
    ) });
    const catalog = await service.list();
    expect(catalog.total).toBe(2);
    expect(catalog.warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(catalog)).not.toContain('private-malformed-secret');
  });

  it('uses synthetic demo declarations without reading configured homes', async () => {
    const { service, homeDir, put } = await fixture({ demo: true });
    await put(join(homeDir, '.claude.json'), { mcpServers: { forbidden: { command: 'real-like-secret' } } });
    const catalog = await service.list();
    expect(catalog.demo).toBe(true);
    expect(catalog.total).toBeGreaterThan(0);
    expect(JSON.stringify(catalog)).not.toContain('forbidden');
    expect(JSON.stringify(catalog)).not.toContain(homeDir);
    expect(catalog.items.every(item => item.checkSupport === 'blocked')).toBe(true);
  });

  it('discovers Codex bundled MCP declarations and server overrides with bounded plugin ownership', async () => {
    const { service, homeDir, put } = await fixture();
    const root = join(homeDir, '.codex/plugins/cache/team/docs/1.0.0');
    await put(join(root, '.codex-plugin/plugin.json'), { name: 'docs', mcpServers: ['./.mcp.json'] });
    await put(join(root, '.mcp.json'), { mcpServers: {
      bundled: { command: process.execPath, args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] },
      disabled: { command: process.execPath },
    } });
    await put(join(homeDir, '.codex/config.toml'), `
[plugins."docs@team"]
enabled = true
[plugins."docs@team".mcp_servers.disabled]
enabled = false
`);
    const catalog = await service.list();
    expect(catalog.total).toBe(2);
    expect(catalog.items.every(item => item.source.kind === 'plugin' && item.source.pluginName === 'docs')).toBe(true);
    expect(catalog.items.find(item => item.name === 'bundled')?.status).toBe('enabled');
    expect(catalog.items.find(item => item.name === 'disabled')?.status).toBe('disabled');
  });

  it('does not select a Codex plugin version just because multiple versions are cached', async () => {
    const { service, homeDir, put } = await fixture();
    for (const version of ['1.0.0', '2.0.0']) {
      const root = join(homeDir, '.codex/plugins/cache/team/docs', version);
      await put(join(root, '.codex-plugin/plugin.json'), { name: 'docs' });
      await put(join(root, '.mcp.json'), { mcpServers: { docs: { command: process.execPath } } });
    }
    await put(join(homeDir, '.codex/config.toml'), '[plugins."docs@team"]\nenabled = true');
    const catalog = await service.list();
    expect(catalog.total).toBe(2);
    expect(catalog.items.every(item => item.status === 'unknown' && item.checkSupport === 'blocked')).toBe(true);
  });

  it('uses Claude installed-registry evidence and excludes other-project plugin records', async () => {
    const { service, homeDir, projectPath, projects, put } = await fixture();
    const root = join(homeDir, '.claude/plugins/cache/team/docs/1.0.0');
    const other = join(homeDir, '.claude/plugins/cache/team/private/1.0.0');
    for (const [path, name] of [[root, 'docs'], [other, 'private']]) {
      await put(join(path, '.claude-plugin/plugin.json'), { name, mcpServers: { [name]: { command: process.execPath } } });
    }
    await put(join(homeDir, '.claude/plugins/installed_plugins.json'), {
      version: 2, plugins: {
        'docs@team': [{ scope: 'project', projectPath, installPath: root }],
        'private@team': [{ scope: 'project', projectPath: '/other/unselected', installPath: other }],
      },
    });
    await put(join(projectPath, '.claude/settings.json'), { enabledPlugins: { 'docs@team': true } });
    const catalog = await service.list({ projectId: projects[0].id });
    expect(catalog.items.find(item => item.name === 'docs')).toMatchObject({ status: 'enabled', scope: 'project' });
    expect(catalog.items.some(item => item.name === 'private')).toBe(false);
    expect((await service.list()).items.some(item => item.name === 'docs')).toBe(false);
  });

  it('does not follow a plugin declaration outside its owner, even into another admitted root', async () => {
    const { service, homeDir, projectPath, projects, put } = await fixture();
    const root = join(homeDir, '.codex/plugins/cache/team/docs/1.0.0');
    await put(join(root, '.codex-plugin/plugin.json'), { name: 'docs', mcpServers: '../../../../../outside.json' });
    await put(join(projectPath, 'private.json'), { mcpServers: { private: { command: process.execPath } } });
    await symlink(join(projectPath, 'private.json'), join(root, '.mcp.json'));
    await put(join(homeDir, '.codex/config.toml'), '[plugins."docs@team"]\nenabled = true');
    const catalog = await service.list({ projectId: projects[0].id });
    expect(catalog.items).toEqual([]);
    expect(catalog.warnings.some(message => /owner|plugin/i.test(message))).toBe(true);
  });

  it('discovers Kiro Power MCP metadata without equating installation with activation', async () => {
    const { service, homeDir, put } = await fixture();
    const root = join(homeDir, '.kiro/powers/installed/docs');
    await put(join(root, 'plugin.json'), { name: 'docs', mcpServers: './mcp.json' });
    await put(join(root, 'mcp.json'), { mcpServers: { powerDocs: { command: process.execPath } } });
    const catalog = await service.list();
    expect(catalog.items[0]).toMatchObject({
      name: 'powerDocs', status: 'unknown', checkSupport: 'blocked',
      source: { kind: 'power', pluginName: 'docs' },
    });
  });

  it('preserves YAML source identity and distinct IDE/CLI consumers for Kiro Markdown declarations', async () => {
    const { service, homeDir, put } = await fixture();
    await put(join(homeDir, '.kiro/agents/review.md'), `---\nname: review\nmcpServers:\n  agentServer:\n    command: ${JSON.stringify(process.execPath)}\n---\nSynthetic agent instructions.`);
    await put(join(homeDir, '.kiro/powers/installed/docs/POWER.md'), `---\nname: docs\nmcpServers:\n  powerServer:\n    command: ${JSON.stringify(process.execPath)}\n---\nSynthetic Power instructions.`);
    const catalog = await service.list();
    expect(catalog.items.map(item => [item.name, item.source.format, item.source.clients])).toEqual([
      ['agentServer', 'yaml', ['kiro-cli']], ['powerServer', 'yaml', ['kiro-ide']],
    ]);
    expect(catalog.items.every(item => item.lastCheck === null)).toBe(true);
  });
});
