import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { HarnessClient, HarnessDecision, HarnessRuntime, HarnessValidation } from '../../shared/harness.js';
import { redactor, secretValues } from '../mcp/redaction.js';
import {
  HARNESS_ENGINE_VERSION, HARNESS_MAX_INPUT_BYTES, HARNESS_MAX_OUTPUT_BYTES,
  HARNESS_MAX_POLICY_BYTES, HARNESS_TIMEOUT_MS, harnessPaths,
} from './types.js';

interface RuntimeOptions {
  dataDir: string;
  bridgePath?: string;
  timeoutMs?: number;
  cleanupGraceMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}
interface ValidationInput {
  policy: Record<string, unknown>;
  projectDir: string;
  signal?: AbortSignal;
}
interface EvaluationInput extends ValidationInput {
  auditPath: string;
  client: HarnessClient;
  projectId: string | null;
  policyId: string;
  policyRevision: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}
interface Job {
  ownerId: string;
  child: ChildProcess | null;
  promise: Promise<unknown>;
  stop: (reason: string) => void;
}

const MAX_REQUEST_BYTES = 128 * 1024;
const GLOBAL_CONCURRENCY = 4;
let activeProcesses = 0;
const mode = z.enum(['core', 'standard', 'enhanced']);
const shortText = z.string().max(1024);
const version = z.string().max(80).regex(/^[0-9][a-zA-Z0-9.+_-]*$/);
const probeResponse = z.object({
  protocol: z.literal(1), operation: z.literal('probe'),
  state: z.enum(['ready', 'missing', 'unsupported', 'error']),
  pythonVersion: version, engineVersion: version.nullable(),
  requiredApi: z.object({
    constitutionFromDict: z.boolean(), pipelineEvaluate: z.boolean(), toolCall: z.boolean(),
  }),
  error: shortText.nullable(),
});
const validationResponse = z.object({
  protocol: z.literal(1), operation: z.literal('validate'),
  valid: z.boolean(), engineValidated: z.boolean(), mode: mode.nullable(),
  ruleCount: z.number().int().min(0).max(1000),
  errors: z.array(shortText).max(100), warnings: z.array(shortText).max(100),
});
const decisionResponse = z.object({
  protocol: z.literal(1), operation: z.literal('evaluate'),
  action: z.enum(['allow', 'ask', 'deny', 'error']),
  risk: z.enum(['low', 'medium', 'high', 'critical']).nullable(),
  reason: z.string().min(1).max(4096),
  matchedRules: z.array(z.string().max(256)).max(100),
  engineVersion: version, executed: z.literal(false),
});

function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('Harness limits must be positive finite numbers.');
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function unchecked(): HarnessRuntime {
  return {
    state: 'unchecked', pythonPath: null, pythonVersion: null, engineVersion: null,
    testedVersion: HARNESS_ENGINE_VERSION, checkedAt: null, error: null,
  };
}

/** Do not forward native CLI credentials, loader variables, Python paths or agent configuration. */
function minimalEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/local/bin', LANG: 'C.UTF-8' };
  for (const key of ['HOME', 'SYSTEMROOT', 'WINDIR'] as const) {
    const value = source[key];
    if (value && !value.includes('\0') && value.length <= 4096) env[key] = value;
  }
  return env;
}

function safeText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[a-zA-Z0-9_]{12,}|github_pat_[a-zA-Z0-9_]+)\b/g, '[redacted]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|password|passwd|secret|token|authorization)\s*["']?\s*[:=]\s*)["']?[^"' \t\r\n,;}]+["']?/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 4096);
}

function resultRedactor(value: unknown): (text: string) => string {
  const secrets = new Set(secretValues(value));
  const stack = [{ value, hidden: false }];
  let visited = 0;
  while (stack.length) {
    if (++visited > 12000) return () => '[redacted]';
    const { value: item, hidden } = stack.pop()!;
    if (typeof item === 'string' && hidden && item) secrets.add(item);
    else if (Array.isArray(item)) for (const child of item) stack.push({ value: child, hidden });
    else if (plainObject(item)) for (const [key, child] of Object.entries(item)) {
      stack.push({ value: child, hidden: hidden || /env|headers|cookie|password|passwd|secret|token|credential|authorization|api[_-]?key|private[_-]?key|tool[_-]?input/i.test(key) });
    }
  }
  const clean = redactor([...secrets]);
  return text => safeText(clean(text, 4096));
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function jsonBytes(value: unknown, maximum: number): string {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number) => {
    if (++nodes > 12000 || depth > 32) throw new Error('Harness input exceeds the structure limit.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || (!Array.isArray(item) && !plainObject(item)) || ancestors.has(item)) {
      throw new Error('Harness input must contain only finite JSON values.');
    }
    ancestors.add(item);
    for (const value of Object.values(item)) visit(value, depth + 1);
    ancestors.delete(item);
  };
  visit(value, 0);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maximum) throw new Error('Harness input exceeds the byte limit.');
  return text;
}

function textField(value: unknown, limit = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f]/.test(value);
}

function pythonSupported(value: string): boolean {
  const [major, minor] = value.split('.').map(Number);
  return major === 3 && minor >= 10;
}

/** Readiness is evidence from an explicit probe, never a side effect of catalog/GET reads. */
export class HarnessRuntimeManager {
  private readonly dataDir: string;
  private readonly bridgePath: string;
  private readonly timeoutMs: number;
  private readonly cleanupGraceMs: number;
  private readonly maxOutputBytes: number;
  private readonly sourceEnv: NodeJS.ProcessEnv;
  private readonly env: NodeJS.ProcessEnv;
  private runtime = unchecked();
  private readonly jobs = new Set<Job>();
  private generation = 0;
  private closed = false;

  constructor(options: RuntimeOptions) {
    this.dataDir = resolve(options.dataDir);
    this.bridgePath = options.bridgePath ?? fileURLToPath(new URL('./bridge.py', import.meta.url));
    if (!isAbsolute(this.bridgePath)) throw new Error('Harness bridge path must be absolute.');
    this.timeoutMs = boundedOption(options.timeoutMs, HARNESS_TIMEOUT_MS, HARNESS_TIMEOUT_MS);
    this.cleanupGraceMs = boundedOption(options.cleanupGraceMs, 100, 1000);
    this.maxOutputBytes = boundedOption(options.maxOutputBytes, HARNESS_MAX_OUTPUT_BYTES, HARNESS_MAX_OUTPUT_BYTES);
    this.sourceEnv = { ...(options.env ?? process.env) };
    this.env = minimalEnvironment(this.sourceEnv);
  }

  get info(): HarnessRuntime { return { ...this.runtime }; }

  get resourceRoots(): Array<{ pid: number; ownerId: string; kind: 'harness'; processGroup: boolean }> {
    return [...this.jobs].flatMap(job => job.child?.pid ? [{
      pid: job.child.pid, ownerId: job.ownerId, kind: 'harness' as const, processGroup: process.platform !== 'win32',
    }] : []);
  }

  invalidate(): void {
    this.generation++;
    this.runtime = unchecked();
    for (const job of this.jobs) job.stop('Harness runtime settings changed.');
  }

  async probe(pythonPath?: string | null, signal?: AbortSignal): Promise<HarnessRuntime> {
    const generation = this.generation;
    const deadline = Date.now() + this.timeoutMs;
    let result: HarnessRuntime = { ...unchecked(), state: 'missing', checkedAt: new Date().toISOString(), error: 'Python was not found.' };
    const priority = { unchecked: 0, unsupported: 1, missing: 2, error: 3, ready: 4 };
    try {
      this.checkCurrent(generation, signal);
      if (pythonPath != null && (!isAbsolute(pythonPath) || pythonPath.includes('\0'))) {
        throw new Error('Python executable must be an absolute path.');
      }
      const candidates = pythonPath ? [pythonPath] : await this.candidates();
      for (const candidate of candidates) {
        this.checkCurrent(generation, signal);
        if (Date.now() >= deadline) throw new Error('Harness probe timed out.');
        let current: HarnessRuntime;
        try {
          const executable = await stat(candidate).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
            throw new Error('Python executable could not be inspected.');
          });
          if (!executable) {
            current = {
              ...unchecked(), state: 'missing', pythonPath: candidate, checkedAt: new Date().toISOString(),
              error: 'Python executable was not found.',
            };
            if (!result.pythonPath || priority[current.state] > priority[result.state]) result = current;
            continue;
          }
          if (!executable.isFile()) throw new Error('Python executable must be a regular executable file.');
          const raw = await this.run(candidate, { protocol: 1, operation: 'probe', dataDir: this.dataDir },
            dirname(this.bridgePath), generation, signal, deadline - Date.now());
          const parsed = probeResponse.safeParse(raw);
          if (!parsed.success) throw new Error('Harness bridge returned an invalid probe report.');
          const data = parsed.data;
          if (data.state === 'ready' && (!pythonSupported(data.pythonVersion)
            || data.engineVersion !== HARNESS_ENGINE_VERSION || !Object.values(data.requiredApi).every(Boolean) || data.error)) {
            throw new Error('Harness bridge did not confirm a supported engine and its required API.');
          }
          current = {
            state: data.state, pythonPath: candidate, pythonVersion: data.pythonVersion,
            engineVersion: data.engineVersion, testedVersion: HARNESS_ENGINE_VERSION,
            checkedAt: new Date().toISOString(), error: data.error ? safeText(data.error) : null,
          };
        } catch (error) {
          current = { ...unchecked(), state: 'error', pythonPath: candidate, checkedAt: new Date().toISOString(), error: this.message(error) };
        }
        if (!result.pythonPath || priority[current.state] > priority[result.state]) result = current;
        if (current.state === 'ready' || signal?.aborted || this.closed || generation !== this.generation) break;
      }
    } catch (error) {
      result = { ...unchecked(), state: 'error', pythonPath: pythonPath ?? null, checkedAt: new Date().toISOString(), error: this.message(error) };
    }
    if (generation !== this.generation) {
      return { ...unchecked(), state: 'error', checkedAt: new Date().toISOString(), error: 'Harness runtime settings changed.' };
    }
    if (!this.closed) this.runtime = result;
    return { ...result };
  }

  async validate(input: ValidationInput): Promise<HarnessValidation> {
    const generation = this.generation;
    try {
      this.checkReady(generation, input.signal);
      await this.validateInput(input);
      const raw = await this.run(this.runtime.pythonPath!, {
        protocol: 1, operation: 'validate', dataDir: this.dataDir, policy: input.policy, projectDir: input.projectDir,
      }, input.projectDir, generation, input.signal);
      this.checkCurrent(generation, input.signal);
      const parsed = validationResponse.safeParse(raw);
      if (!parsed.success || (parsed.data.valid && (!parsed.data.engineValidated || parsed.data.errors.length))) {
        throw new Error('Harness bridge returned an invalid validation report.');
      }
      const { valid, engineValidated, mode, ruleCount, errors, warnings } = parsed.data;
      const clean = resultRedactor(input.policy);
      return { valid, engineValidated, mode, ruleCount, errors: errors.map(clean), warnings: warnings.map(clean) };
    } catch (error) {
      return { valid: false, engineValidated: false, mode: null, ruleCount: 0, errors: [this.message(error)], warnings: [] };
    }
  }

  async evaluate(input: EvaluationInput): Promise<HarnessDecision> {
    const generation = this.generation;
    const started = Date.now();
    let clean = safeText;
    const base = () => ({
      client: input.client, projectId: input.projectId === null ? null : clean(input.projectId),
      policyId: clean(input.policyId), policyRevision: clean(input.policyRevision), toolName: clean(input.toolName),
      engineVersion: this.runtime.engineVersion ?? HARNESS_ENGINE_VERSION,
      checkedAt: new Date().toISOString(), durationMs: Date.now() - started, executed: false as const,
    });
    try {
      this.checkReady(generation, input.signal);
      await this.validateInput(input);
      if (!plainObject(input.toolInput)) throw new Error('Harness tool input must be a JSON object.');
      jsonBytes(input.toolInput, HARNESS_MAX_INPUT_BYTES);
      clean = resultRedactor({ policy: input.policy, tool_input: input.toolInput });
      if (!['codex', 'claude-code', 'kiro-ide', 'kiro-cli'].includes(input.client)
        || !textField(input.toolName, 128) || !textField(input.policyId) || !textField(input.policyRevision)
        || (input.projectId !== null && !textField(input.projectId))
        || !isAbsolute(input.auditPath) || resolve(input.auditPath) !== harnessPaths(this.dataDir, input.projectId).auditPath) {
        throw new Error('Harness evaluation metadata or audit path is invalid.');
      }
      const raw = await this.run(this.runtime.pythonPath!, {
        protocol: 1, operation: 'evaluate', dataDir: this.dataDir, policy: input.policy,
        projectDir: input.projectDir, auditPath: input.auditPath, client: input.client, projectId: input.projectId,
        policyId: input.policyId, policyRevision: input.policyRevision, toolName: input.toolName, toolInput: input.toolInput,
      }, input.projectDir, generation, input.signal);
      this.checkCurrent(generation, input.signal);
      const parsed = decisionResponse.safeParse(raw);
      if (!parsed.success || parsed.data.engineVersion !== HARNESS_ENGINE_VERSION) {
        throw new Error('Harness bridge returned an invalid decision.');
      }
      const { action, risk, reason, matchedRules } = parsed.data;
      return { ...base(), action, risk, reason: clean(reason), matchedRules: matchedRules.map(clean) };
    } catch (error) {
      return { ...base(), action: 'error', risk: null, reason: this.message(error), matchedRules: [] };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.invalidate();
    await Promise.all([...this.jobs].map(job => job.promise.catch(() => {})));
  }

  private message(error: unknown): string {
    // Only errors created here reach this function; child stderr and JSON parse errors are discarded.
    return error instanceof Error && /^(Harness|Python)\b/.test(error.message)
      ? safeText(error.message) : 'Harness operation failed.';
  }

  private checkCurrent(generation: number, signal?: AbortSignal): void {
    if (this.closed) throw new Error('Harness runtime is closed.');
    if (generation !== this.generation) throw new Error('Harness runtime settings changed.');
    if (signal?.aborted) throw new Error('Harness operation cancelled.');
  }

  private checkReady(generation: number, signal?: AbortSignal): void {
    this.checkCurrent(generation, signal);
    if (this.runtime.state !== 'ready' || !this.runtime.pythonPath) throw new Error('Harness engine must be explicitly probed before use.');
  }

  private async validateInput(input: ValidationInput): Promise<void> {
    if (!plainObject(input.policy)) throw new Error('Harness policy must be a JSON object.');
    jsonBytes(input.policy, HARNESS_MAX_POLICY_BYTES);
    if (!isAbsolute(input.projectDir) || input.projectDir.includes('\0')
      || !await stat(input.projectDir).then(info => info.isDirectory(), () => false)) {
      throw new Error('Harness project directory is invalid.');
    }
  }

  private async candidates(): Promise<string[]> {
    const names = ['python3.12', 'python3.11', 'python3'];
    const paths = [join(this.dataDir, 'harness', 'venv', 'bin', 'python')];
    const directories = (this.sourceEnv.PATH ?? '').split(delimiter).filter(path => isAbsolute(path) && !path.includes('\0')).slice(0, 64);
    for (const name of names) for (const directory of directories) paths.push(join(directory, name));
    const found = await Promise.all([...new Set(paths)].map(async path => {
      try {
        if (!(await stat(path)).isFile()) return null;
        await access(path, constants.X_OK);
        return path;
      } catch { return null; }
    }));
    return found.filter((path): path is string => path !== null);
  }

  private async run(
    python: string, request: Record<string, unknown>, cwd: string, generation: number,
    abort?: AbortSignal, budgetMs = this.timeoutMs,
  ): Promise<unknown> {
    const input = jsonBytes(request, MAX_REQUEST_BYTES);
    this.checkCurrent(generation, abort);
    if (!isAbsolute(python) || python.includes('\0')) throw new Error('Python executable must be an absolute path.');
    if (this.jobs.size >= 1 || activeProcesses >= GLOBAL_CONCURRENCY) throw new Error('Harness process concurrency limit reached.');
    let resolveResult!: (value: unknown) => void;
    let rejectResult!: (reason: Error) => void;
    const promise = new Promise<unknown>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    void promise.catch(() => {});
    let settled = false, cleaning = false, closed = false;
    let failure: string | null = null;
    let code: number | null = null;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const processGroup = process.platform !== 'win32';
    const job: Job = { ownerId: `harness:${randomUUID()}`, child: null, promise, stop: reason => stop(reason) };
    this.jobs.add(job);
    activeProcesses++;
    const later = (callback: () => void, ms: number) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
      timers.add(timer);
    };
    const closePipes = () => {
      job.child?.stdin?.destroy();
      job.child?.stdout?.destroy();
      job.child?.stderr?.destroy();
    };
    const groupAlive = () => {
      if (!job.child?.pid) return false;
      try { process.kill(processGroup ? -job.child.pid : job.child.pid, 0); return true; }
      catch { return false; }
    };
    const kill = (signal: NodeJS.Signals) => {
      if (!job.child?.pid || settled) return;
      try {
        if (processGroup) process.kill(-job.child.pid, signal);
        else if (job.child.exitCode === null && job.child.signalCode === null) job.child.kill(signal);
      } catch { /* The captured PID/group belongs exclusively to this request. */ }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      abort?.removeEventListener('abort', cancel);
      closePipes();
      job.child?.unref();
      this.jobs.delete(job);
      activeProcesses--;
      if (failure) { chunks.length = 0; rejectResult(new Error(failure)); return; }
      try {
        if (!closed || code !== 0) throw new Error();
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!plainObject(value)) throw new Error();
        resolveResult(value);
      } catch { rejectResult(new Error('Harness bridge returned invalid output.')); }
      chunks.length = 0;
    };
    const cleanup = () => {
      if (cleaning || settled) return;
      cleaning = true;
      kill('SIGTERM');
      later(() => {
        kill('SIGKILL');
        closePipes();
        if (!groupAlive()) finish();
        else later(finish, this.cleanupGraceMs);
      }, this.cleanupGraceMs);
    };
    const stop = (reason: string) => {
      if (settled) return;
      failure ??= reason;
      closePipes();
      if (!job.child?.pid) { finish(); return; }
      cleanup();
    };
    const cancel = () => stop('Harness operation cancelled.');
    try {
      job.child = spawn(python, ['-I', this.bridgePath], {
        shell: false, cwd, env: this.env, windowsHide: true, detached: processGroup,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const child = job.child;
      for (const [stream, retain] of [[child.stdout, true], [child.stderr, false]] as const) {
        stream!.on('data', (chunk: Buffer) => {
          if (settled || failure) return;
          bytes += chunk.byteLength;
          if (bytes > this.maxOutputBytes) { stop('Harness output exceeded the byte limit.'); return; }
          if (retain) chunks.push(chunk);
        });
        stream!.on('error', () => stop('Harness output pipe failed.'));
      }
      child.stdin!.on('error', () => stop('Harness input pipe failed.'));
      child.once('error', () => stop('Harness Python process could not start.'));
      child.once('exit', (exitCode, signal) => {
        code = exitCode;
        if (exitCode !== 0 || signal) failure ??= 'Harness Python process failed.';
        if (groupAlive()) cleanup();
        // Descendants may retain pipes even after their leader exits.
        later(() => {
          if (!closed) stop('Harness output pipes did not close.');
        }, this.cleanupGraceMs);
      });
      child.once('close', exitCode => {
        closed = true;
        code = exitCode;
        if (cleaning) return;
        if (groupAlive()) cleanup();
        else finish();
      });
      // Include escalation and inherited-pipe cleanup in the overall <=15s budget.
      const runtimeMs = Math.max(1, Math.min(budgetMs, HARNESS_TIMEOUT_MS) - 2 * this.cleanupGraceMs);
      later(() => stop('Harness operation timed out.'), runtimeMs);
      abort?.addEventListener('abort', cancel, { once: true });
      if (abort?.aborted) cancel();
      if (!failure) child.stdin!.end(input);
    } catch { stop('Harness Python process could not start.'); }
    return promise;
  }
}
