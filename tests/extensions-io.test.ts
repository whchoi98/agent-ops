import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtensionReader } from '../server/extensions/io.js';

const temporary: string[] = [];
async function tree() {
  const base = await mkdtemp(join(tmpdir(), 'agent-ops-extension-io-'));
  temporary.push(base);
  const root = join(base, 'skills');
  await mkdir(root);
  return { base, root };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('bounded extension files', () => {
  it('reads ordinary UTF-8 instructions and parses JSON/TOML without evaluating content', async () => {
    const { root } = await tree();
    await writeFile(join(root, 'SKILL.md'), '한글 검토 지침\n`echo never-execute`');
    await writeFile(join(root, 'plugin.json'), '{"name":"sample","enabled":false}');
    await writeFile(join(root, 'config.toml'), '[plugins."sample@team"]\nenabled = false');
    const io = new ExtensionReader({ roots: [root] });
    expect(await io.text(join(root, 'SKILL.md'))).toContain('한글 검토');
    expect(await io.json(join(root, 'plugin.json'))).toEqual({ name: 'sample', enabled: false });
    expect(await io.toml(join(root, 'config.toml'))).toEqual({ plugins: { 'sample@team': { enabled: false } } });
    expect(await io.text(join(root, 'absent.md'))).toBeNull();
  });

  it('rejects unapproved paths and outside symlinks while permitting an in-root link', async () => {
    const { base, root } = await tree();
    const outside = join(base, 'outside.md');
    await writeFile(outside, 'unapproved fixture');
    await writeFile(join(root, 'real.md'), 'approved fixture');
    await symlink(outside, join(root, 'escape.md'));
    await symlink(join(root, 'real.md'), join(root, 'linked.md'));
    const io = new ExtensionReader({ roots: [root] });
    expect(await io.text(outside)).toBeNull();
    expect(await io.text(join(root, '../outside.md'))).toBeNull();
    expect(await io.text(join(root, 'escape.md'))).toBeNull();
    expect(await io.text(join(root, 'linked.md'))).toBe('approved fixture');
    expect(io.warnings.length).toBeGreaterThan(0);
  });

  it('enforces the owning root even when a symlink target is another approved root', async () => {
    const { base, root } = await tree();
    const other = join(base, 'project');
    await mkdir(other);
    await writeFile(join(other, 'SKILL.md'), 'other project fixture');
    await symlink(other, join(root, 'linked'));
    const io = new ExtensionReader({ roots: [root, other] });
    expect(await io.text(join(root, 'linked/SKILL.md'))).toBe('other project fixture');
    expect(await io.contains(root, join(root, 'linked/SKILL.md'))).toBe(false);
    expect(await io.contains(other, join(other, 'SKILL.md'))).toBe(true);
  });

  it('never previews credential stores, private keys, databases or binary content', async () => {
    const { root } = await tree();
    const io = new ExtensionReader({ roots: [root] });
    for (const name of ['.env', '.env.local', 'auth.json', 'credentials.json', 'id_rsa', 'secret.pem', 'history.sqlite']) {
      await writeFile(join(root, name), 'fixture-only');
      expect(await io.text(join(root, name))).toBeNull();
    }
    await writeFile(join(root, 'binary.md'), Buffer.from([1, 0, 2, 0, 3]));
    expect(await io.text(join(root, 'binary.md'))).toBeNull();
  });

  it('reports truncation and rejects oversized structured configuration', async () => {
    const { root } = await tree();
    await writeFile(join(root, 'SKILL.md'), 'a'.repeat(200));
    await writeFile(join(root, 'plugin.json'), JSON.stringify({ name: 'x'.repeat(200) }));
    const io = new ExtensionReader({ roots: [root], maxBytes: 64 });
    const text = await io.readText(join(root, 'SKILL.md'));
    expect(text?.text).toHaveLength(64);
    expect(text?.truncated).toBe(true);
    expect(text?.bytes).toBe(200);
    expect(await io.json(join(root, 'plugin.json'))).toBeNull();
  });

  it('reports malformed metadata without copying its sensitive values into diagnostics', async () => {
    const { root } = await tree();
    await writeFile(join(root, 'plugin.json'), '{"password":"fixture-secret", broken');
    await writeFile(join(root, 'config.toml'), 'token = "fixture-token\n[broken');
    const io = new ExtensionReader({ roots: [root] });
    expect(await io.json(join(root, 'plugin.json'))).toBeNull();
    expect(await io.toml(join(root, 'config.toml'))).toBeNull();
    expect(io.warnings.length).toBeGreaterThan(0);
    expect(io.warnings.join(' ')).not.toMatch(/fixture-secret|fixture-token/);
  });

  it('finds skills with cycle detection and excludes dependency/credential directories', async () => {
    const { root } = await tree();
    await mkdir(join(root, 'review'));
    await writeFile(join(root, 'review/SKILL.md'), 'review');
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules/SKILL.md'), 'not a skill');
    await mkdir(join(root, '.ssh'));
    await writeFile(join(root, '.ssh/SKILL.md'), 'not a skill');
    await symlink(root, join(root, 'review/loop'));
    const io = new ExtensionReader({ roots: [root] });
    expect(await io.skills(root)).toEqual([join(root, 'review/SKILL.md')]);
  });

  it('bounds traversal depth and count and reports omitted entries', async () => {
    const { root } = await tree();
    await mkdir(join(root, 'one/two/three'), { recursive: true });
    await writeFile(join(root, 'one/two/three/SKILL.md'), 'too deep');
    for (let i = 0; i < 20; i++) await writeFile(join(root, `file-${i}.md`), 'fixture');
    const io = new ExtensionReader({ roots: [root], maxDepth: 1, maxEntries: 8 });
    expect((await io.markdown(root)).length).toBeLessThanOrEqual(8);
    expect(io.warnings.length).toBeGreaterThan(0);
  });
});
