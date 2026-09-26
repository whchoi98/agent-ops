import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HarnessRuntimeManager } from '../server/harness/runtime.js';
import { harnessPaths } from '../server/harness/types.js';
import { controlled, enginePython, gone, policy, python, sandbox, waitJson } from './fixtures/harness-bridge.js';

const roots: string[] = [];
const managers: HarnessRuntimeManager[] = [];
async function setup(config: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const paths = await sandbox();
  roots.push(paths.root);
  const bridgePath = await controlled(paths.root, config);
  const manager = new HarnessRuntimeManager({ dataDir: paths.dataDir, bridgePath, cleanupGraceMs: 30, ...options });
  managers.push(manager);
  const input = {
    policy, projectDir: paths.projectDir, auditPath: harnessPaths(paths.dataDir, 'project-1').auditPath,
    client: 'claude-code' as const, projectId: 'project-1', policyId: 'policy-1',
    policyRevision: 'revision-1', toolName: 'Bash', toolInput: { command: 'echo review' },
  };
  return { ...paths, bridgePath, manager, input };
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe.skipIf(!python)('HarnessRuntimeManager transport and process ownership', () => {
  it('does not start Python on construction or info reads; only probe enables evaluation', async () => {
    const { root, manager, input } = await setup();
    expect(manager.info.state).toBe('unchecked');
    expect(manager.resourceRoots).toEqual([]);
    expect((await manager.evaluate(input)).action).toBe('error');
    expect(await readFile(join(root, 'ready.json')).catch(() => null)).toBeNull();
    const state = await manager.probe(python);
    expect(state).toMatchObject({ state: 'ready', pythonPath: python, pythonVersion: '3.12.12', engineVersion: '0.1.1' });
    state.state = 'error';
    expect(manager.info.state).toBe('ready');
    expect(await manager.evaluate(input)).toMatchObject({ action: 'ask', executed: false, client: 'claude-code' });
  });

  it('uses isolated Python, JSON stdin, an absolute bridge and a credential-free environment', async () => {
    const { root, bridgePath, manager, input } = await setup({}, {
      env: { PATH: '/usr/bin:/bin', HOME: '/tmp/synthetic-home', OPENAI_API_KEY: 'fixture-secret',
        AWS_SECRET_ACCESS_KEY: 'fixture-secret', PYTHONPATH: '/tmp/evil', LD_PRELOAD: '/tmp/evil.so' },
    });
    await manager.probe(python);
    await manager.evaluate(input);
    const ready = await waitJson(join(root, 'ready.json'));
    expect(ready.args).toEqual([bridgePath]);
    expect(ready.isolated).toBe(1);
    expect(ready.request).toMatchObject({ protocol: 1, operation: 'evaluate', toolInput: input.toolInput });
    expect(ready.environment).not.toHaveProperty('OPENAI_API_KEY');
    expect(ready.environment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(ready.environment).not.toHaveProperty('PYTHONPATH');
    expect(ready.environment).not.toHaveProperty('LD_PRELOAD');
  });

  it('finds the app venv before PATH and preserves the venv executable path', async () => {
    const { dataDir, manager } = await setup({}, { env: { PATH: '/does-not-exist' } });
    const candidate = join(dataDir, 'harness/venv/bin/python');
    await mkdir(join(dataDir, 'harness/venv/bin'), { recursive: true });
    await symlink(python, candidate);
    expect(await manager.probe()).toMatchObject({ state: 'ready', pythonPath: candidate });
  });

  it('rejects relative executable paths without starting a process', async () => {
    const { root, manager } = await setup();
    expect((await manager.probe('python3')).state).toBe('error');
    expect(await readFile(join(root, 'ready.json')).catch(() => null)).toBeNull();
  });

  it('distinguishes a missing interpreter from an engine/import error', async () => {
    const { manager, root } = await setup();
    expect(await manager.probe(join(root, 'missing-python'))).toMatchObject({ state: 'missing', pythonVersion: null });
  });

  it('redacts secrets echoed by the child into otherwise ordinary result fields', async () => {
    const { manager, root, input } = await setup();
    await manager.probe(python);
    await writeFile(join(root, 'fixture.json'), JSON.stringify({
      response: { protocol: 1, operation: 'evaluate', action: 'ask', risk: 'low', reason: 'opaque-value-123',
        matchedRules: ['opaque-value-123'], engineVersion: '0.1.1', executed: false },
    }));
    const result = await manager.evaluate({ ...input, toolInput: { headers: { 'X-Custom': 'opaque-value-123' } } });
    expect(JSON.stringify(result)).not.toContain('opaque-value-123');
  });

  it('redacts Basic authentication parts echoed by the child', async () => {
    const { manager, root, input } = await setup();
    await manager.probe(python);
    const encoded = Buffer.from('fixture-user:fixture-pass').toString('base64');
    await writeFile(join(root, 'fixture.json'), JSON.stringify({
      response: { protocol: 1, operation: 'evaluate', action: 'ask', risk: 'low',
        reason: `${encoded} fixture-pass`, matchedRules: [], engineVersion: '0.1.1', executed: false },
    }));
    const result = await manager.evaluate({ ...input, toolInput: { headers: { Authorization: `Basic ${encoded}` } } });
    expect(JSON.stringify(result)).not.toContain(encoded);
    expect(JSON.stringify(result)).not.toContain('fixture-pass');
  });

  it('keeps result fields bounded after redaction expands a short secret', async () => {
    const { manager, root, input } = await setup();
    await manager.probe(python);
    await writeFile(join(root, 'fixture.json'), JSON.stringify({
      response: { protocol: 1, operation: 'evaluate', action: 'ask', risk: 'low',
        reason: 'a'.repeat(1000), matchedRules: ['a'.repeat(250)], engineVersion: '0.1.1', executed: false },
    }));
    const result = await manager.evaluate({ ...input, toolInput: { secret: 'a' } });
    expect(result.reason.length).toBeLessThanOrEqual(4096);
    expect(result.matchedRules[0].length).toBeLessThanOrEqual(256);
  });

  it('cancels in-flight evaluation during invalidation and cannot return a stale allow', async () => {
    const { manager, root, input } = await setup({ evaluate: 'hang' });
    await manager.probe(python);
    await rm(join(root, 'ready.json'));
    const pending = manager.evaluate(input);
    const ready = await waitJson(join(root, 'ready.json'));
    manager.invalidate();
    expect((await pending).action).toBe('error');
    expect(manager.info.state).toBe('unchecked');
    await gone(ready.pid);
  });

  it.each(['stdout-flood', 'stderr-flood', 'crash'])('fails closed on %s without exposing child diagnostics', async mode => {
    const { manager, input } = await setup({ evaluate: mode }, { maxOutputBytes: 4096 });
    await manager.probe(python);
    const decision = await manager.evaluate(input);
    expect(decision.action).toBe('error');
    expect(JSON.stringify(decision)).not.toContain('fixture-private-secret');
    expect(manager.resourceRoots).toEqual([]);
  });

  it.each([null, [], { protocol: 1, operation: 'evaluate', action: 'allow' }])('rejects malformed successful child output', async response => {
    const { manager, root, input } = await setup();
    await manager.probe(python);
    await writeFile(join(root, 'fixture.json'), JSON.stringify({ response }));
    expect((await manager.evaluate(input)).action).toBe('error');
  });

  it('bounds inputs and rejects external audit targets before starting the next process', async () => {
    const { manager, root, input } = await setup();
    await manager.probe(python);
    await rm(join(root, 'ready.json'));
    expect((await manager.evaluate({ ...input, toolInput: { command: 'x'.repeat(65537) } })).action).toBe('error');
    expect((await manager.evaluate({ ...input, auditPath: join(root, 'external.jsonl') })).action).toBe('error');
    expect(await readFile(join(root, 'ready.json')).catch(() => null)).toBeNull();
  });

  it('exposes a defensive owned-process root and kills its process group on cancellation', async () => {
    const { manager, root } = await setup({ probe: 'ignore-term' });
    const controller = new AbortController();
    const pending = manager.probe(python, controller.signal);
    const ready = await waitJson(join(root, 'ready.json'));
    expect(manager.resourceRoots).toEqual([
      { pid: ready.pid, ownerId: expect.any(String), kind: 'harness', processGroup: process.platform !== 'win32' },
    ]);
    manager.resourceRoots[0].pid = 1;
    expect(manager.resourceRoots[0].pid).toBe(ready.pid);
    controller.abort();
    expect((await pending).state).toBe('error');
    await gone(ready.pid);
    expect(manager.resourceRoots).toEqual([]);
  });

  it('times out a SIGTERM-resistant process and keeps close bounded', async () => {
    const { manager, root } = await setup({ probe: 'ignore-term' }, { timeoutMs: 300 });
    const start = Date.now();
    const pending = manager.probe(python);
    const ready = await waitJson(join(root, 'ready.json'));
    expect((await pending).state).toBe('error');
    expect(Date.now() - start).toBeLessThan(2000);
    await gone(ready.pid);
    await manager.close();
    expect((await manager.probe(python)).state).toBe('error');
  });

  it('invalidates readiness and prevents an in-flight probe from restoring stale settings', async () => {
    const { manager, root, input } = await setup({ delayMs: 100 });
    await manager.probe(python);
    await rm(join(root, 'ready.json'));
    const pending = manager.probe(python);
    const ready = await waitJson(join(root, 'ready.json'));
    manager.invalidate();
    expect(manager.info.state).toBe('unchecked');
    expect((await pending).state).toBe('error');
    expect(manager.info.state).toBe('unchecked');
    expect((await manager.evaluate(input)).action).toBe('error');
    await gone(ready.pid);
  });

  it.each(['inherited-pipes', 'closed-pipes'])('cleans up descendants after the leader exits with %s', async mode => {
    const { manager, root } = await setup({ probe: mode }, { timeoutMs: 1000 });
    const pending = manager.probe(python);
    const descendant = await waitJson(join(root, 'descendant.json'));
    await pending;
    await gone(descendant.pid);
    expect(manager.resourceRoots).toEqual([]);
  });

  it('bounds process concurrency across manager instances without an unbounded queue', async () => {
    const setups = await Promise.all(Array.from({ length: 8 }, () => setup({ probe: 'hang' }, { timeoutMs: 700 })));
    const pending = setups.map(({ manager }) => manager.probe(python));
    await delay(100);
    const count = setups.reduce((total, { manager }) => total + manager.resourceRoots.length, 0);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(4);
    expect((await Promise.all(pending)).every(info => info.state === 'error')).toBe(true);
  });
});

describe.skipIf(!enginePython)('HarnessRuntimeManager with installed real AutoHarness', () => {
  it('validates and judges allow/ask/deny without executing the supplied command or upstream audit', async () => {
    const paths = await sandbox();
    roots.push(paths.root);
    const manager = new HarnessRuntimeManager({ dataDir: paths.dataDir });
    managers.push(manager);
    expect(await manager.probe(enginePython)).toMatchObject({ state: 'ready', engineVersion: '0.1.1' });
    expect(await manager.validate({ policy, projectDir: paths.projectDir })).toMatchObject({ valid: true, engineValidated: true });
    const auditPath = harnessPaths(paths.dataDir, 'project-1').auditPath;
    for (const [command, action] of [['echo safe', 'allow'], ['echo review', 'ask'], ['echo forbidden', 'deny']]) {
      expect(await manager.evaluate({
        policy, projectDir: paths.projectDir, auditPath, client: 'claude-code', projectId: 'project-1',
        policyId: 'p', policyRevision: 'r', toolName: 'Bash', toolInput: { command },
      })).toMatchObject({ action, executed: false });
    }
    const marker = join(paths.projectDir, 'must-not-exist');
    const external = join(paths.root, 'upstream.jsonl');
    const check = await manager.evaluate({
      policy: { ...policy, audit: { enabled: true, output: external },
        permissions: { ...policy.permissions, tools: { bash: { policy: 'allow' } } } }, projectDir: paths.projectDir,
      auditPath, client: 'codex', projectId: 'project-1', policyId: 'p', policyRevision: 'r',
      toolName: 'Bash', toolInput: { command: `touch '${marker}'` },
    });
    expect(check.action).toBe('allow');
    expect(await readFile(marker).catch(() => null)).toBeNull();
    expect(await readFile(external).catch(() => null)).toBeNull();
    const events = (await readFile(auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ origin: 'agent-ops-test', execution: { status: 'not-executed' } });
  });
});
