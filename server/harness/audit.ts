import type { Stats } from 'node:fs';
import { resolve } from 'node:path';
import {
  HARNESS_AUDIT_CLIENTS, type HarnessAction, type HarnessAuditClient, type HarnessAuditPage,
  type HarnessAuditQuery, type HarnessAuditRecord, type HarnessAuditSource, type HarnessRisk,
} from '../../shared/harness.js';
import {
  boundedInteger, contentHash, decodeHarnessText, harnessObject, harnessRedactor,
  missingHarnessFile, openHarnessFile, type HarnessOpenFile,
} from './io.js';
import { HARNESS_MAX_AUDIT_READ_BYTES, harnessError, type HarnessAuditFile } from './types.js';

const MAX_SOURCES = 64;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_RECORDS = 10000;
const MAX_DEPTH = 24;
const MAX_NODES = 4096;
const NEWLINE = Buffer.from([10]);
const DAY = 86400000;
const ACTIONS: HarnessAction[] = ['allow', 'ask', 'deny', 'error'];
const RISKS: HarnessRisk[] = ['low', 'medium', 'high', 'critical'];
const ORIGINS = ['autoharness', 'agent-ops-test', 'agent-ops-hook'] as const;

interface Cursor {
  source: HarnessAuditFile;
  info: Stats;
  generation: number;
  loaded: boolean;
  offset: number;
  pending: Buffer;
  lineStart: number;
  skipping: boolean;
  invalidLines: number;
  truncated: boolean;
}
interface Retained {
  record: HarnessAuditRecord;
  timestamp: number;
  order: number;
  key: string;
  /** Hashes and positions only; complete raw input/output is never cached. */
  raw: { position: number; length: number; hash: string };
}
interface ReadBudget { remaining: number; bytesRead: number }

const sourceKey = (source: HarnessAuditFile) =>
  JSON.stringify([source.id, source.root, source.path, source.projectId, source.managed]);
const changed = (before: Stats, after: Stats) => before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs;
const identityChanged = (before: Stats, after: Stats) => before.dev !== after.dev || before.ino !== after.ino;
const object = (value: unknown): Record<string, unknown> => harnessObject(value) ? value : {};

function publicSource(source: HarnessAuditFile): HarnessAuditSource {
  const clean = harnessRedactor(null);
  return {
    id: clean(source.id, 256), path: clean(source.path, 4096),
    projectId: source.projectId === null ? null : clean(source.projectId, 256), managed: source.managed,
  };
}

function validTimestamp(value: unknown, now: number): number | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
    || hour > 23 || minute > 59 || second > 59
    || (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds <= now + 5 * 60000 ? milliseconds : null;
}

/** Bound nesting before parsing, then inspect nodes without recursive traversal. */
function parseRecord(text: string): Record<string, unknown> | null {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[' || char === '{') { if (++depth > MAX_DEPTH) return null; }
    else if (char === ']' || char === '}') depth--;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!harnessObject(value)) return null;
    const stack: unknown[] = [value];
    let nodes = 0;
    while (stack.length) {
      if (++nodes > MAX_NODES) return null;
      const current = stack.pop();
      if (Array.isArray(current)) stack.push(...current);
      else if (harnessObject(current)) {
        for (const [key, child] of Object.entries(current)) {
          if (['__proto__', 'prototype', 'constructor'].includes(key)) return null;
          stack.push(child);
        }
      }
    }
    return value;
  } catch { return null; }
}

function projectRecord(
  raw: Record<string, unknown>, source: HarnessAuditFile, id: string, now: number,
): { record: HarnessAuditRecord; timestamp: number } | null {
  const timestamp = validTimestamp(raw.timestamp, now);
  const permission = object(raw.permission);
  const execution = object(raw.execution);
  const action = permission.action ?? raw.action;
  if (timestamp === null || !ACTIONS.includes(action as HarnessAction)
    || typeof raw.tool_name !== 'string' || !raw.tool_name.trim()
    || typeof raw.event_type !== 'string' || !raw.event_type.trim()) return null;
  if (raw.project_id !== undefined && raw.project_id !== null
    && (typeof raw.project_id !== 'string' || source.projectId !== null && raw.project_id !== source.projectId)) return null;
  if (source.managed && raw.origin !== undefined && !ORIGINS.includes(raw.origin as typeof ORIGINS[number])) return null;
  const clean = harnessRedactor(raw, true);
  const nullable = (value: unknown) => typeof value === 'string' && value.trim() ? clean(value, 256) || null : null;
  const risk = harnessObject(raw.risk) ? raw.risk.level : raw.risk;
  const duration = execution.duration_ms ?? raw.duration_ms;
  const client = typeof raw.client === 'string' ? raw.client.toLowerCase().trim() : null;
  const toolName = clean(raw.tool_name, 160);
  const eventType = clean(raw.event_type, 80);
  if (!toolName.trim() || !eventType.trim()) return null;
  return {
    timestamp,
    record: {
      id, sourceId: publicSource(source).id, timestamp: new Date(timestamp).toISOString(),
      client: HARNESS_AUDIT_CLIENTS.includes(client as HarnessAuditClient) ? client as HarnessAuditClient : null,
      projectId: nullable(source.projectId ?? raw.project_id),
      sessionId: nullable(raw.session_id), runId: nullable(raw.run_id),
      toolName, action: action as HarnessAction, risk: RISKS.includes(risk as HarnessRisk) ? risk as HarnessRisk : null,
      reason: clean(typeof permission.reason === 'string' ? permission.reason : typeof raw.reason === 'string' ? raw.reason : '', 2048),
      eventType, origin: source.managed ? raw.origin as HarnessAuditRecord['origin'] ?? 'autoharness' : 'autoharness',
      status: nullable(execution.status ?? raw.status),
      durationMs: typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : null,
    },
  };
}

async function readRange(file: HarnessOpenFile, position: number, length: number, budget: ReadBudget): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, Math.min(length, budget.remaining)));
  let count = 0;
  while (count < buffer.length) {
    const read = await file.handle.read(buffer, count, buffer.length - count, position + count);
    if (!read.bytesRead) break;
    count += read.bytesRead;
    budget.remaining -= read.bytesRead;
    budget.bytesRead += read.bytesRead;
  }
  return buffer.subarray(0, count);
}

export class HarnessAuditReader {
  private readonly maxReadBytes: number;
  private readonly maxCacheRecords: number;
  private readonly retentionDays: number;
  private readonly cursors = new Map<string, Cursor>();
  private records: Retained[] = [];
  private generation = 0;
  private order = 0;
  private epoch = 0;
  private queue: Promise<void> = Promise.resolve();
  private pendingReads = 0;
  private nextSource = 0;
  private lastObservations: Partial<Record<HarnessAuditClient, string>> = {};

  constructor(options: { maxReadBytes?: number; maxCacheRecords?: number; retentionDays?: number } = {}) {
    this.maxReadBytes = boundedInteger(options.maxReadBytes, HARNESS_MAX_AUDIT_READ_BYTES, 1, HARNESS_MAX_AUDIT_READ_BYTES);
    this.maxCacheRecords = boundedInteger(options.maxCacheRecords, 2000, 1, MAX_RECORDS);
    this.retentionDays = boundedInteger(options.retentionDays, 30, 1, 3650);
  }

  clear(): void {
    this.epoch++;
    this.cursors.clear();
    this.records = [];
    this.nextSource = 0;
    this.lastObservations = {};
  }

  /** Snapshot of the most recently completed project scope, independent of display filters. */
  observations(): Partial<Record<HarnessAuditClient, string>> { return { ...this.lastObservations }; }

  read(
    sources: HarnessAuditFile[], query: HarnessAuditQuery = {},
    settings?: { maxCacheRecords: number; retentionDays: number },
  ): Promise<HarnessAuditPage> {
    if (this.pendingReads >= 8) return Promise.reject(harnessError(429, 'Audit reader is busy. Retry after the current read.'));
    this.pendingReads++;
    const epoch = this.epoch;
    // Snapshot caller-owned options before waiting; neither callbacks nor returned objects own our cache.
    const snapshot = sources.slice(0, MAX_SOURCES).map(source => ({ ...source }));
    const limitedSources = sources.length > MAX_SOURCES;
    const filters = { ...query };
    const limits = settings ? { ...settings } : undefined;
    const task = this.queue.then(() => this.readWindow(snapshot, filters, limits, limitedSources, epoch));
    this.queue = task.then(() => undefined, () => undefined);
    return task.finally(() => { this.pendingReads--; });
  }

  private assertEpoch(epoch: number): void {
    if (epoch !== this.epoch) throw harnessError(409, 'Audit read was invalidated. Refresh with the current scope and settings.');
  }

  private drop(key: string): void {
    this.cursors.delete(key);
    this.records = this.records.filter(item => item.key !== key);
  }

  private cursor(source: HarnessAuditFile, info: Stats): Cursor {
    return {
      source, info, generation: ++this.generation, loaded: false, offset: 0,
      pending: Buffer.alloc(0), lineStart: 0, skipping: false, invalidLines: 0, truncated: false,
    };
  }

  private prune(limit: number, cutoff: number): void {
    this.records = this.records.filter((item, index) => {
      if (item.timestamp >= cutoff && index < limit) return true;
      const cursor = this.cursors.get(item.key);
      if (cursor) cursor.truncated = true;
      return false;
    });
  }

  private remember(item: Retained, limit: number, cutoff: number, cursor: Cursor): void {
    if (item.timestamp < cutoff) { cursor.truncated = true; return; }
    let low = 0;
    let high = this.records.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const other = this.records[middle];
      if (other.timestamp > item.timestamp || other.timestamp === item.timestamp && other.order > item.order) low = middle + 1;
      else high = middle;
    }
    if (low >= limit) { cursor.truncated = true; return; }
    this.records.splice(low, 0, item);
    if (this.records.length > limit) {
      const removed = this.records.pop()!;
      const owner = this.cursors.get(removed.key);
      if (owner) owner.truncated = true;
    }
  }

  private ingest(cursor: Cursor, key: string, bytes: Buffer, position: number, limit: number, cutoff: number, now: number): void {
    let index = 0;
    while (index < bytes.length) {
      const newline = bytes.indexOf(10, index);
      const end = newline < 0 ? bytes.length : newline;
      if (cursor.skipping) {
        if (newline < 0) return;
        cursor.skipping = false;
        index = newline + 1;
        cursor.lineStart = position + index;
        continue;
      }
      if (!cursor.pending.length) cursor.lineStart = position + index;
      const fragment = bytes.subarray(index, end);
      if (cursor.pending.length + fragment.length > MAX_LINE_BYTES) {
        cursor.invalidLines++;
        cursor.truncated = true;
        cursor.pending = Buffer.alloc(0);
        cursor.skipping = newline < 0;
      } else if (newline < 0) {
        // Copy: a small pending line must not keep the full read buffer alive.
        cursor.pending = Buffer.concat([cursor.pending, fragment]);
        return;
      } else {
        const complete = cursor.pending.length ? Buffer.concat([cursor.pending, fragment]) : fragment;
        cursor.pending = Buffer.alloc(0);
        try {
          const text = decodeHarnessText(complete).replace(/^\uFEFF/, '').trim();
          if (text) {
            const raw = parseRecord(text);
            const id = contentHash(JSON.stringify([cursor.source.id, cursor.generation, cursor.lineStart]));
            const projected = raw ? projectRecord(raw, cursor.source, id, now) : null;
            if (projected) {
              // Include both line boundaries: an unchanged JSON object ceases to be
              // a standalone JSONL record if the preceding newline is overwritten.
              const prefix = cursor.lineStart > 0 ? NEWLINE : Buffer.alloc(0);
              const evidence = Buffer.concat([prefix, complete, NEWLINE]);
              this.remember({
                ...projected, order: ++this.order, key,
                raw: { position: cursor.lineStart - prefix.length, length: evidence.length, hash: contentHash(evidence) },
              }, limit, cutoff, cursor);
            }
            else cursor.invalidLines++;
          }
        } catch { cursor.invalidLines++; }
      }
      index = end + 1;
      cursor.lineStart = position + index;
    }
  }

  private async verifyRetained(
    cursor: Cursor, key: string, file: HarnessOpenFile, budget: ReadBudget, epoch: number,
  ): Promise<boolean> {
    // Keep room for appended data. Evidence that cannot fit is removed, never
    // presented as current merely because a different part of the file matched.
    const unread = Math.max(0, file.info.size - cursor.offset);
    const reserve = Math.min(unread, Math.floor(budget.remaining / 4));
    let allowance = budget.remaining - reserve;
    if (cursor.pending.length) {
      const prefix = cursor.lineStart > 0 ? NEWLINE : Buffer.alloc(0);
      const expected = Buffer.concat([prefix, cursor.pending]);
      if (expected.length <= allowance) {
        const bytes = await readRange(file, cursor.lineStart - prefix.length, expected.length, budget);
        this.assertEpoch(epoch);
        allowance -= bytes.length;
        if (!bytes.equals(expected)) return false;
      } else {
        cursor.pending = Buffer.alloc(0);
        cursor.skipping = true;
        cursor.truncated = true;
      }
    } else if (cursor.offset > 0 && !cursor.skipping) {
      if (allowance > 0) {
        const boundary = await readRange(file, cursor.offset - 1, 1, budget);
        this.assertEpoch(epoch);
        allowance -= boundary.length;
        if (!boundary.equals(NEWLINE)) return false;
      } else {
        cursor.skipping = true;
        cursor.truncated = true;
      }
    }
    const omitted = new Set<string>();
    for (const item of this.records) {
      if (item.key !== key) continue;
      if (item.raw.length > allowance) {
        omitted.add(item.record.id);
        cursor.truncated = true;
        continue;
      }
      const bytes = await readRange(file, item.raw.position, item.raw.length, budget);
      this.assertEpoch(epoch);
      allowance -= bytes.length;
      if (bytes.length !== item.raw.length || contentHash(bytes) !== item.raw.hash) return false;
    }
    if (omitted.size) this.records = this.records.filter(item => !omitted.has(item.record.id));
    // Malformed lines have no retained ranges to verify after a source changes.
    if (cursor.invalidLines) {
      cursor.invalidLines = 0;
      cursor.truncated = true;
    }
    return true;
  }

  private async readWindow(
    input: HarnessAuditFile[], query: HarnessAuditQuery,
    settings: { maxCacheRecords: number; retentionDays: number } | undefined, limitedSources: boolean, epoch: number,
  ): Promise<HarnessAuditPage> {
    this.assertEpoch(epoch);
    const now = Date.now();
    const limit = boundedInteger(settings?.maxCacheRecords, this.maxCacheRecords, 1, MAX_RECORDS);
    const retention = boundedInteger(settings?.retentionDays, this.retentionDays, 1, 3650);
    const cutoff = now - retention * DAY;
    const budget: ReadBudget = { remaining: this.maxReadBytes, bytesRead: 0 };
    const warnings = new Set<string>();
    const sources: HarnessAuditFile[] = [];
    const identities = new Set<string>();
    const paths = new Set<string>();
    for (const source of input) {
      if (!source || typeof source.id !== 'string' || !source.id || source.id.length > 256
        || typeof source.root !== 'string' || typeof source.path !== 'string'
        || source.root.length > 4096 || source.path.length > 4096
        || source.projectId !== null && (typeof source.projectId !== 'string' || source.projectId.length > 256)) {
        warnings.add('An invalid audit source was excluded.');
        continue;
      }
      const copy = { ...source, path: resolve(source.path), root: resolve(source.root), managed: source.managed === true };
      if (identities.has(copy.id) || paths.has(copy.path)) {
        warnings.add('Duplicate audit sources were excluded.');
        continue;
      }
      identities.add(copy.id);
      paths.add(copy.path);
      sources.push(copy);
    }
    const keys = new Set(sources.map(sourceKey));
    for (const key of this.cursors.keys()) if (!keys.has(key)) this.drop(key);
    this.prune(limit, cutoff);
    let sourceBytes = 0;
    let deferred = false;
    const visible: HarnessAuditSource[] = [];
    if (limitedSources) warnings.add(`Only the first ${MAX_SOURCES} audit sources are read.`);
    // An active first log must not consume every request's budget indefinitely.
    const firstSource = this.nextSource % Math.max(1, sources.length);
    this.nextSource = (firstSource + 1) % Math.max(1, sources.length);
    for (const source of [...sources.slice(firstSource), ...sources.slice(0, firstSource)]) {
      const key = sourceKey(source);
      let file: HarnessOpenFile | undefined;
      let observedSize = 0;
      try {
        file = await openHarnessFile(source.root, source.path);
        this.assertEpoch(epoch);
        const info = file.info;
        observedSize = info.size;
        sourceBytes += observedSize;
        let cursor = this.cursors.get(key);
        const reset = () => {
          this.drop(key);
          cursor = this.cursor(source, info);
          this.cursors.set(key, cursor);
        };
        if (!cursor || identityChanged(cursor.info, info) || info.size < cursor.info.size
          || info.size < cursor.offset || info.size === cursor.info.size && changed(cursor.info, info)) reset();
        cursor = cursor!;
        if (cursor.loaded && info.size > cursor.info.size) {
          if (!await this.verifyRetained(cursor, key, file, budget, epoch)) {
            reset();
            // A failed verification may have consumed the useful tail budget.
            // Rebuild on the next read instead of accepting an unverified old row.
            if (info.size > budget.remaining) {
              this.cursors.get(key)!.truncated = true;
              await file.verify(true);
              this.assertEpoch(epoch);
              deferred = true;
              visible.push(publicSource(source));
              continue;
            }
          }
        }
        cursor = this.cursors.get(key)!;
        if (info.size > cursor.offset && !budget.remaining) {
          // Verification can exhaust tiny budgets; the next read continues with data.
          await file.verify(true);
          this.assertEpoch(epoch);
          cursor.info = info;
          deferred = true;
          visible.push(publicSource(source));
          continue;
        }
        if (!cursor.loaded) {
          // One byte of the tail budget is a boundary probe, avoiding a false malformed first line.
          const start = Math.max(0, info.size - budget.remaining);
          const bytes = await readRange(file, start, info.size - start, budget);
          this.assertEpoch(epoch);
          const leading = start > 0 && bytes.length ? 1 : 0;
          cursor.skipping = leading === 1 && bytes[0] !== 10;
          cursor.truncated = start > 0;
          this.ingest(cursor, key, bytes.subarray(leading), start + leading, limit, cutoff, now);
          cursor.offset = start + bytes.length;
          cursor.loaded = true;
        } else if (info.size > cursor.offset) {
          const start = cursor.offset;
          const bytes = await readRange(file, start, info.size - start, budget);
          this.assertEpoch(epoch);
          this.ingest(cursor, key, bytes, start, limit, cutoff, now);
          cursor.offset += bytes.length;
        }
        await file.verify(true);
        this.assertEpoch(epoch);
        cursor.info = info;
        visible.push(publicSource(source));
        if (cursor.offset < info.size) deferred = true;
      } catch (error) {
        this.assertEpoch(epoch);
        const previouslyPresent = this.cursors.has(key);
        this.drop(key);
        sourceBytes -= observedSize;
        if (observedSize || previouslyPresent) deferred = true;
        if (!missingHarnessFile(error) || previouslyPresent) warnings.add('An audit source disappeared, changed during reading, or failed owner/file safety checks.');
      } finally { await file?.handle.close(); }
    }
    this.assertEpoch(epoch);
    this.prune(limit, cutoff);
    const observations: Partial<Record<HarnessAuditClient, string>> = {};
    for (const { record } of this.records) {
      if (record.origin === 'agent-ops-hook' && record.client !== null
        && (query.projectId === undefined || record.projectId === query.projectId)
        && observations[record.client] === undefined) observations[record.client] = record.timestamp;
    }
    this.lastObservations = observations;
    const invalidLines = [...this.cursors.values()].reduce((sum, cursor) => sum + cursor.invalidLines, 0);
    const truncated = limitedSources || deferred || [...this.cursors.values()].some(cursor => cursor.truncated);
    if (invalidLines) warnings.add('Malformed, unsupported or oversized audit lines were skipped; raw content is not exposed.');
    if (truncated) warnings.add('Audit data is bounded by read/verification, record and retention limits. Unverified evidence is omitted; totals describe only the retained window.');
    const offset = boundedInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const pageLimit = boundedInteger(query.limit, 50, 1, 200);
    const needle = typeof query.q === 'string' ? query.q.slice(0, 512).trim().toLowerCase() : '';
    const matching = this.records.filter(({ record }) =>
      (query.projectId === undefined || record.projectId === query.projectId)
      && (query.client === undefined || record.client === query.client)
      && (query.action === undefined || record.action === query.action)
      && (query.sessionId === undefined || record.sessionId === query.sessionId)
      && (!needle || [record.toolName, record.reason, record.sessionId, record.runId, record.eventType]
        .some(value => value?.toLowerCase().includes(needle))));
    const counts: Record<HarnessAction, number> = { allow: 0, ask: 0, deny: 0, error: 0 };
    for (const { record } of matching) counts[record.action]++;
    return {
      items: matching.slice(offset, offset + pageLimit).map(item => ({ ...item.record })),
      total: matching.length, offset, limit: pageLimit, counts,
      observed: { ...observations },
      storage: {
        cachedRecords: this.records.length, cacheLimit: limit, retentionDays: retention,
        sourceBytes, bytesRead: budget.bytesRead, truncated, invalidLines,
      },
      sources: visible, warnings: [...warnings].slice(0, 32),
    };
  }
}
