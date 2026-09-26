import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppContext } from '../server/app.js';
import type { HarnessPolicyDetail, HarnessSettings } from '../shared/harness.js';

const python = process.env.HARNESS_TEST_PYTHON;
const headers = { 'x-agent-ops': '1' };
const fixtures: Array<{ context: AppContext; root: string }> = [];
const policy = {
  mode: 'core', hooks: { profile: 'minimal' },
  permissions: {
    defaults: { unknown_tool: 'ask', unknown_path: 'allow', on_error: 'deny' },
    tools: {
      bash: { policy: 'restricted', allow_patterns: ['^echo safe$'], ask_patterns: ['^echo review$'], deny_patterns: ['^echo forbidden$'] },
      file_read: { policy: 'allow' },
    },
  },
  risk: { classifier: 'rules', thresholds: { low: 'allow', medium: 'allow', high: 'ask', critical: 'deny' } },
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent ops harness integration '));
  const homeDir = join(root, 'home'), projectDir = join(root, 'project with spaces');
  await Promise.all([mkdir(homeDir), mkdir(projectDir)]);
  const context = await createApp({
    dataDir: join(root, 'data'), autoSync: false, connectorProbe: async () => [],
    harnessOptions: { homeDir }, desktopAppOptions: { platform: 'linux' },
    mcpOptions: { homeDir }, extensionOptions: { homeDir },
  });
  fixtures.push({ context, root });
  const project = context.store.ensureProject(projectDir, 'Harness integration fixture');
  context.store.saveProject({ ...project, executionEnabled: true });
  const settings = (await context.app.inject('/api/harness')).json().settings as HarnessSettings;
  expect((await context.app.inject({ method: 'PATCH', url: '/api/harness/settings', headers,
    payload: { ...settings, pythonPath: python },
  })).statusCode).toBe(200);
  const probe = await context.app.inject({ method: 'POST', url: '/api/harness/runtime/check', headers, payload: {} });
  expect(probe.statusCode).toBe(200);
  expect(probe.json()).toMatchObject({ state: 'ready', engineVersion: '0.1.1' });
  const saved = await context.app.inject({ method: 'PUT', url: '/api/harness/policies/managed', headers,
    payload: { projectId: project.id, content: JSON.stringify(policy), expectedRevision: null },
  });
  expect(saved.statusCode).toBe(200);
  return { ...context, root, homeDir, projectDir, project, policy: saved.json<HarnessPolicyDetail>() };
}
afterEach(async () => {
  for (const { context, root } of fixtures.splice(0)) {
    await context.app.close();
    await rm(root, { recursive: true, force: true });
  }
});

describe.skipIf(!python)('harness API with the installed AutoHarness engine', () => {
  it('uses real allow/ask/deny decisions and keeps tests separate from native hook observations', async () => {
    const setup = await fixture();
    const { app, project } = setup;
    for (const [command, action] of [['echo safe', 'allow'], ['echo review', 'ask'], ['echo forbidden', 'deny']] as const) {
      const response = await app.inject({ method: 'POST', url: '/api/harness/evaluate', headers, payload: {
        projectId: project.id, policyId: setup.policy.id, revision: setup.policy.revision,
        client: 'claude-code', toolName: 'Bash', toolInput: { command },
      } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ action, engineVersion: '0.1.1', executed: false });
    }
    const audit = (await app.inject(`/api/harness/audit?projectId=${project.id}`)).json();
    expect(audit.items).toHaveLength(3);
    expect(audit.items.every((item: { origin: string }) => item.origin === 'agent-ops-test')).toBe(true);
    const catalog = (await app.inject(`/api/harness?projectId=${project.id}`)).json();
    expect(catalog.bindings.every((binding: { lastObservedAt: string | null }) => binding.lastObservedAt === null)).toBe(true);
    expect((await app.inject('/api/harness/status')).json()).toMatchObject({ busy: false, processCount: 0 });
  });

  it('does not execute even an allowed shell command, and rejects a stale selected policy', async () => {
    const setup = await fixture();
    const marker = join(setup.projectDir, 'must-not-be-created');
    const permissive = structuredClone(policy);
    permissive.permissions.tools.bash.allow_patterns = ['.*'];
    permissive.permissions.tools.bash.ask_patterns = [];
    permissive.permissions.tools.bash.deny_patterns = [];
    const changed = await setup.app.inject({ method: 'PUT', url: '/api/harness/policies/managed', headers, payload: {
      projectId: setup.project.id, content: JSON.stringify(permissive), expectedRevision: setup.policy.revision,
    } });
    expect(changed.statusCode).toBe(200);
    const current = changed.json<HarnessPolicyDetail>();
    const input = {
      projectId: setup.project.id, policyId: current.id, revision: current.revision, client: 'claude-code',
      toolName: 'Bash', toolInput: { command: `printf fixture > '${marker}'` },
    };
    const evaluation = await setup.app.inject({ method: 'POST', url: '/api/harness/evaluate', headers, payload: input });
    expect(evaluation.statusCode).toBe(200);
    expect(evaluation.json()).toMatchObject({ action: 'allow', executed: false });
    expect(await stat(marker).then(() => true, () => false)).toBe(false);
    expect((await setup.app.inject({ method: 'POST', url: '/api/harness/evaluate', headers,
      payload: { ...input, revision: setup.policy.revision },
    })).statusCode).toBe(409);
  });

  it('applies a reviewed hook using a venv interpreter, observes its event and removes only its own entries', async () => {
    const setup = await fixture();
    const nativeDir = join(setup.projectDir, '.claude');
    const nativePath = join(nativeDir, 'settings.local.json');
    await mkdir(nativeDir);
    const original = { hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'printf keep-existing' }] }] } };
    await writeFile(nativePath, JSON.stringify(original));
    const request = {
      projectId: setup.project.id, client: 'claude-code', action: 'install',
      policyId: setup.policy.id, revision: setup.policy.revision,
    };
    const preview = await setup.app.inject({ method: 'POST', url: '/api/harness/hooks/preview', headers, payload: request });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().canApply).toBe(true);
    const applied = await setup.app.inject({ method: 'POST', url: '/api/harness/hooks/apply', headers,
      payload: { projectId: setup.project.id, previewId: preview.json().id },
    });
    expect(applied.statusCode).toBe(200);
    const configured = JSON.parse(await readFile(nativePath, 'utf8'));
    expect(configured.hooks.PreToolUse).toContainEqual(original.hooks.PreToolUse[0]);
    const command = configured.hooks.PreToolUse.flatMap((entry: { hooks: Array<{ command: string }> }) => entry.hooks)
      .find((hook: { command: string }) => hook.command.includes('--binding'))?.command;
    expect(command).toBeTruthy();
    const output = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: setup.projectDir, env: { PATH: '/usr/bin:/bin', AGENT_OPS_UNATTENDED: '1', AGENT_OPS_RUN_ID: 'run-harness-fixture' },
        stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      });
      let stdout = '';
      const timer = setTimeout(() => {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        reject(new Error('Generated hook did not finish within its bound.'));
      }, 10000);
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.resume();
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, stdout }); });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo review' }, session_id: 'native-harness-fixture' }));
    });
    expect(output.code).toBe(0);
    expect(JSON.parse(output.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    const catalog = (await setup.app.inject(`/api/harness?projectId=${setup.project.id}`)).json();
    expect(catalog.bindings.find((binding: { client: string }) => binding.client === 'claude-code').lastObservedAt).not.toBeNull();
    const audit = (await setup.app.inject(`/api/harness/audit?projectId=${setup.project.id}`)).json();
    expect(audit.items[0]).toMatchObject({
      origin: 'agent-ops-hook', action: 'ask', runId: 'run-harness-fixture', sessionId: 'native-harness-fixture',
    });
    const removal = (await setup.app.inject({ method: 'POST', url: '/api/harness/hooks/preview', headers,
      payload: { projectId: setup.project.id, client: 'claude-code', action: 'remove' },
    })).json();
    expect((await setup.app.inject({ method: 'POST', url: '/api/harness/hooks/apply', headers,
      payload: { projectId: setup.project.id, previewId: removal.id },
    })).statusCode).toBe(200);
    const remaining = JSON.parse(await readFile(nativePath, 'utf8'));
    expect(remaining.hooks.PreToolUse).toEqual(original.hooks.PreToolUse);
  });
});
