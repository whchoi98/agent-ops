import { link, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessClient, HarnessHookRequest, HarnessRuntime } from '../shared/harness.js';
import type { Project } from '../shared/types.js';
import { HarnessHookManager } from '../server/harness/hooks.js';
import { harnessPaths, type HarnessResolvedPolicy } from '../server/harness/types.js';

// Keep real filesystem behavior; individual tests inject one I/O failure at an
// actual transaction boundary. No generated hook or native client is executed.
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));

let root: string;
let dataDir: string;
let homeDir: string;
let bridgePath: string;
let project: Project;
let runtime: HarnessRuntime;
let policy: HarnessResolvedPolicy;
let manager: HarnessHookManager;
const versions = { 'claude-code': '2.1.200', codex: '0.120.0', 'kiro-ide': '1.0.0', 'kiro-cli': '3.0.0' };

async function put(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
async function json(path: string) { return JSON.parse(await readFile(path, 'utf8')); }
function target(client: HarnessClient) {
  if (client === 'claude-code') return join(project.path, '.claude', 'settings.local.json');
  if (client === 'codex') return join(project.path, '.codex', 'hooks.json');
  return join(project.path, '.kiro', 'hooks', 'agent-ops-autoharness.json');
}
function bindingPath(client: HarnessClient) {
  return join(harnessPaths(dataDir, project.id).bindingsDir, `${client.startsWith('kiro-') ? 'kiro' : client}.json`);
}
function request(client: HarnessClient, action: 'install' | 'remove' = 'install'): HarnessHookRequest {
  return {
    projectId: project.id, client, action,
    ...(action === 'install' ? { policyId: policy.detail.id, revision: policy.detail.revision } : {}),
  };
}
async function install(client: HarnessClient) {
  const preview = await manager.preview(request(client), project, policy, runtime);
  expect(preview.canApply).toBe(true);
  return manager.apply(preview.id, project, runtime);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-ops-harness-hooks-'));
  dataDir = join(root, 'app data');
  homeDir = join(root, 'home');
  bridgePath = join(root, 'app code', 'bridge.py');
  project = {
    id: 'registered-project', name: 'Synthetic project', path: join(root, 'project'),
    executionEnabled: true, color: '#000000', createdAt: '2026-09-26T00:00:00.000Z',
  };
  runtime = {
    state: 'ready', pythonPath: join(root, 'python bin', 'python3'), pythonVersion: '3.11.9',
    engineVersion: '0.1.1', testedVersion: '0.1.1', checkedAt: '2026-09-26T00:00:00.000Z', error: null,
  };
  policy = {
    detail: {
      id: 'builtin-policy', name: 'Default', scope: 'builtin', projectId: null, path: null,
      revision: 'revision-one', bytes: 25, valid: true, mode: 'standard', ruleCount: 0,
      editable: false, redacted: false, warnings: [], content: 'mode: standard\nrules: []\n', rules: [],
    },
    content: 'mode: standard\nrules: []\n', config: { mode: 'standard', rules: [] },
  };
  await Promise.all([
    mkdir(project.path, { recursive: true }), mkdir(homeDir, { recursive: true }),
    put(bridgePath, '# synthetic bridge; never executed\n'),
    put(runtime.pythonPath!, '# synthetic interpreter; never executed\n'),
  ]);
  manager = new HarnessHookManager({ dataDir, homeDir, bridgePath });
  await manager.list(project, versions);
});

afterEach(async () => {
  manager?.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('project-scoped native hook configuration', () => {
  it.each([
    ['claude-code', ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']],
    ['codex', ['PreToolUse', 'PostToolUse']],
  ] as const)('writes official %s matcher groups and an immutable binding', async (client, events) => {
    const existing = {
      env: { PRIVATE_TOKEN: 'do-not-return-this-value' },
      permissions: { allow: ['Read'] },
      hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'user-check' }] }] },
    };
    await put(target(client), existing);
    const preview = await manager.preview(request(client), project, policy, runtime);
    expect(preview.files.every(file => file.before === '[redacted]' && file.after === '[redacted]')).toBe(true);
    expect(JSON.stringify(preview)).not.toContain('do-not-return-this-value');
    expect(JSON.stringify(preview)).not.toContain('user-check');
    expect(await json(target(client))).toEqual(existing);
    await expect(readFile(bindingPath(client))).rejects.toMatchObject({ code: 'ENOENT' });

    const result = await manager.apply(preview.id, project, runtime);
    const config = await json(target(client));
    expect(config.env).toEqual(existing.env);
    expect(config.permissions).toEqual(existing.permissions);
    expect(config.hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0]);
    expect(Object.keys(config.hooks)).toEqual(events);
    for (const event of events) {
      expect(config.hooks[event].at(-1)).toEqual({
        matcher: '.*',
        hooks: [{
          type: 'command',
          command: `'${runtime.pythonPath}' -I '${bridgePath}' --binding '${bindingPath(client)}' --event ${event}${event === 'PreToolUse' ? ' || exit 2' : ''}`,
          timeout: 15,
        }],
      });
    }
    expect(await json(bindingPath(client))).toEqual({
      protocol: 1, client, projectId: project.id, projectDir: project.path,
      policyId: policy.detail.id, policyRevision: policy.detail.revision, policy: policy.config,
      pythonPath: runtime.pythonPath, engineVersion: '0.1.1', createdAt: expect.any(String),
    });
    expect(result).toMatchObject({
      client, projectId: project.id, scope: 'project', managed: true,
      state: client === 'codex' ? 'needs-review' : 'configured',
      policyRevision: policy.detail.revision, lastObservedAt: null,
    });
    if (client === 'codex') {
      expect(result.notices.join(' ')).toMatch(/\/hooks/);
      expect(JSON.stringify(config)).not.toContain('bypass');
    }
  });

  it.each(['kiro-ide', 'kiro-cli'] as const)('writes the official v1 %s array with one shared Kiro binding', async client => {
    const userHook = {
      name: 'User lint', trigger: 'PostFileSave', matcher: '\\.ts$',
      action: { type: 'command', command: 'user-lint' }, timeout: 45, enabled: true,
    };
    await put(target(client), { version: 'v1', hooks: [userHook], description: 'Keep me' });
    await install(client);
    const config = await json(target(client));
    expect(config.version).toBe('v1');
    expect(config.description).toBe('Keep me');
    expect(config.hooks).toHaveLength(3);
    expect(config.hooks[0]).toEqual(userHook);
    expect(config.hooks.slice(1)).toEqual(['PreToolUse', 'PostToolUse'].map(event => ({
      name: `agent-ops AutoHarness ${event}`, trigger: event, matcher: '.*',
      action: {
        type: 'command',
        command: `'${runtime.pythonPath}' -I '${bridgePath}' --binding '${bindingPath(client)}' --event ${event}${event === 'PreToolUse' ? ' || exit 2' : ''}`,
      },
      timeout: 15,
    })));
    const other = client === 'kiro-ide' ? 'kiro-cli' : 'kiro-ide';
    const otherRow = (await manager.list(project, versions)).find(row => row.client === other)!;
    expect(otherRow.managed).toBe(true);
    expect(otherRow.state).toBe('configured');
    expect(otherRow.notices.join(' ')).toMatch(/shared.*Kiro|Kiro.*shared/i);
    expect(await json(bindingPath(client))).toMatchObject({ client: 'kiro' });
    const shared = await manager.preview(request(other), project, policy, runtime);
    expect(shared.canApply).toBe(true);
    expect(shared.notices.join(' ')).toMatch(/both|IDE.*CLI/);
    await manager.apply(shared.id, project, runtime);
    expect(await json(target(client))).toEqual(config);
    expect((await readdir(harnessPaths(dataDir, project.id).bindingsDir)).filter(file => /kiro.*\.json$/.test(file)))
      .not.toContain(`${client}.json`);
    const removal = await manager.preview(request(other, 'remove'), project, null, runtime);
    expect(removal.notices.join(' ')).toMatch(/both|IDE.*CLI/);
    await manager.apply(removal.id, project, runtime);
    expect(await json(target(client))).toEqual({ version: 'v1', hooks: [userHook], description: 'Keep me' });
    expect((await manager.list(project, versions)).filter(row => row.client.startsWith('kiro-')).every(row => !row.managed)).toBe(true);
  });

  it.each(['claude-code', 'codex', 'kiro-ide', 'kiro-cli'] as const)('does not duplicate an existing %s installation', async client => {
    await install(client);
    const original = await readFile(target(client), 'utf8');
    const binding = await readFile(bindingPath(client), 'utf8');
    await install(client);
    expect(await readFile(target(client), 'utf8')).toBe(original);
    expect(await readFile(bindingPath(client), 'utf8')).toBe(binding);
  });

  it('removes only the bound client command and preserves arbitrary user hooks and app data', async () => {
    const existing = {
      env: { secret: 'keep' },
      hooks: {
        PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'autoharness-user-owned' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'user-stop' }] }],
      },
    };
    await put(target('claude-code'), existing);
    await install('claude-code');
    const paths = harnessPaths(dataDir, project.id);
    await put(paths.policyPath, 'immutable policy');
    await put(paths.auditPath, 'immutable audit\n');
    const remove = await manager.preview(request('claude-code', 'remove'), project, null, runtime);
    const result = await manager.apply(remove.id, project, runtime);
    expect(await json(target('claude-code'))).toEqual(existing);
    await expect(readFile(bindingPath('claude-code'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(paths.policyPath, 'utf8')).toBe('immutable policy');
    expect(await readFile(paths.auditPath, 'utf8')).toBe('immutable audit\n');
    expect(result.managed).toBe(false);
  });

  it('does not claim or remove an outside AutoHarness declaration', async () => {
    const path = join(homeDir, '.claude', 'settings.json');
    const external = {
      hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'python3 -m autoharness.hooks' }] }] },
    };
    await put(path, external);
    const row = (await manager.list(project, versions)).find(row => row.client === 'claude-code')!;
    expect(row).toMatchObject({ path, managed: false, scope: 'user', lastObservedAt: null });
    expect(row.notices.join(' ')).toMatch(/outside|not managed|read.only/i);
    const preview = await manager.preview(request('claude-code', 'remove'), project, null, runtime);
    expect(preview.canApply).toBe(false);
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow();
    expect(await json(path)).toEqual(external);
  });

  it('does not add a shared Kiro hook beside an unowned per-client bridge declaration', async () => {
    const legacyPath = join(harnessPaths(dataDir, project.id).bindingsDir, 'kiro-ide.json');
    const external = {
      version: 'v1',
      hooks: [{
        name: 'Previous AutoHarness integration', trigger: 'PreToolUse',
        action: { type: 'command', command: `'${runtime.pythonPath}' -I '${bridgePath}' --binding '${legacyPath}' --event PreToolUse` },
      }],
    };
    await put(target('kiro-cli'), external);
    const row = (await manager.list(project, versions)).find(item => item.client === 'kiro-cli')!;
    expect(row.managed).toBe(false);
    const preview = await manager.preview(request('kiro-cli'), project, policy, runtime);
    expect(preview.canApply).toBe(false);
    expect(preview.notices.join(' ')).toMatch(/conflict|existing.*binding/i);
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow();
    expect(await json(target('kiro-cli'))).toEqual(external);
    await expect(readFile(bindingPath('kiro-cli'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('inventories all configured user homes without implying project ownership or event observation', async () => {
    manager.close();
    const claudeHome = join(root, 'custom-claude');
    const codexHome = join(root, 'custom-codex');
    const kiroHome = join(root, 'custom-kiro');
    await put(join(claudeHome, 'settings.local.json'), {
      hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'autoharness-claude' }] }] },
    });
    await put(join(codexHome, 'config.toml'),
      '[[hooks.PreToolUse]]\nmatcher = ".*"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "autoharness-codex"\n');
    await put(join(kiroHome, 'hooks', 'external.json'), {
      version: 'v1', hooks: [{ name: 'External', trigger: 'PreToolUse', action: { type: 'command', command: 'autoharness-kiro' } }],
    });
    manager = new HarnessHookManager({ dataDir, homeDir, claudeHome, codexHome, kiroHome, bridgePath });
    const rows = await manager.list(null, versions);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).toMatchObject({ managed: false, scope: 'user', projectId: null, lastObservedAt: null });
    expect(rows.find(row => row.client === 'claude-code')!.path).toBe(join(claudeHome, 'settings.local.json'));
    expect(rows.find(row => row.client === 'codex')!.path).toBe(join(codexHome, 'config.toml'));
    expect(rows.filter(row => row.client.startsWith('kiro-')).map(row => row.path))
      .toEqual([join(kiroHome, 'hooks', 'external.json'), join(kiroHome, 'hooks', 'external.json')]);
    await expect(readdir(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves unrelated handlers merged into an owned matcher group during removal', async () => {
    await install('claude-code');
    const config = await json(target('claude-code'));
    const userHook = { type: 'command', command: 'user-owned-command-with-autoharness-in-name', timeout: 60 };
    config.hooks.PreToolUse[0].hooks.push(userHook);
    config.hooks.PreToolUse[0].description = 'User metadata';
    await put(target('claude-code'), config);
    const preview = await manager.preview(request('claude-code', 'remove'), project, null, runtime);
    await manager.apply(preview.id, project, runtime);
    expect(await json(target('claude-code'))).toEqual({
      hooks: { PreToolUse: [{ matcher: '.*', hooks: [userHook], description: 'User metadata' }] },
    });
  });
});

describe('preview authorization and immutable selection', () => {
  it('exposes a defensive selection copy and consumes a token only once', async () => {
    const selection = request('claude-code');
    const preview = await manager.preview(selection, project, policy, runtime);
    selection.client = 'codex';
    const returned = manager.getSelection(preview.id);
    expect(returned.client).toBe('claude-code');
    returned.revision = 'browser-changed';
    expect(manager.getSelection(preview.id).revision).toBe('revision-one');
    const results = await Promise.allSettled([
      manager.apply(preview.id, project, runtime), manager.apply(preview.id, project, runtime),
    ]);
    expect(results.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(() => manager.getSelection(preview.id)).toThrow();
  });

  it('never accepts edited public preview contents as the intended write', async () => {
    policy.config.apiToken = 'private-policy-value';
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    expect(JSON.stringify(preview)).not.toContain('private-policy-value');
    preview.files.forEach(file => { file.before = 'browser text'; file.after = '{"browser":"supplied"}'; });
    preview.client = 'claude-code';
    await manager.apply(preview.id, project, runtime);
    expect((await json(target('codex'))).browser).toBeUndefined();
    expect((await json(bindingPath('codex'))).policy.apiToken).toBe('private-policy-value');
    await expect(readFile(target('claude-code'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('invalidates outstanding preview tokens when closed', async () => {
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    manager.close();
    expect(() => manager.getSelection(preview.id)).toThrow();
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow(/closed/);
    await expect(readFile(target('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('expires previews after 60 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    expect(Date.parse(preview.expiresAt)).toBe(now + 60000);
    vi.setSystemTime(now + 60001);
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow(/expired|preview/i);
    await expect(readFile(target('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bounds stored preview count and invalidates the oldest token', async () => {
    const first = await manager.preview(request('codex'), project, policy, runtime);
    let latest = first;
    for (let i = 0; i < 40; i++) latest = await manager.preview(request('codex'), project, policy, runtime);
    expect(() => manager.getSelection(first.id)).toThrow();
    await manager.apply(latest.id, project, runtime);
  });

  it.each(['id', 'path', 'executionEnabled'] as const)('rejects a changed project %s at apply', async field => {
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    const changed = {
      ...project,
      [field]: field === 'executionEnabled' ? false : field === 'path' ? homeDir : 'another-project',
    };
    await expect(manager.apply(preview.id, changed, runtime)).rejects.toThrow(/project|changed|stale/i);
    await expect(readFile(target('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a replaced project directory at the same registered path', async () => {
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    await rename(project.path, `${project.path}-old`);
    await mkdir(project.path);
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow(/changed|identity|stale/i);
  });

  it.each(['pythonPath', 'engineVersion', 'state'] as const)('rejects a changed runtime %s at apply', async field => {
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    const changed = { ...runtime, [field]: field === 'state' ? 'missing' : 'changed' } as HarnessRuntime;
    await expect(manager.apply(preview.id, project, changed)).rejects.toThrow(/runtime|changed|stale/i);
  });

  it('rejects mutated selected policy content even with the old revision', async () => {
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    policy.config.mode = 'core';
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow(/policy|changed|stale/i);
  });

  it('rejects changes to the selected policy source file', async () => {
    const path = harnessPaths(dataDir, project.id).policyPath;
    await put(path, policy.content);
    policy.detail = { ...policy.detail, path, scope: 'managed', projectId: project.id };
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    await writeFile(path, 'mode: core\nrules: []\n');
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow(/changed|stale/i);
  });

  it('rejects a policy source already changed since the parent resolved it', async () => {
    const path = harnessPaths(dataDir, project.id).policyPath;
    await put(path, 'mode: core\nrules: []\n');
    policy.detail = { ...policy.detail, path, scope: 'managed', projectId: project.id };
    await expect(manager.preview(request('codex'), project, policy, runtime)).rejects.toThrow(/policy|changed|stale/i);
  });

  it('requires a matching selected policy and project for install', async () => {
    await expect(manager.preview({ ...request('codex'), revision: 'old' }, project, policy, runtime)).rejects.toThrow(/policy|revision/i);
    await expect(manager.preview({ ...request('codex'), projectId: 'other' }, project, policy, runtime)).rejects.toThrow(/project/i);
    await expect(manager.preview(request('codex'), project, null, runtime)).rejects.toThrow(/policy/i);
  });

  it.each(['missing', 'unsupported', 'unchecked', 'error'] as const)('does not enable hooks with %s runtime', async state => {
    const preview = await manager.preview(request('codex'), project, policy, { ...runtime, state, pythonPath: null });
    expect(preview.canApply).toBe(false);
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow();
    await expect(readFile(target('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires executionEnabled only for installation, allowing removal without the runtime', async () => {
    const denied = await manager.preview(request('codex'), { ...project, executionEnabled: false }, policy, runtime);
    expect(denied.canApply).toBe(false);
    await install('codex');
    const disabled = { ...project, executionEnabled: false };
    const absent = { ...runtime, state: 'missing' as const, pythonPath: null };
    await rm(runtime.pythonPath!);
    await rm(bridgePath);
    const preview = await manager.preview(request('codex', 'remove'), disabled, null, absent);
    expect(preview.canApply).toBe(true);
    await manager.apply(preview.id, disabled, absent);
    await expect(readFile(bindingPath('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['kiro-ide', '0.9.9', '1.0'],
    ['kiro-cli', '2.9.9', '3.0'],
  ] as const)('does not install the new %s schema on an older known version', async (client, version, required) => {
    const rows = await manager.list(project, { ...versions, [client]: version });
    expect(rows.find(row => row.client === client)).toMatchObject({ state: 'unsupported', requiredVersion: required });
    const preview = await manager.preview(request(client), project, policy, runtime);
    expect(preview.canApply).toBe(false);
  });

  it('reports unknown versions as requiring verification even with installed declarations', async () => {
    await install('kiro-cli');
    const rows = await manager.list(project, { 'kiro-cli': null });
    const row = rows.find(item => item.client === 'kiro-cli')!;
    expect(row.detectedVersion).toBeNull();
    expect(row.state).toBe('needs-review');
    expect(row.notices.join(' ')).toMatch(/version.*unknown|verify.*version/i);
    expect(row.lastObservedAt).toBeNull();
  });

  it('quotes apostrophes, spaces and shell metacharacters without executing commands', async () => {
    runtime.pythonPath = join(root, "Python's $(touch nope); bin", 'python3');
    await put(runtime.pythonPath, '# not executable');
    await install('claude-code');
    const command = (await json(target('claude-code'))).hooks.PreToolUse[0].hooks[0].command;
    expect(command).toBe(`'${root}/Python'"'"'s $(touch nope); bin/python3' -I '${bridgePath}' --binding '${bindingPath('claude-code')}' --event PreToolUse || exit 2`);
    await expect(readFile(join(project.path, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('bounded input reads and filesystem safety', () => {
  it.each(['target', 'user-config', 'inline-toml', 'python', 'bridge', 'binding'] as const)(
    'rejects changed %s input before mutation', async input => {
      let path: string;
      if (input === 'target') {
        path = target('codex');
        await put(path, { hooks: {} });
      } else if (input === 'user-config') {
        path = join(homeDir, '.codex', 'hooks.json');
        await put(path, { hooks: {} });
      } else if (input === 'inline-toml') {
        path = join(project.path, '.codex', 'config.toml');
        await put(path, 'model = "synthetic"\n');
      } else if (input === 'binding') {
        await install('codex');
        path = bindingPath('codex');
      } else path = input === 'python' ? runtime.pythonPath! : bridgePath;
      const preview = await manager.preview(request('codex'), project, policy, runtime);
      const contents = await readFile(path, 'utf8');
      await writeFile(path, `${contents}\n`);
      await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow(/changed|stale/i);
      expect(await readFile(path, 'utf8')).toBe(`${contents}\n`);
    },
  );

  it('rejects a file that appeared after preview even when its previous parent did not exist', async () => {
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    await put(target('codex'), { user: 'new file' });
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow(/changed|stale/i);
    expect(await json(target('codex'))).toEqual({ user: 'new file' });
  });

  it.each(['target', 'global', 'toml'] as const)('does not replace or silently ignore invalid %s JSON/TOML', async kind => {
    const path = kind === 'target' ? target('codex')
      : kind === 'global' ? join(homeDir, '.codex', 'hooks.json')
        : join(project.path, '.codex', 'config.toml');
    const invalid = kind === 'toml' ? '[hooks\nbad = "' : '{"hooks": ';
    await put(path, invalid);
    await expect(manager.preview(request('codex'), project, policy, runtime)).rejects.toThrow(/invalid|parse|JSON|TOML/i);
    expect(await readFile(path, 'utf8')).toBe(invalid);
    const row = (await manager.list(project, versions)).find(item => item.client === 'codex')!;
    expect(row.state).toBe('unknown');
  });

  it.each([
    { hooks: [] },
    { hooks: { PreToolUse: 'invalid' } },
    { hooks: { PreToolUse: [{ type: 'command', command: 'malformed-flat-hook' }] } },
  ])('rejects malformed existing matcher schemas without losing content', async config => {
    await put(target('claude-code'), config);
    await expect(manager.preview(request('claude-code'), project, policy, runtime)).rejects.toThrow(/hook|schema|invalid/i);
    expect(await json(target('claude-code'))).toEqual(config);
  });

  it.each(['deep', 'huge'] as const)('rejects %s input configurations', async kind => {
    const content = kind === 'huge' ? JSON.stringify({ extra: 'x'.repeat(1024 * 1024) })
      : '{"extra":'.repeat(60) + '0' + '}'.repeat(60);
    await put(target('codex'), content);
    await expect(manager.preview(request('codex'), project, policy, runtime)).rejects.toThrow(/large|limit|depth|deep/i);
    expect(await readFile(target('codex'), 'utf8')).toBe(content);
  });

  it.each(['parent', 'file', 'hardlink', 'data-dir', 'project'] as const)('rejects %s link escapes', async kind => {
    const outside = join(root, 'outside');
    await mkdir(outside);
    await put(join(outside, 'hooks.json'), { user: 'must survive' });
    if (kind === 'parent') await symlink(outside, join(project.path, '.codex'));
    else if (kind === 'project') {
      await rm(project.path, { recursive: true });
      await symlink(outside, project.path);
    } else if (kind === 'data-dir') await symlink(outside, dataDir);
    else {
      await mkdir(dirname(target('codex')), { recursive: true });
      if (kind === 'file') await symlink(join(outside, 'hooks.json'), target('codex'));
      else await link(join(outside, 'hooks.json'), target('codex'));
    }
    await expect(manager.preview(request('codex'), project, policy, runtime)).rejects.toThrow(/link|safe|path|regular/i);
    expect(await json(join(outside, 'hooks.json'))).toEqual({ user: 'must survive' });
  });

  it('rejects a parent symlink substituted after preview', async () => {
    await put(target('codex'), { hooks: {} });
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    const outside = join(root, 'outside');
    await rename(dirname(target('codex')), outside);
    await symlink(outside, dirname(target('codex')));
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow(/link|changed|safe|stale/i);
    expect(await json(join(outside, 'hooks.json'))).toEqual({ hooks: {} });
  });

  it('never edits global native configuration even when the home directory is registered as a project', async () => {
    const homeProject = { ...project, path: homeDir };
    await expect(manager.preview(request('codex'), homeProject, policy, runtime)).rejects.toThrow(/user|global|scope/i);
  });

  it('preserves inline Codex TOML hooks and native trust settings', async () => {
    const path = join(project.path, '.codex', 'config.toml');
    const content = '[features]\nhooks = true\n[[hooks.PreToolUse]]\nmatcher = ".*"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "autoharness-original"\n';
    await put(path, content);
    const before = (await manager.list(project, versions)).find(row => row.client === 'codex')!;
    expect(before).toMatchObject({ scope: 'project', managed: false, path });
    await install('codex');
    expect(await readFile(path, 'utf8')).toBe(content);
  });

  it('persists drift evidence across manager restarts while preserving the installed policy', async () => {
    await install('claude-code');
    const before = await readFile(bindingPath('claude-code'), 'utf8');
    await writeFile(target('claude-code'), `${await readFile(target('claude-code'), 'utf8')}\n`);
    manager.close();
    manager = new HarnessHookManager({ dataDir, homeDir, bridgePath });
    const row = (await manager.list(project, versions)).find(item => item.client === 'claude-code')!;
    expect(row).toMatchObject({ state: 'changed', managed: true, policyRevision: 'revision-one' });
    expect(await readFile(bindingPath('claude-code'), 'utf8')).toBe(before);
  });

  it('retains at most three private app-owned backups and leaves unrelated files untouched', async () => {
    await put(target('claude-code'), { env: { original: 'preserved' }, hooks: {} });
    await install('claude-code');
    for (let index = 0; index < 5; index++) {
      policy.detail.revision = `revision-${index}`;
      policy.config.mode = index % 2 === 0 ? 'core' : 'standard';
      await install('claude-code');
    }
    const backups = join(harnessPaths(dataDir, project.id).bindingsDir, 'hook-backups');
    const files = await readdir(backups);
    expect(files).toHaveLength(3);
    for (const file of files) {
      expect((await lstat(join(backups, file))).mode & 0o777).toBe(0o600);
      const backup = await json(join(backups, file));
      expect(backup.projectId).toBe(project.id);
      expect(backup.client).toBe('claude-code');
    }
    await put(join(backups, 'user-note.txt'), 'leave this alone');
    policy.detail.revision = 'next';
    await install('claude-code');
    expect(await readFile(join(backups, 'user-note.txt'), 'utf8')).toBe('leave this alone');
    expect((await readdir(backups)).filter(file => file.endsWith('.json'))).toHaveLength(3);
  });

  it('evicts raw preview snapshots by bytes before the count limit', async () => {
    await put(target('codex'), { retained: 'x'.repeat(180 * 1024) });
    const first = await manager.preview(request('codex'), project, policy, runtime);
    for (let i = 0; i < 16; i++) await manager.preview(request('codex'), project, policy, runtime);
    expect(() => manager.getSelection(first.id)).toThrow();
    expect((await json(target('codex'))).retained).toHaveLength(180 * 1024);
  });
});

describe('transaction rollback and outside edits', () => {
  it('saves the complete binding before a native command becomes visible', async () => {
    const realRename = fsPromises.rename;
    let atActivation: unknown;
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (to === target('codex')) atActivation = await json(bindingPath('codex'));
      await realRename(from, to);
    });
    await install('codex');
    expect(atActivation).toMatchObject({ protocol: 1, policy: policy.config, projectId: project.id });
  });

  it('rolls back binding and ownership files when native activation fails', async () => {
    await put(target('codex'), { user: 'preserve original' });
    const original = await readFile(target('codex'), 'utf8');
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    const realRename = fsPromises.rename;
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (to === target('codex')) throw new Error('simulated activation failure');
      await realRename(from, to);
    });
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow(/failure/);
    expect(await readFile(target('codex'), 'utf8')).toBe(original);
    await expect(readFile(bindingPath('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    const directory = harnessPaths(dataDir, project.id).bindingsDir;
    expect((await readdir(directory)).filter(file => file.endsWith('.json'))).toEqual([]);
    const backups = await readdir(join(directory, 'hook-backups'));
    expect(backups).toHaveLength(1);
    const backup = await json(join(directory, 'hook-backups', backups[0]));
    expect(backup.files.find((file: { path: string }) => file.path === target('codex')).before).toBe(original);
    expect((await readdir(dirname(target('codex')))).some(file => file.endsWith('.tmp'))).toBe(false);
  });

  it('restores native config when a read fails after the atomic rename succeeded', async () => {
    await put(target('codex'), { user: 'original' });
    const original = await readFile(target('codex'), 'utf8');
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    const realRename = fsPromises.rename;
    const realOpen = fsPromises.open;
    let failNextRead = false;
    let injected = false;
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      await realRename(from, to);
      if (to === target('codex') && !injected) failNextRead = true;
    });
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      if (args[0] === target('codex') && failNextRead) {
        injected = true;
        failNextRead = false;
        throw new Error('simulated post-rename read failure');
      }
      return realOpen(...args);
    });
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow(/failure/);
    expect(await readFile(target('codex'), 'utf8')).toBe(original);
    await expect(readFile(bindingPath('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a concurrent native edit after binding installation and rolls back the binding', async () => {
    await put(target('codex'), { user: 'before' });
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    const realRename = fsPromises.rename;
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      await realRename(from, to);
      if (to === bindingPath('codex')) await put(target('codex'), { user: 'concurrent outside edit' });
    });
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow(/changed|stale/i);
    expect(await json(target('codex'))).toEqual({ user: 'concurrent outside edit' });
    await expect(readFile(bindingPath('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a concurrently edited binding intact when rollback can no longer prove ownership', async () => {
    await put(target('codex'), { user: 'before' });
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    const realRename = fsPromises.rename;
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (to === target('codex')) {
        await put(bindingPath('codex'), { user: 'concurrently replaced binding' });
        throw new Error('simulated activation failure');
      }
      await realRename(from, to);
    });
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow(/concurrent outside edits.*preserved/i);
    expect(await json(bindingPath('codex'))).toEqual({ user: 'concurrently replaced binding' });
    expect(await json(target('codex'))).toEqual({ user: 'before' });
  });

  it('restores removed native commands if deleting the binding fails', async () => {
    await install('codex');
    const original = await readFile(target('codex'), 'utf8');
    const binding = await readFile(bindingPath('codex'), 'utf8');
    const preview = await manager.preview(request('codex', 'remove'), project, null, runtime);
    const realUnlink = fsPromises.unlink;
    vi.spyOn(fsPromises, 'unlink').mockImplementation(async path => {
      if (path === bindingPath('codex')) throw new Error('simulated binding removal failure');
      await realUnlink(path);
    });
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow(/failure/);
    expect(await readFile(target('codex'), 'utf8')).toBe(original);
    expect(await readFile(bindingPath('codex'), 'utf8')).toBe(binding);
    const row = (await manager.list(project, versions)).find(item => item.client === 'codex')!;
    expect(row).toMatchObject({ managed: true, state: 'needs-review', policyRevision: policy.detail.revision });
  });
});

async function linkedPython() {
  const environment = join(root, 'actual venv');
  const environmentLink = join(root, 'selected venv');
  const distribution = join(root, 'Cellar', 'python 3.12');
  const distributionLink = join(root, 'python opt');
  const executable = join(distribution, 'bin', 'python3.12');
  await put(executable, '# synthetic Python endpoint; never executed\n');
  await mkdir(join(environment, 'bin'), { recursive: true });
  await symlink(distribution, distributionLink);
  await symlink(join(distributionLink, 'bin', 'python3.12'), join(environment, 'bin', 'python3.12'));
  const leafLink = join(environment, 'bin', 'python');
  await symlink('python3.12', leafLink);
  await symlink(environment, environmentLink);
  runtime.pythonPath = join(environmentLink, 'bin', 'python');
  return { environment, environmentLink, distributionLink, executable, leafLink };
}

describe('selected interpreter symlink fingerprints', () => {
  it('preserves the original venv command path through relative and absolute links and parent aliases', async () => {
    const links = await linkedPython();
    await install('claude-code');
    expect((await json(bindingPath('claude-code'))).pythonPath).toBe(runtime.pythonPath);
    const command = (await json(target('claude-code'))).hooks.PreToolUse[0].hooks[0].command;
    expect(command).toBe(`'${runtime.pythonPath}' -I '${bridgePath}' --binding '${bindingPath('claude-code')}' --event PreToolUse || exit 2`);
    expect(command).not.toContain(links.executable);
    const first = await readFile(target('claude-code'), 'utf8');
    await install('claude-code');
    expect(await readFile(target('claude-code'), 'utf8')).toBe(first);
  });

  it.each(['leaf-link', 'parent-link', 'target-parent-link', 'executable-identity', 'executable-content', 'venv-directory'] as const)(
    'rejects a changed %s even when the selected runtime object is unchanged', async change => {
      const links = await linkedPython();
      const preview = await manager.preview(request('codex'), project, policy, runtime);
      if (change === 'leaf-link') {
        await rm(links.leafLink);
        await symlink(join(links.environment, 'bin', 'python3.12'), links.leafLink);
      } else if (change === 'parent-link' || change === 'target-parent-link') {
        const path = change === 'parent-link' ? links.environmentLink : links.distributionLink;
        const destination = await fsPromises.readlink(path);
        await rm(path);
        await symlink(destination, path);
      } else if (change === 'executable-identity') {
        const bytes = await readFile(links.executable);
        await rename(links.executable, `${links.executable}.old`);
        await writeFile(links.executable, bytes);
      } else if (change === 'executable-content') {
        await writeFile(links.executable, '# different endpoint\n');
      } else {
        await rename(links.environment, `${links.environment}.old`);
        await mkdir(join(links.environment, 'bin'), { recursive: true });
        await symlink('python3.12', join(links.environment, 'bin', 'python'));
        await symlink(join(links.distributionLink, 'bin', 'python3.12'), join(links.environment, 'bin', 'python3.12'));
      }
      await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow(/changed|stale/i);
      await expect(readFile(target('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(bindingPath('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(['cycle', 'too-many-links', 'hardlinked-endpoint', 'directory-endpoint'] as const)(
    'rejects a %s interpreter safely', async kind => {
      const links = await linkedPython();
      if (kind === 'cycle') {
        await rm(links.leafLink);
        await symlink('python', links.leafLink);
      } else if (kind === 'too-many-links') {
        for (let index = 0; index < 45; index++) {
          await symlink(index === 44 ? links.executable : `python-link-${index + 1}`, join(root, `python-link-${index}`));
        }
        runtime.pythonPath = join(root, 'python-link-0');
      } else if (kind === 'hardlinked-endpoint') {
        await link(links.executable, join(root, 'second-executable-name'));
      } else {
        await rm(links.executable);
        await mkdir(links.executable);
      }
      await expect(manager.preview(request('codex'), project, policy, runtime)).rejects.toThrow(/link|limit|regular|directory|cycle/i);
      await expect(readFile(target('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(['policy', 'binding', 'bridge'] as const)('keeps %s links forbidden when interpreter links are allowed', async kind => {
    await linkedPython();
    let path: string;
    let contents: string;
    if (kind === 'policy') {
      path = join(project.path, '.autoharness.yaml');
      contents = policy.content;
      policy.detail = { ...policy.detail, path, scope: 'project', projectId: project.id };
    } else if (kind === 'binding') {
      path = bindingPath('codex');
      contents = '{}';
    } else {
      path = bridgePath;
      contents = '# bridge stays private\n';
      await rm(path);
    }
    const outside = join(root, `outside-${kind}`);
    await put(outside, contents);
    await mkdir(dirname(path), { recursive: true });
    await symlink(outside, path);
    await expect(manager.preview(request('codex'), project, policy, runtime)).rejects.toThrow(/link|safe/i);
    expect(await readFile(outside, 'utf8')).toBe(contents);
  });

  const realPython = '/tmp/agent-ops-harness-engine/bin/python';
  it.runIf(existsSync(realPython))('previews and applies the available real AutoHarness venv to a temporary project', async () => {
    manager.close();
    bridgePath = fileURLToPath(new URL('../server/harness/bridge.py', import.meta.url));
    runtime = { ...runtime, pythonPath: realPython, pythonVersion: '3.12.12', engineVersion: '0.1.1' };
    manager = new HarnessHookManager({ dataDir, homeDir, bridgePath });
    await manager.list(project, versions);
    expect((await lstat(realPython)).isSymbolicLink()).toBe(true);
    const canonical = await fsPromises.realpath(realPython);
    expect(canonical).not.toBe(realPython);
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    expect(preview.canApply).toBe(true);
    const binding = await manager.apply(preview.id, project, runtime);
    expect(binding).toMatchObject({ managed: true, scope: 'project', state: 'needs-review' });
    expect((await json(bindingPath('codex'))).pythonPath).toBe(realPython);
    const command = (await json(target('codex'))).hooks.PreToolUse[0].hooks[0].command;
    expect(command.startsWith(`'${realPython}' -I `)).toBe(true);
    expect(command).not.toContain(`'${canonical}'`);
  });
});

describe('live project registration revalidation', () => {
  it.each(['removed', 'path', 'executionEnabled'] as const)('rejects a %s registered project at apply', async changed => {
    manager.close();
    let registered: Project | null = { ...project };
    manager = new HarnessHookManager({ dataDir, homeDir, bridgePath, getProject: () => registered });
    await manager.list(project, versions);
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    registered = changed === 'removed' ? null : changed === 'path'
      ? { ...project, path: homeDir } : { ...project, executionEnabled: false };
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow(/registered|project|execution/i);
    await expect(readFile(target('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(bindingPath('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rechecks execution after asynchronous staging and before the first binding rename', async () => {
    manager.close();
    let registered = { ...project };
    manager = new HarnessHookManager({ dataDir, homeDir, bridgePath, getProject: id => id === project.id ? registered : null });
    await manager.list(project, versions);
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    const realOpen = fsPromises.open;
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const result = await realOpen(...args);
      if (typeof args[0] === 'string' && args[0].endsWith('.tmp') && dirname(args[0]) === dirname(bindingPath('codex'))) {
        registered = { ...registered, executionEnabled: false };
      }
      return result;
    });
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow(/registered|project|execution/i);
    await expect(readFile(bindingPath('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(target('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(dirname(bindingPath('codex')))).some(path => path.endsWith('.tmp'))).toBe(false);
  });

  it('rolls back a written binding when registration is revoked before native activation', async () => {
    manager.close();
    let registered: Project | null = { ...project };
    manager = new HarnessHookManager({ dataDir, homeDir, bridgePath, getProject: () => registered });
    await manager.list(project, versions);
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    const realRename = fsPromises.rename;
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      await realRename(from, to);
      if (to === bindingPath('codex')) registered = null;
    });
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow(/registered|project/i);
    await expect(readFile(bindingPath('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(target('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows explicit removal from a still-registered disabled project without its engine', async () => {
    manager.close();
    let registered = { ...project };
    manager = new HarnessHookManager({ dataDir, homeDir, bridgePath, getProject: () => registered });
    await manager.list(project, versions);
    await install('codex');
    registered = { ...project, executionEnabled: false };
    const absent: HarnessRuntime = { ...runtime, state: 'missing', pythonPath: null };
    const preview = await manager.preview(request('codex', 'remove'), registered, null, absent);
    expect(preview.canApply).toBe(true);
    await manager.apply(preview.id, registered, absent);
    await expect(readFile(bindingPath('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('fail-closed native command compatibility', () => {
  it.each(['claude-code', 'codex', 'kiro-ide'] as const)('updates legacy %s commands without duplicates and still removes only owned commands', async client => {
    await install(client);
    const config = await json(target(client));
    const legacy = `'${runtime.pythonPath}' -I '${bridgePath}' --binding '${bindingPath(client)}' --event PreToolUse`;
    if (client === 'kiro-ide') config.hooks[0].action.command = legacy;
    else config.hooks.PreToolUse[0].hooks[0].command = legacy;
    await put(target(client), config);
    await install(client);
    const updated = await json(target(client));
    const pre = client === 'kiro-ide' ? updated.hooks.filter((hook: { trigger: string }) => hook.trigger === 'PreToolUse')
      : updated.hooks.PreToolUse;
    expect(pre).toHaveLength(1);
    expect(client === 'kiro-ide' ? pre[0].action.command : pre[0].hooks[0].command).toBe(`${legacy} || exit 2`);
    const post = client === 'kiro-ide' ? updated.hooks.find((hook: { trigger: string }) => hook.trigger === 'PostToolUse').action.command
      : updated.hooks.PostToolUse[0].hooks[0].command;
    expect(post).toBe(`'${runtime.pythonPath}' -I '${bridgePath}' --binding '${bindingPath(client)}' --event PostToolUse`);
    await install(client);
    expect(await json(target(client))).toEqual(updated);
    const remove = await manager.preview(request(client, 'remove'), project, null, runtime);
    await manager.apply(remove.id, project, runtime);
    await expect(readFile(bindingPath(client))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(target(client))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('ambiguous binding references', () => {
  it.each(['claude-code', 'codex', 'kiro-ide', 'kiro-cli'] as const)(
    'blocks %s update and removal after an owned command gains trailing whitespace', async client => {
      await install(client);
      const binding = await readFile(bindingPath(client), 'utf8');
      const config = await json(target(client));
      if (client.startsWith('kiro-')) config.hooks[0].action.command += ' \t';
      else config.hooks.PreToolUse[0].hooks[0].command += ' \t';
      await put(target(client), config);
      expect((await manager.list(project, versions)).find(row => row.client === client))
        .toMatchObject({ state: 'changed', managed: true });
      for (const action of ['install', 'remove'] as const) {
        const preview = await manager.preview(request(client, action), project, action === 'install' ? policy : null, runtime);
        expect(preview.canApply).toBe(false);
        expect(preview.notices.join(' ')).toMatch(/binding.*reconcil|reconcil.*binding/i);
        await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow();
        expect(await json(target(client))).toEqual(config);
        expect(await readFile(bindingPath(client), 'utf8')).toBe(binding);
      }
    },
  );

  it('never reports configured when a stored fingerprint already includes an ambiguous duplicate', async () => {
    await install('claude-code');
    const config = await json(target('claude-code'));
    const edited = structuredClone(config.hooks.PreToolUse[0]);
    edited.hooks[0].command += ' ';
    config.hooks.PreToolUse.unshift(edited);
    await put(target('claude-code'), config);
    const statePath = join(harnessPaths(dataDir, project.id).bindingsDir, 'claude-code.hooks-state.json');
    const state = await json(statePath);
    state.configHash = createHash('sha256').update(await readFile(target('claude-code'))).digest('hex');
    await put(statePath, state);
    expect((await manager.list(project, versions)).find(row => row.client === 'claude-code'))
      .toMatchObject({ state: 'changed', managed: true });
    const preview = await manager.preview(request('claude-code'), project, policy, runtime);
    expect(preview.canApply).toBe(false);
    expect(await json(target('claude-code'))).toEqual(config);
  });

  it('preserves the binding when an out-of-scope handler references its shell-quoted path', async () => {
    manager.close();
    dataDir = join(root, "app's data");
    manager = new HarnessHookManager({ dataDir, homeDir, bridgePath });
    await manager.list(project, versions);
    await install('claude-code');
    const config = await json(target('claude-code'));
    const outside = { hooks: { PreToolUse: [structuredClone(config.hooks.PreToolUse[0])] } };
    const userPath = join(homeDir, '.claude', 'settings.json');
    await put(userPath, outside);
    const binding = await readFile(bindingPath('claude-code'), 'utf8');
    const preview = await manager.preview(request('claude-code', 'remove'), project, null, runtime);
    expect(preview.canApply).toBe(false);
    await expect(manager.apply(preview.id, project, runtime)).rejects.toThrow();
    expect(await readFile(bindingPath('claude-code'), 'utf8')).toBe(binding);
    expect(await json(userPath)).toEqual(outside);
    expect(await json(target('claude-code'))).toEqual(config);
  });
});

describe('partial write recovery', () => {
  it('does not publish partial backup JSON and permits a fresh apply after ENOSPC', async () => {
    await put(target('codex'), { user: 'preserve' });
    const original = await readFile(target('codex'), 'utf8');
    const backups = join(harnessPaths(dataDir, project.id).bindingsDir, 'hook-backups');
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    const realOpen = fsPromises.open;
    let injected = false;
    let partialSize = 0;
    let visibleDuringWrite: string[] = [];
    const openSpy = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (!injected && typeof args[0] === 'string' && dirname(args[0]) === backups &&
        typeof args[1] === 'number' && (args[1] & constants.O_CREAT)) {
        injected = true;
        const realWrite = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async data => {
          await realWrite(String(data).slice(0, 12), 'utf8');
          partialSize = (await handle.stat()).size;
          visibleDuringWrite = await readdir(backups);
          throw Object.assign(new Error('simulated partial backup ENOSPC'), { code: 'ENOSPC' });
        });
      }
      return handle;
    });
    await expect(manager.apply(preview.id, project, runtime)).rejects.toMatchObject({ code: 'ENOSPC' });
    openSpy.mockRestore();
    expect(partialSize).toBe(12);
    expect(visibleDuringWrite.filter(path => path.endsWith('.json'))).toEqual([]);
    expect(await readdir(backups)).toEqual([]);
    expect(await readFile(target('codex'), 'utf8')).toBe(original);
    await expect(readFile(bindingPath('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    const fresh = await manager.preview(request('codex'), project, policy, runtime);
    expect(fresh.canApply).toBe(true);
    expect(await manager.apply(fresh.id, project, runtime)).toMatchObject({ managed: true, scope: 'project' });
    const saved = await readdir(backups);
    expect(saved).toHaveLength(1);
    const backup = await json(join(backups, saved[0]));
    expect(backup.files.find((file: { path: string }) => file.path === target('codex')).before).toBe(original);
  });

  it('does not unlink a foreign replacement for the failed backup inode', async () => {
    const backups = join(harnessPaths(dataDir, project.id).bindingsDir, 'hook-backups');
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    const realOpen = fsPromises.open;
    let failedPath: string | null = null;
    const openSpy = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (!failedPath && typeof args[0] === 'string' && dirname(args[0]) === backups &&
        typeof args[1] === 'number' && (args[1] & constants.O_CREAT)) {
        const path = failedPath = args[0];
        const realWrite = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async data => {
          await realWrite(String(data).slice(0, 12), 'utf8');
          await rename(path, `${path}.detached`);
          await put(path, 'foreign replacement must survive');
          throw Object.assign(new Error('simulated backup ENOSPC with outside replacement'), { code: 'ENOSPC' });
        });
      }
      return handle;
    });
    await expect(manager.apply(preview.id, project, runtime)).rejects.toMatchObject({ code: 'ENOSPC' });
    openSpy.mockRestore();
    expect(await readFile(failedPath!, 'utf8')).toBe('foreign replacement must survive');
    expect((await readFile(`${failedPath}.detached`)).length).toBe(12);
    const fresh = await manager.preview(request('codex'), project, policy, runtime);
    expect(fresh.canApply).toBe(true);
    await manager.apply(fresh.id, project, runtime);
    expect(await readFile(failedPath!, 'utf8')).toBe('foreign replacement must survive');
  });

  it('cleans an exclusively created partial binding stage and permits a fresh apply', async () => {
    const directory = harnessPaths(dataDir, project.id).bindingsDir;
    const preview = await manager.preview(request('codex'), project, policy, runtime);
    const realOpen = fsPromises.open;
    let injected = false;
    const openSpy = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (!injected && typeof args[0] === 'string' && dirname(args[0]) === directory && args[0].endsWith('.tmp') &&
        typeof args[1] === 'number' && (args[1] & constants.O_CREAT)) {
        injected = true;
        const realWrite = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async data => {
          await realWrite(String(data).slice(0, 12), 'utf8');
          throw Object.assign(new Error('simulated partial binding ENOSPC'), { code: 'ENOSPC' });
        });
      }
      return handle;
    });
    await expect(manager.apply(preview.id, project, runtime)).rejects.toMatchObject({ code: 'ENOSPC' });
    openSpy.mockRestore();
    expect((await readdir(directory)).filter(path => path.endsWith('.tmp') || path.endsWith('.json'))).toEqual([]);
    await expect(readFile(target('codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    const fresh = await manager.preview(request('codex'), project, policy, runtime);
    await manager.apply(fresh.id, project, runtime);
    expect(await json(bindingPath('codex'))).toMatchObject({ policyRevision: policy.detail.revision });
  });
});
