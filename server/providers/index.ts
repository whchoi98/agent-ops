import type { Agent, ImportedSession } from '../../shared/types.js';
import { createCodexParser } from './codex.js';
import { createClaudeParser } from './claude.js';
import { createKiroParser } from './kiro.js';
import {
  collectSources, errorDescription, fingerprints, readSource, sameFingerprints, type Source,
} from './files.js';
import { readKiroDatabase, type KiroRowCache } from './kiro-sqlite.js';

export { parseCodexSession } from './codex.js';
export { parseClaudeSession } from './claude.js';
export { parseKiroSession, parseKiroRecords } from './kiro.js';
export type { ParseContext, ParseResult } from './common.js';
export type { KiroRowCheckpoint, KiroRowCache } from './kiro-sqlite.js';

export interface DiscoverOptions {
  shouldRead?: (path: string, fingerprint: string) => boolean;
  onRead?: (path: string, fingerprint: string) => void;
  maxFiles?: number;
  kiroRows?: KiroRowCache;
}

export async function discoverSessions(
  roots: Record<Agent, string[]>,
  onSession: (session: ImportedSession) => void | false | Promise<void | false>,
  options: DiscoverOptions = {},
): Promise<{ filesScanned: number; skipped: number; warnings: string[] }> {
  const warnings: string[] = [];
  const warningSet = new Set<string>();
  let suppressed = 0;
  function warn(message: string) {
    if (warningSet.has(message)) return;
    if (warnings.length >= 1000) {
      suppressed++;
      return;
    }
    warningSet.add(message);
    warnings.push(message);
  }
  const maxFiles = options.maxFiles ?? 10_000;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0) {
    return { filesScanned: 0, skipped: 0, warnings: ['Invalid maxFiles; expected a non-negative integer.'] };
  }
  const sources = await collectSources(roots, Math.min(maxFiles, 100_000), warn);
  const byPath = new Map(sources.map(source => [`${source.agent}\0${source.path}`, source]));
  const grouped = new Set<Source>();
  const groups: Source[][] = [];
  for (const source of sources) {
    if (grouped.has(source)) continue;
    const group = [source];
    if (source.agent === 'kiro' && (source.kind === 'json' || source.kind === 'jsonl')) {
      const companionPath = source.kind === 'json' ? `${source.path}l` : source.path.slice(0, -1);
      const companion = byPath.get(`kiro\0${companionPath}`);
      // A companion must itself have been discovered inside a configured root.
      if (companion && !grouped.has(companion)) group.push(companion);
      group.sort((a, b) => a.kind.localeCompare(b.kind));
    }
    group.forEach(item => grouped.add(item));
    groups.push(group);
  }
  const emitted = new Map<string, { updatedAt: string; messageCount: number }>();
  async function emit(session: ImportedSession) {
    const previous = emitted.get(session.id);
    if (previous && (previous.updatedAt > session.updatedAt
      || (previous.updatedAt === session.updatedAt && previous.messageCount >= session.messageCount))) return false;
    if (await onSession(session) === false) return false;
    emitted.set(session.id, { updatedAt: session.updatedAt, messageCount: session.messageCount });
  }

  let skipped = 0;
  for (const group of groups) {
    let changed = group.length;
    const primary = group[0];
    try {
      const before = await fingerprints(group);
      const shouldRead = group.map(source => options.shouldRead?.(source.path, before.get(source.path)!) ?? true);
      changed = shouldRead.filter(Boolean).length;
      skipped += group.length - changed;
      if (!changed) continue;
      let ok = true;
      if (primary.kind === 'sqlite') {
        ok = await readKiroDatabase(primary, emit, warn, options.kiroRows);
      } else {
        const context = { sourcePath: primary.path, fallbackTimestamp: primary.stat.mtimeMs };
        const parser = primary.agent === 'codex' ? createCodexParser(context)
          : primary.agent === 'claude' ? createClaudeParser(context) : createKiroParser(context);
        for (const source of group) {
          // Re-read paired metadata as a dependency of a changed transcript.
          const successful = await readSource(source, record => parser.consume(record), warn);
          ok = successful && ok;
        }
        const parsed = parser.finish();
        parsed.warnings.forEach(warn);
        if (!parsed.session) ok = false;
        if (ok && !sameFingerprints(before, await fingerprints(group))) {
          warn(`${primary.path}: Source changed while reading; import deferred until a stable read.`);
          ok = false;
        }
        if (ok && parsed.session) await emit(parsed.session);
      }
      if (ok && !sameFingerprints(before, await fingerprints(group))) {
        warn(`${primary.path}: Source changed during import; its fingerprint was not checkpointed.`);
        ok = false;
      }
      if (ok) {
        // A callback failure, damaged file, or unstable WAL must remain retryable.
        for (const source of group) await options.onRead?.(source.path, before.get(source.path)!);
      } else skipped += changed;
    } catch (error) {
      skipped += changed;
      warn(`${primary.path}: Source read/import failed (${errorDescription(error)}).`);
    }
  }
  if (suppressed) warnings.push(`${suppressed} additional source diagnostics were suppressed.`);
  return { filesScanned: sources.length, skipped, warnings };
}
