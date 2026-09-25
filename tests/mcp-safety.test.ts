import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finished, mcpFixture, type McpFixture } from './fixtures/mcp-test-helpers.js';
import { McpService } from '../server/mcp/service.js';

const fixtures: McpFixture[] = [];
const script = fileURLToPath(new URL('./fixtures/mcp-stdio.cjs', import.meta.url));
async function setup(options: Parameters<typeof mcpFixture>[0] = {}) {
  const fixture = await mcpFixture(options);
  fixtures.push(fixture);
  return fixture;
}
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose())); });

describe('MCP privacy, preview and ownership boundaries', () => {
  it('rejects an initial Claude configuration symlink outside its configuration home', async () => {
    const { service, homeDir, projectPath, projects, put } = await setup();
    await put(join(projectPath, 'foreign.json'), { mcpServers: { foreign: { command: process.execPath } } });
    await symlink(join(projectPath, 'foreign.json'), join(homeDir, '.claude.json'));
    const catalog = await service.list({ projectId: projects[0].id });
    expect(catalog.items).toEqual([]);
    expect(catalog.warnings.some(message => /owner|outside/i.test(message))).toBe(true);
  });

  it('rejects a plugin cache root redirected into another admitted project', async () => {
    const { service, homeDir, projectPath, projects, put } = await setup();
    await put(join(homeDir, '.codex/config.toml'), '[plugins."docs@team"]\nenabled = true');
    const root = join(projectPath, 'foreign/team/docs/1.0.0');
    await put(join(root, '.codex-plugin/plugin.json'), { name: 'docs' });
    await put(join(root, '.mcp.json'), { mcpServers: { foreign: { command: process.execPath } } });
    await mkdir(join(homeDir, '.codex/plugins'), { recursive: true });
    await symlink(join(projectPath, 'foreign'), join(homeDir, '.codex/plugins/cache'));
    const catalog = await service.list({ projectId: projects[0].id });
    expect(catalog.items).toEqual([]);
    expect(catalog.warnings.some(message => /owner|outside/i.test(message))).toBe(true);
  });

  it('preserves Claude missing-type semantics instead of guessing HTTP from the URL', async () => {
    const { service, config } = await setup();
    await config({ missingType: { url: 'https://example.invalid/mcp' } });
    const item = (await service.list()).items[0];
    expect(item.transport).toBe('stdio');
    expect(item.checkSupport).toBe('blocked');
    expect(item.findings.some(finding => finding.code === 'missing-command')).toBe(true);
  });

  it('does not forward native/cloud credentials from Claude remote interpolation', async () => {
    const { service, config } = await setup({ env: { ANTHROPIC_API_KEY: 'synthetic-native-private', API_KEY: 'synthetic-custom-private' } });
    await config({
      blocked: { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${ANTHROPIC_API_KEY}' } },
      supported: { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${API_KEY}' } },
    });
    const catalog = await service.list();
    expect(catalog.items.find(item => item.name === 'blocked')?.checkSupport).toBe('blocked');
    expect(catalog.items.find(item => item.name === 'supported')?.checkSupport).toBe('supported');
    expect(JSON.stringify(catalog)).not.toMatch(/synthetic-native-private|synthetic-custom-private/);
  });

  it.each([
    { env_http_headers: { Authorization: 'ANTHROPIC_API_KEY' } },
    { bearer_token_env_var: 'ANTHROPIC_API_KEY' },
    { env_http_headers: { 'X-Cloud': 'AWS_SECRET_ACCESS_KEY' } },
  ])('applies the remote credential denylist to every environment lookup path: %j', async fields => {
    const { service, config } = await setup({ env: {
      ANTHROPIC_API_KEY: 'fixture-native-credential-never-forward',
      AWS_SECRET_ACCESS_KEY: 'fixture-cloud-credential-never-forward',
    } });
    await config({ guarded: { type: 'http', url: 'https://example.invalid/mcp', ...fields } });
    const item = (await service.list()).items[0];
    expect(item.checkSupport).toBe('blocked');
    expect(item.findings.some(finding => finding.code === 'credential-variable-blocked')).toBe(true);
    expect((await service.preview(item.id)).canCheck).toBe(false);
    expect(JSON.stringify(await service.detail(item.id))).not.toMatch(/fixture-(?:native|cloud)-credential/);
  });

  it('blocks unresolved client-specific placeholders rather than sending literal or guessed targets', async () => {
    const { service, config } = await setup();
    await config({ input: { type: 'http', url: 'https://example.invalid/${input:TOKEN}' } });
    const item = (await service.list()).items[0];
    expect(item.checkSupport).not.toBe('supported');
    expect((await service.preview(item.id)).canCheck).toBe(false);
  });

  it('supports an environment-defined URL without disclosing its resolved hostname', async () => {
    const { service, config } = await setup({ env: { MCP_BASE_URL: 'https://fixture-private-host.invalid' } });
    await config({ remote: { type: 'streamable-http', url: '${MCP_BASE_URL}/mcp' } });
    const item = (await service.list()).items[0];
    expect(item.checkSupport).toBe('supported');
    expect(item.transport).toBe('http');
    expect(item.configuration.inheritedEnvironmentNames).toContain('MCP_BASE_URL');
    expect(JSON.stringify(item)).not.toContain('fixture-private-host');
  });

  it('redacts credential components and aliases across server summaries', async () => {
    const { service, config } = await setup();
    const value = 'fixture-cross-server-credential';
    const password = 'fixture-decoded-password';
    await config({
      secretSource: { type: 'http', url: 'https://example.invalid/mcp',
        env: { CUSTOM: value }, headers: { Authorization: `Basic ${Buffer.from(`user:${password}`).toString('base64')}`, Cookie: 'session=fixture-cookie-private' } },
      copies: { type: 'http', url: `https://${value}.invalid/mcp`,
        headers: { [value]: 'anything' }, disabled_tools: [password, 'fixture-cookie-private'] },
    });
    const catalog = await service.list();
    expect(JSON.stringify(catalog)).not.toMatch(/fixture-cross-server-credential|fixture-decoded-password|fixture-cookie-private/);
  });

  it('does not fail discovery on unpaired Unicode in a configured argument', async () => {
    const { service, config } = await setup();
    await config({ synthetic: { command: process.execPath, args: ['\ud800'] } });
    const catalog = await service.list();
    expect(catalog.total).toBe(1);
    expect(catalog.items[0].configuration.args).toEqual(['[redacted]']);
  });

  it('withholds command-line text mistakenly supplied as an executable name', async () => {
    const { service, config } = await setup();
    await config({ broken: { command: 'sshpass -p fixture-command-private' } });
    const item = (await service.list()).items[0];
    expect(item.checkSupport).toBe('blocked');
    expect(JSON.stringify(item)).not.toContain('fixture-command-private');
  });

  it('forwards only configured Codex environment values and literal arguments to the synthetic process', async () => {
    const { service, homeDir, base, put } = await setup({ env: {
      PATH: dirname(process.execPath), FORWARDED: 'synthetic-forwarded-value', AMBIENT_SECRET: 'synthetic-ambient-private',
      NODE_OPTIONS: '--must-not-be-inherited',
    } });
    const log = join(base, 'environment.jsonl');
    await put(join(homeDir, '.codex/config.toml'), `
[mcp_servers.synthetic]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(script)}, ${JSON.stringify(log)}, "normal"]
env_vars = ["FORWARDED"]
[mcp_servers.synthetic.env]
FIXTURE_TOKEN = "synthetic-codex-token"
`);
    const item = (await service.list()).items[0];
    const preview = await service.preview(item.id);
    const result = await finished(service, (await service.check(item.id, preview.previewId)).id);
    expect(result.status).toBe('reachable');
    const first = JSON.parse((await readFile(log, 'utf8')).split('\n')[0]);
    expect(first.environment).toEqual({ FIXTURE_TOKEN: 'synthetic-codex-token', FORWARDED: 'synthetic-forwarded-value' });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-codex-token|synthetic-forwarded-value|synthetic-ambient-private/);
  });

  it('shows Codex HTTP environment reference names while hiding their resolved credentials', async () => {
    const { service, homeDir, put } = await setup({ env: { MCP_ACCESS_TOKEN: 'synthetic-http-env-private' } });
    await put(join(homeDir, '.codex/config.toml'), `
[mcp_servers.remote]
url = "https://example.invalid/mcp"
bearer_token_env_var = "MCP_ACCESS_TOKEN"
env_http_headers = { "X-Workspace" = "MCP_WORKSPACE" }
`);
    const item = (await service.list()).items[0];
    expect(item.configuration.inheritedEnvironmentNames).toEqual(['MCP_ACCESS_TOKEN', 'MCP_WORKSPACE']);
    expect(item.configuration.missingEnvironmentNames).toEqual(['MCP_WORKSPACE']);
    expect(JSON.stringify(item)).not.toContain('synthetic-http-env-private');
  });

  it('uses the selected workspace and execution gate when a global stdio declaration is checked there', async () => {
    const { service, config, base, projects, projectPath } = await setup();
    const log = join(base, 'selected-workspace.jsonl');
    await config({ global: { command: process.execPath, args: [script, log] } });
    const item = (await service.list({ projectId: projects[0].id })).items[0];
    expect((await service.preview(item.id, projects[0].id)).canCheck).toBe(false);
    projects[0].executionEnabled = true;
    const preview = await service.preview(item.id, projects[0].id);
    expect(preview.configuration.cwd).toBe(projectPath);
    const result = await finished(service, (await service.check(item.id, preview.previewId, projects[0].id)).id);
    expect(result.status).toBe('reachable');
    expect(JSON.parse((await readFile(log, 'utf8')).split('\n')[0]).cwd).toBe(projectPath);
  });

  it('rejects a project path change during asynchronous check revalidation', async () => {
    const { config, homeDir, base, projects } = await setup();
    projects[0].executionEnabled = true;
    const replacement = join(base, 'replacement');
    await mkdir(replacement);
    await config({ synthetic: { command: process.execPath, args: [script, join(base, 'race.jsonl')] } });
    let changeOnRead = false;
    const service = new McpService({ homeDir, env: { PATH: dirname(process.execPath) }, cleanupGraceMs: 50 }, () => {
      if (changeOnRead) {
        changeOnRead = false;
        queueMicrotask(() => { projects[0].path = replacement; });
      }
      return projects;
    });
    try {
      const item = (await service.list({ projectId: projects[0].id })).items[0];
      const preview = await service.preview(item.id, projects[0].id);
      changeOnRead = true;
      await expect(service.check(item.id, preview.previewId, projects[0].id)).rejects.toMatchObject({ code: 'stale-preview' });
      expect(service.resourceRoots).toEqual([]);
    } finally { await service.close(); }
  });

  it('preserves last results after unrelated workspace writes, but not after configuration changes', async () => {
    const { service, config, base, homeDir, put } = await setup();
    await config({ synthetic: { command: process.execPath, args: [script, join(base, 'history.jsonl')] } });
    const item = (await service.list()).items[0];
    const preview = await service.preview(item.id);
    const check = await service.check(item.id, preview.previewId);
    await finished(service, check.id);
    await put(join(homeDir, 'unrelated.txt'), 'synthetic unrelated content');
    service.refresh();
    expect((await service.detail(item.id)).lastResult?.id).toBe(check.id);
    await config({ synthetic: { command: process.execPath, args: ['--version'] } });
    service.refresh();
    expect((await service.detail(item.id)).lastResult).toBeNull();
  });

  it('expires unused previews', async () => {
    const { service, config } = await setup({ previewTtlMs: 50 });
    await config({ synthetic: { command: process.execPath } });
    const item = (await service.list()).items[0];
    const expired = await service.preview(item.id);
    await new Promise(resolve => setTimeout(resolve, 60));
    await expect(service.check(item.id, expired.previewId)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('retains only bounded results and protects state from public object mutation', async () => {
    const { service, config, base } = await setup({ maxResults: 2 });
    await config({ synthetic: { command: process.execPath, args: [script, join(base, 'bounded.jsonl')] } });
    const item = (await service.list()).items[0];
    const checks: string[] = [];
    for (let index = 0; index < 3; index++) {
      const preview = await service.preview(item.id);
      preview.configuration.command = 'should-never-execute';
      preview.configuration.args.push('--should-not-run');
      const check = await service.check(item.id, preview.previewId);
      const result = await finished(service, check.id);
      expect(result.status).toBe('reachable');
      result.tools.items[0].name = 'should-not-persist';
      expect(service.getCheck(check.id).tools.items[0].name).toBe('first');
      checks.push(check.id);
    }
    expect(() => service.getCheck(checks[0])).toThrow(/evicted/);
    expect(service.getCheck(checks[2]).status).toBe('reachable');
  });
});
