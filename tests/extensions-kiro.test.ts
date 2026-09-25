import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { discoverKiro } from '../server/extensions/kiro.js';
import { ExtensionReader } from '../server/extensions/io.js';
import type { DiscoveryContext, DiscoveryIO } from '../server/extensions/types.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(homeName = 'home', extraProjectRoots: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-kiro-'));
  temporaryRoots.push(root);
  const home = join(root, homeName);
  const project = join(root, 'project');
  const calls: { operation: string; path: string; ownerRoot?: string }[] = [];
  const allowedRoots = [
    join(home, '.kiro', 'skills'),
    join(home, '.kiro', 'agents'),
    join(home, '.kiro', 'powers'),
    join(project, '.kiro', 'skills'),
    join(project, '.kiro', 'agents'),
    ...extraProjectRoots.map(path => join(project, path)),
  ];
  let reader: ExtensionReader | null = null;

  function inside(parent: string, path: string) {
    const child = relative(parent, path);
    return child === '' || (!child.startsWith('..') && !isAbsolute(child));
  }

  async function read<T>(
    operation: string, path: string, action: (reader: ExtensionReader) => Promise<T>, ownerRoot?: string,
  ) {
    calls.push({ operation, path, ownerRoot });
    expect(isAbsolute(path)).toBe(true);
    expect(allowedRoots.some(parent => inside(parent, path))).toBe(true);
    reader ??= new ExtensionReader({ roots: allowedRoots });
    return action(reader);
  }

  const io: DiscoveryIO = {
    text: (path, ownerRoot) => read('text', path, io => io.text(path, ownerRoot), ownerRoot),
    json: path => read('json', path, io => io.json(path)),
    toml: path => read('toml', path, io => io.toml(path)),
    directories: path => read('directories', path, io => io.directories(path)),
    files: path => read('files', path, io => io.files(path)),
    skills: (path, ownerRoot) => read('skills', path, io => io.skills(path, ownerRoot), ownerRoot),
    markdown: path => read('markdown', path, io => io.markdown(path)),
    exists: path => read('exists', path, io => io.exists(path)),
    contains: (ownerRoot, path) => read('contains', path, io => io.contains(ownerRoot, path), ownerRoot),
  };
  const context: DiscoveryContext = {
    homeDir: home,
    codexHome: join(root, 'unrelated-codex'),
    claudeHome: join(root, 'unrelated-claude'),
    platform: 'linux',
    project: { id: 'fixture-project', name: '테스트 프로젝트', path: project },
    io,
  };
  async function put(path: string, content: string | object) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
    reader = null;
    return path;
  }
  return { root, home, project, context, calls, put, readerWarnings: () => reader?.warnings ?? [] };
}

describe('Kiro extension discovery', () => {
  it('discovers global and project skills with metadata, owning directories and stable path identities', async () => {
    const f = await fixture();
    const global = await f.put(join(f.home, '.kiro/skills/editor/SKILL.md'), [
      '---', 'name: editor', 'description: 한국어 문장을 다듬습니다.', 'metadata:', '  version: "0.1.1"', '---',
      '# 편집', 'Instructions are data, not executable code.',
    ].join('\n'));
    const local = await f.put(join(f.project, '.kiro/skills/build/SKILL.md'),
      '---\nname: build\ndescription: Build this project.\n---\n# Build');

    const result = await discoverKiro(f.context);
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: `kiro:skill:${global}`, agent: 'kiro', kind: 'skill', name: 'editor',
        description: '한국어 문장을 다듬습니다.', version: '0.1.1',
        scope: 'user', path: global, rootPath: dirname(global), status: 'available',
      }),
      expect.objectContaining({
        key: `kiro:skill:${local}`, scope: 'project', path: local, rootPath: dirname(local),
        status: 'available',
      }),
    ]));
    expect(result.candidates).toHaveLength(2);
    expect(result.roots).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: join(f.home, '.kiro/skills'), scope: 'user', exists: true }),
      expect.objectContaining({ path: join(f.project, '.kiro/skills'), scope: 'project', exists: true }),
    ]));

    await f.put(global, '---\nname: renamed\ndescription: Changed metadata.\n---');
    const refreshed = await discoverKiro(f.context);
    expect(refreshed.candidates.find(candidate => candidate.path === global)?.key).toBe(`kiro:skill:${global}`);
    expect(refreshed.candidates.find(candidate => candidate.path === global)?.warnings?.length).toBeGreaterThan(0);
  });

  it('associates exact, home-expanded and project-relative skill resources without claiming activation', async () => {
    const f = await fixture();
    const editor = await f.put(join(f.home, '.kiro/skills/editor/SKILL.md'),
      '---\nname: editor\ndescription: Edit prose.\n---');
    const review = await f.put(join(f.project, '.kiro/skills/team/review/SKILL.md'),
      '---\nname: review\ndescription: Review code.\n---');
    const unrelated = await f.put(join(f.home, '.kiro/skills/unrelated/SKILL.md'),
      '---\nname: unrelated\ndescription: Not a resource.\n---');
    const editorAgent = await f.put(join(f.home, '.kiro/agents/editor.json'), {
      name: '문장 편집',
      resources: ['skill://~/.kiro/skills/editor/SKILL.md'],
      prompt: 'unrelated',
      mcpServers: { ignored: { env: { ACCESS_TOKEN: 'fixture-sensitive-value' } } },
    });
    const projectAgent = await f.put(join(f.project, '.kiro/agents/review.json'), {
      name: 'review-agent',
      resources: [
        'skill://.kiro/skills/**/SKILL.md',
        `skill://${editor}`,
        `file://${unrelated}`,
        { type: 'knowledgeBase', source: `file://${unrelated}` },
      ],
    });

    const result = await discoverKiro(f.context);
    const global = result.candidates.find(candidate => candidate.path === editor);
    const local = result.candidates.find(candidate => candidate.path === review);
    expect(global?.usedBy).toEqual(expect.arrayContaining(['문장 편집', 'review-agent']));
    expect(global?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: editorAgent, detail: expect.stringContaining('skill://') }),
      expect.objectContaining({ source: projectAgent, detail: expect.stringContaining('skill://') }),
    ]));
    expect(local?.usedBy).toEqual(['review-agent']);
    expect(result.candidates.find(candidate => candidate.path === unrelated)?.usedBy ?? []).toEqual([]);
    expect(result.candidates.every(candidate => candidate.status === 'available')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('fixture-sensitive-value');
  });

  it('uses workspace agent overrides and supports nested Markdown agent resources', async () => {
    const f = await fixture();
    const old = await f.put(join(f.home, '.kiro/skills/old/SKILL.md'), '---\nname: old\ndescription: Old.\n---');
    const current = await f.put(join(f.project, '.kiro/skills/current/SKILL.md'),
      '---\nname: current\ndescription: Current.\n---');
    await f.put(join(f.home, '.kiro/agents/reviewer.json'), {
      name: 'reviewer', resources: ['skill://~/.kiro/skills/old/SKILL.md'],
    });
    const override = await f.put(join(f.project, '.kiro/agents/reviewer.md'), [
      '---', 'name: reviewer', 'resources:', '  - skill://.kiro/skills/current/SKILL.md', '---', 'Review.',
    ].join('\n'));
    await f.put(join(f.home, '.kiro/agents/team/planner.md'), [
      '---', 'resources:', '  - skill://~/.kiro/skills/old/SKILL.md', '---', 'Plan.',
    ].join('\n'));

    const result = await discoverKiro(f.context);
    expect(result.candidates.find(candidate => candidate.path === old)?.usedBy).toEqual(['team/planner']);
    expect(result.candidates.find(candidate => candidate.path === current)?.usedBy).toEqual(['reviewer']);
    expect(result.candidates.find(candidate => candidate.path === current)?.evidence)
      .toEqual(expect.arrayContaining([expect.objectContaining({ source: override })]));
  });

  it('keeps IDE Power installation separate from activation and links bundled skills', async () => {
    const f = await fixture();
    const installed = join(f.home, '.kiro/powers/installed');
    const legacy = await f.put(join(installed, 'legacy/POWER.md'), [
      '---', 'name: legacy', 'displayName: Legacy Power', 'description: Legacy guidance.',
      'keywords: [review]', '---', '# Guidance',
    ].join('\n'));
    const manifest = await f.put(join(installed, 'modern/plugin.json'), {
      name: 'modern', version: '1.2.3', description: 'Modern Power',
      author: { name: 'Fixture' }, keywords: ['build'],
    });
    const bundled = await f.put(join(installed, 'modern/skills/setup/SKILL.md'),
      '---\nname: setup\ndescription: Setup guidance.\n---');
    await f.put(join(installed, 'modern/mcp.json'), {
      mcpServers: { sensitive: { env: { TOKEN: 'fixture-mcp-secret' } } },
    });
    const cached = await f.put(join(installed, 'cached/POWER.md'),
      '---\nname: cached\ndescription: Leftover files.\n---');
    const registry = await f.put(join(f.home, '.kiro/powers/registry.json'), {
      version: '1.0.0',
      powers: {
        legacy: { name: 'legacy', installed: true },
        modern: { name: 'modern', installed: true },
        cached: { name: 'cached', installed: false },
        catalogOnly: { name: 'catalog-only', installed: false },
      },
    });

    const result = await discoverKiro(f.context);
    expect(result.candidates.filter(candidate => candidate.kind === 'power')).toHaveLength(3);
    expect(result.candidates.find(candidate => candidate.path === legacy))
      .toMatchObject({ kind: 'power', status: 'unknown', scope: 'user', rootPath: dirname(legacy) });
    expect(result.candidates.find(candidate => candidate.path === manifest)).toMatchObject({
      key: `kiro:power:${manifest}`, name: 'modern', version: '1.2.3', status: 'unknown',
      evidence: expect.arrayContaining([expect.objectContaining({ source: registry })]),
    });
    expect(result.candidates.find(candidate => candidate.path === cached)?.status).toBe('cached');
    expect(result.candidates.find(candidate => candidate.path === bundled)).toMatchObject({
      kind: 'skill', pluginKey: `kiro:power:${manifest}`, pluginName: 'modern',
      rootPath: dirname(bundled), status: 'unknown',
    });
    expect(f.calls.some(call => call.path.endsWith('/mcp.json'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('fixture-mcp-secret');
  });

  it.each(['component root', 'entry'] as const)(
    'rejects Power bundled skill %s symlinks into another admitted root before reading content',
    async linkKind => {
      const f = await fixture('home', ['private-docs']);
      const powerRoot = join(f.home, '.kiro/powers/installed/owned');
      const manifest = await f.put(join(powerRoot, 'plugin.json'), { name: 'owned' });
      const privateRoot = join(f.project, 'private-docs');
      const privateEntry = await f.put(join(privateRoot, 'review/SKILL.md'),
        '---\nname: review\ndescription: Private project fixture.\n---');
      const componentRoot = join(powerRoot, 'skills');
      const entry = join(componentRoot, 'review/SKILL.md');
      if (linkKind === 'component root') {
        await symlink(privateRoot, componentRoot, 'dir');
      } else {
        await mkdir(dirname(entry), { recursive: true });
        await symlink(privateEntry, entry, 'file');
      }

      const result = await discoverKiro(f.context);
      expect(f.calls.filter(call => call.operation === 'text' && call.path === entry)).toHaveLength(0);
      expect(result.candidates.some(candidate => candidate.path === entry)).toBe(false);
      expect(result.candidates.find(candidate => candidate.path === manifest)?.kind).toBe('power');
      expect([...result.warnings, ...f.readerWarnings()].some(warning => warning.includes(componentRoot))).toBe(true);
      if (linkKind === 'component root') {
        expect(f.calls.filter(call => call.operation === 'skills' && call.path === componentRoot)).toHaveLength(0);
      }
    },
  );

  it('keeps Power ownership attached to real-reader traversal and text reads without scoping standalone skills', async () => {
    const f = await fixture();
    const powerRoot = join(f.home, '.kiro/powers/installed/owned');
    await f.put(join(powerRoot, 'plugin.json'), { name: 'owned' });
    const componentRoot = join(powerRoot, 'skills');
    const entry = await f.put(join(componentRoot, 'setup/SKILL.md'),
      '---\nname: setup\ndescription: Owned skill.\n---');
    const standalone = await f.put(join(f.home, '.kiro/skills/standalone/SKILL.md'),
      '---\nname: standalone\ndescription: Standalone skill.\n---');

    const result = await discoverKiro(f.context);
    expect(result.candidates.some(candidate => candidate.path === entry)).toBe(true);
    expect(f.calls.find(call => call.operation === 'skills' && call.path === componentRoot)?.ownerRoot).toBe(powerRoot);
    expect(f.calls.find(call => call.operation === 'text' && call.path === entry)?.ownerRoot).toBe(powerRoot);
    expect(f.calls.find(call => call.operation === 'skills' && call.path === join(f.home, '.kiro/skills'))?.ownerRoot)
      .toBeUndefined();
    expect(f.calls.find(call => call.operation === 'text' && call.path === standalone)?.ownerRoot).toBeUndefined();
  });

  it('does not follow agent references, registry paths or discovery results outside fixed roots', async () => {
    const f = await fixture();
    const safe = await f.put(join(f.home, '.kiro/skills/safe/SKILL.md'),
      '---\nname: safe\ndescription: Safe.\n---');
    const outside = await f.put(join(f.root, 'outside/SKILL.md'),
      '---\nname: outside\ndescription: fixture-outside-secret\n---');
    await f.put(join(f.home, '.kiro/agents/malicious.json'), {
      name: 'malicious',
      resources: [
        `skill://${outside}`, 'skill://../../outside/SKILL.md', 'skill://https://example.invalid/SKILL.md',
        'skill://~/.kiro/skills/%2e%2e/credentials.json',
        'file://~/.kiro/auth.json',
      ],
    });
    await f.put(join(f.home, '.kiro/powers/registry.json'), {
      powers: { external: { installed: true, path: outside, localPath: dirname(outside) } },
    });
    await f.put(join(f.home, '.kiro/agents/credentials.json'), { token: 'fixture-auth-secret' });
    const originalSkills = f.context.io.skills;
    f.context.io.skills = async path => [...await originalSkills(path), outside, resolve(path, '../escape/SKILL.md')];

    const result = await discoverKiro(f.context);
    expect(result.candidates.map(candidate => candidate.path)).toEqual([safe]);
    expect(result.candidates[0].usedBy ?? []).toEqual([]);
    expect(f.calls.some(call => call.path === outside || basename(call.path) === 'credentials.json')).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toMatch(/fixture-(outside|auth)-secret/);
  });

  it('reports malformed metadata without losing readable siblings and handles absent roots', async () => {
    const f = await fixture();
    const empty = await discoverKiro({ ...f.context, project: null, platform: 'darwin' });
    expect(empty.candidates).toEqual([]);
    expect(empty.roots.every(root => root.exists === false && root.scope === 'user')).toBe(true);

    const valid = await f.put(join(f.home, '.kiro/skills/valid/SKILL.md'),
      '---\nname: valid\ndescription: Valid metadata.\n---');
    const broken = await f.put(join(f.home, '.kiro/skills/broken/SKILL.md'),
      '---\nname: [invalid YAML\ndescription: Broken\n---');
    await f.put(join(f.home, '.kiro/agents/broken.json'), '{ invalid JSON');
    await f.put(join(f.home, '.kiro/powers/registry.json'), '{ invalid registry');
    await f.put(join(f.home, '.kiro/powers/installed/broken/plugin.json'), '{ invalid manifest');

    const result = await discoverKiro(f.context);
    expect(result.candidates.find(candidate => candidate.path === valid)?.name).toBe('valid');
    expect(result.candidates.find(candidate => candidate.path === broken)?.warnings?.length).toBeGreaterThan(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.candidates.find(candidate => candidate.kind === 'power')?.status).toBe('unknown');
  });

  it('resolves named skill resources against workspace overrides without including Power skills by name', async () => {
    const f = await fixture();
    const global = await f.put(join(f.home, '.kiro/skills/review/SKILL.md'),
      '---\nname: review\ndescription: Global review.\n---');
    const local = await f.put(join(f.project, '.kiro/skills/review/SKILL.md'),
      '---\nname: review\ndescription: Project review.\n---');
    await f.put(join(f.home, '.kiro/powers/installed/power/plugin.json'), { name: 'power' });
    const bundled = await f.put(join(f.home, '.kiro/powers/installed/power/skills/review/SKILL.md'),
      '---\nname: review\ndescription: Bundled review.\n---');
    const agent = await f.put(join(f.home, '.kiro/agents/named.json'), {
      name: 'named', resources: ['skill://review'],
    });

    const result = await discoverKiro(f.context);
    expect(result.candidates.find(candidate => candidate.path === local)?.usedBy).toEqual(['named']);
    expect(result.candidates.find(candidate => candidate.path === global)?.usedBy ?? []).toEqual([]);
    expect(result.candidates.find(candidate => candidate.path === bundled)?.usedBy ?? []).toEqual([]);
    expect(result.candidates.find(candidate => candidate.path === local)?.evidence)
      .toEqual(expect.arrayContaining([expect.objectContaining({ source: agent, detail: 'resources: skill://review' })]));
  });

  it('never emits parser warnings or returns unrelated tagged metadata values', async () => {
    const f = await fixture();
    const path = await f.put(join(f.home, '.kiro/skills/tagged/SKILL.md'), [
      '---', 'name: tagged', 'description: Tagged metadata.', 'metadata:',
      '  ignored: !private fixture-tagged-sensitive-value', '---',
    ].join('\n'));
    const nodeWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const consoleWarning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await discoverKiro(f.context);
      expect(result.candidates.find(candidate => candidate.path === path)).toBeDefined();
      expect(JSON.stringify(result)).not.toContain('fixture-tagged-sensitive-value');
      expect(nodeWarning.mock.calls.length).toBe(0);
      expect(consoleWarning.mock.calls.length).toBe(0);
    } finally {
      nodeWarning.mockRestore();
      consoleWarning.mockRestore();
    }
  });

  it.each(['skill', 'power'] as const)(
    'rejects aliased %s frontmatter before populating candidate metadata',
    async kind => {
      const f = await fixture();
      const folder = kind === 'skill'
        ? join(f.home, '.kiro/skills/alias')
        : join(f.home, '.kiro/powers/installed/alias');
      const value = 'fixture-kiro-alias-private';
      const entry = await f.put(join(folder, kind === 'skill' ? 'SKILL.md' : 'POWER.md'), [
        '---', `shared: &s ${value}`, 'name: *s', 'description: *s', 'displayName: *s',
        'version: *s', 'env: { PLAIN: *s }', '---', '# Instructions',
      ].join('\n'));
      if (kind === 'power') {
        await f.put(join(folder, 'skills/setup/SKILL.md'),
          '---\nname: setup\ndescription: Owned setup instructions.\n---');
      }

      const result = await discoverKiro(f.context);
      expect(JSON.stringify(result).includes(value)).toBe(false);
      const item = result.candidates.find(candidate => candidate.path === entry);
      expect(item?.name).toBe('alias');
      expect(item?.description).toBeUndefined();
      expect(item?.version).toBeUndefined();
      expect(item?.warnings?.length).toBeGreaterThan(0);
      if (kind === 'power') {
        expect(result.candidates.find(candidate => candidate.pluginKey === item?.key)?.pluginName).toBe('alias');
      }
    },
  );

  it('rejects aliased Markdown agent names before adding resource evidence or usedBy names', async () => {
    const f = await fixture();
    const entry = await f.put(join(f.home, '.kiro/skills/review/SKILL.md'),
      '---\nname: review\ndescription: Review instructions.\n---');
    const value = 'fixture-kiro-agent-alias-private';
    const agent = await f.put(join(f.home, '.kiro/agents/alias.md'), [
      '---', `shared: &s ${value}`, 'name: *s', 'description: *s', 'env: { PLAIN: *s }',
      'resources:', '  - skill://~/.kiro/skills/review/SKILL.md', '---', 'Review the project.',
    ].join('\n'));
    await f.put(join(f.home, '.kiro/agents/valid.md'), [
      '---', 'name: valid-agent', 'resources:', '  - skill://~/.kiro/skills/review/SKILL.md',
      '---', 'Review the project.',
    ].join('\n'));

    const result = await discoverKiro(f.context);
    expect(JSON.stringify(result).includes(value)).toBe(false);
    const item = result.candidates.find(candidate => candidate.path === entry);
    expect(item?.usedBy).toEqual(['valid-agent']);
    expect(item?.evidence.some(evidence => evidence.source === agent)).toBe(false);
    expect(result.warnings.some(warning => warning.includes(agent))).toBe(true);
  });

  it.each([
    ['depth', `nested: ${'['.repeat(40)}0${']'.repeat(40)}`],
    ['UTF-8 bytes', `padding: "${'한'.repeat(23_000)}"`],
    ['node count', `steps: [${Array.from({ length: 10_001 }, () => '0').join(',')}]`],
  ])('rejects frontmatter exceeding the shared YAML %s limit without retaining parsed fields', async (_limit, source) => {
    const f = await fixture();
    const entry = await f.put(join(f.home, '.kiro/skills/bounded/SKILL.md'), [
      '---', 'name: declared', 'description: Over-limit metadata.', source, '---', '# Instructions',
    ].join('\n'));

    const result = await discoverKiro(f.context);
    const item = result.candidates.find(candidate => candidate.path === entry);
    expect(item?.name).toBe('bounded');
    expect(item?.description).toBeUndefined();
    expect(item?.warnings?.length).toBeGreaterThan(0);
  });

  it('bounds the total inventory across multiple Power packages and reports omitted entries', async () => {
    const f = await fixture();
    for (const power of ['first', 'second', 'third']) {
      const directory = join(f.home, '.kiro/powers/installed', power);
      await f.put(join(directory, 'plugin.json'), { name: power });
      await Promise.all(Array.from({ length: 175 }, (_, index) => f.put(
        join(directory, 'skills', `skill-${index}`, 'SKILL.md'),
        `---\nname: skill-${index}\ndescription: Bounded fixture.\n---`,
      )));
    }

    const result = await discoverKiro(f.context);
    expect(result.candidates.length).toBeLessThanOrEqual(512);
    expect(result.warnings.some(warning => warning.includes('제한'))).toBe(true);
    expect(f.calls.filter(call => call.operation === 'text' && basename(call.path) === 'SKILL.md').length)
      .toBeLessThanOrEqual(512);
  });

  it('bounds resource matching across agents instead of only limiting each individual configuration', async () => {
    const f = await fixture();
    const path = await f.put(join(f.home, '.kiro/skills/target/SKILL.md'),
      '---\nname: target\ndescription: Bounded matching.\n---');
    for (let agent = 0; agent < 9; agent++) {
      const resources = Array.from({ length: 256 }, (_, index) =>
        `skill://~/.kiro/skills/missing-${agent}-${index}/SKILL.md`);
      if (agent === 8) resources[0] = 'skill://~/.kiro/skills/target/SKILL.md';
      await f.put(join(f.home, `.kiro/agents/agent-${agent}.json`), { name: `agent-${agent}`, resources });
    }

    const result = await discoverKiro(f.context);
    expect(result.candidates.find(candidate => candidate.path === path)?.usedBy ?? []).toEqual([]);
    expect(result.warnings.some(warning => warning.includes('제한'))).toBe(true);
  });

  it('deduplicates normalized absolute entry paths so aliases cannot create different identities', async () => {
    const f = await fixture();
    const path = await f.put(join(f.home, '.kiro/skills/normalized/SKILL.md'),
      '---\nname: normalized\ndescription: One file.\n---');
    const original = f.context.io.skills;
    f.context.io.skills = async root => {
      const entries = await original(root);
      return entries.flatMap(entry => [entry, `${dirname(entry)}/./SKILL.md`]);
    };

    const result = await discoverKiro(f.context);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      key: `kiro:skill:${path}`, path, rootPath: dirname(path),
    });
  });

  it('reports unresolved configured skills without inventing candidates or usage', async () => {
    const f = await fixture();
    await f.put(join(f.home, '.kiro/skills/present/SKILL.md'),
      '---\nname: present\ndescription: Available file.\n---');
    const agent = await f.put(join(f.home, '.kiro/agents/missing-resource.json'), {
      name: 'missing-resource', resources: ['skill://~/.kiro/skills/removed/SKILL.md'],
    });

    const result = await discoverKiro(f.context);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].usedBy ?? []).toEqual([]);
    expect(result.warnings.some(warning => warning.includes(agent))).toBe(true);
  });

  it('skips credential filename variants without treating the account directory name as a credential', async () => {
    const f = await fixture('auth-user');
    const path = await f.put(join(f.home, '.kiro/skills/visible/SKILL.md'),
      '---\nname: visible\ndescription: Visible metadata.\n---');
    const blocked = ['auth-token.json', 'credentials.local.json', 'oauth.json', 'private-key.json'];
    for (const filename of blocked) {
      await f.put(join(f.home, '.kiro/agents', filename), { token: 'fixture-unread-value' });
    }
    await f.put(join(f.home, '.kiro/agents/visible.json'), {
      name: 'visible-agent', resources: [`skill://${path}`],
    });

    const result = await discoverKiro(f.context);
    expect(result.candidates.find(candidate => candidate.path === path)?.usedBy).toEqual(['visible-agent']);
    expect(f.calls.filter(call => ['text', 'json'].includes(call.operation) && blocked.includes(basename(call.path))).length).toBe(0);
    expect(JSON.stringify(result)).not.toContain('fixture-unread-value');
  });
});
