import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { McpResourceRoot } from '../../shared/mcp.js';
import type { McpTarget, Dictionary } from './types.js';
import { ByteBudget, parseMessage, ProbeError, RpcPeer, type RpcChannel } from './protocol.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Own only this detached process group; never inspect or terminate native MCP client processes. */
export class StdioChannel implements RpcChannel {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly peer: RpcPeer;
  private buffer = Buffer.alloc(0);
  private closing = false;
  private closed = false;
  private groupGone = false;
  private released = false;
  private readonly stopped: Promise<void>;
  private stopTimer: NodeJS.Timeout | null = null;
  private cleanup: Promise<void> | null = null;
  constructor(
    target: McpTarget, ownerId: string, signal: AbortSignal, private readonly budget: ByteBudget,
    private readonly onRoot: (root: McpResourceRoot | null) => void,
  ) {
    if (!target.command || process.platform === 'win32') throw new ProbeError('transport-unsupported', 'POSIX stdio process-group ownership is required.');
    this.child = spawn(target.command, target.args, {
      cwd: target.cwd, env: target.env, shell: false, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.peer = new RpcPeer(async message => {
      if (this.closing) throw new ProbeError('transport-closed', 'The MCP process is closing.');
      const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
      budget.frame(bytes.length); budget.consume(bytes.length);
      await new Promise<void>((resolve, reject) => this.child.stdin.write(bytes, error => error ? reject(error) : resolve()));
    }, signal);
    if (this.child.pid) onRoot({ pid: this.child.pid, ownerId, kind: 'mcp', processGroup: true });
    this.child.stdin.on('error', () => { if (!this.closing) this.peer.fail(new ProbeError('transport-write', 'The configured process closed its input.')); });
    this.child.once('error', () => this.peer.fail(new ProbeError('spawn-failed', 'The configured process could not be started.')));
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.closing) return;
      try {
        budget.consume(chunk.length);
        // Accumulated partial frames are bounded before allocating a concatenated buffer.
        if (this.buffer.length + chunk.length > budget.limits.maxMessageBytes && !chunk.includes(10)) budget.frame(this.buffer.length + chunk.length);
        const combined = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        let start = 0;
        for (let newline = combined.indexOf(10); newline !== -1; newline = combined.indexOf(10, start)) {
          const line = combined.subarray(start, newline);
          budget.frame(line.length);
          if (line.length) this.peer.receive(parseMessage(line.toString('utf8'), budget));
          start = newline + 1;
        }
        const remaining = combined.subarray(start);
        budget.frame(remaining.length);
        this.buffer = Buffer.from(remaining);
      } catch (error) {
        this.peer.fail(error instanceof ProbeError ? error : new ProbeError('invalid-message', 'The process emitted an invalid protocol stream.'));
      }
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      if (this.closing) return;
      try { budget.consume(chunk.length); }
      catch (error) { this.peer.fail(error as ProbeError); }
      // Never retain or return stderr; arbitrary logs may contain credentials or user documents.
    });
    this.child.stdout.on('error', () => this.peer.fail(new ProbeError('transport-read', 'The configured process output stream failed.')));
    this.child.stderr.on('error', () => this.peer.fail(new ProbeError('transport-read', 'The configured process error stream failed.')));
    this.child.once('exit', () => {
      if (!this.closing) this.peer.fail(new ProbeError('process-exited', 'The configured process exited before the metadata probe finished.'));
      this.terminate();
    });
    this.stopped = new Promise(resolve => this.child.once('close', () => {
      // Kill same-group descendants even if they redirected their own stdio.
      this.signal('SIGKILL');
      this.closed = true;
      if (this.stopTimer) clearTimeout(this.stopTimer);
      this.stopTimer = null;
      resolve();
    }));
  }
  request(method: string, params?: Dictionary) { return this.peer.request(method, params); }
  notify(method: string, params?: Dictionary) { return this.peer.notify(method, params); }
  setProtocolVersion(_version: string) {}
  private signal(signal: NodeJS.Signals) {
    if (this.released || this.groupGone || this.closed || !this.child.pid) return;
    try { process.kill(-this.child.pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') this.groupGone = true;
      else throw new ProbeError('cleanup-failed', 'An owned MCP process group could not be signalled.');
    }
  }
  private terminate() {
    if (this.closed || this.released || this.stopTimer) return;
    try { this.signal('SIGTERM'); } catch { /* close() retries and reports failure. */ }
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      try { this.signal('SIGKILL'); } catch { /* close() reports failure. */ }
    }, this.budget.limits.cleanupGraceMs);
    this.stopTimer.unref();
  }
  close(): Promise<void> {
    this.cleanup ??= this.finish();
    return this.cleanup;
  }
  private async finish() {
    this.closing = true;
    this.peer.dispose();
    this.child.stdin.end();
    this.terminate();
    try {
      await Promise.race([this.stopped, delay(this.budget.limits.cleanupGraceMs)]);
      this.signal('SIGKILL');
      // A process outside our group may inherit pipes; close our handles without signalling it.
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      await Promise.race([this.stopped, delay(this.budget.limits.cleanupGraceMs)]);
    } finally {
      if (this.stopTimer) clearTimeout(this.stopTimer);
      this.stopTimer = null;
      this.buffer = Buffer.alloc(0);
      this.released = true;
      this.child.unref();
      this.onRoot(null);
    }
  }
}
