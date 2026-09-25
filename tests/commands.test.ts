import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCommand } from '../server/commands.js';
import { connectorForResume, detectConnectors, invalidateConnectorCache } from '../server/connectors.js';
import { defaultSettings } from '../server/config.js';
import type { Agent, ConnectorStatus, Project, RunRequest, Settings } from '../shared/types.js';

let root: string;
let project: Project;
const request = (agent: Agent = 'codex', patch: Partial<RunRequest> = {}): RunRequest => ({
  agent, projectId: project.id, prompt: 'Review this workspace', policy: 'read-only', ...patch,
});
const connector = (agent: Agent = 'codex', patch: Partial<ConnectorStatus> = {}): ConnectorStatus => ({
  agent, installed: true, version: 'fixture 1', executable: process.execPath,
  roots: [], existingRoots: [], sessionCount: 0, error: null,
  supportsResume: true, supportsStreaming: true, ...patch,
});
const probeFixture = readFileSync(fileURLToPath(new URL('./fixtures/runner/probe.cjs', import.meta.url)), 'utf8');

function probe(name: string, options: Record<string, unknown> = {}) {
  const executable = join(root, name);
  writeFileSync(executable, `#!${process.execPath}\n${probeFixture}`, { mode: 0o700 });
  writeFileSync(`${executable}.json`, JSON.stringify(options));
  return executable;
}
function settings(): Settings {
  return {
    ...defaultSettings(),
    sourceRoots: {
      codex: [join(root, 'history'), join(root, 'absent')],
      claude: [], kiro: [join(root, 'history.sqlite3')],
    },
  };
}
function calls(executable: string): string[][] {
  return readFileSync(`${executable}.calls`, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-ops-commands-'));
  const path = join(root, 'workspace');
  mkdirSync(join(path, '.git'), { recursive: true });
  writeFileSync(join(path, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  project = { id: 'project-one', path, name: 'Workspace', color: '#3564e8', executionEnabled: true, createdAt: '2026-09-24T00:00:00.000Z' };
  invalidateConnectorCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  invalidateConnectorCache();
  rmSync(root, { recursive: true, force: true });
});

describe('fixed CLI commands', () => {
  it('uses literal Codex read-only flags and stdin without exposing the prompt in its display', () => {
    const preview = buildCommand(request('codex', { prompt: 'token=my-private-token; $(touch do-not-create)' }), project, connector());
    expect(preview.args).toEqual([
      'exec', '--json', '--color', 'never', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-',
    ]);
    expect(preview).toMatchObject({ executable: process.execPath, cwd: project.path, stdin: true });
    expect(preview.displayCommand).toContain(`-c 'approval_policy="never"' -`);
    expect(preview.displayCommand).not.toMatch(/my-private-token|touch do-not-create/);
  });

  it('selects write policy and a single model argument without changing approval policy', () => {
    const preview = buildCommand(request('codex', { policy: 'workspace-write', model: 'configured-model' }), project, connector());
    expect(preview.args).toEqual([
      'exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"',
      '--model', 'configured-model', '-',
    ]);
  });

  it('uses Codex resume configuration overrides because exec resume has no sandbox flag', () => {
    const preview = buildCommand(request('codex', { resumeSessionId: 'codex:session' }), project, connector(), 'native-123');
    expect(preview.args).toEqual([
      'exec', 'resume', '--json', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', 'native-123', '-',
    ]);
    expect(preview.args).not.toContain('--sandbox');
  });

  it('skips only the git check for an enabled workspace outside a git repository', () => {
    rmSync(join(project.path, '.git'), { recursive: true });
    const preview = buildCommand(request(), project, connector());
    expect(preview.args).toEqual([
      'exec', '--json', '--color', 'never', '--sandbox', 'read-only', '-c', 'approval_policy="never"',
      '--skip-git-repo-check', '-',
    ]);
    expect(preview.warnings.join(' ')).toMatch(/Git/i);
  });

  it('recognizes a parent git directory without executing git', () => {
    const nested = join(project.path, 'nested');
    mkdirSync(nested);
    expect(buildCommand(request(), { ...project, path: nested }, connector()).args).not.toContain('--skip-git-repo-check');
  });

  it('uses Claude print mode and explicitly limits read-only tools', () => {
    const preview = buildCommand(request('claude'), project, connector('claude'));
    expect(preview.args).toEqual([
      '--print', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'plan',
      '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep',
      '--disallowedTools', 'AskUserQuestion,ExitPlanMode,mcp__*',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    ]);
    expect(preview.stdin).toBe(true);
    expect(preview.args).not.toContain('Review this workspace');
    expect(preview.policyDescription).toMatch(/provider|CLI/i);
  });

  it('allows only file edits in Claude write mode and resumes an explicit native session', () => {
    const preview = buildCommand(request('claude', {
      policy: 'workspace-write', model: 'configured-model', resumeSessionId: 'claude:session',
    }), project, connector('claude'), 'native-456');
    expect(preview.args).toEqual([
      '--print', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'acceptEdits',
      '--tools', 'Read,Glob,Grep,Edit,Write', '--allowedTools', 'Read,Glob,Grep,Edit,Write',
      '--disallowedTools', 'AskUserQuestion,ExitPlanMode,mcp__*',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--model', 'configured-model', '--resume', 'native-456',
    ]);
    expect(preview.args.join(' ')).not.toMatch(/dangerously|bypassPermissions/);
  });

  it('keeps a leading-flag Kiro prompt positional after the argument terminator', () => {
    const preview = buildCommand(request('kiro', { prompt: '--trust-all-tools; $(touch never)' }), project, connector('kiro'));
    expect(preview.args).toEqual([
      'chat', '--no-interactive', '--wrap', 'never', '--trust-tools=fs_read',
      '--output-format', 'stream-json', '--', '--trust-all-tools; $(touch never)',
    ]);
    expect(preview.stdin).toBe(false);
    expect(preview.displayCommand).toContain("'--trust-all-tools; $(touch never)'");
  });

  it('supports current Kiro streaming and native resume with a bounded write trust list', () => {
    const preview = buildCommand(request('kiro', {
      policy: 'workspace-write', resumeSessionId: 'kiro:session', model: 'configured-model',
    }), project, connector('kiro'), 'native-789');
    expect(preview.args).toEqual([
      'chat', '--no-interactive', '--wrap', 'never', '--trust-tools=fs_read,fs_write',
      '--model', 'configured-model', '--output-format', 'stream-json', '--resume-id', 'native-789',
      '--', 'Review this workspace',
    ]);
    expect(preview.args).not.toContain('--trust-all-tools');
  });

  it('falls back to plain Kiro output without substituting a last-session resume', () => {
    const older = connector('kiro', { supportsResume: false, supportsStreaming: false });
    expect(buildCommand(request('kiro'), project, older).args).toEqual([
      'chat', '--no-interactive', '--wrap', 'never', '--trust-tools=fs_read', '--', 'Review this workspace',
    ]);
    expect(() => buildCommand(request('kiro', { resumeSessionId: 'kiro:one' }), project, older, 'one')).toThrow(/resume/i);
  });

  it.each([
    { version: 'kiro-cli 2.8.0', policy: 'read-only' as const, trust: '--trust-tools=fs_read' },
    { version: 'kiro-cli 3.0.0', policy: 'read-only' as const, trust: '--trust-tools=read,grep' },
    { version: 'kiro-cli 3.1.2', policy: 'workspace-write' as const, trust: '--trust-tools=read,grep,write' },
  ])('uses version-aware Kiro trust categories and stdin for $version $policy', ({ version, policy, trust }) => {
    const preview = buildCommand(request('kiro', { policy, prompt: 'private task' }), project, connector('kiro', { version }));
    expect(preview.args).toEqual([
      'chat', '--no-interactive', '--wrap', 'never', trust, '--output-format', 'stream-json',
    ]);
    expect(preview.stdin).toBe(true);
    expect(preview.displayCommand).not.toContain('private task');
    expect(preview.policyDescription).toMatch(/hooks/i);
  });

  it.each([
    { version: '2.1.258 (Claude Code)', want: false },
    { version: '2.1.259 (Claude Code)', want: true },
    { version: '2.2.0 (Claude Code)', want: true },
  ])('gates Claude prompt suppression for $version', ({ version, want }) => {
    const preview = buildCommand(request('claude'), project, connector('claude', { version }));
    expect(preview.args.includes('--permission-prompts')).toBe(want);
  });

  it('requires explicit workspace-write shell opt-in and keeps Claude MCP configuration empty', () => {
    const preview = buildCommand(request('claude', { policy: 'workspace-write', allowShell: true }), project, connector('claude'));
    expect(preview.args).toEqual([
      '--print', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'acceptEdits',
      '--tools', 'Read,Glob,Grep,Edit,Write,Bash', '--allowedTools', 'Read,Glob,Grep,Edit,Write,Bash',
      '--disallowedTools', 'AskUserQuestion,ExitPlanMode,mcp__*',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    ]);
    expect(preview.policyDescription).toMatch(/shell|Bash/i);
    expect(preview.warnings.join(' ')).toMatch(/OS|process/i);
    expect(() => buildCommand(request('claude', { allowShell: true }), project, connector('claude'))).toThrow(/read-only|workspace-write/i);
  });

  it.each([
    { version: 'kiro-cli 2.8.0', trust: '--trust-tools=fs_read,fs_write,execute_bash' },
    { version: 'kiro-cli 3.0.1', trust: '--trust-tools=read,grep,write,shell' },
  ])('uses the native shell category only with explicit Kiro opt-in for $version', ({ version, trust }) => {
    const preview = buildCommand(request('kiro', { policy: 'workspace-write', allowShell: true }), project, connector('kiro', { version }));
    expect(preview.args).toEqual([
      'chat', '--no-interactive', '--wrap', 'never', trust, '--output-format', 'stream-json',
    ]);
    expect(preview.warnings.join(' ')).toMatch(/OS|process/i);
  });

  it('quotes executable apostrophes and redacts display secrets without modifying real argv', () => {
    const executable = probe("agent's tool");
    const preview = buildCommand(request('kiro', { prompt: "don't share token=fixture-secret-value" }), project, connector('kiro', { executable }));
    expect(preview.displayCommand).toContain("/agent'\\''s tool'");
    expect(preview.displayCommand).toContain("don'\\''t");
    expect(preview.displayCommand).not.toContain('fixture-secret-value');
    expect(preview.args.at(-1)).toBe("don't share token=fixture-secret-value");
  });

  it.each([
    { installed: false },
    { executable: null },
    { executable: '/definitely/missing/agent-ops-executable' },
    { executable: 'codex' },
  ])('rejects a connector that cannot be executed safely: %j', (patch) => {
    expect(() => buildCommand(request(), project, connector('codex', patch))).toThrow(/executable|installed/i);
  });

  it('rejects non-executable files and directories', () => {
    const executable = probe('not-executable');
    chmodSync(executable, 0o600);
    expect(() => buildCommand(request(), project, connector('codex', { executable }))).toThrow(/executable/i);
    expect(() => buildCommand(request(), project, connector('codex', { executable: root }))).toThrow(/executable/i);
  });

  it('uses conservative generic capabilities only through the internal sample-preview option', () => {
    const missing = connector('kiro', { installed: false, executable: null, version: 'kiro-cli 3.0.1' });
    const preview = buildCommand(request('kiro'), project, missing, undefined, { previewOnly: true });
    expect(preview.executable).toBe('kiro-cli');
    expect(preview.args).toEqual([
      'chat', '--no-interactive', '--wrap', 'never', '--trust-tools=fs_read', '--', 'Review this workspace',
    ]);
    expect(preview.stdin).toBe(false);
    expect(preview.warnings.join(' ')).toMatch(/unverified/i);
    expect(() => buildCommand(request('kiro', { resumeSessionId: 'kiro:one' }), project, missing, 'one', { previewOnly: true }))
      .toThrowError(expect.objectContaining({ statusCode: 409 }));
    expect(() => buildCommand(request(), project, connector('codex', { executable: 'codex' }), undefined, { previewOnly: true }))
      .toThrowError(expect.objectContaining({ statusCode: 409 }));
  });

  it.each([
    { policy: 'danger-full-access' },
    { agent: 'other' },
    { model: '--config=evil' },
    { model: 'model\n--dangerously-skip-permissions' },
    { prompt: 'bad\0prompt' },
    { prompt: '   ' },
    { executable: '/bin/sh' },
    { args: ['--trust-all-tools'] },
    { cwd: '/' },
    { env: { PATH: '/evil' } },
    { previewOnly: true },
  ])('rejects invalid policy and request-controlled execution fields: %j', (patch) => {
    expect(() => buildCommand({ ...request(), ...patch } as RunRequest, project, connector())).toThrow();
  });

  it('rejects mismatched agents, unresolved resumes and native IDs that look like options', () => {
    expect(() => buildCommand(request(), project, connector('claude'))).toThrow(/agent|connector/i);
    expect(() => buildCommand(request('codex', { resumeSessionId: 'unknown' }), project, connector())).toThrow(/session|resume/i);
    expect(() => buildCommand(request('codex', { resumeSessionId: 'codex:one' }), project, connector(), '--last')).toThrow(/session|resume/i);
  });

  it.each([
    { patch: { policy: 'unsafe' }, status: {}, nativeId: undefined, code: 400 },
    { patch: {}, status: { installed: false }, nativeId: undefined, code: 409 },
    { patch: { resumeSessionId: 'codex:one' }, status: { supportsResume: false }, nativeId: 'one', code: 409 },
  ])('returns an actionable HTTP status for command validation: $code', ({ patch, status, nativeId, code }) => {
    expect(() => buildCommand({ ...request(), ...patch } as RunRequest, project, connector('codex', status), nativeId))
      .toThrowError(expect.objectContaining({ statusCode: code }));
  });
});

describe('bounded connector discovery without inference', () => {
  it('probes only versions and help, derives capabilities, and checks roots without reading credentials', async () => {
    const codex = probe('codex', { help: { 'exec --help': '--json\nCommands:\n  resume', 'exec resume --help': '--json' } });
    const claude = probe('claude', { help: { '--help': '--resume <id>\n--output-format <format> text,json,stream-json\n--permission-prompts <mode> none' } });
    const kiro = probe('kiro-cli', { help: { 'chat --help': '--resume-id <id>\n--output-format <format> stream-json' } });
    mkdirSync(join(root, 'history'));
    writeFileSync(join(root, 'history.sqlite3'), 'not opened by discovery');
    vi.stubEnv('PATH', root);
    const result = await detectConnectors(settings(), { codex: 12, kiro: 3 });
    expect(result.map((item) => item.agent)).toEqual(['codex', 'claude', 'kiro']);
    expect(result[0]).toMatchObject({
      installed: true, executable: codex, version: 'fixture 1.2.3',
      existingRoots: [join(root, 'history')], sessionCount: 12, supportsResume: true, supportsStreaming: true,
    });
    expect(result[1]).toMatchObject({ installed: true, executable: claude, supportsResume: true, supportsStreaming: true, sessionCount: 0 });
    expect(result[2]).toMatchObject({ installed: true, executable: kiro, existingRoots: [join(root, 'history.sqlite3')], supportsResume: true, supportsStreaming: true, sessionCount: 3 });
    expect(calls(codex)).toContainEqual(['--version']);
    expect(calls(codex)).toContainEqual(['exec', '--help']);
    expect(calls(claude)).toContainEqual(['--help']);
    expect(calls(kiro)).toContainEqual(['chat', '--help']);
    for (const executable of [codex, claude, kiro]) {
      expect(calls(executable).every((args) => args.at(-1) === '--help' || args.join(' ') === '--version')).toBe(true);
    }
    expect(JSON.stringify(result)).not.toMatch(/authenticated|loggedIn|credential/i);
    expect(buildCommand(request('claude'), project, result[1]).args.slice(-2)).toEqual(['--permission-prompts', 'none']);
  });

  it('supports legacy Kiro without claiming that --resume means an explicit resume ID', async () => {
    probe('codex');
    probe('kiro-cli', { help: { 'chat --help': '--resume\n--no-interactive\n--wrap\n--trust-tools' } });
    vi.stubEnv('PATH', root);
    const result = await detectConnectors(settings());
    expect(result[0]).toMatchObject({ installed: true, supportsResume: true, supportsStreaming: false });
    expect(result[1]).toMatchObject({ installed: false, executable: null, supportsResume: false, supportsStreaming: false });
    expect(result[2]).toMatchObject({ installed: true, supportsResume: false, supportsStreaming: false });
  });

  it('uses a positive Kiro help probe for stdin even with an unrecognized version string', async () => {
    probe('kiro-cli', { version: 'custom build', help: { 'chat --help': 'Read the prompt from stdin if no prompt is supplied.\n--output-format' } });
    vi.stubEnv('PATH', root);
    const result = await detectConnectors(settings());
    const preview = buildCommand(request('kiro'), project, result[2]);
    expect(preview.stdin).toBe(true);
    expect(preview.args).toEqual([
      'chat', '--no-interactive', '--wrap', 'never', '--trust-tools=fs_read', '--output-format', 'stream-json',
    ]);
  });

  it('recognizes V2/V3 stdin support in older-numbered Kiro builds advertising engine selection and streaming', async () => {
    probe('kiro-cli', { version: 'kiro-cli 1.27.0', help: {
      'chat --help': '--agent-engine <engine> v2,v3\n--output-format <format> stream-json\n--resume-id <id>',
    } });
    vi.stubEnv('PATH', root);
    const detected = (await detectConnectors(settings()))[2];
    const preview = buildCommand(request('kiro'), project, detected);
    expect(preview.stdin).toBe(true);
    expect(preview.args).toEqual([
      'chat', '--no-interactive', '--wrap', 'never', '--trust-tools=fs_read', '--output-format', 'stream-json',
    ]);
  });

  it('selects the legacy engine for historical SQLite resumes only when Kiro advertises it', async () => {
    probe('kiro-cli', { version: 'kiro-cli 3.0.1', help: {
      'chat --help': '--agent-engine <engine> v2,v3\n--resume-id <id>\n--output-format <format> stream-json\nRead prompts from stdin',
    } });
    vi.stubEnv('PATH', root);
    const detected = (await detectConnectors(settings()))[2];
    const resumeConnector = connectorForResume(detected, join(root, 'conversations.sqlite3'));
    const preview = buildCommand(request('kiro', { resumeSessionId: 'kiro:old' }), project, resumeConnector, 'native-old');
    expect(preview.args).toEqual([
      'chat', '--agent-engine', 'v2', '--no-interactive', '--wrap', 'never', '--trust-tools=fs_read',
      '--output-format', 'stream-json', '--resume-id', 'native-old',
    ]);
    expect(buildCommand(request('kiro'), project, detected).args).toContain('--trust-tools=read,grep');
  });

  it('refreshes session counts and root existence even when executable probes are cached', async () => {
    const executable = probe('codex');
    vi.stubEnv('PATH', root);
    await detectConnectors(settings(), { codex: 1 });
    const firstCalls = calls(executable).length;
    mkdirSync(join(root, 'history'));
    const result = await detectConnectors(settings(), { codex: 7 });
    expect(result[0]).toMatchObject({ sessionCount: 7, existingRoots: [join(root, 'history')] });
    expect(calls(executable)).toHaveLength(firstCalls);
    invalidateConnectorCache();
    await detectConnectors(settings());
    expect(calls(executable).length).toBeGreaterThan(firstCalls);
  });

  it('reports a failed version probe as a diagnostic rather than failed authentication', async () => {
    probe('claude', { failVersion: true });
    vi.stubEnv('PATH', root);
    const result = await detectConnectors(settings());
    expect(result[1]).toMatchObject({ installed: true, version: null });
    expect(result[1].error).toMatch(/version|probe/i);
    expect(result[1].error).not.toContain('probe-private-token');
  });

  it('treats oversized version output as unknown rather than passing it through an expensive text matcher', async () => {
    probe('codex', { version: 'x'.repeat(20000) });
    vi.stubEnv('PATH', root);
    const result = await detectConnectors(settings());
    expect(result[0]).toMatchObject({ installed: true, version: null });
    expect(result[0].error).toMatch(/oversized|too long/i);
  });

  it('bounds a hung version probe even when SIGTERM is ignored', async () => {
    probe('kiro-cli', { hangVersion: true });
    vi.stubEnv('PATH', root);
    const started = Date.now();
    const result = await detectConnectors(settings());
    expect(Date.now() - started).toBeLessThan(7000);
    expect(result[2]).toMatchObject({ installed: true, version: null });
    expect(result[2].error).toMatch(/timed out|timeout/i);
  });
});
