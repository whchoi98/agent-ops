import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, spawn as realSpawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runner } from '../server/runner.js';
import { Store } from '../server/store.js';
import { emptyUsage, type Agent, type ConnectorStatus, type ImportedSession, type Project, type Run, type RunEvent, type RunRequest } from '../shared/types.js';

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/runner/process.cjs', import.meta.url)), 'utf8');
const execFileAsync = promisify(execFile);
let root: string;
let store: Store;
let project: Project;
let executable: string;
const runners: Runner[] = [];
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
type Notice = { type: 'refresh' } | { type: 'run-event'; runId: string; event: RunEvent };
type FixtureCall = { argv: string[]; cwd: string; stdin: string; prompt: string; pid: number };

function configure(config: Record<string, unknown> = {}) {
  writeFileSync(`${executable}.json`, JSON.stringify({ controlDir: root, ...config }));
}
function connectors(patch: Partial<ConnectorStatus> = {}): ConnectorStatus[] {
  return (['codex', 'claude', 'kiro'] as Agent[]).map((agent) => ({
    agent, installed: true, executable, version: 'fixture 1.0.0', roots: [], existingRoots: [],
    sessionCount: 0, error: null, supportsResume: true, supportsStreaming: true, ...patch,
  }));
}
function runner(options: ConstructorParameters<typeof Runner>[1] = {}) {
  const instance = new Runner(store, { connectors: async () => connectors(), timeoutMs: 5000, ...options });
  runners.push(instance);
  return instance;
}
function request(patch: Partial<RunRequest> = {}): RunRequest {
  return { agent: 'codex', projectId: project.id, prompt: 'Review the workspace', policy: 'read-only', ...patch };
}
function newProject(name: string): Project {
  const path = join(root, name);
  mkdirSync(join(path, '.git'), { recursive: true });
  writeFileSync(join(path, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return store.saveProject({ ...store.ensureProject(path, name), executionEnabled: true });
}
function fixtureCalls(): FixtureCall[] {
  if (!existsSync(`${executable}.calls`)) return [];
  return readFileSync(`${executable}.calls`, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as FixtureCall);
}
async function until<T>(read: () => T, predicate: (value: T) => boolean, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T;
  do {
    value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() < deadline);
  throw new Error(`Condition did not become true: ${JSON.stringify(value!)}`);
}
async function finished(id: string, timeout = 5000) {
  return until(() => store.getRun(id)!, (run) => terminal.has(run.status), timeout);
}
async function ready(id: string) {
  return until(() => store.getEvents(id), (events) => events.some((event) => event.text === 'fixture ready'));
}
function release(name: string) { writeFileSync(join(root, `${name}.release`), 'release\n'); }
function session(agent: Agent, path = project.path, nativeId = 'native-123'): ImportedSession {
  return {
    id: `${agent}:${nativeId}`, nativeId, agent, projectPath: path, projectName: 'Workspace',
    title: 'Previous task', model: 'recorded-model', startedAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:03:00.000Z', status: 'completed', messageCount: 0,
    toolCallCount: 0, usage: emptyUsage(), sourcePath: '', messages: [],
  };
}
function storedRun(id: string, status: Run['status']): Run {
  return {
    ...request(), id, title: id, status, projectName: project.name, projectPath: project.path,
    createdAt: '2026-09-20T10:00:00.000Z', startedAt: status === 'running' ? '2026-09-20T10:00:01.000Z' : null,
    finishedAt: null, exitCode: null, error: null, nativeSessionId: null, usage: emptyUsage(), command: 'old command',
  };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-ops-runner-'));
  store = new Store(join(root, 'runs.sqlite'));
  project = newProject('workspace');
  executable = join(root, "fixture agent's command");
  writeFileSync(executable, `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
  configure();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runners.splice(0).map((instance) => instance.close()));
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('real process execution and durable records', () => {
  it.each(['codex', 'claude', 'kiro'] as Agent[])('passes literal %s argv, exact stdin and the approved cwd to a real executable', async (agent) => {
    const notices: Notice[] = [];
    const instance = runner({ onEvent: (notice) => notices.push(notice) });
    const prompt = "--leading-flag; $(touch definitely-not-created)\n한글 user's task";
    const preview = await instance.preview(request({ agent, prompt }));
    expect(fixtureCalls()).toEqual([]);
    const created = await instance.create(request({ agent, prompt }));
    const result = await finished(created.id);
    expect(result).toMatchObject({ status: 'completed', exitCode: 0, error: null, prompt });
    expect(result.startedAt).not.toBeNull();
    expect(result.finishedAt! >= result.startedAt!).toBe(true);
    expect(fixtureCalls()).toHaveLength(1);
    expect(fixtureCalls()[0]).toMatchObject({ cwd: project.path, prompt, stdin: agent === 'kiro' ? '' : prompt });
    if (agent === 'codex') expect(fixtureCalls()[0].argv).toEqual([
      'exec', '--json', '--color', 'never', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-',
    ]);
    if (agent === 'claude') expect(fixtureCalls()[0].argv).toEqual([
      '--print', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'plan',
      '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep',
      '--disallowedTools', 'AskUserQuestion,ExitPlanMode,mcp__*',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    ]);
    if (agent === 'kiro') expect(fixtureCalls()[0].argv).toEqual([
      'chat', '--no-interactive', '--wrap', 'never', '--trust-tools=fs_read', '--output-format', 'stream-json', '--', prompt,
    ]);
    expect(existsSync(join(project.path, 'definitely-not-created'))).toBe(false);
    expect(result.command).toBe(preview.displayCommand);
    const events = store.getEvents(created.id);
    expect(events[0]).toMatchObject({ stream: 'system', runId: created.id });
    expect(events[0].text).toMatch(/queued/i);
    expect(notices.filter((notice) => notice.type === 'run-event').map((notice) => notice.event)).toEqual(events);
    expect(result.usage).toEqual({
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null,
    });
  });

  it('executes Kiro V3 with stdin and modern trust categories without exposing its prompt in argv', async () => {
    const instance = runner({ connectors: async () => connectors({ version: 'kiro-cli 3.0.1' }) });
    const created = await instance.create(request({ agent: 'kiro', prompt: 'A private task' }));
    expect((await finished(created.id)).status).toBe('completed');
    expect(fixtureCalls()[0]).toMatchObject({
      stdin: 'A private task', prompt: 'A private task',
      argv: ['chat', '--no-interactive', '--wrap', 'never', '--trust-tools=read,grep', '--output-format', 'stream-json'],
    });
  });

  it.each(['codex', 'claude', 'kiro'] as Agent[])('enforces %s file-policy selection through the controlled executable', async (agent) => {
    configure({ checkFilePolicy: true });
    const instance = runner();
    const readOnly = await instance.create(request({ agent }));
    expect((await finished(readOnly.id)).status).toBe('completed');
    expect(existsSync(join(project.path, 'fixture-edit.txt'))).toBe(false);
    expect(store.getEvents(readOnly.id).some((event) => event.text === 'file edit denied')).toBe(true);
    const writable = await instance.create(request({ agent, policy: 'workspace-write' }));
    expect((await finished(writable.id)).status).toBe('completed');
    expect(readFileSync(join(project.path, 'fixture-edit.txt'), 'utf8')).toBe('approved file edit\n');
  });

  it.each([
    { agent: 'claude' as const, version: '2.1.259 (Claude Code)' },
    { agent: 'kiro' as const, version: 'kiro-cli 2.8.0' },
    { agent: 'kiro' as const, version: 'kiro-cli 3.0.1' },
  ])('permits a controlled build process only after explicit shell opt-in for $agent $version', async ({ agent, version }) => {
    configure({ checkShellPolicy: true });
    const instance = runner({ connectors: async () => connectors({ version }) });
    await expect(instance.create(request({ agent, allowShell: true }))).rejects.toMatchObject({ statusCode: 400 });
    const filesOnly = await instance.create(request({ agent, policy: 'workspace-write' }));
    expect((await finished(filesOnly.id)).status).toBe('completed');
    expect(existsSync(join(project.path, 'fixture-build.txt'))).toBe(false);
    const builds = await instance.create(request({ agent, policy: 'workspace-write', allowShell: true }));
    expect((await finished(builds.id)).status).toBe('completed');
    expect(readFileSync(join(project.path, 'fixture-build.txt'), 'utf8')).toBe('build passed\n');
    expect(store.getRun(builds.id)!.allowShell).toBe(true);
  });

  it('persists Codex thread ID and reported turn usage without inventing price or missing cache writes', async () => {
    configure({ records: [
      { type: 'thread.started', thread_id: 'thread-fixture-123' },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 } },
      { type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 10 } },
    ] });
    const created = await runner().create(request());
    expect(await finished(created.id)).toMatchObject({
      status: 'completed', nativeSessionId: 'thread-fixture-123',
      usage: { inputTokens: 150, outputTokens: 40, cacheReadTokens: 20, cacheWriteTokens: null, costUsd: null },
    });
  });

  it.each([13, 0])('records Codex cache_write_input_tokens=%s as measured usage', async (cacheWriteTokens) => {
    configure({ records: [{ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 5, cache_write_input_tokens: cacheWriteTokens } }] });
    const created = await runner().create(request());
    expect(await finished(created.id)).toMatchObject({
      status: 'completed', usage: { inputTokens: 100, outputTokens: 5, cacheWriteTokens, costUsd: null },
    });
  });

  it('clears a provisional Codex reconnecting error after a successful turn', async () => {
    configure({ records: [
      { type: 'error', message: 'Reconnecting... token=fixture-reconnect-secret' },
      { type: 'turn.completed', usage: { input_tokens: 9, output_tokens: 2 } },
    ] });
    const created = await runner().create(request());
    expect(await finished(created.id)).toMatchObject({ status: 'completed', exitCode: 0, error: null });
    expect(JSON.stringify(store.getEvents(created.id))).not.toContain('fixture-reconnect-secret');
  });

  it('keeps explicit Codex turn.failed fatal even if a later turn completes', async () => {
    configure({ records: [
      { type: 'error', message: 'Reconnecting...' },
      { type: 'turn.failed', error: { message: 'Terminal provider failure' } },
      { type: 'turn.completed', usage: { input_tokens: 9, output_tokens: 2 } },
    ] });
    const created = await runner().create(request());
    expect(await finished(created.id)).toMatchObject({ status: 'failed', error: 'Terminal provider failure' });
  });

  it.each(['json', 'text'])('processes protocol outcomes independently of a %s private-key marker', async (format) => {
    configure({
      records: [
        format === 'json'
          ? { type: 'item.completed', item: { type: 'agent_message', text: 'Example: -----BEGIN PRIVATE KEY-----\nfixture-hidden-body' } }
          : '-----BEGIN PRIVATE KEY-----\nfixture-hidden-body',
        { type: 'thread.started', thread_id: 'thread-after-marker' },
        { type: 'turn.failed', error: { message: 'Failed token=fixture-provider-secret' } },
      ],
    });
    const notices: Notice[] = [];
    const created = await runner({ onEvent: (notice) => notices.push(notice) }).create(request());
    expect(await finished(created.id)).toMatchObject({ status: 'failed', nativeSessionId: 'thread-after-marker' });
    const exposed = JSON.stringify(store.getEvents(created.id)) + JSON.stringify(notices) + store.getRun(created.id)!.error;
    expect(exposed).not.toMatch(/fixture-hidden-body|fixture-provider-secret/);
  });

  it('uses Claude result totals rather than double-counting assistant usage', async () => {
    configure({ records: [
      { type: 'system', subtype: 'init', session_id: 'claude-fixture-123' },
      { type: 'assistant', message: { usage: { input_tokens: 999, output_tokens: 999 } } },
      { type: 'result', subtype: 'success', session_id: 'claude-fixture-123', total_cost_usd: 0.0123,
        usage: { input_tokens: 25, output_tokens: 15, cache_read_input_tokens: 12, cache_creation_input_tokens: 8 } },
    ] });
    const created = await runner().create(request({ agent: 'claude' }));
    expect(await finished(created.id)).toMatchObject({
      status: 'completed', nativeSessionId: 'claude-fixture-123',
      usage: { inputTokens: 25, outputTokens: 15, cacheReadTokens: 12, cacheWriteTokens: 8, costUsd: 0.0123 },
    });
  });

  it('reads Kiro ACP session and explicit usage without treating context occupancy as token totals', async () => {
    configure({ records: [
      { jsonrpc: '2.0', id: 1, result: { sessionId: 'kiro-fixture-123' } },
      { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'kiro-fixture-123',
        update: { sessionUpdate: 'usage_update', used: 4096, size: 100000 } } },
      { jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn',
        usage: { inputTokens: 80, outputTokens: 13, cachedReadTokens: 9, cost: { amount: 0.03, currency: 'USD' } } } },
    ] });
    const created = await runner().create(request({ agent: 'kiro' }));
    expect(await finished(created.id)).toMatchObject({
      nativeSessionId: 'kiro-fixture-123',
      usage: { inputTokens: 80, outputTokens: 13, cacheReadTokens: 9, cacheWriteTokens: null, costUsd: 0.03 },
    });
  });

  it('does not report success when Kiro ACP records an interrupted turn with a zero process exit', async () => {
    configure({ records: [{ jsonrpc: '2.0', id: 2, result: { stopReason: 'cancelled' } }] });
    const created = await runner().create(request({ agent: 'kiro' }));
    const result = await finished(created.id);
    expect(result).toMatchObject({ status: 'interrupted', exitCode: 0 });
    expect(result.error).toMatch(/interrupted|cancelled/i);
  });

  it.each([
    { agent: 'codex' as const, record: { type: 'turn.failed', error: { message: 'Provider rejected token=private-token' } } },
    { agent: 'claude' as const, record: { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Provider rejected token=private-token' } },
    { agent: 'kiro' as const, record: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Provider rejected token=private-token' } } },
  ])('records a structured $agent failure even when the process exits zero', async ({ agent, record }) => {
    configure({ records: [record] });
    const created = await runner().create(request({ agent }));
    const result = await finished(created.id);
    expect(result).toMatchObject({ status: 'failed', exitCode: 0 });
    expect(result.error).toMatch(/Provider rejected/);
    expect(JSON.stringify(store.getEvents(created.id)) + result.error).not.toContain('private-token');
  });

  it('reports nonzero exit and authentication errors naturally without manufactured usage', async () => {
    configure({ exitCode: 17, stderr: ['Authentication required by fixture provider.'] });
    const created = await runner().create(request({ agent: 'kiro' }));
    expect(await finished(created.id)).toMatchObject({ status: 'failed', exitCode: 17, nativeSessionId: null });
    expect(store.getRun(created.id)!.error).toMatch(/17/);
    expect(store.getEvents(created.id).some((event) => event.text.includes('Authentication required'))).toBe(true);
  });
});

describe('project and session permission gates', () => {
  it('rejects missing, disabled, nonexistent and non-directory projects before queueing or spawning', async () => {
    const instance = runner();
    await expect(instance.create(request({ projectId: 'missing' }))).rejects.toThrow(/project/i);
    store.saveProject({ ...project, executionEnabled: false });
    await expect(instance.create(request())).rejects.toThrow(/enabled|disabled/i);
    await expect(instance.preview(request())).rejects.toThrow(/enabled|disabled/i);
    store.saveProject({ ...project, path: join(root, 'missing-directory') });
    await expect(instance.create(request())).rejects.toThrow(/directory|exist|workspace/i);
    const file = join(root, 'plain-file');
    writeFileSync(file, 'text');
    store.saveProject({ ...project, path: file });
    await expect(instance.create(request())).rejects.toThrow(/directory/i);
    expect(store.listRuns()).toEqual([]);
    expect(fixtureCalls()).toEqual([]);
  });

  it('allows demo previews for virtual projects but rejects creation and retry', async () => {
    const instance = runner({ demo: true });
    store.saveProject({ ...project, path: '/virtual/agent-ops/demo/workspace', executionEnabled: false });
    expect(await instance.preview(request())).toMatchObject({ cwd: '/virtual/agent-ops/demo/workspace', stdin: true });
    await expect(instance.create(request())).rejects.toThrow(/demo/i);
    store.insertRun(storedRun('demo-failed', 'failed'));
    await expect(instance.retry('demo-failed')).rejects.toThrow(/demo/i);
    store.insertRun(storedRun('demo-completed', 'completed'));
    await expect(instance.cancel('demo-completed')).rejects.toMatchObject({ statusCode: 409 });
    expect(fixtureCalls()).toEqual([]);
  });

  it.each([
    { agent: 'codex' as const, binary: 'codex' },
    { agent: 'claude' as const, binary: 'claude' },
    { agent: 'kiro' as const, binary: 'kiro-cli' },
  ])('previews missing $binary only as an unverified demo sample without spawning', async ({ agent, binary }) => {
    const missing = connectors({
      installed: false, executable: null, version: null, supportsResume: false, supportsStreaming: false,
    }).map((status) => Object.freeze(status));
    const spawn = vi.fn(() => { throw new Error('Demo attempted to spawn a process'); }) as unknown as typeof realSpawn;
    const demo = runner({ demo: true, connectors: async () => missing, spawn });
    store.saveProject({ ...project, path: '/virtual/agent-ops/demo/workspace', executionEnabled: false });
    const preview = await demo.preview(request({ agent }));
    expect(preview).toMatchObject({ executable: binary, cwd: '/virtual/agent-ops/demo/workspace' });
    expect(preview.displayCommand.startsWith(`${binary} `)).toBe(true);
    expect(preview.warnings.join(' ')).toMatch(/sample.*demo|demo.*sample/i);
    expect(preview.warnings.join(' ')).toMatch(/unverified/i);
    expect(preview.warnings.join(' ')).toMatch(new RegExp(`install.*${binary}`, 'i'));
    if (agent === 'kiro') {
      expect(preview.args).toEqual([
        'chat', '--no-interactive', '--wrap', 'never', '--trust-tools=fs_read', '--', 'Review the workspace',
      ]);
      expect(preview.stdin).toBe(false);
    }
    await expect(demo.create(request({ agent }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(demo.create(request({ agent, projectId: 'missing-project' }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(demo.retry('missing-run')).rejects.toMatchObject({ statusCode: 403 });
    expect(spawn).not.toHaveBeenCalled();
    expect(missing.every((status) => !status.installed && status.executable === null)).toBe(true);
    expect(store.listRuns()).toEqual([]);

    store.saveProject(project);
    const live = runner({ connectors: async () => missing, spawn });
    await expect(live.preview(request({ agent }))).rejects.toMatchObject({ statusCode: 409 });
    await expect(live.create(request({ agent }))).rejects.toMatchObject({ statusCode: 409 });
    await expect(live.preview({ ...request({ agent }), previewOnly: true } as RunRequest)).rejects.toMatchObject({ statusCode: 400 });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps installed CLI previews identical in live and demo mode', async () => {
    const live = runner();
    const demo = runner({ demo: true });
    expect(await demo.preview(request())).toEqual(await live.preview(request()));
    expect(fixtureCalls()).toEqual([]);
  });

  it('does not rewrite static demo queue records when the runner closes', async () => {
    const instance = runner({ demo: true });
    store.insertRun(storedRun('demo-queued', 'queued'));
    await instance.close();
    expect(store.getRun('demo-queued')).toMatchObject({ status: 'queued', finishedAt: null });
    expect(store.getEvents('demo-queued')).toEqual([]);
  });

  it('returns concrete HTTP status codes for expected validation errors', async () => {
    const instance = runner();
    await expect(instance.create(request({ projectId: 'unknown' }))).rejects.toMatchObject({ statusCode: 404 });
    await expect(instance.create(request({ policy: 'unsafe' as RunRequest['policy'] }))).rejects.toMatchObject({ statusCode: 400 });
    store.saveProject({ ...project, executionEnabled: false });
    await expect(instance.create(request())).rejects.toMatchObject({ statusCode: 403 });
    await expect(instance.cancel('missing')).rejects.toMatchObject({ statusCode: 404 });
    await expect(instance.retry('missing')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects historical Kiro SQLite resume on V3 when an engine selector is not advertised', async () => {
    const previous = { ...session('kiro'), sourcePath: join(root, 'conversations.sqlite3') };
    store.upsertSession(previous);
    const instance = runner({ connectors: async () => connectors({ version: 'kiro-cli 3.0.1' }) });
    await expect(instance.create(request({ agent: 'kiro', resumeSessionId: previous.id }))).rejects.toMatchObject({ statusCode: 409 });
    expect(fixtureCalls()).toEqual([]);
  });

  it('resolves only known native sessions with matching agent and physical workspace', async () => {
    const instance = runner();
    await expect(instance.create(request({ resumeSessionId: 'unknown' }))).rejects.toThrow(/session/i);
    store.upsertSession(session('claude'));
    await expect(instance.create(request({ resumeSessionId: 'claude:native-123' }))).rejects.toThrow(/agent/i);
    const other = newProject('other');
    store.upsertSession(session('codex', other.path, 'different-workspace'));
    await expect(instance.create(request({ resumeSessionId: 'codex:different-workspace' }))).rejects.toThrow(/project|workspace/i);
    const alias = join(root, 'workspace-alias');
    symlinkSync(project.path, alias, process.platform === 'win32' ? 'junction' : 'dir');
    store.upsertSession(session('codex', alias));
    const created = await instance.create(request({ resumeSessionId: 'codex:native-123' }));
    expect((await finished(created.id)).status).toBe('completed');
    expect(fixtureCalls()[0].argv).toEqual([
      'exec', 'resume', '--json', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', 'native-123', '-',
    ]);
  });

  it('validates cross-agent context sources without silently converting them to native resume', async () => {
    const instance = runner();
    await expect(instance.create(request({ sourceSessionId: 'missing' }))).rejects.toThrow(/session/i);
    store.upsertSession(session('codex'));
    await expect(instance.create(request({ sourceSessionId: 'codex:native-123' }))).rejects.toThrow(/agent/i);
    store.upsertSession(session('claude'));
    const created = await instance.create(request({ sourceSessionId: 'claude:native-123' }));
    expect((await finished(created.id)).status).toBe('completed');
    expect(fixtureCalls()[0].argv).not.toContain('resume');
  });

  it('rejects native resume for non-resumable child sessions while allowing a new cross-agent handoff', async () => {
    const child = { ...session('claude'), resumable: false, parentId: 'claude:parent' };
    store.upsertSession(child);
    const instance = runner();
    await expect(instance.preview(request({ agent: 'claude', resumeSessionId: child.id })))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/handoff/i) });
    await expect(instance.create(request({ agent: 'claude', resumeSessionId: child.id })))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(fixtureCalls()).toEqual([]);
    const created = await instance.create(request({ sourceSessionId: child.id, prompt: 'Continue from the child context' }));
    expect((await finished(created.id)).status).toBe('completed');
    expect(fixtureCalls()[0].stdin).toBe('Continue from the child context');
  });
});

describe('queue scheduling and lifecycle', () => {
  it('honors global concurrency while serializing projects and symlink aliases', async () => {
    store.saveSettings({ concurrency: 2 });
    const secondProject = newProject('other-workspace');
    const alias = join(root, 'alias');
    symlinkSync(project.path, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasProject = store.saveProject({ ...store.ensureProject(alias), executionEnabled: true });
    const instance = runner();
    const first = await instance.create(request({ prompt: 'hold:A' }));
    await ready(first.id);
    const same = await instance.create(request({ prompt: 'hold:B' }));
    const aliased = await instance.create(request({ projectId: aliasProject.id, prompt: 'hold:C' }));
    const other = await instance.create(request({ projectId: secondProject.id, prompt: 'hold:D' }));
    await ready(other.id);
    expect(store.getRun(same.id)!.status).toBe('queued');
    expect(store.getRun(aliased.id)!.status).toBe('queued');
    expect(fixtureCalls().map((call) => call.prompt)).toEqual(['hold:A', 'hold:D']);
    release('A');
    await finished(first.id);
    await ready(same.id);
    expect(store.getRun(aliased.id)!.status).toBe('queued');
    release('B');
    await finished(same.id);
    await ready(aliased.id);
    expect(fixtureCalls().at(-1)!.cwd).toBe(project.path);
    release('C');
    release('D');
    expect((await finished(aliased.id)).status).toBe('completed');
    expect((await finished(other.id)).status).toBe('completed');
  });

  it('applies changed concurrency through pump without restarting active processes', async () => {
    store.saveSettings({ concurrency: 1 });
    const other = newProject('other-workspace');
    const instance = runner();
    const first = await instance.create(request({ prompt: 'hold:A' }));
    await ready(first.id);
    const queued = await instance.create(request({ projectId: other.id, prompt: 'hold:B' }));
    expect(store.getRun(queued.id)!.status).toBe('queued');
    store.saveSettings({ concurrency: 2 });
    instance.pump();
    await ready(queued.id);
    expect(store.getRun(first.id)!.status).toBe('running');
    release('A'); release('B');
    await finished(first.id); await finished(queued.id);
  });

  it('respects a reduced concurrency limit without cancelling work already in progress', async () => {
    store.saveSettings({ concurrency: 2 });
    const other = newProject('other-workspace');
    const third = newProject('third-workspace');
    const instance = runner();
    const first = await instance.create(request({ prompt: 'hold:A' }));
    const second = await instance.create(request({ projectId: other.id, prompt: 'hold:B' }));
    await ready(first.id); await ready(second.id);
    const queued = await instance.create(request({ projectId: third.id, prompt: 'hold:C' }));
    store.saveSettings({ concurrency: 1 });
    instance.pump();
    release('A');
    await finished(first.id);
    expect(store.getRun(second.id)!.status).toBe('running');
    expect(store.getRun(queued.id)!.status).toBe('queued');
    release('B');
    await finished(second.id);
    await ready(queued.id);
    release('C');
    expect((await finished(queued.id)).status).toBe('completed');
  });

  it.each(['disabled', 'moved', 'replaced'] as const)('revalidates a %s project after waiting in the queue', async (change) => {
    store.saveSettings({ concurrency: 1 });
    const other = newProject('other-workspace');
    const instance = runner();
    const first = await instance.create(request({ prompt: 'hold:A' }));
    await ready(first.id);
    const queued = await instance.create(request({ projectId: other.id, prompt: 'must never execute' }));
    if (change === 'disabled') store.saveProject({ ...other, executionEnabled: false });
    if (change === 'moved') {
      const destination = join(root, 'moved-workspace');
      mkdirSync(destination);
      store.saveProject({ ...other, path: destination });
    }
    if (change === 'replaced') {
      renameSync(other.path, `${other.path}-old`);
      mkdirSync(other.path);
    }
    release('A');
    await finished(first.id);
    expect((await finished(queued.id)).status).toBe('failed');
    expect(fixtureCalls()).toHaveLength(1);
  });

  it('cancels a queued run without spawning it and keeps cancellation idempotent', async () => {
    const instance = runner();
    const first = await instance.create(request({ prompt: 'hold:A' }));
    await ready(first.id);
    const queued = await instance.create(request({ prompt: 'never execute' }));
    expect(await instance.cancel(queued.id)).toMatchObject({ status: 'cancelled', startedAt: null, exitCode: null });
    expect(await instance.cancel(queued.id)).toMatchObject({ status: 'cancelled' });
    release('A');
    await finished(first.id);
    expect(fixtureCalls()).toHaveLength(1);
  });

  it('does not spawn a queued run cancelled while its launch-time connector lookup is pending', async () => {
    let entered!: () => void;
    const lookupEntered = new Promise<void>((resolve) => { entered = resolve; });
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let lookups = 0;
    const instance = runner({ connectors: async () => {
      if (++lookups === 2) { entered(); await blocked; }
      return connectors();
    } });
    const cancelled = await instance.create(request({ prompt: 'must never execute' }));
    await lookupEntered;
    expect((await instance.cancel(cancelled.id)).status).toBe('cancelled');
    unblock();
    const next = await instance.create(request({ prompt: 'allowed later run' }));
    expect((await finished(next.id)).status).toBe('completed');
    expect(fixtureCalls().map((call) => call.prompt)).toEqual(['allowed later run']);
  });

  it('rejects an executable removed while its run waited in the queue', async () => {
    const instance = runner();
    const first = await instance.create(request({ prompt: 'hold:A' }));
    await ready(first.id);
    const queued = await instance.create(request({ prompt: 'must never execute' }));
    rmSync(executable);
    release('A');
    await finished(first.id);
    expect(await finished(queued.id)).toMatchObject({ status: 'failed', startedAt: null, exitCode: null });
    expect(fixtureCalls()).toHaveLength(1);
  });

  it('preserves stdout and stderr tails when cancelling a running process', async () => {
    configure({ termStdout: 'stdout cancellation tail 한글', termStderr: 'stderr cancellation tail' });
    const instance = runner();
    const created = await instance.create(request({ prompt: 'hold:A' }));
    await ready(created.id);
    const result = await instance.cancel(created.id);
    expect(result).toMatchObject({ status: 'cancelled', error: null });
    expect(result.finishedAt).not.toBeNull();
    expect(store.getEvents(created.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ stream: 'stdout', text: 'stdout cancellation tail 한글' }),
      expect.objectContaining({ stream: 'stderr', text: 'stderr cancellation tail' }),
    ]));
    expect(await instance.cancel(created.id)).toMatchObject({ status: 'cancelled' });
  });

  it('uses the configured timeout and escalates a process that ignores SIGTERM', async () => {
    configure({ ignoreTerm: true });
    const instance = runner({ timeoutMs: 150 });
    const created = await instance.create(request({ prompt: 'hold:A' }));
    const result = await finished(created.id);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/timed out/i);
    expect(result.exitCode).toBeNull();
  });

  it('reads timeoutMinutes from settings when no test override is supplied', async () => {
    store.saveSettings({ timeoutMinutes: 0.002 });
    const instance = new Runner(store, { connectors: async () => connectors() });
    runners.push(instance);
    const created = await instance.create(request({ prompt: 'hold:A' }));
    expect((await finished(created.id)).error).toMatch(/timed out/i);
  });

  it('retries a failed request with a new ID and refuses successful or active retries', async () => {
    configure({ failOnceFile: join(root, 'has-failed') });
    const instance = runner();
    const first = await instance.create(request({ prompt: 'Keep this exact request' }));
    expect((await finished(first.id)).status).toBe('failed');
    const retried = await instance.retry(first.id);
    expect(retried.id).not.toBe(first.id);
    expect((await finished(retried.id)).status).toBe('completed');
    expect(fixtureCalls().map((call) => call.stdin)).toEqual(['Keep this exact request', 'Keep this exact request']);
    await expect(instance.retry(retried.id)).rejects.toThrow(/completed|retry/i);
  });

  it('recovers old running and queued records as interrupted without repeating their work', async () => {
    store.insertRun(storedRun('old-running', 'running'));
    store.insertRun(storedRun('old-queued', 'queued'));
    const instance = runner();
    instance.start();
    expect(store.getRun('old-running')).toMatchObject({ status: 'interrupted' });
    expect(store.getRun('old-queued')).toMatchObject({ status: 'interrupted', startedAt: null });
    expect(store.getRun('old-running')!.finishedAt).not.toBeNull();
    expect(store.getEvents('old-running').some((event) => /restart|interrupt/i.test(event.text))).toBe(true);
    const created = await instance.create(request({ prompt: 'hold:A' }));
    await ready(created.id);
    instance.start();
    expect(store.getRun(created.id)!.status).toBe('running');
    expect(fixtureCalls()).toHaveLength(1);
    await instance.cancel(created.id);
  });

  it('closes owned work, interrupts its queue and rejects new work after shutdown', async () => {
    configure({ ignoreTerm: true });
    const instance = runner();
    const first = await instance.create(request({ prompt: 'hold:A' }));
    await ready(first.id);
    const queued = await instance.create(request({ prompt: 'never execute' }));
    await instance.close();
    expect(store.getRun(first.id)).toMatchObject({ status: 'interrupted' });
    expect(store.getRun(queued.id)).toMatchObject({ status: 'interrupted', startedAt: null });
    await expect(instance.create(request())).rejects.toThrow(/closed|shutdown/i);
    expect(fixtureCalls()).toHaveLength(1);
    await instance.close();
  });

  it('records actual spawn errors without leaving a running row or a leaked scheduler slot', async () => {
    let disappeared = false;
    const instance = runner({
      spawn: ((...args: Parameters<typeof realSpawn>) => {
        if (!disappeared) {
          disappeared = true;
          renameSync(executable, `${executable}.temporarily-absent`);
          const child = realSpawn(...args);
          renameSync(`${executable}.temporarily-absent`, executable);
          return child;
        }
        return realSpawn(...args);
      }) as typeof realSpawn,
    });
    const first = await instance.create(request());
    expect(await finished(first.id)).toMatchObject({ status: 'failed', exitCode: null });
    const second = await instance.create(request());
    expect((await finished(second.id)).status).toBe('completed');
  });
});

describe('stream safety and process ownership', () => {
  it.each(['append', 'update', 'completion', 'terminal-append', 'close'])('settles owned processes despite %s persistence failure', async (mode) => {
    const { stdout } = await execFileAsync(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./fixtures/runner/persistence.mjs', import.meta.url)), root, mode,
    ], { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 9000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    const report = JSON.parse(stdout);
    expect(report.harnessError).toBeUndefined();
    expect(report.alive).toBe(false);
    expect(report.action.kind).toBe('resolved');
    expect(report.closed.kind).toBe('resolved');
    expect(report.errors).toEqual([]);
    expect(report.completedNotices).toEqual([]);
    expect(report.durable.status).not.toBe('completed');
    const expectedStatus = mode === 'completion' || mode === 'terminal-append' ? 'failed' : mode === 'close' ? 'interrupted' : 'cancelled';
    expect(report.effective).toMatchObject({ status: expectedStatus, error: expect.stringMatching(/persist|save|storage/i) });
    expect(report.listed.find((run: Run) => run.id === report.effective.id)).toMatchObject({ status: expectedStatus });
    expect(report.listed.every((run: Run) => terminal.has(run.status))).toBe(true);
    if (report.restored) {
      expect(report.durable).toMatchObject({ status: expectedStatus, finishedAt: report.effective.finishedAt });
    }
    if (mode !== 'close') {
      expect(report.action.value.status).toBe(mode === 'completion' || mode === 'terminal-append' ? 'failed' : 'cancelled');
      expect(report.action.value.error).toMatch(/persist|save|storage/i);
      expect(report.action.value.error).not.toContain('fixture-disk-secret');
    }
    if (mode === 'completion' || mode === 'terminal-append') {
      expect(report.action.value).toMatchObject({ exitCode: 0, usage: { inputTokens: 7, outputTokens: 3 } });
    }
  });

  it.each(['pump', 'read', 'close'])('reconciles a one-time terminal append failure through %s without changing the effective failed outcome', async (trigger) => {
    configure({ finalRecords: [{ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }] });
    const instance = runner();
    const created = await instance.create(request({ prompt: 'hold:A' }));
    await ready(created.id);
    const append = store.appendEvent.bind(store);
    let injected = false;
    vi.spyOn(store, 'appendEvent').mockImplementation((id, stream, text) => {
      if (id === created.id && !injected && text.startsWith('Run completed')) {
        injected = true;
        throw Object.assign(new Error('SQLITE_FULL: transient disk failure'), { code: 'SQLITE_FULL' });
      }
      return append(id, stream, text);
    });
    release('A');
    await until(() => injected, Boolean);
    const failed = await instance.cancel(created.id);
    expect(failed.status).toBe('failed');
    expect(store.getRun(created.id)!.status).toBe('running');
    expect(instance.getRun(created.id)).toMatchObject({ status: 'failed', exitCode: 0, usage: { inputTokens: 7, outputTokens: 3 } });
    expect(instance.getRun('missing')).toBeNull();
    expect(instance.listRuns(0)).toEqual([]);
    expect(instance.listRuns(1).map((run) => run.status)).toEqual(['failed']);
    // Callers may decorate API snapshots; those changes must never turn the pending write into success.
    instance.getRun(created.id)!.status = 'completed';
    instance.listRuns(1)[0].usage.inputTokens = 999;
    if (trigger === 'close') {
      await instance.close();
    } else {
      const now = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => now() + 6000);
      if (trigger === 'read') instance.listRuns();
      else instance.pump();
      await until(() => store.getRun(created.id)!.status, (status) => status === 'failed', 1500);
    }
    expect(store.getRun(created.id)).toMatchObject({
      status: 'failed', finishedAt: failed.finishedAt, exitCode: 0,
      usage: { inputTokens: 7, outputTokens: 3 }, error: expect.stringMatching(/persist/i),
    });
    expect(store.getEvents(created.id).filter((event) => event.text.startsWith('Run failed'))).toHaveLength(1);
    expect(store.getEvents(created.id).some((event) => event.text.startsWith('Run completed'))).toBe(false);
    expect(fixtureCalls()).toHaveLength(1);
  });

  it('throttles persistent reconciliation failures, overlays list ordering, and cancels scheduled retries on close', async () => {
    const instance = runner();
    const created = await instance.create(request({ prompt: 'hold:A' }));
    await ready(created.id);
    const append = store.appendEvent.bind(store);
    let attempts = 0;
    vi.spyOn(store, 'appendEvent').mockImplementation((id, stream, text) => {
      if (id === created.id && /^Run (?:completed|failed)/.test(text)) {
        attempts++;
        throw Object.assign(new Error('SQLITE_FULL: persistent failure'), { code: 'SQLITE_FULL' });
      }
      return append(id, stream, text);
    });
    release('A');
    await until(() => attempts > 0, Boolean);
    expect((await instance.cancel(created.id)).status).toBe('failed');
    const later = await instance.create(request({ prompt: 'hold:B' }));
    await ready(later.id);
    expect(instance.listRuns(1).map((run) => run.id)).toEqual([later.id]);
    expect(instance.listRuns(-1).map((run) => [run.id, run.status])).toEqual([[later.id, 'running'], [created.id, 'failed']]);
    expect(attempts).toBe(1);
    const now = Date.now.bind(Date);
    let elapsed = 6000;
    vi.spyOn(Date, 'now').mockImplementation(() => now() + elapsed);
    for (let i = 0; i < 20; i++) {
      expect(instance.getRun(created.id)!.status).toBe('failed');
      instance.listRuns();
      instance.pump();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(attempts).toBe(1);
    expect((await instance.cancel(later.id)).status).toBe('cancelled');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(attempts).toBe(2);
    for (let i = 0; i < 20; i++) instance.getRun(created.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(attempts).toBe(2);
    elapsed = 12000;
    instance.pump();
    await instance.close();
    const atClose = attempts;
    expect(atClose).toBe(3);
    expect(instance.getRun(created.id)!.status).toBe('failed');
    elapsed = 18000;
    instance.listRuns();
    instance.pump();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(attempts).toBe(atClose);
    expect(store.getRun(created.id)!.status).toBe('running');
  });

  it('bounds close-time reconciliation under a real SQLite writer lock and restores the connection timeout', async () => {
    const instance = runner();
    const created = await instance.create(request({ prompt: 'hold:A' }));
    await ready(created.id);
    const append = store.appendEvent.bind(store);
    let injected = false;
    vi.spyOn(store, 'appendEvent').mockImplementation((id, stream, text) => {
      if (id === created.id && !injected && text.startsWith('Run completed')) {
        injected = true;
        throw Object.assign(new Error('SQLITE_FULL: transient failure'), { code: 'SQLITE_FULL' });
      }
      return append(id, stream, text);
    });
    release('A');
    await until(() => injected, Boolean);
    expect((await instance.cancel(created.id)).status).toBe('failed');
    store.db.pragma('busy_timeout = 777');
    const writer = new Store(store.filename);
    writer.db.exec('BEGIN IMMEDIATE');
    try {
      const started = performance.now();
      await instance.close();
      expect(performance.now() - started).toBeLessThan(500);
      expect(store.db.pragma('busy_timeout', { simple: true })).toBe(777);
      expect(instance.getRun(created.id)!.status).toBe('failed');
      expect(instance.listRuns(1)[0].status).toBe('failed');
      expect(store.getRun(created.id)!.status).toBe('running');
    } finally {
      writer.db.exec('ROLLBACK');
      writer.close();
    }
  });

  it.skipIf(process.platform === 'win32').each([
    { records: [{ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 4 } }], expected: 'completed' },
    { records: [{ type: 'turn.failed', error: { message: 'final provider failure' } }], expected: 'failed' },
  ])('settles a $expected leader with escaped inherited pipes without killing the escaped process', async ({ records, expected }) => {
    const heartbeat = join(root, 'escaped.heartbeat');
    configure({ heartbeat, detachedDescendant: true, descendantPrompt: 'escape:first', records });
    const instance = runner({ timeoutMs: 250 });
    const first = await instance.create(request({ prompt: 'escape:first' }));
    const queued = await instance.create(request({ prompt: 'queued next' }));
    await until(() => existsSync(`${heartbeat}.pid`), Boolean);
    const pid = Number(readFileSync(`${heartbeat}.pid`, 'utf8'));
    try {
      const result = await finished(first.id, 3200);
      expect(result).toMatchObject({ status: expected, exitCode: 0 });
      expect(store.getEvents(first.id).map((event) => event.text).join('\n')).toMatch(/background.*(?:remain|unconfirmed)|(?:unconfirmed|remain).*background/i);
      expect((await finished(queued.id, 1000)).status).toBe(expected);
      const before = readFileSync(heartbeat, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(readFileSync(heartbeat, 'utf8').length).toBeGreaterThan(before.length);
      await instance.close();
    } finally {
      // This PID comes only from our controlled fixture, whose identity is rechecked.
      try {
        const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (command.includes(executable) && command.includes('--fixture-grandchild')) process.kill(pid, 'SIGKILL');
      } catch { /* The fixture already stopped. */ }
    }
  });

  it('keeps lifecycle and persisted events intact when an event subscriber throws', async () => {
    configure({ tailStdout: 'durable output' });
    const created = await runner({ onEvent: () => { throw new Error('Subscriber failed'); } }).create(request());
    expect((await finished(created.id)).status).toBe('completed');
    expect(store.getEvents(created.id).some((event) => event.text === 'durable output')).toBe(true);
  });

  it('decodes split UTF-8 bytes and drains both final streams before completing', async () => {
    configure({ bytewiseText: '한글 🌱 stream\n', tailStdout: 'stdout without newline', tailStderr: 'stderr without newline' });
    const created = await runner().create(request());
    expect((await finished(created.id)).status).toBe('completed');
    const events = store.getEvents(created.id);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ stream: 'stdout', text: '한글 🌱 stream' }),
      expect.objectContaining({ stream: 'stdout', text: 'stdout without newline' }),
      expect.objectContaining({ stream: 'stderr', text: 'stderr without newline' }),
    ]));
    expect(events.map((event) => event.text).join('')).not.toContain('�');
  });

  it('redacts split secrets, private-key blocks and JSON fields before persistence or notifications', async () => {
    configure({
      chunks: ['Authorization: Bearer ', 'fixture.auth.', 'secret\n', '-----BEGIN PRIVATE KEY-----\n',
        'PRIVATEBODY1\nPRIVATEBODY2\n', '-----END PRIVATE KEY-----\n'],
      records: [{ api_key: 'fixture-api-secret', nested: { message: 'password=fixture-password' }, html: '<script>unsafe()</script>' }],
    });
    const notices: Notice[] = [];
    const instance = runner({ onEvent: (notice) => notices.push(notice) });
    const prompt = 'Keep raw token=fixture-prompt-secret';
    const created = await instance.create(request({ prompt }));
    const result = await finished(created.id);
    const events = store.getEvents(created.id);
    const exposed = JSON.stringify(events) + JSON.stringify(notices) + result.command + result.title;
    expect(exposed).not.toMatch(/fixture\.auth\.secret|PRIVATEBODY|fixture-api-secret|fixture-password|fixture-prompt-secret/);
    expect(store.getRun(created.id)!.prompt).toBe(prompt);
    const safeJson = events.find((event) => event.text.includes('"api_key"'))!;
    expect(JSON.parse(safeJson.text)).toEqual({
      api_key: '[REDACTED]', nested: { message: 'password=[REDACTED]' }, html: '<script>unsafe()</script>',
    });
  });

  it('handles a child closing stdin while a large prompt is still being written', async () => {
    configure({ closeStdin: true });
    const created = await runner().create(request({ prompt: 'x'.repeat(700000) }));
    expect((await finished(created.id)).status).toBe('completed');
    expect(store.getEvents(created.id).some((event) => event.text === 'stdin deliberately closed')).toBe(true);
  });

  it.each([
    { floodLines: 6500, lineLength: 1024, limit: 'bytes' },
    { floodLines: 6200, lineLength: 20, limit: 'events' },
  ])('bounds persisted $limit with an explicit truncation event while still recording final usage', async ({ floodLines, lineLength }) => {
    configure({ floodLines, lineLength, finalRecords: [
      { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 6 } },
    ] });
    const created = await runner().create(request());
    const result = await finished(created.id);
    expect(result).toMatchObject({ status: 'completed', usage: { inputTokens: 5, outputTokens: 6 } });
    const events = store.getEvents(created.id, 0, 10000);
    expect(events.length).toBeLessThanOrEqual(5000);
    expect(events.reduce((total, event) => total + Buffer.byteLength(event.text), 0)).toBeLessThanOrEqual(4194304);
    expect(events.some((event) => event.stream === 'system' && /truncat/i.test(event.text))).toBe(true);
    expect(events.at(-1)!.text).toMatch(/completed/i);
  });

  it('drains oversized output without a newline rather than hanging or allocating unbounded logs', async () => {
    configure({ noNewlineBytes: 6 * 1024 * 1024 });
    const created = await runner().create(request());
    expect((await finished(created.id)).status).toBe('completed');
    const events = store.getEvents(created.id);
    expect(events.reduce((total, event) => total + Buffer.byteLength(event.text), 0)).toBeLessThanOrEqual(4194304);
    expect(events.some((event) => /truncat/i.test(event.text))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('escalates the owned process group after its leader exits and preserves workspace serialization', async () => {
    const heartbeat = join(root, 'descendant.heartbeat');
    configure({ heartbeat });
    const instance = runner();
    const created = await instance.create(request({ prompt: 'hold:A' }));
    await ready(created.id);
    await until(() => existsSync(heartbeat), Boolean);
    const pid = Number(readFileSync(`${heartbeat}.pid`, 'utf8'));
    try {
      const result = await instance.cancel(created.id);
      expect(result.status).toBe('cancelled');
      const last = readFileSync(heartbeat, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(readFileSync(heartbeat, 'utf8')).toBe(last);
      expect((await instance.cancel(created.id)).status).toBe('cancelled');
    } finally {
      // Only the fixture we created may be cleaned up if the assertion catches a leak.
      try {
        if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--fixture-grandchild')) process.kill(pid, 'SIGKILL');
      } catch { /* The owned fixture has already exited. */ }
    }
  });

  it.skipIf(process.platform === 'win32')('cancels only the owned group while a separately launched controlled process continues', async () => {
    configure({ hold: true });
    const independent = realSpawn(executable, ['--', 'independent'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const independentClosed = once(independent, 'close');
    independent.stdout.resume();
    independent.stderr.resume();
    independent.stdin.end();
    try {
      await until(() => fixtureCalls().some((call) => call.prompt === 'independent'), Boolean);
      const instance = runner();
      const created = await instance.create(request({ prompt: 'hold:A' }));
      await ready(created.id);
      expect((await instance.cancel(created.id)).status).toBe('cancelled');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(independent.exitCode).toBeNull();
      expect(independent.signalCode).toBeNull();
      expect(independent.kill(0)).toBe(true);
    } finally {
      independent.kill('SIGTERM');
      await independentClosed;
    }
  });
});
