import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverClaude } from '../server/extensions/claude.js';
import { ExtensionReader } from '../server/extensions/io.js';
import type { DiscoveryContext, ExtensionCandidate } from '../server/extensions/types.js';

const temporaryDirectories: string[] = [];

async function put(path: string, content: string | Record<string, unknown>) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

async function fixture(withProject = true): Promise<DiscoveryContext> {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-extensions-claude-'));
  temporaryDirectories.push(root);
  const homeDir = join(root, 'home');
  return {
    homeDir,
    claudeHome: join(homeDir, 'custom-claude'),
    codexHome: join(homeDir, 'unused-codex'),
    platform: process.platform,
    project: withProject ? { id: 'registered-project', name: '예제 프로젝트', path: join(root, 'workspace') } : null,
    io: new ExtensionReader({ roots: [root] }),
  };
}

function candidate(items: ExtensionCandidate[], path: string) {
  const item = items.find(entry => entry.path === path);
  expect(item, `Missing fixture entry ${path}`).toBeDefined();
  return item!;
}

async function plugin(context: DiscoveryContext, name: string, version = '1.0.0', extra: Record<string, unknown> = {}) {
  const root = join(context.claudeHome, 'plugins', 'cache', 'catalog', name, version);
  const path = await put(join(root, '.claude-plugin', 'plugin.json'), { name, version, ...extra });
  return { root, path };
}

async function registry(context: DiscoveryContext, plugins: Record<string, unknown>) {
  await put(join(context.claudeHome, 'plugins', 'installed_plugins.json'), { version: 2, plugins });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0)
    .map(path => rm(path, { recursive: true, force: true })));
});

describe('Claude extension discovery', () => {
  it('discovers user and selected-project skills without claiming invocation', async () => {
    const context = await fixture();
    const userPath = await put(join(context.claudeHome, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: "변경 사항 검토"\ndisable-model-invocation: true\n---\nInstructions.');
    const projectPath = await put(join(context.project!.path, '.claude', 'skills', 'build', 'SKILL.md'),
      '---\nname: build\ndescription: >-\n  프로젝트를\n  검사합니다.\n---\nInstructions.');

    const result = await discoverClaude(context);
    expect(result.candidates).toHaveLength(2);
    expect(candidate(result.candidates, userPath)).toMatchObject({
      agent: 'claude', kind: 'skill', name: 'review', description: '변경 사항 검토',
      scope: 'user', rootPath: dirname(userPath), status: 'available',
    });
    expect(candidate(result.candidates, projectPath)).toMatchObject({
      name: 'build', description: '프로젝트를 검사합니다.', scope: 'project', status: 'available',
    });
    expect(result.roots).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'claude', path: join(context.claudeHome, 'skills'), scope: 'user', exists: true }),
      expect.objectContaining({ path: join(context.project!.path, '.claude', 'skills'), scope: 'project', exists: true }),
    ]));
  });

  it('keeps path-based identity stable when metadata changes and names collide', async () => {
    const context = await fixture();
    const first = await put(join(context.claudeHome, 'skills', 'one', 'SKILL.md'),
      '---\nname: duplicate\n---\nFirst.');
    const second = await put(join(context.project!.path, '.claude', 'skills', 'two', 'SKILL.md'),
      '---\nname: duplicate\n---\nSecond.');
    const before = await discoverClaude(context);
    await put(first, '---\nname: renamed\ndescription: Updated.\n---\nChanged.');
    const after = await discoverClaude(context);
    expect(candidate(before.candidates, first).key).toBe(candidate(after.candidates, first).key);
    expect(candidate(before.candidates, first).key).not.toBe(candidate(before.candidates, second).key);
  });

  it('reports missing discovery roots without inventing extensions', async () => {
    const context = await fixture(false);
    const result = await discoverClaude(context);
    expect(result.candidates).toEqual([]);
    expect(result.roots).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: join(context.claudeHome, 'skills'), scope: 'user', exists: false }),
    ]));
    expect(result.warnings).toEqual([]);
  });

  it('resolves enabledPlugins per ID with local above project above user settings', async () => {
    const context = await fixture();
    const review = await plugin(context, 'review');
    const unchanged = await plugin(context, 'unchanged');
    const childPath = await put(join(review.root, 'skills', 'inspect', 'SKILL.md'),
      '---\nname: inspect\n---\nInstructions.');
    await registry(context, {
      'review@catalog': [{ scope: 'user', installPath: review.root, version: '1.0.0' }],
      'unchanged@catalog': [{ scope: 'user', installPath: unchanged.root, version: '1.0.0' }],
    });
    await put(join(context.claudeHome, 'settings.json'), {
      enabledPlugins: { 'review@catalog': false, 'unchanged@catalog': true },
      env: { FIXTURE_SECRET: 'fixture-do-not-expose-env' },
      pluginConfigs: { 'review@catalog': { token: 'fixture-do-not-expose-option' } },
    });
    await put(join(context.project!.path, '.claude', 'settings.json'),
      { enabledPlugins: { 'review@catalog': true } });
    const localSettings = join(context.project!.path, '.claude', 'settings.local.json');
    await put(localSettings, { enabledPlugins: { 'review@catalog': false } });

    const disabled = await discoverClaude(context);
    const parent = candidate(disabled.candidates, review.path);
    expect(parent).toMatchObject({ kind: 'plugin', name: 'review', scope: 'user', status: 'disabled', rootPath: review.root });
    expect(candidate(disabled.candidates, childPath)).toMatchObject({
      status: 'disabled', pluginKey: parent.key, pluginName: 'review', rootPath: dirname(childPath),
    });
    expect(candidate(disabled.candidates, unchanged.path).status).toBe('enabled');
    expect(parent.evidence.some(entry => entry.source.includes('settings.local.json'))).toBe(true);
    expect(JSON.stringify(disabled)).not.toContain('fixture-do-not-expose');

    await put(localSettings, {});
    const projectEnabled = await discoverClaude(context);
    expect(candidate(projectEnabled.candidates, review.path).status).toBe('enabled');
    expect(candidate(projectEnabled.candidates, childPath).status).toBe('enabled');
    const userOnly = await discoverClaude({ ...context, project: null });
    expect(candidate(userOnly.candidates, review.path).status).toBe('disabled');
    expect(candidate(userOnly.candidates, review.path).key).toBe(parent.key);
  });

  it('uses v2 projectPath association and never promotes another project installation to user-enabled', async () => {
    const context = await fixture();
    const selected = await plugin(context, 'selected');
    const foreign = await plugin(context, 'foreign');
    const unassociated = await plugin(context, 'unassociated');
    await registry(context, {
      'selected@catalog': [
        { scope: 'project', projectPath: context.project!.path, installPath: selected.root, version: '1.0.0' },
        { scope: 'local', projectPath: context.project!.path, installPath: selected.root, version: '1.0.0' },
      ],
      'foreign@catalog': [{ scope: 'project', projectPath: join(context.homeDir, 'different-project'), installPath: foreign.root }],
      'unassociated@catalog': [{ scope: 'project', installPath: unassociated.root }],
    });
    await put(join(context.claudeHome, 'settings.json'), {
      enabledPlugins: { 'selected@catalog': true, 'foreign@catalog': true, 'unassociated@catalog': true },
    });

    const result = await discoverClaude(context);
    expect(candidate(result.candidates, selected.path)).toMatchObject({ scope: 'project', status: 'enabled' });
    expect(result.candidates.filter(entry => entry.path === selected.path)).toHaveLength(1);
    expect(candidate(result.candidates, foreign.path).status).toBe('cached');
    expect(candidate(result.candidates, unassociated.path).status).toBe('cached');
    const withoutProject = await discoverClaude({ ...context, project: null });
    expect(candidate(withoutProject.candidates, selected.path).status).toBe('cached');
  });

  it('keeps unregistered cache versions cached even when their plugin ID is enabled', async () => {
    const context = await fixture(false);
    const installed = await plugin(context, 'review', '1.0.0');
    const cached = await plugin(context, 'review', '2.0.0');
    const cachedChild = await put(join(cached.root, 'skills', 'inspect', 'SKILL.md'), 'Cached instructions.');
    await registry(context, { 'review@catalog': [{ scope: 'user', installPath: installed.root, version: '1.0.0' }] });
    await put(join(context.claudeHome, 'settings.json'), { enabledPlugins: { 'review@catalog': true } });

    const result = await discoverClaude(context);
    expect(candidate(result.candidates, installed.path)).toMatchObject({ status: 'enabled', version: '1.0.0' });
    expect(candidate(result.candidates, cached.path)).toMatchObject({ status: 'cached', version: '2.0.0' });
    expect(candidate(result.candidates, cachedChild)).toMatchObject({
      status: 'cached', pluginKey: candidate(result.candidates, cached.path).key,
    });
  });

  it('keeps installed activation unknown without a boolean setting and skills available', async () => {
    const context = await fixture(false);
    const installed = await plugin(context, 'review', 'unknown', { defaultEnabled: true });
    const childPath = await put(join(installed.root, 'skills', 'inspect', 'SKILL.md'), 'Instructions.');
    await registry(context, { 'review@catalog': [{ scope: 'user', installPath: installed.root, version: 'unknown' }] });
    await put(join(context.claudeHome, 'settings.json'), { enabledPlugins: { 'review@catalog': 'true' } });
    const result = await discoverClaude(context);
    expect(candidate(result.candidates, installed.path)).toMatchObject({ status: 'unknown', version: 'unknown' });
    expect(candidate(result.candidates, childPath).status).toBe('available');
  });

  it('discovers custom skills and selected legacy commands without duplicate child paths', async () => {
    const context = await fixture(false);
    const installed = await plugin(context, 'toolkit', '1.0.0', {
      skills: ['./.claude/skills/', './skills/'],
      commands: ['./manual/review.md'],
    });
    const base = await put(join(installed.root, 'skills', 'base', 'SKILL.md'), 'Default skill.');
    const custom = await put(join(installed.root, '.claude', 'skills', 'custom', 'SKILL.md'), 'Custom skill.');
    const command = await put(join(installed.root, 'manual', 'review.md'),
      '---\ndescription: 레거시 검토 명령\n---\nInstructions.');
    const excluded = await put(join(installed.root, 'commands', 'not-selected.md'), 'Unselected command.');
    await registry(context, { 'toolkit@catalog': [{ scope: 'user', installPath: installed.root }] });

    const result = await discoverClaude(context);
    const parent = candidate(result.candidates, installed.path);
    const bundled = result.candidates.filter(entry => entry.pluginKey === parent.key);
    expect(bundled.map(entry => entry.path).sort()).toEqual([base, custom, command].sort());
    expect(candidate(result.candidates, command)).toMatchObject({
      kind: 'skill', name: 'review', description: '레거시 검토 명령', rootPath: dirname(command),
    });
    expect(result.candidates.some(entry => entry.path === excluded)).toBe(false);
  });

  it('retains manifestless registry plugins with catalog metadata and unknown activation', async () => {
    const context = await fixture(false);
    const root = join(context.claudeHome, 'plugins', 'cache', 'catalog', 'analyzer', 'unknown');
    await mkdir(root, { recursive: true });
    await registry(context, { 'analyzer@catalog': [{ scope: 'user', installPath: root, version: 'unknown' }] });
    await put(join(context.claudeHome, 'plugins', 'marketplaces', 'catalog', '.claude-plugin', 'marketplace.json'), {
      name: 'catalog',
      plugins: [{ name: 'analyzer', description: '정적 분석 도구', strict: false, lspServers: { analyzer: { command: 'never-run' } } }],
    });
    const result = await discoverClaude(context);
    expect(candidate(result.candidates, join(root, '.claude-plugin', 'plugin.json'))).toMatchObject({
      name: 'analyzer', description: '정적 분석 도구', scope: 'user', status: 'unknown', version: 'unknown',
    });
    expect(JSON.stringify(result)).not.toContain('never-run');
  });

  it('rejects escaping custom component paths and reports malformed metadata without echoing it', async () => {
    const context = await fixture(false);
    const outside = await put(join(context.homeDir, 'outside-components', 'escaped', 'SKILL.md'), 'Outside instructions.');
    const installed = await plugin(context, 'review', '1.0.0', {
      skills: [dirname(dirname(outside)), '../../fixture-secret-path', './safe'],
      commands: ['../../fixture-secret-command.md'],
    });
    const safe = await put(join(installed.root, 'safe', 'ok', 'SKILL.md'), 'Allowed instructions.');
    const broken = await plugin(context, 'broken');
    await put(broken.path, '{"name": "fixture-secret-malformed",');
    await registry(context, {
      'review@catalog': [{ scope: 'user', installPath: installed.root }],
      'broken@catalog': [{ scope: 'user', installPath: broken.root }],
    });
    const result = await discoverClaude(context);
    expect(candidate(result.candidates, safe).name).toBe('ok');
    expect(result.candidates.some(entry => entry.path === outside)).toBe(false);
    expect(candidate(result.candidates, installed.path).warnings?.length).toBeGreaterThan(0);
    expect(candidate(result.candidates, broken.path).warnings?.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });

  it('keeps synced skills and plugins cached with account-independent display names and opaque keys', async () => {
    const context = await fixture(false);
    const bucket = 'private-account-bucket-fixture';
    const syncedSkill = await put(join(context.claudeHome, 'skills', 'synced', bucket, 'review', 'SKILL.md'),
      '---\nname: synced-review\n---\nSynced skill.');
    const unnamed = await put(join(context.claudeHome, 'skills', 'synced', bucket, 'SKILL.md'), 'No declared name.');
    const root = join(context.claudeHome, 'plugins', 'synced', bucket, 'toolkit');
    const manifest = await put(join(root, '.claude-plugin', 'plugin.json'), { name: 'toolkit', version: '2.0.0' });
    const childPath = await put(join(root, 'skills', 'inspect', 'SKILL.md'), 'Synced plugin skill.');
    await put(join(context.claudeHome, 'settings.json'), {
      enabledPlugins: { 'toolkit@catalog': true }, syncClaudeAiSkills: true, syncClaudeAiPlugins: true,
    });
    await put(join(context.claudeHome, 'plugins', 'synced', bucket, 'toolkit.meta.json'), {
      server_plugin_id: 'private-server-id-fixture', installation_preference: 'required', marketplace_name: 'catalog',
    });

    const result = await discoverClaude(context);
    expect(candidate(result.candidates, syncedSkill)).toMatchObject({ name: 'synced-review', status: 'cached', scope: 'user' });
    expect(candidate(result.candidates, unnamed).status).toBe('cached');
    const parent = candidate(result.candidates, manifest);
    expect(parent).toMatchObject({ name: 'toolkit', status: 'cached', scope: 'user', rootPath: root });
    expect(candidate(result.candidates, childPath)).toMatchObject({ status: 'cached', pluginKey: parent.key, pluginName: 'toolkit' });
    expect(JSON.stringify(result.candidates.map(entry => [entry.name, entry.key, entry.evidence]))).not.toContain(bucket);
    expect(JSON.stringify(result)).not.toContain('private-server-id-fixture');
    const again = await discoverClaude(context);
    expect(candidate(again.candidates, manifest).key).toBe(parent.key);
  });

  it('preserves managed installation scope without accepting user enablement as managed-policy evidence', async () => {
    const context = await fixture(false);
    const installed = await plugin(context, 'managed');
    const childPath = await put(join(installed.root, 'skills', 'review', 'SKILL.md'), 'Managed skill.');
    await registry(context, { 'managed@catalog': [{ scope: 'managed', installPath: installed.root }] });
    await put(join(context.claudeHome, 'settings.json'), { enabledPlugins: { 'managed@catalog': true } });
    const result = await discoverClaude(context);
    expect(candidate(result.candidates, installed.path)).toMatchObject({ scope: 'system', status: 'unknown' });
    expect(candidate(result.candidates, childPath)).toMatchObject({ scope: 'system', status: 'unknown' });
  });

  it('discovers standalone legacy commands and applies skill override precedence without disabling plugin children', async () => {
    const context = await fixture();
    const userSkill = await put(join(context.claudeHome, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\n---\nUser skill.');
    const userCommand = await put(join(context.claudeHome, 'commands', 'inspect.md'), 'User command.');
    const projectCommand = await put(join(context.project!.path, '.claude', 'commands', 'check.md'), 'Project command.');
    const installed = await plugin(context, 'toolkit');
    const childPath = await put(join(installed.root, 'skills', 'review', 'SKILL.md'), 'Plugin skill.');
    await registry(context, { 'toolkit@catalog': [{ scope: 'user', installPath: installed.root }] });
    await put(join(context.claudeHome, 'settings.json'), {
      enabledPlugins: { 'toolkit@catalog': true }, skillOverrides: { review: 'on', inspect: 'user-invocable-only' },
    });
    await put(join(context.project!.path, '.claude', 'settings.json'), { skillOverrides: { review: 'off' } });
    const local = join(context.project!.path, '.claude', 'settings.local.json');
    await put(local, { skillOverrides: { review: 'on' } });
    const available = await discoverClaude(context);
    expect(candidate(available.candidates, userSkill).status).toBe('available');
    expect(candidate(available.candidates, userCommand)).toMatchObject({ kind: 'skill', name: 'inspect', scope: 'user', status: 'available' });
    expect(candidate(available.candidates, projectCommand)).toMatchObject({ name: 'check', scope: 'project', status: 'available' });
    await put(local, { skillOverrides: { review: 'off' } });
    const disabled = await discoverClaude(context);
    expect(candidate(disabled.candidates, userSkill).status).toBe('disabled');
    expect(candidate(disabled.candidates, childPath).status).toBe('enabled');
  });

  it('supports root SKILL fallback only when plugin skill directories and selectors are absent', async () => {
    const context = await fixture(false);
    const installed = await plugin(context, 'toolkit');
    const rootSkill = await put(join(installed.root, 'SKILL.md'), 'Root skill.');
    const command = await put(join(installed.root, 'commands', 'nested', 'check.md'), 'Default command.');
    await registry(context, { 'toolkit@catalog': [{ scope: 'user', installPath: installed.root }] });
    const result = await discoverClaude(context);
    const parent = candidate(result.candidates, installed.path);
    expect(candidate(result.candidates, rootSkill)).toMatchObject({ rootPath: installed.root, pluginKey: parent.key });
    expect(candidate(result.candidates, command)).toMatchObject({ name: 'check', pluginKey: parent.key });
    await put(installed.path, { name: 'toolkit', skills: [] });
    const explicitEmpty = await discoverClaude(context);
    expect(explicitEmpty.candidates.some(entry => entry.path === rootSkill)).toBe(false);
  });

  it('links plugins discovered in skill folders without inventing a marketplace installation', async () => {
    const context = await fixture();
    const root = join(context.project!.path, '.claude', 'skills', 'toolkit');
    const manifest = await put(join(root, '.claude-plugin', 'plugin.json'), { name: 'toolkit', skills: './extra' });
    const childPath = await put(join(root, 'extra', 'review', 'SKILL.md'), 'Bundled review.');
    const result = await discoverClaude(context);
    const parent = candidate(result.candidates, manifest);
    expect(parent).toMatchObject({ kind: 'plugin', scope: 'project', rootPath: root, status: 'unknown' });
    expect(candidate(result.candidates, childPath)).toMatchObject({ pluginKey: parent.key, scope: 'project', status: 'available' });
    expect(result.candidates.filter(entry => entry.path === childPath)).toHaveLength(1);
  });

  it('reports an enabled ID without installation evidence without inventing a plugin entry', async () => {
    const context = await fixture(false);
    await put(join(context.claudeHome, 'settings.json'), { enabledPlugins: { 'missing@catalog': true } });
    const result = await discoverClaude(context);
    expect(result.candidates).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('does not mark a lower-scope installed version enabled when the selected project overrides it', async () => {
    const context = await fixture();
    const user = await plugin(context, 'toolkit', '1.0.0');
    const project = await plugin(context, 'toolkit', '2.0.0');
    const userSkill = await put(join(user.root, 'skills', 'inspect', 'SKILL.md'), 'User version.');
    await registry(context, {
      'toolkit@catalog': [
        { scope: 'user', installPath: user.root, version: '1.0.0' },
        { scope: 'project', projectPath: context.project!.path, installPath: project.root, version: '2.0.0' },
      ],
    });
    await put(join(context.claudeHome, 'settings.json'), { enabledPlugins: { 'toolkit@catalog': true } });
    const selected = await discoverClaude(context);
    expect(candidate(selected.candidates, project.path)).toMatchObject({ scope: 'project', status: 'enabled' });
    expect(candidate(selected.candidates, user.path).status).toBe('unknown');
    expect(candidate(selected.candidates, user.path).warnings?.length).toBeGreaterThan(0);
    expect(candidate(selected.candidates, userSkill).status).toBe('unknown');
    const global = await discoverClaude({ ...context, project: null });
    expect(candidate(global.candidates, user.path).status).toBe('enabled');
    expect(candidate(global.candidates, project.path).status).toBe('cached');
  });

  it('redacts credential-shaped values in displayed metadata without exposing skill bodies', async () => {
    const context = await fixture(false);
    await put(join(context.claudeHome, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: \'api_key="fixture-display-secret"\'\n---\nfixture-body-must-not-be-returned');
    await plugin(context, 'toolkit', '1.0.0', { description: 'token="fixture-manifest-secret"' });
    const result = await discoverClaude(context);
    expect(result.candidates).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('fixture-display-secret');
    expect(JSON.stringify(result)).not.toContain('fixture-manifest-secret');
    expect(JSON.stringify(result)).not.toContain('fixture-body-must-not-be-returned');
  });

  it('reports missing declared component paths instead of silently returning an empty plugin', async () => {
    const context = await fixture(false);
    const installed = await plugin(context, 'toolkit', '1.0.0', {
      skills: './missing-skills', commands: './missing-command.md',
    });
    await registry(context, { 'toolkit@catalog': [{ scope: 'user', installPath: installed.root }] });
    const result = await discoverClaude(context);
    expect(result.candidates).toHaveLength(1);
    expect(candidate(result.candidates, installed.path).warnings?.length).toBeGreaterThanOrEqual(2);
  });

  it('retains shadowed standalone files with precedence diagnostics', async () => {
    const context = await fixture();
    const user = await put(join(context.claudeHome, 'skills', 'review', 'SKILL.md'), 'User skill.');
    const project = await put(join(context.project!.path, '.claude', 'skills', 'review', 'SKILL.md'), 'Project skill.');
    const command = await put(join(context.claudeHome, 'commands', 'review.md'), 'Legacy command.');
    const result = await discoverClaude(context);
    expect(result.candidates).toHaveLength(3);
    expect(candidate(result.candidates, user).warnings).toEqual([]);
    expect(candidate(result.candidates, project).warnings?.length).toBeGreaterThan(0);
    expect(candidate(result.candidates, command).warnings?.length).toBeGreaterThan(0);
  });

  it.each([
    ['default skills directory', 'skills', 'directory', 'SKILL.md', {}],
    ['custom skills directory', 'extra', 'directory', 'SKILL.md', { skills: './extra' }],
    ['nested skill entry', 'skills/foreign/SKILL.md', 'file', 'SKILL.md', {}],
    ['default commands directory', 'commands', 'directory', 'inspect.md', {}],
    ['custom commands directory', 'extra', 'directory', 'inspect.md', { commands: './extra' }],
    ['nested command entry', 'commands/nested/inspect.md', 'file', 'inspect.md', {}],
    ['explicit command file', 'extra/inspect.md', 'file', 'inspect.md', { commands: './extra/inspect.md' }],
    ['root skill fallback', 'SKILL.md', 'file', 'SKILL.md', {}],
  ] as const)('excludes %s links into a separately admitted project root', async (_name, location, kind, filename, manifest) => {
    const context = await fixture();
    const installed = await plugin(context, 'toolkit', '1.0.0', manifest);
    const foreign = await put(join(context.project!.path, 'unrelated-files', filename),
      '---\nname: foreign-note\ndescription: cross-owner-metadata-fixture\n---\nUnrelated project content.');
    const linked = join(installed.root, location);
    await mkdir(dirname(linked), { recursive: true });
    await symlink(kind === 'directory' ? dirname(foreign) : foreign, linked, kind === 'directory' ? 'dir' : 'file');
    await registry(context, { 'toolkit@catalog': [{ scope: 'user', installPath: installed.root }] });
    const reader = new ExtensionReader({ roots: [context.claudeHome, context.project!.path] });
    context.io = reader;
    expect(await context.io.exists(foreign)).toBe(true);
    expect(await context.io.exists(linked)).toBe(true);

    const result = await discoverClaude(context);
    const parent = candidate(result.candidates, installed.path);
    expect(result.candidates.filter(entry => entry.pluginKey === parent.key)).toEqual([]);
    expect([...(parent.warnings ?? []), ...reader.warnings].length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('cross-owner-metadata-fixture');
  });

  it('does not read a plugin manifest symlink into another admitted root', async () => {
    const context = await fixture();
    const installed = await plugin(context, 'toolkit');
    const foreign = await put(join(context.project!.path, 'unrelated-files', 'manifest.json'), {
      name: 'foreign-plugin-name', description: 'cross-owner-manifest-fixture',
    });
    await rm(installed.path);
    await symlink(foreign, installed.path, 'file');
    await registry(context, { 'toolkit@catalog': [{ scope: 'user', installPath: installed.root }] });
    context.io = new ExtensionReader({ roots: [context.claudeHome, context.project!.path] });
    expect(await context.io.exists(installed.path)).toBe(true);

    const result = await discoverClaude(context);
    const parent = candidate(result.candidates, installed.path);
    expect(parent.name).toBe('toolkit');
    expect(parent.warnings?.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('cross-owner-manifest-fixture');
  });

  it('retains plugin skill symlinks whose canonical targets remain inside their owner', async () => {
    const context = await fixture(false);
    const installed = await plugin(context, 'toolkit');
    const owned = await put(join(installed.root, 'resources', 'review', 'SKILL.md'),
      '---\nname: owned-review\n---\nOwned skill.');
    await symlink(join(installed.root, 'resources'), join(installed.root, 'skills'), 'dir');
    await registry(context, { 'toolkit@catalog': [{ scope: 'user', installPath: installed.root }] });
    const result = await discoverClaude(context);
    const parent = candidate(result.candidates, installed.path);
    expect(result.candidates.filter(entry => entry.pluginKey === parent.key)).toEqual([
      expect.objectContaining({
        name: 'owned-review', path: join(installed.root, 'skills', 'review', 'SKILL.md'), pluginKey: parent.key,
      }),
    ]);
    expect(parent.warnings).toEqual([]);
    expect(await context.io.exists(owned)).toBe(true);
  });

  it.each([
    ['skill', 'skills/review/SKILL.md'],
    ['command', 'commands/review.md'],
    ['root fallback', 'SKILL.md'],
  ])('rejects a %s entry retargeted after the preliminary containment check', async (_name, location) => {
    const context = await fixture();
    const installed = await plugin(context, 'toolkit');
    const entry = await put(join(installed.root, location), '---\nname: owned-review\n---\nOwned instructions.');
    const foreign = await put(join(context.project!.path, 'unrelated-files', 'review.md'),
      '---\nname: foreign-review\ndescription: retargeted-content-fixture\n---\nUnrelated instructions.');
    await registry(context, { 'toolkit@catalog': [{ scope: 'user', installPath: installed.root }] });
    const reader = new ExtensionReader({ roots: [context.claudeHome, context.project!.path] });
    context.io = reader;
    const originalText = reader.text.bind(reader);
    let retargeted = false;
    // Schedule a real filesystem change at the read boundary, after contains().
    const boundary = vi.spyOn(reader, 'text').mockImplementation(async (path: string, ownerRoot?: string) => {
      if (path === entry && !retargeted) {
        await rm(entry);
        await symlink(foreign, entry, 'file');
        retargeted = true;
      }
      return originalText(path, ownerRoot);
    });

    const result = await discoverClaude(context).finally(() => boundary.mockRestore());
    expect(await readlink(entry)).toBe(foreign);
    expect(candidate(result.candidates, installed.path).name).toBe('toolkit');
    expect(result.candidates.some(item => item.path === entry)).toBe(false);
    expect(JSON.stringify(result)).not.toContain('retargeted-content-fixture');
    expect(reader.warnings.length).toBeGreaterThan(0);
  });

  it.each([
    ['skills', 'skills'],
    ['commands', 'markdown'],
  ] as const)('keeps a retargeted %s walk from exhausting another plugin’s scan budget', async (component, method) => {
    const context = await fixture();
    const first = await plugin(context, 'first');
    const second = await plugin(context, 'second');
    const ownedSkill = await put(join(second.root, 'skills', 'review', 'SKILL.md'), 'Owned skill.');
    const localTarget = join(first.root, 'resources');
    await mkdir(localTarget, { recursive: true });
    const componentRoot = join(first.root, component);
    await symlink(localTarget, componentRoot, 'dir');
    const foreignRoot = join(context.project!.path, 'unrelated-files');
    await Promise.all(Array.from({ length: 64 }, (_, index) =>
      put(join(foreignRoot, `unrelated-${index}.txt`), 'Unrelated file.')));
    await registry(context, {
      'first@catalog': [{ scope: 'user', installPath: first.root }],
      'second@catalog': [{ scope: 'user', installPath: second.root }],
    });
    const reader = new ExtensionReader({
      roots: [context.claudeHome, context.project!.path], maxEntries: 40,
    });
    context.io = reader;
    const originalWalk = reader[method].bind(reader);
    let retargeted = false;
    // Keep the real bounded walker; only control when its symlink target changes.
    const boundary = vi.spyOn(reader, method).mockImplementation(async (path: string, ownerRoot?: string) => {
      if (path === componentRoot && !retargeted) {
        await rm(componentRoot);
        await symlink(foreignRoot, componentRoot, 'dir');
        retargeted = true;
      }
      return originalWalk(path, ownerRoot);
    });

    const result = await discoverClaude(context).finally(() => boundary.mockRestore());
    expect(await readlink(componentRoot)).toBe(foreignRoot);
    expect(candidate(result.candidates, ownedSkill).pluginKey).toBe(candidate(result.candidates, second.path).key);
    expect(reader.warnings.some(warning => warning.includes('파일 수 한도'))).toBe(false);
  });
});
