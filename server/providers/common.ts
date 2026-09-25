import { createHash } from 'node:crypto';
import { basename, win32 } from 'node:path';
import { emptyUsage, type Agent, type ImportedSession, type Message, type Usage } from '../../shared/types.js';

export const MAX_MESSAGES = 20_000;
const MAX_COUNTERS = 100_000;
const MAX_MESSAGE_CHARACTERS = 1_048_576;

export type JsonObject = Record<string, unknown>;
export interface ParseContext {
  sourcePath: string;
  fallbackTimestamp?: string | number;
  nativeId?: string;
  projectPath?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  /** Stable row identity when a legacy SQLite row has no conversation ID. */
  identityKey?: string;
}
export interface ParseResult {
  session: ImportedSession | null;
  warnings: string[];
}
export interface SessionParser {
  consume(record: unknown): void;
  finish(): ParseResult;
}

export function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function firstString(...values: unknown[]): string {
  return values.map(string).find(value => value.trim()) ?? '';
}

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function json(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value) ?? '';
}

/** Extract content, never environment/configuration fields from a message wrapper. */
export function text(value: unknown, depth = 0): string {
  if (depth > 20 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => text(item, depth + 1)).filter(Boolean).join('\n');
  const item = object(value);
  if (typeof item.text === 'string') return item.text;
  if (typeof item.Text === 'string') return item.Text;
  if (typeof item.prompt === 'string') return item.prompt;
  if (item.Json !== undefined) return json(item.Json);
  if (item.kind === 'json' || item.kind === 'Json') return json(item.data);
  if (item.kind === 'text' || item.type === 'text') return text(item.data ?? item.content, depth + 1);
  if (item.content !== undefined) return text(item.content, depth + 1);
  if (item.output !== undefined) return text(item.output, depth + 1);
  return '';
}

/** Derive a title without exposing injected Codex setup as the user's request. */
export function codexTitleCandidate(content: string): string {
  let candidate = content.trim();
  // Only leading, known setup wrappers are removed, and only from the title.
  for (let index = 0; index < 64 && candidate; index++) {
    if (/^#{1,6}\s+AGENTS\.md\s+instructions\b/i.test(candidate)) {
      const end = /<\/instructions\s*>/i.exec(candidate);
      if (!end) return '';
      candidate = candidate.slice(end.index + end[0].length).trim();
      continue;
    }
    const start = /^<(environment_context|instructions|skills[\w:-]*)\b[^>]*>/i.exec(candidate);
    if (!start) return candidate;
    if (start[0].endsWith('/>')) {
      candidate = candidate.slice(start[0].length).trim();
      continue;
    }
    const remaining = candidate.slice(start[0].length);
    const end = new RegExp(`</${start[1]}\\s*>`, 'i').exec(remaining);
    if (!end) return '';
    candidate = remaining.slice(end.index + end[0].length).trim();
  }
  return '';
}

function truncateTitle(value: string): string {
  let end = 0;
  let characters = 0;
  // Inspect only the prefix and keep each UTF-16 surrogate pair intact.
  for (const character of value) {
    if (characters === 160) break;
    end += character.length;
    characters++;
  }
  return value.slice(0, end);
}

/** Native sources use ISO strings, Unix seconds, milliseconds, and occasionally micro/nanoseconds. */
export function timestamp(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const time = object(value);
  if (typeof time.secs_since_epoch === 'number') {
    value = time.secs_since_epoch * 1000 + (typeof time.nanos_since_epoch === 'number' ? time.nanos_since_epoch / 1e6 : 0);
    const date = new Date(value as number);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value)) value = Number(value);
  let milliseconds: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const magnitude = Math.abs(value);
    milliseconds = magnitude >= 1e17 ? value / 1e6
      : magnitude >= 1e14 ? value / 1e3
        : magnitude >= 1e11 ? value : value * 1000;
  } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    // A timestamp without an offset is interpreted as UTC, independent of the server's locale.
    const utc = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(value) ? `${value}Z` : value;
    milliseconds = Date.parse(utc);
  } else return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function count(...values: unknown[]): number | null {
  return values.find((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ?? null;
}

function cost(...values: unknown[]): number | null {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0) ?? null;
}

/** These are recorded counters only: context size, response bytes, credits, etc. are not tokens or USD. */
export function readUsage(value: unknown): Usage {
  const usage = object(value);
  const details = object(usage.input_tokens_details);
  return {
    inputTokens: count(usage.input_tokens, usage.input_token_count, usage.inputTokens, usage.prompt_tokens),
    outputTokens: count(usage.output_tokens, usage.output_token_count, usage.outputTokens, usage.completion_tokens),
    cacheReadTokens: count(usage.cached_input_tokens, usage.cache_read_input_tokens, usage.cache_read_input_token_count,
      usage.cache_read_tokens, usage.cacheReadTokens, details.cached_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens, usage.cache_write_input_tokens,
      usage.cache_write_input_token_count, usage.cache_creation_tokens, usage.cacheWriteTokens),
    costUsd: cost(usage.cost_usd, usage.total_cost_usd, usage.costUsd),
  };
}

const usageKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd'] as const;

function mergeCounters(previous: Usage, incoming: Usage): Usage {
  const merged = { ...previous };
  for (const key of usageKeys) {
    if (incoming[key] !== null) merged[key] = previous[key] === null ? incoming[key] : Math.max(previous[key]!, incoming[key]!);
  }
  return merged;
}

/**
 * Response snapshots update one entry; cumulative session totals override the sum.
 * Claude's raw input excludes cache tokens, so normalization happens AFTER merging
 * each response's streamed counters, never on top of an already-normalized total.
 */
export class UsageLedger {
  private readonly entries = new Map<string, Usage>();
  private cumulative = emptyUsage();
  private overflow = false;

  constructor(private readonly warn: (message: string) => void, private readonly inputExcludesCache = false) {}

  add(key: string, usage: Usage) {
    if (usageKeys.every(field => usage[field] === null)) return;
    if (!this.entries.has(key) && this.entries.size >= MAX_COUNTERS) {
      this.overflow = true;
      this.warn('Too many distinct usage counters; non-cumulative usage is unknown.');
      return;
    }
    this.entries.set(key, mergeCounters(this.entries.get(key) ?? emptyUsage(), usage));
  }

  total(usage: Usage) {
    this.cumulative = mergeCounters(this.cumulative, usage);
  }

  private normalize(usage: Usage): Usage {
    if (!this.inputExcludesCache || usage.inputTokens === null) return usage;
    return {
      ...usage,
      inputTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    };
  }

  finish(): Usage {
    const result = emptyUsage();
    if (!this.overflow) {
      for (const entry of this.entries.values()) {
        for (const key of usageKeys) {
          if (entry[key] !== null) result[key] = (result[key] ?? 0) + entry[key]!;
        }
      }
    }
    for (const key of usageKeys) {
      if (this.cumulative[key] !== null) result[key] = this.cumulative[key];
      if (result[key] !== null && !Number.isFinite(result[key])) result[key] = null;
    }
    // Combine the recorded raw counters before adding cache input. A partial
    // cumulative result must not discard cache counters known from responses.
    return this.normalize(result);
  }
}

interface StoredMessage extends Message {
  key: string;
  callId?: string;
}

export class SessionBuilder {
  nativeId = '';
  /** Provider-scoped identity when a native ID is only unique within its parent. */
  sessionKey = '';
  resumable?: boolean;
  projectPath = '';
  model = '';
  title = '';
  parentId = '';
  readonly usage: UsageLedger;
  readonly warnings: string[] = [];
  private readonly warningSet = new Set<string>();
  private readonly messages: StoredMessage[] = [];
  private readonly byKey = new Map<string, StoredMessage>();
  private readonly calls = new Map<string, string>();
  private first: string | null = null;
  private last: string | null = null;
  private invalid = false;
  private readonly fallback: string;

  constructor(readonly agent: Agent, readonly context: ParseContext, inputExcludesCache = false) {
    this.nativeId = context.nativeId ?? '';
    this.projectPath = context.projectPath ?? '';
    this.fallback = timestamp(context.createdAt) ?? timestamp(context.fallbackTimestamp) ?? '1970-01-01T00:00:00.000Z';
    this.observe(context.createdAt);
    this.observe(context.updatedAt);
    this.usage = new UsageLedger(message => this.warn(message), inputExcludesCache);
  }

  warn(message: string) {
    if (this.warningSet.has(message) || this.warnings.length >= 100) return;
    this.warningSet.add(message);
    this.warnings.push(`${this.context.sourcePath}: ${message}`);
  }

  reject(message: string) {
    this.invalid = true;
    this.warn(message);
  }

  identify(value: unknown) {
    const id = string(value);
    if (!id || this.context.nativeId) return;
    if (this.nativeId && this.nativeId !== id) {
      this.reject('Conflicting native session IDs; import withheld to preserve prior history.');
    } else this.nativeId = id;
  }

  observe(value: unknown): string | null {
    const normalized = timestamp(value);
    if (normalized) {
      if (!this.first || normalized < this.first) this.first = normalized;
      if (!this.last || normalized > this.last) this.last = normalized;
    }
    return normalized;
  }

  time(value?: unknown): string {
    return timestamp(value) ?? this.last ?? this.first ?? this.fallback;
  }

  get(key: string): Message | undefined {
    return this.byKey.get(key);
  }

  message(key: string, role: Message['role'], content: string, time?: unknown, extras: Partial<Pick<Message, 'toolName' | 'isError' | 'model'>> = {}) {
    this.observe(time);
    if (!content && role !== 'tool' && !extras.toolName) return;
    if (content.length > MAX_MESSAGE_CHARACTERS) {
      content = `${content.slice(0, MAX_MESSAGE_CHARACTERS)}\n[Message truncated by Agent Ops]`;
      this.warn('An individual message exceeded 1 MiB of text and was truncated.');
    }
    const previous = this.byKey.get(key);
    if (previous) {
      previous.content = content;
      Object.assign(previous, extras);
      const normalized = timestamp(time);
      if (normalized && normalized < previous.timestamp) previous.timestamp = normalized;
      return;
    }
    if (this.messages.length >= MAX_MESSAGES) {
      this.warn(`Message history truncated at ${MAX_MESSAGES} messages; later recorded usage is still read.`);
      return;
    }
    const message: StoredMessage = { key, id: key, role, content, timestamp: this.time(time), ...extras };
    this.messages.push(message);
    this.byKey.set(key, message);
  }

  toolCall(id: string, name: string, input: unknown, time?: unknown, model?: string) {
    if (!this.calls.has(id) && this.calls.size >= MAX_COUNTERS) {
      this.warn('Tool call history was truncated after 100000 distinct calls.');
      return;
    }
    const toolName = name || this.calls.get(id) || 'unknown';
    this.calls.set(id, toolName);
    this.message(`call:${id}`, 'assistant', json(input), time, { toolName, ...(model ? { model } : {}) });
  }

  toolResult(id: string, content: unknown, time?: unknown, isError = false, name = '') {
    const key = `result:${id}`;
    this.message(key, 'tool', typeof content === 'string' ? content : text(content) || json(content), time,
      { ...(name || this.calls.get(id) ? { toolName: name || this.calls.get(id) } : {}), ...(isError ? { isError: true } : {}) });
    const message = this.byKey.get(key);
    if (message) message.callId = id;
  }

  finish(): ParseResult {
    if (!this.messages.length) this.warn('No supported messages found; empty or unsupported history was not imported.');
    if (this.invalid || !this.messages.length) return { session: null, warnings: this.warnings };
    const nativeId = this.nativeId || `local-${hash(`${this.context.sourcePath}\0${this.context.identityKey ?? ''}`)}`;
    const id = `${this.agent}:${this.sessionKey || nativeId}`;
    const projectName = this.projectPath
      ? (this.projectPath.includes('\\') ? win32.basename(this.projectPath) : basename(this.projectPath)) || this.projectPath
      : 'Unknown project';
    let firstUser = '';
    for (const message of this.messages) {
      if (message.role !== 'user') continue;
      firstUser = this.agent === 'codex' ? codexTitleCandidate(message.content) : message.content.trim();
      if (firstUser) break;
    }
    const agentName = `${this.agent[0].toUpperCase()}${this.agent.slice(1)}`;
    const fallbackTitle = this.agent === 'codex' && this.projectPath ? `${agentName} · ${projectName}` : `${agentName} session`;
    const title = truncateTitle((this.title || firstUser || fallbackTitle).replace(/\s+/g, ' ').trim());
    const messages: Message[] = this.messages.map(({ key, callId, ...message }) => ({
      ...message,
      id: `${id}:${hash(key)}`,
      ...(callId && this.calls.has(callId) ? { toolName: this.calls.get(callId) } : {}),
    }));
    return {
      session: {
        id, nativeId, agent: this.agent, title,
        projectPath: this.projectPath,
        projectName,
        model: this.model || 'unknown',
        startedAt: this.first ?? this.fallback, updatedAt: this.last ?? this.first ?? this.fallback,
        // A transcript is evidence of recorded activity, not of a live process or a successful run.
        status: 'recorded',
        messageCount: messages.length, toolCallCount: this.calls.size,
        usage: this.usage.finish(), sourcePath: this.context.sourcePath, messages,
        ...(this.parentId ? { parentId: this.parentId.startsWith(`${this.agent}:`) ? this.parentId : `${this.agent}:${this.parentId}` } : {}),
        ...(this.resumable === undefined ? {} : { resumable: this.resumable }),
      },
      warnings: this.warnings,
    };
  }
}
