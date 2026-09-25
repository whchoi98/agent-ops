import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { realpathSync, statSync, type Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import {
  emptyUsage, type CommandPreview, type ConnectorStatus, type Project, type Run,
  type RunEvent, type RunRequest, type Usage,
} from '../shared/types.js';
import { buildCommand, validateRunRequest, redactCliText as redact } from './commands.js';
import { connectorForResume, detectConnectors } from './connectors.js';
import { newId, type Store } from './store.js';
import type { OwnedProcessRoot } from './resources/processes.js';

type Notice = { type: 'refresh' } | { type: 'run-event'; runId: string; event: RunEvent };
type Options = {
  demo?: boolean;
  onEvent?: (event: Notice) => void;
  connectors?: () => Promise<ConnectorStatus[]>;
  spawn?: typeof nodeSpawn;
  timeoutMs?: number;
};
type Workspace = { path: string; identity: string };
type Prepared = { project: Project; workspace: Workspace; preview: CommandPreview; nativeId?: string };
type Budget = { bytes: number; count: number; truncated: boolean };
type StopReason = 'cancelled' | 'timeout' | 'shutdown' | 'persistence';
type Owned = {
  run: Run; workspace: Workspace; child: ChildProcess;
  done: Promise<Run>; resolve: (run: Run) => void;
  exited: boolean; closed: boolean; finalizing: boolean;
  code: number | null; signal: NodeJS.Signals | null;
  stop?: StopReason; spawnError?: string; streamError?: string; providerError?: string; provisionalError?: string; providerInterrupted?: boolean;
  persistenceError?: string; drainWarning?: string;
  timeout?: NodeJS.Timeout; escalation?: NodeJS.Timeout; drainDeadline?: NodeJS.Timeout;
  outputs: OutputLines[]; forcedDrain: boolean; groupGone: boolean;
  usage: Usage; nativeId: string | null;
};
type RecordValue = Record<string, unknown>;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 5000;
const TERMINAL_RESERVE = 2048;
const MAX_LINE_BYTES = 1024 * 1024;
const TERM_GRACE_MS = 1000;
const DRAIN_GRACE_MS = TERM_GRACE_MS + 500;
const RECONCILE_INTERVAL_MS = 5000;
const RECONCILE_BATCH_SIZE = 16;
const RECONCILE_BUDGET_MS = 100;
const RECONCILE_BUSY_MS = 20;
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const failure = (statusCode: number, message: string) => Object.assign(new Error(redact(message)), { statusCode });
const messageOf = (error: unknown) => redact(error instanceof Error ? error.message : String(error));
const object = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
const measured = (...values: unknown[]): number | null => {
  for (const value of values) if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  return null;
};
const snapshot = (run: Run): Run => ({ ...run, usage: { ...run.usage } });
function clipBytes(text: string, bytes: number): string {
  if (bytes <= 0) return '';
  const buffer = Buffer.from(text);
  return buffer.length <= bytes ? text : new StringDecoder('utf8').write(buffer.subarray(0, bytes));
}
function workspaceIdentity(path: string, info: Stats): string {
  return info.ino ? `${info.dev}:${info.ino}` : process.platform === 'win32' ? path.toLowerCase() : path;
}
function requestFrom(run: Run): RunRequest {
  return {
    agent: run.agent, projectId: run.projectId, prompt: run.prompt, policy: run.policy,
    title: run.title, model: run.model, allowShell: run.allowShell,
    resumeSessionId: run.resumeSessionId, sourceSessionId: run.sourceSessionId, templateId: run.templateId,
  };
}
function usageOf(value: unknown, extraCost?: unknown): Usage {
  const usage = object(value) || {};
  const cost = object(usage.cost);
  return {
    inputTokens: measured(usage.input_tokens, usage.inputTokens),
    outputTokens: measured(usage.output_tokens, usage.outputTokens),
    cacheReadTokens: measured(usage.cached_input_tokens, usage.cache_read_input_tokens, usage.cachedReadTokens, usage.cacheReadTokens),
    cacheWriteTokens: measured(usage.cache_write_input_tokens, usage.cache_creation_input_tokens, usage.cachedWriteTokens, usage.cacheWriteTokens),
    costUsd: measured(extraCost, usage.cost_usd, usage.costUsd, cost?.currency === 'USD' ? cost.amount : undefined),
  };
}
function mergeUsage(current: Usage, reported: Usage, add: boolean): Usage {
  const next = { ...current };
  for (const key of Object.keys(reported) as Array<keyof Usage>) {
    const value = reported[key];
    if (value !== null) next[key] = add && current[key] !== null ? current[key]! + value : value;
  }
  return next;
}
function safeJson(value: unknown): string {
  const secretKey = /^(?:authorization|proxy-authorization|[A-Z0-9_]*(?:api[_-]?key|secret[_-]?(?:access[_-]?)?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret)|token)$/i;
  return JSON.stringify(value, (key, item: unknown) => {
    if (secretKey.test(key) && item !== null) return '[REDACTED]';
    return typeof item === 'string'
      ? redact(item).replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g, '[REDACTED PRIVATE KEY]')
      : item;
  });
}

/** Assemble complete UTF-8 lines before redaction; oversized lines are discarded, never leaked in fragments. */
class OutputLines {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private discarding = false;
  private privateKey = false;
  private ended = false;
  constructor(
    private readonly protocol: (raw: string) => void,
    private readonly line: (safe: string) => void,
    private readonly truncated: () => void,
  ) {}
  push(chunk: Buffer) { if (!this.ended) this.consume(this.decoder.write(chunk)); }
  end() {
    if (this.ended) return;
    this.ended = true;
    this.consume(this.decoder.end());
    if (this.pending && !this.discarding) this.emit(this.pending);
    this.pending = '';
  }
  private consume(text: string) {
    let offset = 0;
    for (;;) {
      const newline = text.indexOf('\n', offset);
      const fragment = newline < 0 ? text.slice(offset) : text.slice(offset, newline);
      if (!this.discarding) {
        this.pending += fragment;
        if (Buffer.byteLength(this.pending) > MAX_LINE_BYTES) {
          // If an oversized line starts a PEM block, keep suppressing its later lines.
          if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(this.pending)) this.privateKey = true;
          this.pending = '';
          this.discarding = true;
          this.truncated();
        }
      }
      if (newline < 0) break;
      if (!this.discarding) this.emit(this.pending.replace(/\r$/, ''));
      this.pending = '';
      this.discarding = false;
      offset = newline + 1;
    }
  }
  private emit(raw: string) {
    // Protocol outcomes must not depend on whether the display filter suppresses a line.
    this.protocol(raw);
    if (!this.privateKey) {
      try {
        const value: unknown = JSON.parse(raw);
        this.line(safeJson(value));
        return;
      } catch { /* Plain-text output may contain a multiline PEM block. */ }
    }
    let text = raw;
    if (this.privateKey) {
      const end = /-----END [A-Z ]*PRIVATE KEY-----/.exec(text);
      if (!end) return;
      text = text.slice(end.index + end[0].length);
      this.privateKey = false;
    }
    const begin = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.exec(text);
    if (begin && !/-----END [A-Z ]*PRIVATE KEY-----/.test(text.slice(begin.index))) {
      text = `${text.slice(0, begin.index)}[REDACTED PRIVATE KEY]`;
      this.privateKey = true;
    }
    let safe: string;
    try { safe = safeJson(JSON.parse(text)); } catch { safe = redact(text); }
    this.line(safe);
  }
}

export class Runner {
  private readonly owned = new Map<string, Owned>();
  private readonly queuedWorkspaces = new Map<string, Workspace>();
  private readonly budgets = new Map<string, Budget>();
  // SQLite may retain a queued/running row after a failed transaction. Never
  // relaunch it, and expose its terminal result until storage can be reconciled.
  private readonly unpersisted = new Map<string, Run>();
  private reconcileTask?: NodeJS.Immediate;
  private reconcileAfter = 0;
  private reconciling = false;
  private deferredNotices: Notice[] | null = null;
  private started = false;
  private closing = false;
  private draining = false;
  private pumpAgain = false;
  private closingPromise?: Promise<void>;
  constructor(private readonly store: Store, private readonly options: Options = {}) {}

  /** Metadata only; callers cannot obtain or signal the owned ChildProcess. */
  get resourceRoots(): OwnedProcessRoot[] {
    return [...this.owned.values()].flatMap(state => {
      const pid = state.child.pid;
      if (!pid || state.groupGone || process.platform === 'win32' && state.exited) return [];
      return [{ pid, ownerId: state.run.id, kind: 'agents' as const, processGroup: process.platform !== 'win32' }];
    });
  }

  getRun(id: string): Run | null {
    this.scheduleReconciliation();
    const pending = this.unpersisted.get(id);
    return pending ? snapshot(pending) : this.store.getRun(id);
  }

  listRuns(limit = 200): Run[] {
    this.scheduleReconciliation();
    // The original rows retain their creation order and remain subject to LIMIT.
    return this.store.listRuns(limit).map((run) => {
      const pending = this.unpersisted.get(run.id);
      return pending ? snapshot(pending) : run;
    });
  }

  start(): void {
    if (this.started || this.closing || this.options.demo) return;
    this.started = true;
    for (const run of this.store.listRuns(-1)) {
      if (run.status === 'running' || run.status === 'queued') {
        this.finishQueued(run, 'interrupted', 'Server restarted. Previous work was interrupted and was not automatically resumed.');
      }
    }
  }

  async preview(input: RunRequest): Promise<CommandPreview> {
    this.assertOpen();
    const request = this.copyRequest(input);
    return (await this.prepare(request, true)).preview;
  }

  async create(input: RunRequest): Promise<Run> {
    this.assertOpen();
    if (this.options.demo) throw failure(403, 'Demo mode cannot execute agents.');
    this.start();
    const request = this.copyRequest(input);
    const prepared = await this.prepare(request);
    this.assertOpen();
    const run: Run = {
      ...request, id: newId('run'),
      title: redact(request.title || request.prompt).replace(/\s+/g, ' ').trim().slice(0, 120),
      status: 'queued', projectName: prepared.project.name, projectPath: prepared.workspace.path,
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, exitCode: null,
      error: null, nativeSessionId: prepared.nativeId || null, usage: emptyUsage(),
      command: prepared.preview.displayCommand,
    };
    this.store.insertRun(run);
    this.queuedWorkspaces.set(run.id, prepared.workspace);
    try {
      this.append(run.id, 'system', `Run queued with ${run.policy} policy${run.allowShell ? ' and explicit shell opt-in' : ''}.`);
    } catch (error) {
      this.finishQueued(run, 'failed', `Could not persist the queue audit: ${messageOf(error)}`);
      throw failure(503, 'Could not persist the run audit. No process was launched.');
    }
    this.publish({ type: 'refresh' });
    this.pump();
    return run;
  }

  async cancel(id: string): Promise<Run> {
    this.assertOpen();
    const state = this.owned.get(id);
    const run = state?.run || this.getRun(id);
    if (!run) throw failure(404, 'Run not found.');
    if (this.options.demo) throw failure(409, 'Demo runs are static records and cannot be cancelled.');
    if (terminalStatuses.has(run.status)) return run;
    if (run.status === 'queued') {
      const result = this.finishQueued(run, 'cancelled', null);
      this.pump();
      return result;
    }
    if (!state) throw failure(409, 'This running process is not owned by this application instance.');
    if (!state.exited) this.stop(state, 'cancelled');
    return state.done;
  }

  async retry(id: string): Promise<Run> {
    this.assertOpen();
    if (this.options.demo) throw failure(403, 'Demo mode cannot retry agent runs.');
    const run = this.getRun(id);
    if (!run) throw failure(404, 'Run not found.');
    if (!['failed', 'cancelled', 'interrupted'].includes(run.status)) throw failure(409, 'Retry is available only for failed, cancelled or interrupted runs.');
    return this.create(requestFrom(run));
  }

  pump(): void {
    if (this.closing || this.options.demo) return;
    this.start();
    this.scheduleReconciliation();
    if (this.draining) { this.pumpAgain = true; return; }
    void this.drain();
  }

  close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closing = true;
    if (this.reconcileTask) clearImmediate(this.reconcileTask);
    this.reconcileTask = undefined;
    this.closingPromise = (async () => {
      if (this.options.demo) return;
      const active = [...this.owned.values()];
      try {
        // Signal owned children before attempting any shutdown persistence.
        for (const state of active) {
          if (!state.exited) this.stop(state, 'shutdown');
          else this.armDrainDeadline(state);
        }
        for (const run of this.store.queuedRuns()) {
          if (!this.unpersisted.has(run.id)) this.finishQueued(run, 'interrupted', 'Application shutdown interrupted the queued run.');
        }
      } finally {
        await Promise.all(active.map((state) => state.done));
        this.reconcile(true);
        this.budgets.clear();
        this.queuedWorkspaces.clear();
      }
    })();
    return this.closingPromise;
  }

  private assertOpen() {
    if (this.closing) throw failure(409, 'Runner is closed for application shutdown.');
  }
  private copyRequest(input: RunRequest): RunRequest {
    try { validateRunRequest(input); }
    catch (error) { throw failure(400, messageOf(error)); }
    return { ...input };
  }
  private publish(notice: Notice) {
    if (this.deferredNotices) { this.deferredNotices.push(notice); return; }
    try { this.options.onEvent?.(notice); } catch { /* An observer cannot own process lifecycle. */ }
  }
  private concurrency(): number {
    const value = this.store.getSettings().concurrency;
    return Number.isFinite(value) ? Math.max(1, Math.min(8, Math.floor(value))) : 1;
  }
  private timeoutMs(): number {
    const value = this.options.timeoutMs ?? this.store.getSettings().timeoutMinutes * 60_000;
    return Number.isFinite(value) && value > 0 ? Math.min(value, 2_147_483_647) : 30 * 60_000;
  }
  private async workspace(path: string, virtual = false): Promise<Workspace> {
    if (!isAbsolute(path) || path.includes('\0')) throw failure(400, 'Project workspace must be an absolute directory path.');
    try {
      const canonical = await realpath(path);
      const info = await stat(canonical);
      if (!info.isDirectory()) throw failure(400, 'Project workspace is not a directory.');
      return { path: canonical, identity: workspaceIdentity(canonical, info) };
    } catch (error) {
      if (virtual && (error as NodeJS.ErrnoException).code === 'ENOENT') return { path, identity: `virtual:${path}` };
      if ('statusCode' in Object(error)) throw error;
      throw failure(400, 'Project workspace does not exist or is not an accessible directory.');
    }
  }
  private async prepare(request: RunRequest, preview = false): Promise<Prepared> {
    this.assertOpen();
    const project = this.store.getProject(request.projectId);
    if (!project) throw failure(404, 'Project not found.');
    const virtual = Boolean(preview && this.options.demo);
    if (!virtual && !project.executionEnabled) throw failure(403, 'Execution is disabled for this project. Enable it in Projects first.');
    const discovered = await (this.options.connectors?.() ?? detectConnectors(this.store.getSettings()));
    this.assertOpen();
    let connector = discovered.find((item) => item.agent === request.agent);
    if (!connector || !connector.installed) {
      if (!virtual) throw failure(409, 'The requested agent executable is not installed.');
      connector ??= {
        agent: request.agent, installed: false, executable: null, version: null,
        roots: [], existingRoots: [], sessionCount: 0, error: null, supportsResume: false, supportsStreaming: false,
      };
    }
    const workspace = await this.workspace(project.path, virtual);
    this.assertOpen();
    let nativeId: string | undefined;
    const sessionId = request.resumeSessionId || request.sourceSessionId;
    if (sessionId) {
      const session = this.store.getSession(sessionId);
      if (!session) throw failure(404, 'Source session not found.');
      if (request.resumeSessionId && 'resumable' in session && session.resumable === false) {
        throw failure(400, 'This child session cannot be resumed directly. Start a new run with a context handoff instead.');
      }
      if (request.resumeSessionId && session.agent !== request.agent) throw failure(400, 'A native resume must use the same agent as its session.');
      if (request.sourceSessionId && session.agent === request.agent) throw failure(400, 'A cross-agent source session must use a different agent.');
      const sourceWorkspace = await this.workspace(session.projectPath, virtual);
      this.assertOpen();
      if (sourceWorkspace.identity !== workspace.identity) throw failure(400, 'The source session belongs to a different project workspace.');
      if (request.resumeSessionId) {
        nativeId = session.nativeId;
        if (!nativeId) throw failure(409, 'The session has no known native resume ID.');
        connector = connectorForResume(connector, session.sourcePath);
      }
    }
    const current = this.store.getProject(project.id);
    if (!current || current.path !== project.path || (!virtual && !current.executionEnabled)) {
      throw failure(409, 'Project execution settings changed while the request was being prepared.');
    }
    try {
      return {
        project, workspace, nativeId,
        preview: buildCommand(request, { ...project, path: workspace.path }, connector, nativeId, { previewOnly: virtual }),
      };
    } catch (error) {
      if ('statusCode' in Object(error)) throw error;
      throw failure(400, messageOf(error));
    }
  }
  private verifyWorkspace(run: Run, prepared: Prepared) {
    const project = this.store.getProject(run.projectId);
    if (!project || !project.executionEnabled) throw failure(403, 'Project execution was disabled while this run was queued.');
    let current: Workspace;
    try {
      const path = realpathSync(project.path);
      const info = statSync(path);
      if (!info.isDirectory()) throw new Error('Not a directory');
      current = { path, identity: workspaceIdentity(path, info) };
    } catch { throw failure(409, 'Project workspace is no longer an accessible directory.'); }
    const original = this.queuedWorkspaces.get(run.id);
    if (current.path !== run.projectPath || current.identity !== prepared.workspace.identity
      || (original && current.identity !== original.identity)) {
      throw failure(409, 'Project workspace moved or was replaced while this run was queued. Create a new run after reviewing it.');
    }
  }
  private async drain() {
    this.draining = true;
    try {
      do {
        this.pumpAgain = false;
        for (const run of this.store.queuedRuns()) {
          if (this.closing) return;
          if (this.unpersisted.has(run.id)) continue;
          if (this.owned.size >= this.concurrency()) break;
          if ([...this.owned.values()].some((state) => state.run.projectId === run.projectId)) continue;
          try {
            const prepared = await this.prepare(requestFrom(run));
            if (this.closing) return;
            if (this.getRun(run.id)?.status !== 'queued') continue;
            this.verifyWorkspace(run, prepared);
            if ([...this.owned.values()].some((state) => state.workspace.identity === prepared.workspace.identity)) continue;
            // Settings may have changed while an executable probe was pending.
            if (this.owned.size >= this.concurrency()) break;
            this.launch(run, prepared);
          } catch (error) {
            if (this.closing) return;
            const current = this.getRun(run.id);
            if (current?.status === 'queued') this.finishQueued(current, 'failed', messageOf(error));
          }
        }
      } while (this.pumpAgain && !this.closing);
    } finally {
      this.draining = false;
      if (this.pumpAgain && !this.closing) this.pump();
    }
  }
  private budget(id: string): Budget {
    let budget = this.budgets.get(id);
    if (!budget) {
      const events = this.store.getEvents(id, 0, MAX_EVENTS);
      budget = { count: events.length, bytes: events.reduce((total, event) => total + Buffer.byteLength(event.text), 0), truncated: false };
      this.budgets.set(id, budget);
    }
    return budget;
  }
  private persistEvent(id: string, stream: RunEvent['stream'], text: string, budget: Budget) {
    if (budget.count >= MAX_EVENTS || budget.bytes + Buffer.byteLength(text) > MAX_BYTES) return;
    const event = this.store.appendEvent(id, stream, text);
    budget.count++;
    budget.bytes += Buffer.byteLength(text);
    this.publish({ type: 'run-event', runId: id, event });
  }
  private truncated(id: string) {
    const budget = this.budget(id);
    if (budget.truncated) return;
    budget.truncated = true;
    this.persistEvent(id, 'system', 'Output truncated: log storage is limited to 4 MiB, 5000 events, and 1 MiB per line. Remaining process output is still drained.', budget);
  }
  private append(id: string, stream: RunEvent['stream'], text: string, terminal = false, alreadySafe = false) {
    const budget = this.budget(id);
    const safe = alreadySafe ? text : redact(text);
    if (terminal) {
      this.persistEvent(id, stream, clipBytes(safe, Math.min(1024, MAX_BYTES - budget.bytes)), budget);
      return;
    }
    if (budget.truncated) return;
    const room = MAX_BYTES - TERMINAL_RESERVE - budget.bytes;
    if (budget.count >= MAX_EVENTS - 2 || room <= 0) { this.truncated(id); return; }
    const clipped = clipBytes(safe, room);
    this.persistEvent(id, stream, clipped, budget);
    if (clipped.length !== safe.length) this.truncated(id);
  }
  private finishQueued(run: Run, status: Run['status'], error: string | null): Run {
    try {
      return this.persistTerminal({ ...run, status, finishedAt: new Date().toISOString(), error: error ? messageOf(error) : null });
    } finally {
      this.queuedWorkspaces.delete(run.id);
      this.budgets.delete(run.id);
      this.publish({ type: 'refresh' });
    }
  }
  private persistenceResult(run: Run, detail: string): Run {
    const warning = `Could not persist run state or logs: ${clipBytes(messageOf(detail), 1000)}`;
    return {
      ...run, status: run.status === 'completed' ? 'failed' : run.status,
      error: run.error?.includes(warning) ? run.error : [run.error, warning].filter(Boolean).join(' '),
    };
  }
  private persistTerminal(run: Run): Run {
    const parentNotices = this.deferredNotices;
    const notices: Notice[] = [];
    let budget: Budget | undefined;
    let previous: Budget | undefined;
    let committed = false;
    this.deferredNotices = notices;
    try {
      budget = this.budget(run.id);
      previous = { ...budget };
      // A failed terminal log must not leave a committed "completed" row, nor
      // publish a success event from a transaction that ultimately rolls back.
      const result = this.store.db.transaction(() => {
        const saved = this.store.updateRun(run.id, run);
        if (!saved) throw new Error('Run row is missing.');
        this.append(run.id, 'system', `Run ${run.status}${run.error ? `: ${run.error}` : '.'}`, true);
        return saved;
      })();
      committed = true;
      this.unpersisted.delete(run.id);
      return result;
    } catch (error) {
      if (budget && previous) Object.assign(budget, previous);
      const result = this.persistenceResult(run, messageOf(error));
      if (!this.unpersisted.size) this.reconcileAfter = Date.now() + RECONCILE_INTERVAL_MS;
      this.unpersisted.set(run.id, snapshot(result));
      return result;
    } finally {
      this.deferredNotices = parentNotices;
      if (committed) for (const notice of notices) this.publish(notice);
    }
  }
  private scheduleReconciliation() {
    if (this.closing || this.options.demo || this.reconciling || this.reconcileTask
      || this.owned.size || !this.unpersisted.size || Date.now() < this.reconcileAfter) return;
    // A single deferred pass keeps reads cheap. There is no repeating timer.
    this.reconcileTask = setImmediate(() => {
      this.reconcileTask = undefined;
      this.reconcile();
    });
    this.reconcileTask.unref();
  }
  private reconcile(force = false) {
    if (this.reconciling || this.owned.size || !this.unpersisted.size
      || (!force && (this.closing || Date.now() < this.reconcileAfter))) return;
    this.reconciling = true;
    this.reconcileAfter = Date.now() + RECONCILE_INTERVAL_MS;
    const deadline = performance.now() + RECONCILE_BUDGET_MS;
    const parentNotices = this.deferredNotices;
    const notices: Notice[] = [];
    this.deferredNotices = notices;
    let busyTimeout: number | undefined;
    let saved = false;
    try {
      busyTimeout = Number(this.store.db.pragma('busy_timeout', { simple: true }));
      this.store.db.pragma(`busy_timeout = ${Math.min(busyTimeout, RECONCILE_BUSY_MS)}`);
      let attempts = 0;
      for (const [id, run] of this.unpersisted) {
        if (attempts++ >= RECONCILE_BATCH_SIZE || performance.now() >= deadline || this.owned.size) break;
        try { this.persistTerminal(run); }
        finally { this.budgets.delete(id); }
        if (this.unpersisted.has(id)) {
          // Preserve the original failure, timestamp and usage across retries.
          // Rotate a bad row so it cannot permanently starve later entries.
          this.unpersisted.delete(id);
          this.unpersisted.set(id, run);
          break;
        }
        saved = true;
      }
    } catch {
      // A closed, locked or full database must not hide the effective results.
    } finally {
      if (busyTimeout !== undefined) {
        try { this.store.db.pragma(`busy_timeout = ${busyTimeout}`); } catch { /* Storage is unavailable. */ }
      }
      this.deferredNotices = parentNotices;
      this.reconciling = false;
      for (const notice of notices) this.publish(notice);
      if (saved) this.publish({ type: 'refresh' });
    }
  }
  private persistOwned(state: Owned, action: () => void) {
    if (state.finalizing || this.owned.get(state.run.id) !== state) return;
    try { action(); }
    catch (error) {
      state.persistenceError ||= messageOf(error);
      if (!state.exited && !state.stop) this.stop(state, 'persistence');
    }
  }
  private launch(run: Run, prepared: Prepared) {
    let running: Run;
    let timeout: number;
    try {
      timeout = this.timeoutMs();
      running = this.store.updateRun(run.id, {
        status: 'running', startedAt: new Date().toISOString(), command: prepared.preview.displayCommand,
        nativeSessionId: prepared.nativeId || null,
      })!;
      if (!running) throw new Error('Run row is missing.');
      this.append(run.id, 'system', `Run started. ${prepared.preview.policyDescription}`);
      this.publish({ type: 'refresh' });
    } catch (error) {
      this.finishQueued(run, 'failed', `Could not persist run startup: ${messageOf(error)}`);
      return;
    }
    let child: ChildProcess;
    try {
      child = (this.options.spawn || nodeSpawn)(prepared.preview.executable, prepared.preview.args, {
        cwd: prepared.workspace.path, shell: false, detached: process.platform !== 'win32',
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.finishQueued(running, 'failed', `Could not spawn the CLI: ${messageOf(error)}`);
      this.pumpAgain = true;
      return;
    }
    let resolve!: (result: Run) => void;
    const done = new Promise<Run>((finish) => { resolve = finish; });
    const state: Owned = {
      run: running, workspace: prepared.workspace, child, done, resolve,
      exited: false, closed: false, finalizing: false, code: null, signal: null,
      usage: emptyUsage(), nativeId: prepared.nativeId || null, outputs: [], forcedDrain: false, groupGone: false,
    };
    this.owned.set(run.id, state);
    this.queuedWorkspaces.delete(run.id);
    child.stdin?.on('error', () => {}); // EPIPE may arrive before pipeline attaches its handlers.
    child.once('error', (error) => { state.spawnError = messageOf(error); });
    const readers = Promise.all([
      this.readOutput(state, child.stdout, 'stdout'), this.readOutput(state, child.stderr, 'stderr'),
    ]);
    child.once('exit', (code, signal) => {
      state.exited = true;
      state.code = code;
      state.signal = signal;
      if (state.timeout) clearTimeout(state.timeout);
      state.timeout = undefined;
      // A descendant can keep the pipes open after its leader exits.
      if (process.platform !== 'win32') this.terminateGroup(state);
      this.armDrainDeadline(state);
    });
    child.once('close', (code, signal) => {
      state.closed = true;
      state.code = state.spawnError && !child.pid ? null : code;
      state.signal = signal;
      if (state.timeout) clearTimeout(state.timeout);
      if (state.escalation) clearTimeout(state.escalation);
      state.timeout = undefined;
      state.escalation = undefined;
      this.armDrainDeadline(state);
      // Clean up same-group descendants that closed or redirected their stdio.
      // No delayed signal is allowed once this close event has been observed.
      if (process.platform !== 'win32') this.signalOwned(state, 'SIGKILL', true);
      void readers.then(() => this.complete(state));
    });
    state.timeout = setTimeout(() => this.stop(state, 'timeout'), timeout);
    state.timeout.unref();
    if (child.stdin) {
      if (prepared.preview.stdin) {
        void pipeline(Readable.from([run.prompt]), child.stdin).catch((error: NodeJS.ErrnoException) => {
          if (!['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code || '')) {
            state.streamError = `Could not write the prompt to stdin: ${messageOf(error)}`;
          }
        });
      } else child.stdin.end();
    }
  }
  private async readOutput(state: Owned, stream: Readable | null, kind: 'stdout' | 'stderr') {
    if (!stream) return;
    const lines = new OutputLines((raw) => {
      if (!state.finalizing && kind === 'stdout') this.metadata(state, raw);
    }, (safe) => {
      this.persistOwned(state, () => this.append(state.run.id, kind, safe, false, true));
    }, () => this.persistOwned(state, () => this.truncated(state.run.id)));
    state.outputs.push(lines);
    try {
      for await (const chunk of stream) {
        lines.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        // SQLite writes provide backpressure; yield between bounded pipe chunks for cancellation.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      if (!state.forcedDrain) state.streamError = `Could not read CLI ${kind}: ${messageOf(error)}`;
    } finally { lines.end(); }
  }
  private metadata(state: Owned, line: string) {
    let data: RecordValue | null;
    try { data = object(JSON.parse(line)); } catch { return; }
    if (!data) return;
    let native: unknown;
    let usage: Usage | undefined;
    let add = false;
    let providerError: unknown;
    if (state.run.agent === 'codex') {
      if (data.type === 'thread.started') native = data.thread_id;
      if (data.type === 'turn.completed') {
        usage = usageOf(data.usage);
        add = true;
        state.provisionalError = undefined;
      }
      if (data.type === 'error') {
        state.provisionalError = clipBytes(messageOf(object(data.error)?.message || data.message || 'The CLI reported an error.'), 1000);
      }
      if (data.type === 'turn.failed') providerError = object(data.error)?.message || data.message || 'The CLI reported a failed turn.';
    } else if (state.run.agent === 'claude') {
      if (data.type === 'system' && data.subtype === 'init') native = data.session_id;
      if (data.type === 'result') {
        native = data.session_id;
        usage = usageOf(data.usage, data.total_cost_usd);
        if (data.is_error === true || (typeof data.subtype === 'string' && data.subtype.startsWith('error'))) {
          providerError = data.result || (Array.isArray(data.errors) ? data.errors.join('; ') : null) || 'The CLI reported an unsuccessful result.';
        }
      }
    } else {
      const result = object(data.result);
      const params = object(data.params);
      const update = object(params?.update);
      native = result?.sessionId || params?.sessionId;
      if (result?.usage) usage = usageOf(result.usage);
      if (result?.stopReason === 'cancelled') state.providerInterrupted = true;
      if (update?.sessionUpdate === 'usage_update') usage = usageOf(update.usage || update);
      if (data.jsonrpc === '2.0' && data.error) providerError = object(data.error)?.message || 'Kiro reported a protocol error.';
      if (data.type === 'system' && data.subtype === 'init') native = data.session_id;
      if (data.type === 'result') {
        native = data.session_id;
        usage = usageOf(data.usage, data.total_cost_usd);
        if (data.is_error === true) providerError = data.result || 'Kiro reported an unsuccessful result.';
      }
    }
    let changed = false;
    if (typeof native === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/.test(native) && redact(native) === native) {
      state.nativeId = native;
      changed = true;
    }
    if (usage && Object.values(usage).some((value) => value !== null)) {
      state.usage = mergeUsage(state.usage, usage, add);
      changed = true;
    }
    if (providerError) state.providerError = clipBytes(messageOf(providerError), 1000);
    if (changed) {
      this.persistOwned(state, () => { this.store.updateRun(state.run.id, { usage: state.usage, nativeSessionId: state.nativeId }); });
      this.publish({ type: 'refresh' });
    }
  }
  private signalOwned(state: Owned, signal: NodeJS.Signals, closingCleanup = false): boolean {
    if (this.owned.get(state.run.id) !== state || state.groupGone || (state.closed && !closingCleanup)) return false;
    const pid = state.child.pid;
    if (!pid) return false;
    try {
      if (process.platform === 'win32') {
        return state.child.exitCode === null && state.child.signalCode === null && state.child.kill(signal);
      }
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') state.groupGone = true;
      else state.streamError = `Could not stop owned process group: ${messageOf(error)}`;
      return false;
    }
  }
  private terminateGroup(state: Owned) {
    if (state.closed || state.finalizing || state.escalation) return;
    this.signalOwned(state, 'SIGTERM');
    if (state.groupGone) return;
    state.escalation = setTimeout(() => {
      state.escalation = undefined;
      this.signalOwned(state, 'SIGKILL');
    }, TERM_GRACE_MS);
    state.escalation.unref();
  }
  private stop(state: Owned, reason: StopReason) {
    if (state.closed || state.finalizing || state.stop) return;
    state.stop = reason;
    if (state.timeout) clearTimeout(state.timeout);
    state.timeout = undefined;
    try {
      this.append(state.run.id, 'system', reason === 'timeout' ? 'Run timed out; terminating owned processes.'
        : reason === 'shutdown' ? 'Application shutdown; terminating owned processes.'
          : reason === 'persistence' ? 'Persistence failed; terminating owned processes.' : 'Cancellation requested; terminating owned processes.');
    } catch (error) {
      state.persistenceError ||= messageOf(error);
    } finally {
      // Audit failures must never disarm the only means of stopping a child.
      this.terminateGroup(state);
    }
  }
  private armDrainDeadline(state: Owned) {
    if (state.finalizing || state.drainDeadline || this.owned.get(state.run.id) !== state) return;
    state.drainDeadline = setTimeout(() => {
      if (state.finalizing || this.owned.get(state.run.id) !== state) return;
      state.forcedDrain = true;
      state.drainWarning = 'Output capture ended at the drain deadline. An unconfirmed background process may remain; it was not targeted outside the owned process group.';
      this.persistOwned(state, () => this.append(state.run.id, 'system', state.drainWarning!));
      // Close only our pipe ends. Never infer the PID of a process holding them.
      state.child.stdin?.destroy();
      state.child.stdout?.destroy();
      state.child.stderr?.destroy();
      for (const output of state.outputs) output.end();
      this.complete(state);
    }, DRAIN_GRACE_MS);
    state.drainDeadline.unref();
  }
  private clearTimers(state: Owned) {
    if (state.timeout) clearTimeout(state.timeout);
    if (state.escalation) clearTimeout(state.escalation);
    if (state.drainDeadline) clearTimeout(state.drainDeadline);
    state.timeout = undefined;
    state.escalation = undefined;
    state.drainDeadline = undefined;
  }
  private complete(state: Owned) {
    if (state.finalizing || this.owned.get(state.run.id) !== state) return;
    state.finalizing = true;
    this.clearTimers(state);
    let status: Run['status'] = 'completed';
    let error: string | null = null;
    if (state.stop === 'cancelled') status = 'cancelled';
    else if (state.stop === 'shutdown') { status = 'interrupted'; error = 'Application shutdown interrupted the run.'; }
    else if (state.stop === 'timeout') { status = 'failed'; error = 'Run timed out and its owned processes were terminated.'; }
    else if (state.stop === 'persistence') { status = 'failed'; }
    else if (state.providerInterrupted) { status = 'interrupted'; error = 'The CLI reported an interrupted turn.'; }
    else if (state.spawnError || state.streamError || state.providerError || state.provisionalError || state.code !== 0) {
      status = 'failed';
      error = state.spawnError ? `Could not spawn the CLI: ${state.spawnError}` : state.providerError || state.provisionalError || state.streamError
        || (state.signal ? `CLI exited after signal ${state.signal}.` : `CLI exited with code ${state.code ?? 'unknown'}.`);
    }
    if (state.drainWarning) error = [error, state.drainWarning].filter(Boolean).join(' ');
    let result: Run = {
      ...state.run, status, finishedAt: new Date().toISOString(), exitCode: state.code, error: error ? redact(error) : null,
      usage: state.usage, nativeSessionId: state.nativeId,
    };
    if (state.persistenceError) result = this.persistenceResult(result, state.persistenceError);
    try {
      result = this.persistTerminal(result);
    } finally {
      // Disk health cannot retain a process slot or leave callers awaiting done.
      this.owned.delete(state.run.id);
      this.budgets.delete(state.run.id);
      state.resolve(result);
      this.publish({ type: 'refresh' });
      this.pump();
    }
  }
}
