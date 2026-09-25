import type { McpTarget, Dictionary } from './types.js';
import { object } from './types.js';
import { ByteBudget, parseMessage, ProbeError, RpcPeer, type RpcChannel } from './protocol.js';

interface SseEvent { event: string; data: string }
async function sse(
  response: Response, budget: ByteBudget, consume: (event: SseEvent) => boolean,
): Promise<void> {
  if (!response.body) throw new ProbeError('empty-response', 'The MCP endpoint returned no event stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let data: string[] = [];
  let event = '';
  let bytes = 0;
  function line(text: string): boolean {
    bytes += Buffer.byteLength(text) + 1;
    budget.frame(bytes);
    if (!text) {
      const stop = data.length ? consume({ event: event || 'message', data: data.join('\n') }) : false;
      data = []; event = ''; bytes = 0;
      return stop;
    }
    if (text.startsWith(':')) return false;
    const colon = text.indexOf(':');
    const name = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'event') event = value;
    if (name === 'data') data.push(value);
    return false;
  }
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      budget.consume(chunk.value.byteLength);
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r\n|\r|\n/.exec(buffer))) {
        // A CR at the end of a chunk may be the first half of CRLF.
        if (boundary[0] === '\r' && boundary.index === buffer.length - 1) break;
        const text = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (line(text)) return;
      }
      budget.frame(Buffer.byteLength(buffer) + bytes);
    }
    buffer += decoder.decode();
    if (buffer) {
      for (const text of buffer.split(/\r\n|\r|\n/)) if (line(text)) return;
    }
    // SSE only dispatches complete blank-line-delimited events.
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function json(response: Response, budget: ByteBudget): Promise<unknown> {
  if (!response.body) throw new ProbeError('empty-response', 'The MCP endpoint returned an empty response.');
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length)) budget.frame(Number(length));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      budget.consume(chunk.value.byteLength); budget.frame(bytes);
      chunks.push(chunk.value);
    }
    return parseMessage(Buffer.concat(chunks).toString('utf8'), budget);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function status(response: Response) {
  if (response.status >= 300 && response.status < 400) throw new ProbeError('redirect-blocked', 'The configured endpoint redirected. Redirect targets are never probed.');
  if (response.status === 401 || response.status === 403) throw new ProbeError('authentication-required', 'The endpoint requires authentication that this explicit probe could not supply. Native OAuth credentials are not reused.');
  if (response.status === 405 || response.status === 501) throw new ProbeError('transport-unsupported', 'The configured endpoint does not support this transport. Legacy SSE requires an explicit SSE declaration.');
  if (!response.ok) throw new ProbeError('http-status', `The MCP endpoint returned HTTP ${response.status}. Its response body is withheld.`);
}
const contentType = (response: Response) => (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();

/**
 * Streamable HTTP and the legacy 2024-11-05 HTTP+SSE transport.
 * No redirects, automatic reconnection, OAuth discovery, token stores, or arbitrary caller URLs.
 * https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
 */
export class HttpChannel implements RpcChannel {
  private readonly peer: RpcPeer;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly legacy: boolean;
  private readonly ready: Promise<void>;
  private stream: Promise<void> | null = null;
  private endpoint: string;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private readonly sends = new Set<Promise<void>>();
  constructor(
    private readonly target: McpTarget, signal: AbortSignal, private readonly budget: ByteBudget,
    private readonly onSecret: (value: string) => void,
  ) {
    if (!target.url) throw new ProbeError('missing-url', 'No configured endpoint is available.');
    this.endpoint = target.url;
    this.legacy = target.transport === 'sse';
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.peer = new RpcPeer(message => {
      const pending = this.post(message);
      this.sends.add(pending);
      void pending.finally(() => this.sends.delete(pending)).catch(() => {});
      return pending;
    }, this.signal);
    this.ready = this.legacy ? this.openLegacy() : Promise.resolve();
    // A constructor-started GET may fail before request() attaches its await.
    void this.ready.catch(() => {});
  }
  private headers(jsonBody = false, includeSession = true): Headers {
    const headers = new Headers(this.target.headers);
    headers.set('Accept', this.legacy ? 'text/event-stream, application/json' : 'application/json, text/event-stream');
    if (jsonBody) headers.set('Content-Type', 'application/json');
    if (this.protocolVersion) headers.set('MCP-Protocol-Version', this.protocolVersion);
    if (includeSession && this.sessionId) headers.set('MCP-Session-Id', this.sessionId);
    return headers;
  }
  private async openLegacy() {
    let response: Response | null = null;
    let resolveEndpoint!: () => void;
    let rejectEndpoint!: (error: unknown) => void;
    const endpoint = new Promise<void>((resolve, reject) => { resolveEndpoint = resolve; rejectEndpoint = reject; });
    try {
      response = await fetch(this.target.url!, { method: 'GET', headers: this.headers(), signal: this.signal, redirect: 'manual' });
      status(response);
      if (contentType(response) !== 'text/event-stream') throw new ProbeError('invalid-content-type', 'A legacy SSE endpoint must return text/event-stream.');
      let received = false;
      this.stream = sse(response, this.budget, event => {
        if (event.event === 'endpoint') {
          if (received || event.data.length > 8192) throw new ProbeError('unsafe-endpoint', 'The legacy SSE endpoint declaration is invalid.');
          const url = new URL(event.data, this.target.url!);
          const configured = new URL(this.target.url!);
          if (url.origin !== configured.origin || url.username || url.password || url.hash) {
            throw new ProbeError('unsafe-endpoint', 'A legacy SSE message endpoint must remain on the configured origin.');
          }
          this.endpoint = url.href;
          for (const value of url.searchParams.values()) this.onSecret(value);
          received = true;
          resolveEndpoint();
        } else if (event.event === 'message') {
          this.peer.receive(parseMessage(event.data, this.budget));
        }
        return false;
      }).then(() => {
        if (!this.closing) throw new ProbeError('transport-closed', 'The legacy SSE stream closed before the metadata probe completed.');
      }).catch(error => {
        const failure = error instanceof ProbeError ? error : new ProbeError('transport-read', 'The legacy SSE stream failed.');
        rejectEndpoint(failure);
        this.peer.fail(failure);
      });
      await endpoint;
    } catch (error) {
      if (!this.stream) await response?.body?.cancel().catch(() => {});
      throw error instanceof ProbeError ? error : new ProbeError('transport-connect', 'The configured MCP endpoint could not be reached.');
    }
  }
  private async post(message: Dictionary) {
    if (this.closing) throw new ProbeError('transport-closed', 'The MCP HTTP probe is closing.');
    const body = JSON.stringify(message);
    this.budget.frame(Buffer.byteLength(body)); this.budget.consume(Buffer.byteLength(body));
    let response: Response | null = null;
    try {
      response = await fetch(this.endpoint, { method: 'POST', headers: this.headers(true), body, signal: this.signal, redirect: 'manual' });
      status(response);
      if (!this.legacy && message.method === 'initialize') {
        const session = response.headers.get('mcp-session-id');
        if (session !== null) {
          if (!/^[\x21-\x7e]{1,256}$/.test(session)) throw new ProbeError('invalid-session', 'The endpoint returned an invalid or oversized session identifier.');
          this.sessionId = session;
          this.onSecret(session);
        }
      }
      if (this.legacy || message.method === undefined || message.id === undefined) {
        if (response.status !== 202 && response.status !== 204) throw new ProbeError('invalid-acknowledgement', 'The endpoint did not acknowledge an MCP notification or legacy POST.');
        await response.body?.cancel();
        return;
      }
      if (contentType(response) === 'application/json') {
        this.peer.receive(await json(response, this.budget));
      } else if (contentType(response) === 'text/event-stream') {
        let received = false;
        await sse(response, this.budget, event => {
          if (event.event !== 'message') return false;
          const payload = parseMessage(event.data, this.budget);
          this.peer.receive(payload);
          const value = object(payload);
          if (value.method === undefined && value.id === message.id) { received = true; return true; }
          return false;
        });
        if (!received && !this.closing) throw new ProbeError('transport-closed', 'The HTTP event stream ended without its matching response.');
      } else throw new ProbeError('invalid-content-type', 'An MCP response must use application/json or text/event-stream.');
    } catch (error) {
      // Do not include fetch errors, response bodies, URLs, TLS details or request headers.
      this.peer.fail(error instanceof ProbeError ? error : new ProbeError('transport-connect', 'The configured MCP HTTP exchange failed.'));
      throw error;
    } finally {
      // json()/sse() release their readers; other bodies are explicitly discarded.
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
  async request(method: string, params?: Dictionary) { await this.ready; return this.peer.request(method, params); }
  async notify(method: string, params?: Dictionary) { await this.ready; return this.peer.notify(method, params); }
  setProtocolVersion(version: string) { this.protocolVersion = version; }
  close(): Promise<void> { this.closePromise ??= this.finish(); return this.closePromise; }
  private async finish() {
    this.closing = true;
    this.controller.abort(new ProbeError('transport-closed', 'The owned HTTP transport is closing.'));
    this.peer.dispose();
    await Promise.allSettled([...this.sends, ...(this.stream ? [this.stream] : []), this.ready]);
    if (!this.legacy && this.sessionId) {
      const cleanup = new AbortController();
      const timeout = setTimeout(() => cleanup.abort(), this.budget.limits.cleanupGraceMs);
      timeout.unref();
      try {
        // This identifier came only from our initialize response, never a caller or existing CLI session.
        const response = await fetch(this.target.url!, {
          method: 'DELETE', headers: this.headers(), signal: cleanup.signal, redirect: 'manual',
        });
        await response.body?.cancel();
        // MCP permits servers to reject DELETE with 405. No retry or follow-up target is used.
      } catch { /* Cleanup is best effort and bounded; no existing client session is touched. */ }
      finally { clearTimeout(timeout); this.sessionId = null; }
    }
  }
}
