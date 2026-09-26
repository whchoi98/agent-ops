import { afterEach, describe, expect, it } from 'vitest';
import { chmod, link, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { binding, bridgePath, enginePython, gone, invokeBridge, invokeHookFault, policy, probeEnvironment, python, sandbox } from './fixtures/harness-bridge.js';
import { harnessPaths } from '../server/harness/types.js';
import { HarnessPolicyStore } from '../server/harness/policy.js';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const roots: string[] = [];
async function setup(client: 'claude-code' | 'codex' | 'kiro' = 'claude-code', overrides = {}) {
  const paths = await sandbox();
  roots.push(paths.root);
  return { ...paths, ...await binding(paths.dataDir, paths.projectDir, client, overrides) };
}
function native(path: string, input: unknown, event = 'PreToolUse', env: NodeJS.ProcessEnv = {}, executable = enginePython ?? python) {
  return invokeBridge(executable, input, ['--binding', path, '--event', event], env);
}
function pre(command = 'echo safe') {
  return { hook_event_name: 'PreToolUse', session_id: 'native-session-1', tool_name: 'Bash', tool_input: { command } };
}
async function events(path: string) {
  return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe.skipIf(!python)('Real Python bridge input and native failure boundaries', () => {
  it('reports the interpreter and missing/unsupported engine honestly using JSON-only output', async () => {
    const paths = await setup();
    const result = await invokeBridge(python, { protocol: 1, operation: 'probe', dataDir: paths.dataDir });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(['ready', 'missing', 'unsupported']).toContain(report.state);
    expect(report.pythonVersion).toMatch(/^\d+\.\d+\.\d+/);
    if (report.state !== 'ready') expect(Object.values(report.requiredApi)).toContain(false);
    expect(result.stderr).toBe('');
  });

  it.each(['{', '[]', '{"protocol":1,"protocol":2}', '{"x":NaN}', ' '.repeat(131073)])('rejects malformed, duplicate or oversized JSON', async input => {
    const result = await invokeBridge(python, input);
    expect(JSON.parse(result.stdout).action).toBe('error');
    expect(result.stderr).toBe('');
  });

  it.each([undefined, '0.1.1', '0.2.0'])('reports missing or unsupported package API/version in an isolated interpreter', async version => {
    const paths = await setup();
    const executable = await probeEnvironment(paths.root, version);
    const result = await invokeBridge(executable, { protocol: 1, operation: 'probe', dataDir: paths.dataDir });
    const report = JSON.parse(result.stdout);
    if (Number(report.pythonVersion.split('.')[1]) >= 10) {
      expect(report.state).toBe(version === undefined ? 'missing' : 'unsupported');
      expect(report.engineVersion).toBe(version ?? null);
    } else expect(report.state).toBe('unsupported');
    expect(report.requiredApi.constitutionFromDict).toBe(false);
    expect(report.requiredApi.pipelineEvaluate).toBe(false);
  });

  it('fails closed for a native pre-hook with no working engine and records trusted provenance', async () => {
    const paths = await setup('kiro', { pythonPath: python });
    const result = await native(paths.path, {
      ...pre(), hook_event_name: 'preToolUse', tool_name: 'execute_bash',
      client: 'kiro-ide', origin: 'agent-ops-test', auditPath: join(paths.root, 'external.jsonl'),
    }, 'PreToolUse', { AGENT_OPS_RUN_ID: 'run-123' }, python);
    if (JSON.parse((await invokeBridge(python, { protocol: 1, operation: 'probe', dataDir: paths.dataDir })).stdout).state !== 'ready') {
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/Harness|engine|Python/);
      expect(JSON.parse(result.stdout)).toEqual({});
      expect((await events(paths.auditPath))[0]).toMatchObject({
        origin: 'agent-ops-hook', client: 'kiro', project_id: 'project-1', run_id: 'run-123',
        session_id: 'native-session-1', event_type: 'PreToolUse', permission: { action: 'error' },
      });
    }
    expect(await readFile(join(paths.root, 'external.jsonl')).catch(() => null)).toBeNull();
  });

  it.each(['symlink', 'hardlink', 'world-writable'])('rejects a %s binding without following or modifying it', async kind => {
    const paths = await setup();
    const saved = await readFile(paths.path);
    const target = join(paths.root, 'outside.json');
    await writeFile(target, saved);
    await rm(paths.path);
    if (kind === 'symlink') await symlink(target, paths.path);
    else if (kind === 'hardlink') await link(target, paths.path);
    else await writeFile(paths.path, saved, { mode: 0o666 });
    if (kind === 'world-writable') await chmod(paths.path, 0o666);
    const result = await native(paths.path, pre());
    expect(result.code).toBe(2);
    expect(await readFile(target)).toEqual(saved);
    expect(await readFile(paths.auditPath).catch(() => null)).toBeNull();
  });

  it('rejects symlinked binding directories and policy/project metadata mismatches', async () => {
    const paths = await setup();
    const saved = await readFile(paths.path);
    await rm(dirname(paths.path), { recursive: true });
    const outside = join(paths.root, 'outside-bindings');
    await mkdir(outside);
    await writeFile(join(outside, 'claude-code.json'), saved, { mode: 0o600 });
    await symlink(outside, dirname(paths.path));
    expect((await native(paths.path, pre())).code).toBe(2);
    await rm(dirname(paths.path));
    await mkdir(dirname(paths.path), { mode: 0o700 });
    await writeFile(paths.path, JSON.stringify({ ...paths.value, projectId: 'a-different-project' }), { mode: 0o600 });
    expect((await native(paths.path, pre())).code).toBe(2);
  });

  it('does not let a post-hook failure veto execution or retain raw output', async () => {
    const paths = await setup('claude-code', { pythonPath: python });
    const result = await native(paths.path, {
      ...pre(), hook_event_name: 'PostToolUseFailure', tool_response: { result: 'PRIVATE RAW OUTPUT', success: false },
      error: 'PRIVATE FAILURE', duration_ms: 42,
    }, 'PostToolUseFailure', {}, python);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
    const text = await readFile(paths.auditPath, 'utf8');
    expect(text).not.toContain('PRIVATE RAW OUTPUT');
    expect(text).not.toContain('PRIVATE FAILURE');
    expect((await events(paths.auditPath))[0]).toMatchObject({ execution: { status: 'observed-failure', duration_ms: 42 } });
  });

  it('fails closed on a symlinked audit target without modifying an external file', async () => {
    const paths = await setup('kiro', { pythonPath: python });
    const outside = join(paths.root, 'outside-audit');
    await writeFile(outside, 'preserve-this');
    await mkdir(dirname(paths.auditPath), { recursive: true, mode: 0o700 });
    await symlink(outside, paths.auditPath);
    const result = await native(paths.path, pre(), 'PreToolUse', {}, python);
    expect(result.code).toBe(2);
    expect(await readFile(outside, 'utf8')).toBe('preserve-this');
  });

  it('rotates app logs within three 2MiB files and serializes concurrent native writers', async () => {
    const paths = await setup('kiro', { pythonPath: python });
    await mkdir(dirname(paths.auditPath), { recursive: true, mode: 0o700 });
    const full = 'x'.repeat(2 * 1024 * 1024 - 1) + '\n';
    await writeFile(paths.auditPath, full, { mode: 0o600 });
    await writeFile(join(dirname(paths.auditPath), 'events.1.jsonl'), full, { mode: 0o600 });
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      native(paths.path, { ...pre(), session_id: `s-${index}` }, 'PreToolUse', {}, python)));
    expect(results.every(result => result.code === 0 || result.code === 2)).toBe(true);
    const names = (await readdir(dirname(paths.auditPath))).filter(name => name.endsWith('.jsonl'));
    expect(names.sort()).toEqual(['events.1.jsonl', 'events.2.jsonl', 'events.jsonl']);
    for (const name of names) expect((await stat(join(dirname(paths.auditPath), name))).size).toBeLessThanOrEqual(2 * 1024 * 1024);
    const recorded = await events(paths.auditPath);
    expect(recorded).toHaveLength(12);
    expect(new Set(recorded.map(event => event.session_id)).size).toBe(12);
  });

  it('bounds an already oversized managed archive even when the active file is still small', async () => {
    const paths = await setup('kiro', { pythonPath: python });
    await mkdir(dirname(paths.auditPath), { recursive: true, mode: 0o700 });
    const archive = join(dirname(paths.auditPath), 'events.1.jsonl');
    await writeFile(archive, 'x'.repeat(2 * 1024 * 1024 + 1), { mode: 0o600 });
    await native(paths.path, pre(), 'PreToolUse', {}, python);
    expect(await stat(archive).then(info => info.size, () => 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(await events(paths.auditPath)).toHaveLength(1);
  });
});

describe.skipIf(!enginePython)('Real installed AutoHarness native judgment', () => {
  it.each([
    ['exception', 'error'],
    ['timeout', 'error'],
    ['success', 'allow'],
  ] as const)('distinguishes a real pre-hook %s from a successful permission check', async (fault, action) => {
    const paths = await setup();
    const evidencePath = join(paths.root, 'hook-evidence.json');
    const result = await invokeHookFault(enginePython!, {
      protocol: 1, operation: 'evaluate', dataDir: paths.dataDir, projectDir: paths.projectDir,
      auditPath: paths.auditPath, client: 'claude-code', projectId: 'project-1', policyId: 'p', policyRevision: 'r',
      policy: { ...policy, permissions: { ...policy.permissions, tools: { bash: { policy: 'allow' } } } },
      toolName: 'Bash', toolInput: { command: 'echo safe' },
    }, fault, evidencePath);
    expect(JSON.parse(await readFile(evidencePath, 'utf8')).calls).toBeGreaterThan(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ action, executed: false });
    expect((await events(paths.auditPath))[0].permission.action).toBe(action);
    expect(result.stdout + result.stderr + await readFile(paths.auditPath, 'utf8')).not.toContain('fixture-private-hook-error');
  });

  it.skipIf(process.platform !== 'linux' || process.getuid?.() === 0)('fails closed when the real engine cannot create a hook thread under RLIMIT_NPROC', async () => {
    const paths = await setup();
    const evidencePath = join(paths.root, 'thread-limit-evidence.json');
    const result = await invokeHookFault(enginePython!, {
      protocol: 1, operation: 'evaluate', dataDir: paths.dataDir, projectDir: paths.projectDir,
      auditPath: paths.auditPath, client: 'claude-code', projectId: 'project-1', policyId: 'p', policyRevision: 'r',
      policy: { ...policy, permissions: { ...policy.permissions, tools: { bash: { policy: 'allow' } } } },
      toolName: 'Bash', toolInput: { command: 'echo safe' },
    }, 'nproc', evidencePath);
    expect(JSON.parse(await readFile(evidencePath, 'utf8')).threadBlocked).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({ action: 'error', executed: false });
    expect((await events(paths.auditPath))[0].permission.action).toBe('error');
  });

  it('does not mistake a successful medium-risk warning for a hook failure', async () => {
    const paths = await setup();
    const result = await invokeBridge(enginePython!, {
      protocol: 1, operation: 'evaluate', dataDir: paths.dataDir, projectDir: paths.projectDir,
      auditPath: paths.auditPath, client: 'claude-code', projectId: 'project-1', policyId: 'p', policyRevision: 'r',
      policy: {
        ...policy, mode: 'standard', hooks: { profile: 'standard' },
        permissions: { ...policy.permissions, tools: { bash: { policy: 'allow' } } },
        risk: { ...policy.risk, custom_rules: [{ pattern: '^medium-risk-fixture$', level: 'medium', tool: 'bash' }] },
      },
      toolName: 'Bash', toolInput: { command: 'medium-risk-fixture' },
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ action: 'allow', risk: 'medium', executed: false });
  });

  it.each(['absolute', 'relative'])('honors bundled default Read permissions for an unattended %s path', async form => {
    const paths = await setup();
    const store = new HarnessPolicyStore({ dataDir: paths.dataDir, homeDir: paths.root });
    const builtin = (await store.list(null)).policies.find(item => item.scope === 'builtin')!;
    paths.value.policy = (await store.resolve(builtin.id, builtin.revision, null)).config;
    await writeFile(paths.path, JSON.stringify(paths.value), { mode: 0o600 });
    const file = join(paths.projectDir, 'README.md');
    await writeFile(file, 'A synthetic ordinary project file.\n');
    const result = await native(paths.path, {
      ...pre(), cwd: paths.projectDir, tool_name: 'Read', tool_input: { file_path: form === 'absolute' ? file : 'README.md' },
    }, 'PreToolUse', { AGENT_OPS_UNATTENDED: '1' });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
    expect((await events(paths.auditPath))[0]).toMatchObject({ permission: { action: 'allow' }, execution: { status: 'permitted' } });
  });

  it('excludes only the unconfigured alias default when the native tool is explicitly allowed', async () => {
    const paths = await setup();
    paths.value.policy = {
      ...policy, permissions: {
        defaults: { ...policy.permissions.defaults, unknown_tool: 'deny' },
        tools: { Read: { policy: 'allow' } },
      },
    };
    await writeFile(paths.path, JSON.stringify(paths.value), { mode: 0o600 });
    const result = await native(paths.path, { ...pre(), tool_name: 'Read', tool_input: { file_path: join(paths.projectDir, 'ordinary.txt') } });
    expect(JSON.parse(result.stdout)).toEqual({});
    expect((await events(paths.auditPath))[0].permission.action).toBe('allow');
  });

  it.each([
    [{ file_read: { policy: 'restricted' }, Read: { policy: 'allow' } }, 'ask'],
    [{ file_read: { policy: 'deny' }, Read: { policy: 'allow' } }, 'deny'],
    [{ file_read: { policy: 'allow' }, Read: { policy: 'deny' } }, 'deny'],
    [{ file_read: { policy: 'allow', deny_paths: ['*ordinary.txt'] }, Read: { policy: 'allow' } }, 'deny'],
  ] as const)('retains all explicitly configured canonical/native restrictions: %j', async (tools, action) => {
    const paths = await setup();
    paths.value.policy = { ...policy, permissions: { ...policy.permissions, tools } };
    await writeFile(paths.path, JSON.stringify(paths.value), { mode: 0o600 });
    const result = await native(paths.path, { ...pre(), tool_name: 'Read', tool_input: { file_path: join(paths.projectDir, 'ordinary.txt') } });
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe(action);
    expect((await events(paths.auditPath))[0].permission.action).toBe(action);
  });

  it('retains canonical risk denials even when only the native alias has a configured grant', async () => {
    const paths = await setup();
    paths.value.policy = {
      ...policy, permissions: { ...policy.permissions, tools: { exec_command: { policy: 'allow' } } },
      risk: { ...policy.risk, custom_rules: [{ pattern: '^canonical-risk-fixture$', tool: 'bash', level: 'critical' }] },
    };
    await writeFile(paths.path, JSON.stringify(paths.value), { mode: 0o600 });
    const result = await native(paths.path, {
      ...pre(), tool_name: 'exec_command', tool_input: { cmd: 'canonical-risk-fixture' },
    });
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect((await events(paths.auditPath))[0]).toMatchObject({ permission: { action: 'deny' }, risk: { level: 'critical' } });
  });

  it('retains canonical built-in hook denials when only the native alias is configured', async () => {
    const paths = await setup();
    paths.value.policy = {
      ...policy, mode: 'standard', hooks: { profile: 'strict' },
      permissions: { ...policy.permissions, tools: { fs_write: { policy: 'allow' } } },
      risk: { classifier: 'rules', thresholds: { low: 'allow', medium: 'allow', high: 'allow', critical: 'allow' } },
    };
    await writeFile(paths.path, JSON.stringify(paths.value), { mode: 0o600 });
    const result = await native(paths.path, {
      ...pre(), tool_name: 'fs_write', tool_input: { path: join(paths.projectDir, '.eslintrc.json'), content: '{}' },
    });
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect((await events(paths.auditPath))[0].permission.action).toBe('deny');
  });

  it.each(['claude-code', 'codex', 'kiro'] as const)('returns no native permission override for allowed %s events', async client => {
    const paths = await setup(client);
    const result = await native(paths.path, pre());
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
    expect((await events(paths.auditPath))[0]).toMatchObject({ client, permission: { action: 'allow' } });
  });

  it.each(['claude-code', 'codex', 'kiro'] as const)('preserves ask and safely adapts the %s native protocol', async client => {
    const paths = await setup(client);
    const result = await native(paths.path, pre('echo review'));
    const value = JSON.parse(result.stdout);
    if (client === 'kiro') {
      expect(result.code).toBe(2);
      expect(value).toEqual({});
    } else {
      expect(result.code).toBe(0);
      expect(value.hookSpecificOutput).toMatchObject({
        hookEventName: 'PreToolUse', permissionDecision: client === 'claude-code' ? 'ask' : 'deny',
      });
    }
    expect((await events(paths.auditPath))[0].permission.action).toBe('ask');
  });

  it.each(['claude-code', 'codex', 'kiro'] as const)('denies unattended asks for %s while auditing the original decision', async client => {
    const paths = await setup(client);
    const result = await native(paths.path, pre('echo review'), 'PreToolUse', { AGENT_OPS_UNATTENDED: '1' });
    if (client === 'kiro') expect(result.code).toBe(2);
    else expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect((await events(paths.auditPath))[0]).toMatchObject({
      permission: { action: 'ask' }, execution: { status: 'blocked-unattended' },
    });
  });

  it('keeps unknown tools subject to the configured default and normalizes every Kiro read operation', async () => {
    const paths = await setup('kiro');
    expect((await native(paths.path, { ...pre(), tool_name: 'unrecognized_tool', tool_input: {} })).code).toBe(2);
    expect((await events(paths.auditPath))[0].permission.action).toBe('ask');
    paths.value.policy = {
      ...policy, permissions: { ...policy.permissions, tools: { file_read: { policy: 'allow', deny_paths: ['*protected.txt'] } } },
    };
    await writeFile(paths.path, JSON.stringify(paths.value), { mode: 0o600 });
    const result = await native(paths.path, {
      hook_event_name: 'preToolUse', cwd: paths.projectDir, session_id: 'kiro-session', tool_name: 'read',
      tool_input: { operations: [{ mode: 'Line', path: join(paths.projectDir, 'safe.txt') }, { mode: 'Line', path: join(paths.projectDir, 'protected.txt') }] },
    });
    expect(result.code).toBe(2);
    expect((await events(paths.auditPath))[1]).toMatchObject({ client: 'kiro', permission: { action: 'deny' } });
  });

  it.each([
    { mode: 'made-up' },
    { permissions: { tools: { bash: { policy: 'made-up' } } } },
    { permissions: { tools: { bash: { policy: 'allow', deny_patterns: ['['] } } } },
    { permissions: { defaults: { unknown_tool: 'ALLOW' } } },
    { permissions: { defaults: { on_error: 'allow' } } },
    { risk: { classifier: 'llm' } },
    { risk: { classifier: 'hybrid' } },
    { hooks: { pre: [{ command: 'touch must-not-execute' }] } },
  ])('rejects invalid or executable policy data before an allowed result can escape', async bad => {
    const paths = await setup();
    const result = await invokeBridge(enginePython!, {
      protocol: 1, operation: 'validate', dataDir: paths.dataDir, projectDir: paths.projectDir, policy: bad,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: false, engineValidated: true });
  });

  it('does not execute tool commands, project Python, policy hooks or external upstream audit writes', async () => {
    const paths = await setup();
    const marker = join(paths.projectDir, 'executed');
    await writeFile(join(paths.projectDir, 'autoharness.py'), `open(${JSON.stringify(marker)}, 'w').write('executed')\n`);
    paths.value.policy = { ...policy, audit: { enabled: true, output: join(paths.root, 'upstream.jsonl') },
      permissions: { ...policy.permissions, tools: { bash: { policy: 'allow' } } } };
    await writeFile(paths.path, JSON.stringify(paths.value), { mode: 0o600 });
    const result = await native(paths.path, pre(`touch '${marker}'`), 'PreToolUse', {
      PYTHONPATH: paths.projectDir, OPENAI_API_KEY: 'fixture-not-a-real-key',
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
    expect(await readFile(marker).catch(() => null)).toBeNull();
    expect(await readFile(join(paths.root, 'upstream.jsonl')).catch(() => null)).toBeNull();
  });

  it('redacts audit identifiers and reasons and never retains original inputs or outputs', async () => {
    const paths = await setup();
    const result = await native(paths.path, {
      ...pre('echo password=fixture-secret-value'), session_id: 'Bearer fixture-session-token',
      tool_response: { result: 'RAW RESPONSE SECRET' },
    }, 'PreToolUse', { AGENT_OPS_RUN_ID: 'token=fixture-run-token' });
    const stored = await readFile(paths.auditPath, 'utf8');
    const combined = stored + result.stdout + result.stderr;
    for (const secret of ['fixture-secret-value', 'fixture-session-token', 'fixture-run-token', 'RAW RESPONSE SECRET']) {
      expect(combined).not.toContain(secret);
    }
    expect(stored).not.toContain('"tool_input"');
    expect(stored).not.toContain('"tool_response"');
  });

  it('rejects conflicting command aliases instead of evaluating only the harmless one', async () => {
    const paths = await setup();
    const result = await native(paths.path, {
      ...pre(), tool_input: { command: 'echo safe', cmd: 'echo forbidden' },
    });
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect((await events(paths.auditPath))[0].permission.action).toBe('error');
  });

  it('rejects conflicting paths inside a Kiro operation', async () => {
    const paths = await setup('kiro');
    const result = await native(paths.path, {
      ...pre(), tool_name: 'read', tool_input: {
        operations: [{ path: join(paths.projectDir, 'safe.txt'), file_path: join(paths.projectDir, 'protected.txt') }],
      },
    });
    expect(result.code).toBe(2);
    expect((await events(paths.auditPath))[0].permission.action).toBe('error');
  });

  it('governs the actual file for relative Kiro paths from a project subdirectory', async () => {
    const paths = await setup('kiro');
    const cwd = join(paths.projectDir, 'subdirectory');
    await mkdir(cwd, { mode: 0o700 });
    paths.value.policy = {
      ...policy, permissions: { ...policy.permissions, tools: {
        file_read: { policy: 'allow', deny_paths: [join(cwd, 'protected.txt')] },
      } },
    };
    await writeFile(paths.path, JSON.stringify(paths.value), { mode: 0o600 });
    const result = await native(paths.path, {
      ...pre(), cwd, tool_name: 'read', tool_input: { operations: [{ mode: 'Line', path: 'protected.txt' }] },
    });
    expect(result.code).toBe(2);
    expect((await events(paths.auditPath))[0].permission.action).toBe('deny');
  });

  it('resolves relative allowed paths while keeping PROJECT_DIR anchored to the binding', async () => {
    const paths = await setup();
    const cwd = join(paths.projectDir, 'subdirectory');
    await mkdir(cwd, { mode: 0o700 });
    paths.value.policy = {
      ...policy, permissions: { ...policy.permissions, tools: {
        file_read: { policy: 'restricted', allow_paths: ['${PROJECT_DIR}/subdirectory/*'] },
      } },
    };
    await writeFile(paths.path, JSON.stringify(paths.value), { mode: 0o600 });
    const result = await native(paths.path, { ...pre(), cwd, tool_name: 'Read', tool_input: { file_path: 'safe.txt' } });
    expect(JSON.parse(result.stdout)).toEqual({});
    expect((await events(paths.auditPath))[0].permission.action).toBe('allow');
  });

  it.each(['protected.txt', '../sibling.txt'])('preserves literal path denials and traversal checks for %s', async file => {
    const paths = await setup();
    paths.value.policy = {
      ...policy, permissions: { ...policy.permissions, tools: {
        file_read: { policy: 'allow', deny_paths: ['protected.txt'] },
      } },
    };
    await writeFile(paths.path, JSON.stringify(paths.value), { mode: 0o600 });
    const result = await native(paths.path, { ...pre(), tool_name: 'Read', tool_input: { file_path: file } });
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('keeps an explicit tool deny when absolute-path risk classification asks for confirmation', async () => {
    const paths = await setup();
    paths.value.policy = {
      ...policy, permissions: { ...policy.permissions, tools: { file_read: { policy: 'deny' } } },
      risk: { ...policy.risk, custom_rules: [{ pattern: '^/', level: 'high', tool: 'file_read' }] },
    };
    await writeFile(paths.path, JSON.stringify(paths.value), { mode: 0o600 });
    const result = await native(paths.path, { ...pre(), tool_name: 'Read', tool_input: { file_path: 'ordinary.txt' } });
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('redacts credentials copied into audit metadata and hides raw post-hook payload aliases', async () => {
    const paths = await setup();
    await native(paths.path, {
      ...pre(), hook_event_name: 'PostToolUse', session_id: 'opaque-private-value',
      tool_input: { command: 'echo safe', headers: { 'X-Custom': 'opaque-private-value' } },
      tool_response: { result: 'opaque-output-value' },
    }, 'PostToolUse', { AGENT_OPS_RUN_ID: 'opaque-output-value' });
    const stored = await readFile(paths.auditPath, 'utf8');
    expect(stored).not.toContain('opaque-private-value');
    expect(stored).not.toContain('opaque-output-value');
  });

  it('redacts Basic authentication parts copied into native identifiers', async () => {
    const paths = await setup();
    const encoded = Buffer.from('fixture-user:fixture-pass').toString('base64');
    await native(paths.path, {
      ...pre(), session_id: encoded,
      tool_input: { command: 'echo safe', headers: { Authorization: `Basic ${encoded}` } },
    }, 'PreToolUse', { AGENT_OPS_RUN_ID: 'fixture-pass' });
    const stored = await readFile(paths.auditPath, 'utf8');
    expect(stored).not.toContain(encoded);
    expect(stored).not.toContain('fixture-pass');
  });

  it('times out a real engine regex and still returns native deny with an error audit event', async () => {
    const paths = await setup('kiro', {
      policy: { ...policy, risk: { ...policy.risk, custom_rules: [{ pattern: '(x+)+$', level: 'high' }] } },
    });
    const started = Date.now();
    const result = await native(paths.path, pre('x'.repeat(45) + '!'));
    expect(Date.now() - started).toBeLessThan(15000);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/timed out/);
    expect((await events(paths.auditPath))[0]).toMatchObject({ permission: { action: 'error' } });
  }, 20000);

  it.skipIf(process.platform !== 'linux')('cancels the native supervisor without leaving its engine worker alive', async () => {
    const paths = await setup('kiro', {
      policy: { ...policy, risk: { ...policy.risk, custom_rules: [{ pattern: '(x+)+$', level: 'high' }] } },
    });
    const child = spawn(enginePython!, ['-I', bridgePath, '--binding', paths.path, '--event', 'PreToolUse'], {
      env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'ignore', 'ignore'], detached: true,
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(pre('x'.repeat(45) + '!')));
    let worker = 0;
    try {
      const deadline = Date.now() + 3000;
      while (!worker && Date.now() < deadline) {
        const children = await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').catch(() => '');
        worker = Number(children.trim().split(/\s+/)[0]);
        if (!worker) await delay(10);
      }
      expect(worker).toBeGreaterThan(0);
      child.kill('SIGTERM');
      await gone(child.pid!);
      await gone(worker);
    } finally {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already reaped. */ }
      if (worker) { try { process.kill(-worker, 'SIGKILL'); } catch { /* Already reaped. */ } }
    }
  }, 10000);

  it('records synthetic events only in the application scope selected by project ID', async () => {
    const paths = await setup();
    const auditPath = harnessPaths(paths.dataDir, null).auditPath;
    const result = await invokeBridge(enginePython!, {
      protocol: 1, operation: 'evaluate', dataDir: paths.dataDir, policy, projectDir: paths.projectDir,
      auditPath, client: 'kiro-cli', projectId: null, policyId: 'p', policyRevision: 'r',
      toolName: 'Bash', toolInput: { command: 'echo forbidden' },
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ action: 'deny', executed: false });
    expect((await events(auditPath))[0]).toMatchObject({
      origin: 'agent-ops-test', client: 'kiro-cli', project_id: null,
      execution: { status: 'not-executed' },
    });
  });
});
