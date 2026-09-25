import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtensionReader } from '../server/extensions/io.js';
import { discoverCodex } from '../server/extensions/codex.js';
import type { DiscoveryContext } from '../server/extensions/types.js';

const dirs: string[] = [];
async function setup() {
  const homeDir = await mkdtemp(join(tmpdir(), 'agent-ops-codex-extensions-'));
  dirs.push(homeDir);
  const project = { id: 'project-one', name: 'Example', path: join(homeDir, 'work/project') };
  const codexHome = join(homeDir, '.codex');
  const claudeHome = join(homeDir, '.claude');
  for (const path of [codexHome, claudeHome, join(homeDir, '.agents'), project.path]) await mkdir(path, { recursive: true });
  async function put(path: string, value: string | object) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  }
  const context = (): DiscoveryContext => ({
    homeDir, codexHome, claudeHome, project, platform: 'linux',
    io: new ExtensionReader({ roots: [codexHome, claudeHome, join(homeDir, '.agents'), project.path] }),
  });
  return { homeDir, codexHome, project, put, context };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('Codex extension discovery', () => {
  it('finds user, shared and bundled system skills and honors file/directory overrides', async () => {
    const { homeDir, codexHome, put, context } = await setup();
    const review = join(codexHome, 'skills/review/SKILL.md');
    const shared = join(homeDir, '.agents/skills/shared/SKILL.md');
    await put(review, '---\nname: review\ndescription: Review code.\n---');
    await put(shared, '# Shared skill');
    await put(join(codexHome, 'skills/.system/creator/SKILL.md'), '# System');
    await put(join(codexHome, 'config.toml'), `[[skills.config]]\npath = ${JSON.stringify(review)}\nenabled = false\n[[skills.config]]\npath = ${JSON.stringify(dirname(shared))}\nenabled = false`);
    const found = (await discoverCodex(context())).candidates;
    expect(found.find(item => item.path === review)?.status).toBe('disabled');
    expect(found.find(item => item.path === shared)?.status).toBe('disabled');
    expect(found.find(item => item.name === 'creator')?.scope).toBe('system');
  });

  it('links cached plugin skills to a single explicitly configured plugin version', async () => {
    const { codexHome, put, context } = await setup();
    const root = join(codexHome, 'plugins/cache/team/review-kit/1.2.0');
    await put(join(root, '.codex-plugin/plugin.json'), { name: 'review-kit', version: '1.2.0', skills: './custom/' });
    await put(join(root, 'custom/check/SKILL.md'), '---\nname: check\ndescription: Check code.\n---');
    await put(join(codexHome, 'config.toml'), '[plugins."review-kit@team"]\nenabled = true');
    const items = (await discoverCodex(context())).candidates;
    const plugin = items.find(item => item.kind === 'plugin')!;
    const skill = items.find(item => item.kind === 'skill')!;
    expect(plugin.status).toBe('enabled');
    expect(plugin.version).toBe('1.2.0');
    expect(skill.pluginKey).toBe(plugin.key);
    expect(skill.status).toBe('enabled');
    expect(skill.path).toBe(join(root, 'custom/check/SKILL.md'));
    expect(plugin.evidence.some(item => item.source.endsWith('config.toml'))).toBe(true);
  });

  it('applies a project override only with explicit project trust', async () => {
    const { codexHome, project, put, context } = await setup();
    const root = join(codexHome, 'plugins/cache/team/sample/1.0.0');
    await put(join(root, '.codex-plugin/plugin.json'), { name: 'sample' });
    await put(join(project.path, '.codex/config.toml'), '[plugins."sample@team"]\nenabled = false');
    await put(join(codexHome, 'config.toml'), '[plugins."sample@team"]\nenabled = true');
    expect((await discoverCodex(context())).candidates.find(item => item.kind === 'plugin')?.status).toBe('enabled');
    await put(join(codexHome, 'config.toml'), `[plugins."sample@team"]\nenabled = true\n[projects.${JSON.stringify(project.path)}]\ntrust_level = "trusted"`);
    const result = await discoverCodex(context());
    expect(result.candidates.find(item => item.kind === 'plugin')?.status).toBe('disabled');
    expect(result.candidates.find(item => item.kind === 'plugin')?.evidence.at(-1)?.source).toBe(join(project.path, '.codex/config.toml'));
  });

  it('does not choose an active version from multiple cached copies', async () => {
    const { codexHome, put, context } = await setup();
    for (const version of ['1.0.0', '2.0.0']) {
      await put(join(codexHome, `plugins/cache/team/sample/${version}/.codex-plugin/plugin.json`), { name: 'sample', version });
    }
    await put(join(codexHome, 'config.toml'), '[plugins."sample@team"]\nenabled = true');
    const items = (await discoverCodex(context())).candidates.filter(item => item.kind === 'plugin');
    expect(items).toHaveLength(2);
    expect(items.every(item => item.status === 'unknown')).toBe(true);
    expect(items.every(item => /버전/.test(item.statusReason))).toBe(true);
  });

  it('marks unconfigured cache entries as cached and records missing configured plugins', async () => {
    const { codexHome, put, context } = await setup();
    await put(join(codexHome, 'plugins/cache/team/cached/1/.codex-plugin/plugin.json'), { name: 'cached' });
    await put(join(codexHome, 'config.toml'), '[plugins."missing@team"]\nenabled = true');
    const items = (await discoverCodex(context())).candidates;
    expect(items.find(item => item.name === 'cached')?.status).toBe('cached');
    expect(items.find(item => item.name === 'missing')?.status).toBe('unknown');
  });

  it('rejects manifest component paths outside the owning plugin', async () => {
    const { codexHome, put, context } = await setup();
    const root = join(codexHome, 'plugins/cache/team/sample/1');
    await put(join(root, '.codex-plugin/plugin.json'), { name: 'sample', skills: '../../outside' });
    await put(join(root, '../../outside/SKILL.md'), '# Escaped');
    const result = await discoverCodex(context());
    expect(result.candidates.filter(item => item.kind === 'skill')).toHaveLength(0);
    expect(result.warnings.some(item => /범위/.test(item))).toBe(true);
  });

  it('does not promote a plugin child linked into another admitted project root', async () => {
    const { codexHome, project, put, context } = await setup();
    const root = join(codexHome, 'plugins/cache/team/sample/1');
    await put(join(root, '.codex-plugin/plugin.json'), { name: 'sample', skills: './linked' });
    await put(join(project.path, 'private-docs/SKILL.md'), '---\nname: private-definition\ndescription: Not owned by this plugin.\n---');
    await symlink(join(project.path, 'private-docs'), join(root, 'linked'));
    const result = await discoverCodex(context());
    expect(result.candidates.filter(item => item.kind === 'skill')).toHaveLength(0);
    expect(result.warnings.some(item => /범위/.test(item))).toBe(true);
  });

  it('does not read a plugin manifest linked outside the package in an admitted root', async () => {
    const { codexHome, put, context } = await setup();
    const root = join(codexHome, 'plugins/cache/team/sample/1');
    await put(join(codexHome, 'unrelated.json'), { name: 'private-manifest-name', description: 'private manifest description' });
    await mkdir(join(root, '.codex-plugin'), { recursive: true });
    await symlink(join(codexHome, 'unrelated.json'), join(root, '.codex-plugin/plugin.json'));
    const result = await discoverCodex(context());
    expect(JSON.stringify(result).includes('private-manifest-name')).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
