import { constants, type Stats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, parse, resolve, sep } from 'node:path';
import type { Agent } from '../../shared/types.js';
import { hash } from './common.js';

export const MAX_JSON_BYTES = 64 * 1024 * 1024;
export const MAX_JSONL_BYTES = 512 * 1024 * 1024;
export const MAX_JSONL_LINE_BYTES = 64 * 1024 * 1024;
export const MAX_SQLITE_ROW_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 10;
export type Warn = (message: string) => void;
export interface Source {
  agent: Agent;
  path: string;
  kind: 'json' | 'jsonl' | 'sqlite';
  stat: Stats;
}

class SourceError extends Error {}

export function errorDescription(error: unknown): string {
  if (error instanceof SourceError) return error.message;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.name : 'unknown error';
}

function kindFor(agent: Agent, path: string): Source['kind'] | null {
  const extension = extname(path).toLowerCase();
  if (extension === '.jsonl') return 'jsonl';
  if (agent === 'kiro' && extension === '.json') return 'json';
  if (agent === 'kiro' && ['.sqlite3', '.sqlite', '.db'].includes(extension)) return 'sqlite';
  return null;
}

async function checkRoot(path: string) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new SourceError('Symbolic link root or ancestor skipped.');
  }
}

/** Only enumerates the configured roots. Directory handles and recursion are bounded. */
export async function collectSources(roots: Record<Agent, string[]>, maxFiles: number, warn: Warn): Promise<Source[]> {
  const sources: Source[] = [];
  const files = new Set<string>();
  const directories = new Map<string, number>();
  let full = false;

  async function walk(agent: Agent, path: string, depth: number): Promise<void> {
    if (full) return;
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        warn(`${path}: Symbolic link skipped.`);
        return;
      }
      if (stat.isDirectory()) {
        if (depth > MAX_DEPTH) {
          warn(`${path}: Directory depth limit ${MAX_DEPTH} reached.`);
          return;
        }
        const identity = `${agent}\0${path}`;
        const visitedDepth = directories.get(identity);
        if (visitedDepth !== undefined && visitedDepth <= depth) return;
        directories.set(identity, depth);
        const directory = await opendir(path);
        for await (const entry of directory) {
          if (full) break;
          // Files in a directory at depth 10 are allowed; only further directories
          // are out of scope. lstat below also handles unknown dirent file types.
          await walk(agent, join(path, entry.name), depth + (entry.isDirectory() ? 1 : 0));
        }
        return;
      }
      const kind = kindFor(agent, path);
      if (!kind) return;
      if (!stat.isFile()) {
        warn(`${path}: Non-regular source file skipped.`);
        return;
      }
      const identity = `${agent}\0${path}`;
      if (files.has(identity)) return;
      if (sources.length >= maxFiles) {
        full = true;
        warn(`Source file limit (maxFiles=${maxFiles}) reached; remaining sources were not scanned.`);
        return;
      }
      files.add(identity);
      sources.push({ agent, path, kind, stat });
    } catch (error) {
      warn(`${path}: Source scan failed (${errorDescription(error)}).`);
    }
  }

  for (const agent of ['codex', 'claude', 'kiro'] as const) {
    for (const root of roots[agent] ?? []) {
      if (full) break;
      if (typeof root !== 'string' || !root.trim()) {
        warn(`${agent}: Invalid source root ignored.`);
        continue;
      }
      const path = resolve(root === '~' ? homedir() : root.startsWith(`~${sep}`) ? join(homedir(), root.slice(2)) : root);
      try {
        await checkRoot(path);
        await walk(agent, path, 0);
      } catch (error) {
        warn(`${path}: Source root unavailable (${errorDescription(error)}).`);
      }
    }
  }
  return sources;
}

function sourceByteLimit(kind: Source['kind']): number | null {
  if (kind === 'jsonl') return MAX_JSONL_BYTES;
  if (kind === 'json') return MAX_JSON_BYTES;
  // SQLite is read through a bounded row iterator, not loaded as one document.
  return null;
}

function validateFile(stat: Stats) {
  if (stat.isSymbolicLink()) throw new SourceError('Symbolic link source skipped.');
  if (!stat.isFile()) throw new SourceError('Source is not a regular file.');
}

function validateSourceFile(kind: Source['kind'], stat: Stats) {
  validateFile(stat);
  const limit = sourceByteLimit(kind);
  if (limit !== null && stat.size > limit) {
    throw new SourceError(`Source exceeds the ${limit / (1024 * 1024)} MiB ${kind} file size limit.`);
  }
}

async function stamp(path: string, optional = false): Promise<unknown> {
  let stat: Stats;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return [path, null];
    throw error;
  }
  // A stamp reads metadata only; DB/WAL/SHM/journal sizes are not payload limits.
  validateFile(stat);
  return [path, stat.size, stat.mtimeMs, stat.ctimeMs, stat.dev, stat.ino];
}

export async function assertSourcePath(source: Source) {
  validateSourceFile(source.kind, await lstat(source.path));
  if (await realpath(source.path) !== source.path) throw new SourceError('Symbolic link source ancestor skipped.');
}

/**
 * Each paired file depends on both stamps, so either metadata or transcript
 * changes invalidate both checkpoints. SQLite commits can change only its WAL.
 */
export async function fingerprints(sources: Source[]): Promise<Map<string, string>> {
  const stamps: unknown[] = [];
  for (const source of sources) {
    await assertSourcePath(source);
    source.stat = await lstat(source.path);
    stamps.push(await stamp(source.path));
    if (source.kind === 'sqlite') {
      stamps.push(await stamp(`${source.path}-wal`, true));
      stamps.push(await stamp(`${source.path}-journal`, true));
      // SQLite itself may access the SHM sidecar; reject a symlink there too.
      // Its lock/read-mark changes are not conversation data or fingerprints.
      await stamp(`${source.path}-shm`, true);
    }
  }
  const digest = hash(JSON.stringify(stamps));
  return new Map(sources.map(source => [source.path, `${source.path}|${source.stat.size}|${source.stat.mtimeMs}|${digest}`]));
}

export function sameFingerprints(first: Map<string, string>, second: Map<string, string>): boolean {
  return first.size === second.size && [...first].every(([path, value]) => second.get(path) === value);
}

/**
 * JSONL sources up to 512 MiB are consumed record by record, retaining only one
 * line (at most 64 MiB). JSON documents retain their separate 64 MiB source cap.
 * Bad lines are diagnosed without exposing their contents or aborting the scan.
 * Any bad line makes the file ineligible to replace/checkpoint prior history.
 */
export async function readSource(source: Source, consume: (record: unknown) => void, warn: Warn): Promise<boolean> {
  await assertSourcePath(source);
  const handle = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let ok = true;
  let records = 0;
  let lineNumber = 0;
  let totalBytes = 0;
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const sourceLimit = sourceByteLimit(source.kind);

  function checkLineSize(bytes: number) {
    if (bytes > MAX_JSONL_LINE_BYTES) {
      // Reject before appending/concatenating beyond the bound. The caller
      // withholds this entire source and continues with other source files.
      fragments = [];
      fragmentBytes = 0;
      throw new SourceError(`JSONL line ${lineNumber + 1} exceeds the 64 MiB line size limit; prior history was not replaced.`);
    }
  }

  function record(buffer: Buffer) {
    lineNumber++;
    let value: unknown;
    try {
      const line = decoder.decode(buffer).replace(/^\uFEFF/, '').trim();
      if (!line) return;
      value = JSON.parse(line);
    } catch {
      ok = false;
      warn(`${source.path}: Malformed, truncated, or invalid UTF-8 JSON at line ${lineNumber}; prior history was not replaced.`);
      return;
    }
    records++;
    try {
      consume(value);
    } catch (error) {
      ok = false;
      warn(`${source.path}: Native record parsing failed at line ${lineNumber} (${errorDescription(error)}).`);
    }
  }

  try {
    validateSourceFile(source.kind, await handle.stat());
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
    try {
      for await (const chunk of stream) {
        const buffer = chunk as Buffer;
        totalBytes += buffer.length;
        if (sourceLimit !== null && totalBytes > sourceLimit) {
          throw new SourceError(`Source grew beyond the ${sourceLimit / (1024 * 1024)} MiB ${source.kind} file size limit while reading.`);
        }
        if (source.kind === 'json') {
          fragments.push(buffer);
          fragmentBytes += buffer.length;
          continue;
        }
        let start = 0;
        let end: number;
        while ((end = buffer.indexOf(10, start)) !== -1) {
          const part = buffer.subarray(start, end);
          checkLineSize(fragmentBytes + part.length);
          if (fragments.length) {
            fragments.push(part);
            record(Buffer.concat(fragments, fragmentBytes + part.length));
          } else record(part);
          fragments = [];
          fragmentBytes = 0;
          start = end + 1;
        }
        if (start < buffer.length) {
          const part = buffer.subarray(start);
          checkLineSize(fragmentBytes + part.length);
          fragments.push(part);
          fragmentBytes += part.length;
        }
      }
      if (fragments.length) record(Buffer.concat(fragments, fragmentBytes));
    } finally {
      stream.destroy();
    }
    if (!records) {
      ok = false;
      warn(`${source.path}: Empty or unreadable ${source.kind} source; prior history was not replaced.`);
    }
    return ok;
  } finally {
    await handle.close();
  }
}
