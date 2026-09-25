import type { McpCheck, McpMetadataList, McpResourceRoot } from '../../shared/mcp.js';
import type { McpServiceOptions } from './service.js';
import { bounded, object, type Dictionary, type McpRecord } from './types.js';
import { redactor } from './redaction.js';
import { StdioChannel } from './stdio.js';
import { HttpChannel } from './http.js';
import { VERSION } from '../config.js';

export class ProbeError extends Error {
  constructor(readonly code: string, message: string, readonly rpcCode?: number) { super(message); }
}
export interface ProbeLimits {
  maxMessageBytes: number;
  maxProbeBytes: number;
  maxListItems: number;
  maxPages: number;
  cleanupGraceMs: number;
}
export function probeLimits(options: McpServiceOptions): ProbeLimits {
  return {
    maxMessageBytes: bounded(options.maxMessageBytes, 256 * 1024, 512, 1024 * 1024),
    maxProbeBytes: bounded(options.maxProbeBytes, 2 * 1024 * 1024, 1024, 8 * 1024 * 1024),
    maxListItems: bounded(options.maxListItems, 100, 1, 200),
    maxPages: bounded(options.maxPages, 4, 1, 8),
    cleanupGraceMs: bounded(options.cleanupGraceMs, 250, 20, 1000),
  };
}
export class ByteBudget {
  private total = 0;
  constructor(readonly limits: ProbeLimits) {}
  consume(bytes: number) {
    this.total += bytes;
    if (this.total > this.limits.maxProbeBytes) throw new ProbeError('buffer-limit', 'The probe exceeded its total input/output byte limit.');
  }
  frame(bytes: number) {
    if (bytes > this.limits.maxMessageBytes) throw new ProbeError('buffer-limit', 'An MCP protocol message exceeded the byte limit.');
  }
}
export interface RpcChannel {
  request(method: string, params?: Dictionary): Promise<Dictionary>;
  notify(method: string, params?: Dictionary): Promise<void>;
  setProtocolVersion(version: string): void;
  close(): Promise<void>;
}

/** A bounded sequential JSON-RPC peer. No server request can trigger code, model inference, or a tool call. */
export class RpcPeer {
  private nextId = 0;
  private pending: { id: number; resolve: (value: Dictionary) => void; reject: (error: ProbeError) => void } | null = null;
  private failure: ProbeError | null = null;
  private messages = 0;
  constructor(private readonly send: (value: Dictionary) => Promise<void>, private readonly signal: AbortSignal) {
    signal.addEventListener('abort', this.aborted, { once: true });
  }
  private aborted = () => this.fail(this.signal.reason instanceof ProbeError ? this.signal.reason : new ProbeError('cancelled', 'The probe was cancelled.'));
  fail(error: ProbeError) {
    this.failure ??= error;
    this.pending?.reject(this.failure);
    this.pending = null;
  }
  async request(method: string, params: Dictionary = {}): Promise<Dictionary> {
    if (this.signal.aborted) this.aborted();
    if (this.failure) throw this.failure;
    if (this.pending) throw new ProbeError('concurrency', 'The probe only supports one outstanding protocol request.');
    const id = ++this.nextId;
    return new Promise<Dictionary>((resolve, reject) => {
      this.pending = { id, resolve, reject };
      void this.send({ jsonrpc: '2.0', id, method, params }).catch(error =>
        this.fail(error instanceof ProbeError ? error : new ProbeError('transport-write', 'The MCP transport could not send a message.')));
    });
  }
  async notify(method: string, params?: Dictionary) {
    if (this.signal.aborted) this.aborted();
    if (this.failure) throw this.failure;
    await this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }
  receive(value: unknown) {
    if (this.failure) return;
    if (++this.messages > 1024) { this.fail(new ProbeError('message-limit', 'The probe received too many protocol messages.')); return; }
    const message = object(value);
    if (message.jsonrpc !== '2.0' || Array.isArray(value)) {
      this.fail(new ProbeError('invalid-message', 'The server returned an invalid JSON-RPC envelope.'));
      return;
    }
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        if (!(typeof message.id === 'number' && Number.isSafeInteger(message.id) || typeof message.id === 'string' && message.id.length <= 200)) {
          this.fail(new ProbeError('invalid-message', 'The server returned an invalid request identifier.'));
          return;
        }
        const reply = message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'This metadata-only client does not support server-initiated operations.' } };
        void this.send({ jsonrpc: '2.0', id: message.id, ...reply }).catch(() => this.fail(new ProbeError('transport-write', 'The MCP transport could not reply.')));
      }
      return;
    }
    if (!this.pending || message.id !== this.pending.id) {
      this.fail(new ProbeError('unexpected-response', 'The server returned an unexpected JSON-RPC response identifier.'));
      return;
    }
    const pending = this.pending;
    this.pending = null;
    if (Object.hasOwn(message, 'error') === Object.hasOwn(message, 'result')) {
      pending.reject(new ProbeError('invalid-message', 'The response must contain either a result or an error.'));
    } else if (message.error !== undefined) {
      const code = object(message.error).code;
      pending.reject(new ProbeError('rpc-error', 'The server rejected a metadata request. Its error body is withheld.', typeof code === 'number' ? code : undefined));
    } else if (message.result === null || typeof message.result !== 'object' || Array.isArray(message.result)) {
      pending.reject(new ProbeError('invalid-message', 'The result of an MCP metadata request must be an object.'));
    } else pending.resolve(object(message.result));
  }
  dispose() {
    this.signal.removeEventListener('abort', this.aborted);
    this.fail(new ProbeError('transport-closed', 'The probe transport was closed.'));
  }
}

export function parseMessage(text: string, budget: ByteBudget): unknown {
  budget.frame(Buffer.byteLength(text));
  try { return JSON.parse(text); }
  catch { throw new ProbeError('invalid-json', 'The server returned malformed JSON. Its contents are withheld.'); }
}
export function emptyList(): McpMetadataList { return { status: 'not-requested', items: [], count: 0, truncated: false }; }
const protocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** MCP lifecycle and list requests only: no tools/call, resources/read, or prompts/get. */
export async function probe(
  record: McpRecord, result: McpCheck, options: McpServiceOptions,
  signal: AbortSignal, onRoot: (root: McpResourceRoot | null) => void,
): Promise<void> {
  const limits = probeLimits(options);
  const budget = new ByteBudget(limits);
  const clean = (value: string, limit: number) => redactor(record.secrets)(value, limit);
  let channel: RpcChannel | null = null;
  try {
    if (signal.aborted) throw signal.reason;
    channel = record.target.transport === 'stdio' ? new StdioChannel(record.target, result.id, signal, budget, onRoot)
      : record.target.transport === 'http' || record.target.transport === 'sse'
        ? new HttpChannel(record.target, signal, budget, value => { if (value) record.secrets.push(value); })
        : null;
    if (!channel) throw new ProbeError('transport-unsupported', 'This transport is not implemented.');
    const initialized = await channel.request('initialize', {
      protocolVersion: protocolVersions[0], capabilities: {}, clientInfo: { name: 'agent-ops', version: VERSION },
    });
    if (typeof initialized.protocolVersion !== 'string' || !protocolVersions.includes(initialized.protocolVersion)) {
      throw new ProbeError('protocol-version', 'The server selected a protocol version this metadata client does not support.');
    }
    const info = object(initialized.serverInfo);
    if (typeof info.name !== 'string' || typeof info.version !== 'string'
      || initialized.capabilities === null || typeof initialized.capabilities !== 'object' || Array.isArray(initialized.capabilities)) {
      throw new ProbeError('invalid-initialize', 'The server initialization response lacks valid identity or capability metadata.');
    }
    result.protocolVersion = initialized.protocolVersion;
    result.serverInfo = { name: clean(info.name, 240), version: clean(info.version, 120) };
    channel.setProtocolVersion(initialized.protocolVersion);
    const capabilities = object(initialized.capabilities);
    result.capabilities = {
      tools: capabilities.tools !== null && typeof capabilities.tools === 'object' && !Array.isArray(capabilities.tools),
      resources: capabilities.resources !== null && typeof capabilities.resources === 'object' && !Array.isArray(capabilities.resources),
      prompts: capabilities.prompts !== null && typeof capabilities.prompts === 'object' && !Array.isArray(capabilities.prompts),
    };
    await channel.notify('notifications/initialized');
    for (const kind of ['tools', 'resources', 'prompts'] as const) {
      const list = result[kind];
      if (!result.capabilities[kind]) { list.status = 'unsupported'; continue; }
      let cursor: string | undefined;
      const seen = new Set<string>();
      list.status = 'ok';
      for (let page = 0; page < limits.maxPages; page++) {
        let response: Dictionary;
        try { response = await channel.request(`${kind}/list`, cursor ? { cursor } : {}); }
        catch (error) {
          if (error instanceof ProbeError && error.rpcCode === -32601) { list.status = 'unsupported'; break; }
          list.status = 'failed';
          throw error;
        }
        const items = response[kind];
        if (!Array.isArray(items)) { list.status = 'failed'; throw new ProbeError('invalid-list', 'The server returned an invalid metadata list.'); }
        const remaining = limits.maxListItems - list.items.length;
        for (const value of items.slice(0, remaining)) {
          const item = object(value);
          if (typeof item.name !== 'string' || !item.name.trim()) {
            list.status = 'failed';
            throw new ProbeError('invalid-list', 'A metadata list entry lacks a valid name.');
          }
          list.items.push({
            name: clean(item.name, 240), title: typeof item.title === 'string' ? clean(item.title, 240) : null,
            description: typeof item.description === 'string' ? clean(item.description, 1000) : null,
          });
        }
        list.count = list.items.length;
        const next = response.nextCursor;
        if (next !== undefined && (typeof next !== 'string' || !next || next.length > 4096)) {
          list.status = 'failed'; throw new ProbeError('invalid-cursor', 'The metadata pagination cursor is invalid or exceeds its limit.');
        }
        if (items.length > remaining || next && (list.items.length >= limits.maxListItems || page + 1 >= limits.maxPages || seen.has(next as string))) {
          list.truncated = true;
          break;
        }
        if (!next) break;
        cursor = next as string;
        seen.add(cursor);
      }
    }
    result.status = 'reachable';
  } catch (error) {
    const failure = signal.aborted && signal.reason instanceof ProbeError ? signal.reason
      : error instanceof ProbeError ? error : new ProbeError('probe-failed', 'The MCP probe failed. Transport details are withheld.');
    result.status = failure.code === 'timeout' ? 'timeout' : failure.code === 'cancelled' ? 'cancelled'
      : ['protocol-version', 'transport-unsupported'].includes(failure.code) ? 'unsupported' : 'failed';
    result.error = { code: failure.code, message: failure.message };
  } finally {
    try { await channel?.close(); }
    catch {
      result.status = 'failed';
      result.error = { code: 'cleanup-failed', message: 'The probe could not confirm owned transport cleanup.' };
    }
    result.finishedAt = new Date().toISOString();
    result.durationMs = Math.max(0, Date.now() - Date.parse(result.startedAt));
  }
}
