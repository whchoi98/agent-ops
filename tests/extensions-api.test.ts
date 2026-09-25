import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type AppContext } from '../server/app.js';

const contexts: AppContext[] = [];
const directories: string[] = [];
async function setup(demo = false, publicUrl?: string) {
  const base = await mkdtemp(join(tmpdir(), 'agent-ops-extension-api-'));
  directories.push(base);
  const homeDir = join(base, 'home');
  const codexHome = join(homeDir, '.codex');
  const claudeHome = join(homeDir, '.claude');
  const skillRoot = join(codexHome, 'skills/review');
  async function put(path: string, value: string | object) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  }
  await mkdir(claudeHome, { recursive: true });
  await put(join(skillRoot, 'SKILL.md'), '---\nname: 검토 도우미\ndescription: 코드와 테스트를 검토합니다.\nallowed-tools: [Read, Grep]\n---\n# 검토\n회귀 테스트를 확인하세요.\npassword=fixture-secret-value');
  await put(join(skillRoot, 'references/details.md'), '# 세부 지침\n변경 범위를 확인하세요.');
  const plugin = join(codexHome, 'plugins/cache/team/review-kit/1.0.0');
  await put(join(plugin, '.codex-plugin/plugin.json'), { name: 'review-kit', version: '1.0.0' });
  await put(join(plugin, 'skills/check/SKILL.md'), '---\nname: check\ndescription: Check the build.\n---\nRead the instructions.');
  await put(join(plugin, '.mcp.json'), { mcpServers: { docs: { command: 'fixture-never-execute', env: { CUSTOM_VALUE: 'fixture-hidden-environment' } } } });
  await put(join(codexHome, 'config.toml'), '[plugins."review-kit@team"]\nenabled = true');
  const context = await createApp({
    dataDir: join(base, 'state'), demo, autoSync: false, publicUrl,
    extensionOptions: { homeDir, codexHome, claudeHome, systemRoots: [] },
    connectorProbe: async () => [],
  });
  contexts.push(context);
  return { ...context, base, homeDir, codexHome, skillRoot, put };
}
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.app.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('extension catalog API', () => {
  it('scopes project discovery to a registered project and keeps its IDs separate', async () => {
    const { app, store, base, put } = await setup();
    const path = join(base, 'project');
    await put(join(path, '.agents/skills/project-rules/SKILL.md'), '---\nname: 프로젝트 전용\ndescription: 선택한 프로젝트에서만 발견하는 규칙입니다.\n---\n# 프로젝트 규칙');
    const project = store.ensureProject(path, 'Example');
    expect((await app.inject('/api/extensions?scope=project')).json().total).toBe(0);
    const response = await app.inject(`/api/extensions?projectId=${project.id}&scope=project`);
    expect(response.statusCode).toBe(200);
    expect(response.json().total).toBe(1);
    const item = response.json().items[0];
    expect(item.name).toBe('프로젝트 전용');
    expect((await app.inject(`/api/extensions/${item.id}`)).statusCode).toBe(404);
    expect((await app.inject(`/api/extensions/${item.id}?projectId=${project.id}`)).json().entry.content).toContain('프로젝트 규칙');
  });

  it('filters and pages native definitions and relates bundled skills to their plugin', async () => {
    const { app } = await setup();
    const all = await app.inject('/api/extensions?agent=codex&limit=1');
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(3);
    expect(all.json().items).toHaveLength(1);
    expect(all.json().counts.codex.plugins).toBe(1);
    const next = await app.inject('/api/extensions?agent=codex&limit=1&offset=1');
    expect(next.json().items[0].id).not.toBe(all.json().items[0].id);
    const found = await app.inject(`/api/extensions?q=${encodeURIComponent('검토')}`);
    expect(found.json().total).toBe(1);
    expect(found.json().items[0].name).toBe('검토 도우미');
    const plugins = (await app.inject('/api/extensions?kind=plugin')).json();
    const detail = (await app.inject(`/api/extensions/${plugins.items[0].id}`)).json();
    expect(detail.children).toHaveLength(1);
    expect(detail.children[0].pluginId).toBe(detail.id);
  });

  it('returns local analysis and redacted instruction/config previews', async () => {
    const { app } = await setup();
    const item = (await app.inject(`/api/extensions?q=${encodeURIComponent('검토')}`)).json().items[0];
    const response = await app.inject(`/api/extensions/${item.id}`);
    expect(response.statusCode).toBe(200);
    const detail = response.json();
    expect(detail.analysis.tools).toContain('Read');
    expect(detail.entry.content).toContain('회귀 테스트');
    expect(response.body).not.toContain('fixture-secret-value');
    const reference = detail.files.find((file: { path: string }) => file.path.endsWith('details.md'));
    const content = await app.inject(`/api/extensions/${item.id}/files/${reference.id}`);
    expect(content.json().content).toContain('변경 범위');
    const plugin = (await app.inject('/api/extensions?kind=plugin')).json().items[0];
    const pluginDetail = (await app.inject(`/api/extensions/${plugin.id}`)).json();
    expect(pluginDetail.analysis.mcpServers).toContain('docs');
    const config = pluginDetail.files.find((file: { path: string }) => file.path === '.mcp.json');
    const configContent = await app.inject(`/api/extensions/${plugin.id}/files/${config.id}`);
    expect(configContent.body).not.toContain('fixture-hidden-environment');
    expect(configContent.json().content).toContain('CUSTOM_VALUE');
  });

  it('preserves JSON arrays in reference previews while redacting nested secrets', async () => {
    const { app, skillRoot, put } = await setup();
    await put(join(skillRoot, 'references/data.json'), [{ name: 'example', token: 'fixture-array-secret' }]);
    const item = (await app.inject(`/api/extensions?q=${encodeURIComponent('검토')}`)).json().items[0];
    const detail = (await app.inject(`/api/extensions/${item.id}`)).json();
    const file = detail.files.find((entry: { path: string }) => entry.path.endsWith('data.json'));
    const response = await app.inject(`/api/extensions/${item.id}/files/${file.id}`);
    const preview = JSON.parse(response.json().content);
    expect(Array.isArray(preview)).toBe(true);
    expect(preview[0].name).toBe('example');
    expect(response.body).not.toContain('fixture-array-secret');
  });

  it('preserves scalar JSON document types in previews', async () => {
    const { app, skillRoot, put } = await setup();
    const values = [true, 42, 'ordinary reference', null];
    for (let index = 0; index < values.length; index++) await put(join(skillRoot, `references/value-${index}.json`), JSON.stringify(values[index]));
    const item = (await app.inject(`/api/extensions?q=${encodeURIComponent('검토')}`)).json().items[0];
    const detail = (await app.inject(`/api/extensions/${item.id}`)).json();
    for (let index = 0; index < values.length; index++) {
      const file = detail.files.find((entry: { path: string }) => entry.path.endsWith(`value-${index}.json`));
      const response = await app.inject(`/api/extensions/${item.id}/files/${file.id}`);
      expect(JSON.parse(response.json().content)).toEqual(values[index]);
    }
  });

  it('does not expose another approved project through a plugin child symlink', async () => {
    const { app, store, base, codexHome, put } = await setup();
    const projectPath = join(base, 'project');
    const privateRoot = join(projectPath, 'private-docs');
    await put(join(privateRoot, 'SKILL.md'), '---\nname: private-definition\ndescription: Not part of the plugin.\n---');
    await put(join(privateRoot, 'internal.txt'), 'unrelated project document');
    const project = store.ensureProject(projectPath, 'Example');
    const pluginRoot = join(codexHome, 'plugins/cache/team/review-kit/1.0.0');
    await symlink(privateRoot, join(pluginRoot, 'skills/linked'));
    const response = await app.inject(`/api/extensions?projectId=${project.id}`);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('private-definition');
    expect(response.json().warnings.length).toBeGreaterThan(0);
  });

  it('analyzes one current file version after the definition changes between requests', async () => {
    const { app, skillRoot, put } = await setup();
    await put(join(skillRoot, 'SKILL.md'), '---\nname: 검토 도우미\ndescription: 코드와 테스트를 검토합니다.\nallowed-tools: [Read]\nversion: \"1.0.0\"\n---\n# 이전 검토');
    const item = (await app.inject(`/api/extensions?q=${encodeURIComponent('검토')}`)).json().items[0];
    await put(join(skillRoot, 'SKILL.md'), '---\nname: 새 검토\ndescription: 현재 버전의 설명입니다.\nallowed-tools: [NewTool]\nversion: \"2.0.0\"\n---\n# 새 검토\n현재 내용입니다.');
    const detail = (await app.inject(`/api/extensions/${item.id}`)).json();
    expect(detail.name).toBe('새 검토');
    expect(detail.metadata.description).toBe('현재 버전의 설명입니다.');
    expect(detail.analysis.purpose).toContain('현재 버전');
    expect(detail.analysis.tools).toContain('NewTool');
    expect(detail.analysis.tools).not.toContain('Read');
    expect(detail.version).toBe('2.0.0');
    expect(detail.warnings.some((warning: string) => /변경/.test(warning))).toBe(true);
    const draft = await app.inject({ method: 'POST', url: `/api/extensions/${item.id}/analyze`, headers: { 'x-agent-ops': '1' }, payload: {} });
    expect(draft.json().draft.title).toContain('새 검토');
    expect(draft.body).not.toContain('코드와 테스트를 검토합니다.');
    await put(join(skillRoot, 'SKILL.md'), '---\nname: 새 검토\ndescription: 버전 선언을 제거했습니다.\n---\n# 현재 내용');
    expect((await app.inject(`/api/extensions/${item.id}`)).json().version).toBeNull();
  });

  it('redacts aliases in fenced or multi-document YAML and values in TOML environment tables', async () => {
    const { app, skillRoot, put } = await setup();
    await put(join(skillRoot, 'SKILL.md'), '---\nname: alias-review\ndescription: Review the examples.\n---\n# Examples\n```yaml\nshared: &s fixture-fenced-alias\nenv: { PLAIN: *s }\n```\n');
    await put(join(skillRoot, 'references/documents.yaml'), 'title: first\n---\nshared: &s fixture-document-alias\nenv: { PLAIN: *s }\n');
    await put(join(skillRoot, 'references/config.toml'), '[mcp_servers.docs.env]\nplain = "fixture-toml-environment"\n');
    const item = (await app.inject('/api/extensions?q=alias-review')).json().items[0];
    const response = await app.inject(`/api/extensions/${item.id}`);
    expect(response.body).not.toContain('fixture-fenced-alias');
    const detail = response.json();
    expect(detail.metadata.name).toBe('alias-review');
    expect(detail.analysis.purpose).toBe('Review the examples.');
    expect(detail.warnings.some((warning: string) => /정의가 변경/.test(warning))).toBe(false);
    for (const [suffix, secret] of [['documents.yaml', 'fixture-document-alias'], ['config.toml', 'fixture-toml-environment']]) {
      const file = detail.files.find((entry: { path: string }) => entry.path.endsWith(suffix));
      const preview = await app.inject(`/api/extensions/${item.id}/files/${file.id}`);
      expect(preview.body).not.toContain(secret);
    }
    const draft = await app.inject({ method: 'POST', url: `/api/extensions/${item.id}/analyze`, headers: { 'x-agent-ops': '1' }, payload: {} });
    expect(draft.body).not.toContain('fixture-fenced-alias');
  });

  it('does not publish a Kiro name or description expanded from an environment alias', async () => {
    const { app, homeDir, put } = await setup();
    const secret = 'fixture-kiro-alias-private';
    await put(join(homeDir, '.kiro/skills/alias/SKILL.md'), `---\nshared: &s ${secret}\nname: *s\ndescription: *s\nenv: { PLAIN: *s }\n---\n# Instructions`);
    const response = await app.inject('/api/extensions?agent=kiro');
    expect(response.statusCode).toBe(200);
    expect(response.body.includes(secret)).toBe(false);
  });

  it('retains unchanged cache and nested-metadata version evidence in detail', async () => {
    const { app, homeDir, codexHome, put } = await setup();
    await put(join(codexHome, 'plugins/cache/team/review-kit/1.0.0/.codex-plugin/plugin.json'), { name: 'review-kit' });
    await put(join(homeDir, '.kiro/skills/nested-version/SKILL.md'), '---\nname: nested-version\ndescription: Versioned skill.\nmetadata:\n  version: \"4.5.6\"\n---\n# Skill');
    const catalog = (await app.inject('/api/extensions')).json();
    for (const [name, version] of [['review-kit', '1.0.0'], ['nested-version', '4.5.6']]) {
      const item = catalog.items.find((entry: { name: string }) => entry.name === name);
      expect(item.version).toBe(version);
      const detail = (await app.inject(`/api/extensions/${item.id}`)).json();
      expect(detail.version).toBe(version);
      expect(detail.warnings.some((warning: string) => /정의가 변경/.test(warning))).toBe(false);
    }
  });

  it('does not expose Kiro package manifest or POWER links outside their owner', async () => {
    const { app, homeDir, put } = await setup();
    const secret = 'private-power-manifest';
    await put(join(homeDir, '.kiro/unrelated.json'), { name: secret, description: secret });
    await put(join(homeDir, '.kiro/unrelated.md'), `---\nname: ${secret}\ndescription: ${secret}\n---`);
    for (const [name, file] of [['manifest', 'plugin.json'], ['legacy', 'POWER.md']]) {
      const root = join(homeDir, '.kiro/powers/installed', name);
      await mkdir(root, { recursive: true });
      await symlink(join(homeDir, '.kiro', name === 'manifest' ? 'unrelated.json' : 'unrelated.md'), join(root, file));
    }
    const response = await app.inject('/api/extensions?agent=kiro');
    expect(response.statusCode).toBe(200);
    expect(response.body.includes(secret)).toBe(false);
  });

  it('rejects arbitrary project/file paths and a symlink swapped after discovery', async () => {
    const { app, base, skillRoot, put } = await setup();
    expect((await app.inject('/api/extensions?projectId=missing')).statusCode).toBe(404);
    expect((await app.inject('/api/extensions?path=/etc')).statusCode).toBe(400);
    expect((await app.inject('/api/extensions/not-known')).statusCode).toBe(404);
    const item = (await app.inject(`/api/extensions?q=${encodeURIComponent('검토')}`)).json().items[0];
    const detail = (await app.inject(`/api/extensions/${item.id}`)).json();
    const reference = detail.files.find((file: { path: string }) => file.path.endsWith('details.md'));
    await put(join(base, 'outside.md'), 'outside-fixture-secret');
    await rm(join(skillRoot, 'references/details.md'));
    await symlink(join(base, 'outside.md'), join(skillRoot, 'references/details.md'));
    const result = await app.inject(`/api/extensions/${item.id}/files/${reference.id}`);
    expect(result.statusCode).toBe(404);
    expect(result.body).not.toContain('outside-fixture-secret');
    expect((await app.inject(`/api/extensions/${item.id}/files/not-known`)).statusCode).toBe(404);
  });

  it('prepares a read-only analysis draft and refreshes without executing a run', async () => {
    const { app, runner, put, codexHome } = await setup();
    const item = (await app.inject(`/api/extensions?q=${encodeURIComponent('검토')}`)).json().items[0];
    expect((await app.inject({ method: 'POST', url: `/api/extensions/${item.id}/analyze`, payload: {} })).statusCode).toBe(403);
    const response = await app.inject({ method: 'POST', url: `/api/extensions/${item.id}/analyze`, headers: { 'x-agent-ops': '1' }, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().draft.policy).toBe('read-only');
    expect(response.json().draft.prompt).toContain('검토 도우미');
    expect(response.body).not.toContain('fixture-secret-value');
    expect(runner.listRuns()).toEqual([]);
    await put(join(codexHome, 'skills/new/SKILL.md'), '---\nname: new-skill\ndescription: Newly installed skill.\n---');
    expect((await app.inject('/api/extensions?agent=codex')).json().total).toBe(3);
    expect((await app.inject({ method: 'POST', url: '/api/extensions/refresh', payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/extensions/refresh', headers: { 'x-agent-ops': '1' }, payload: {} })).statusCode).toBe(200);
    expect((await app.inject('/api/extensions?agent=codex')).json().total).toBe(4);
  });

  it('uses isolated demo content and preserves the configured proxy prefix', async () => {
    const { app, runner } = await setup(true, 'https://workbench.example.com/proxy/4327/');
    const response = await app.inject({ url: '/proxy/4327/api/extensions', headers: { host: 'workbench.example.com' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().demo).toBe(true);
    expect(response.body).toContain('코드 리뷰');
    expect(response.body).not.toContain('검토 도우미');
    expect(response.body).not.toContain('agent-ops-extension-api-');
    const item = response.json().items.find((entry: { name: string }) => entry.name === '코드 리뷰');
    const detail = await app.inject({ url: `/proxy/4327/api/extensions/${item.id}`, headers: { host: 'workbench.example.com' } });
    expect(detail.json().entry.content).toContain('회귀 테스트');
    expect(runner.listRuns().every(run => run.id.startsWith('demo-'))).toBe(true);
  });
});
