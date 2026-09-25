import { lstat, opendir, realpath, statfs } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  DISK_CATEGORIES, type DiskCategory, type DiskCategoryUsage, type DiskSnapshot, type ResourceWarning,
} from '../../shared/resources.js';

type FileUsage = { category: DiskCategory; logicalBytes: number; allocatedBytes: number | null };
export interface DiskScanOptions {
  signal?: AbortSignal; maxEntries?: number; maxDepth?: number; timeBudgetMs?: number;
  now?: () => number;
}
const safeNumber = (value: bigint): number | null => value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
const categories = (): Record<DiskCategory, DiskCategoryUsage> => Object.fromEntries(
  DISK_CATEGORIES.map(name => [name, { logicalBytes: 0, allocatedBytes: 0, fileCount: 0 }]),
) as Record<DiskCategory, DiskCategoryUsage>;

function categoryFor(path: string): DiskCategory {
  const portable = path.split(sep).join('/');
  if (portable === 'agent-ops.sqlite') return 'database';
  if (['agent-ops.sqlite-wal', 'agent-ops.sqlite-shm'].includes(portable)) return 'wal';
  if (/(?:^|\/)backups?(?:\/|$)/i.test(portable) || /\.(?:bak|backup|sqlite(?:3)?\.gz)$/i.test(portable)) return 'backups';
  return 'other';
}
function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
}

/** Counts regular file metadata; it never opens a database or a transcript. */
export async function scanDisk(dataDirectory: string, options: DiskScanOptions = {}): Promise<DiskSnapshot> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const maxEntries = Math.max(1, Math.min(10_000, Number.isFinite(options.maxEntries) ? Math.floor(options.maxEntries!) : 10_000));
  const maxDepth = Math.max(0, Math.min(12, Number.isFinite(options.maxDepth) ? Math.floor(options.maxDepth!) : 12));
  const timeBudget = Math.max(1, Math.min(2000, Number.isFinite(options.timeBudgetMs) ? options.timeBudgetMs! : 2000));
  const warnings = new Set<ResourceWarning>();
  const result: DiskSnapshot = {
    at: new Date().toISOString(), dataDirectory: resolve(dataDirectory), logicalBytes: null,
    allocatedBytes: null, fileCount: 0, entriesScanned: 0, skippedLinks: 0,
    complete: false, durationMs: 0, categories: categories(), volume: null, warnings: [],
  };
  const finish = () => {
    result.durationMs = Math.max(0, now() - started);
    result.warnings = [...warnings];
    return result;
  };
  let root: string;
  try {
    root = await realpath(result.dataDirectory);
    if (root === parse(root).root || !(await lstat(root)).isDirectory()) throw new Error('Invalid data directory');
  } catch {
    warnings.add('disk_unavailable');
    return finish();
  }
  const files = new Map<string, FileUsage>();
  const pending = [{ path: root, depth: 0 }];
  const directoryIdentities = new Set<string>();
  let partial = false, rootReadable = false;
  const stopped = () => {
    if (options.signal?.aborted || now() - started >= timeBudget) {
      warnings.add('disk_time_limit'); partial = true; return true;
    }
    if (result.entriesScanned >= maxEntries) {
      warnings.add('disk_entry_limit'); partial = true; return true;
    }
    return false;
  };
  for (let index = 0; index < pending.length && !stopped(); index++) {
    const { path, depth } = pending[index];
    try {
      const directoryInfo = await lstat(path, { bigint: true });
      if (directoryInfo.isSymbolicLink()) { result.skippedLinks++; continue; }
      if (!directoryInfo.isDirectory() || !within(root, await realpath(path))) { partial = true; continue; }
      const identity = directoryInfo.ino ? `${directoryInfo.dev}:${directoryInfo.ino}` : path;
      if (directoryIdentities.has(identity)) continue;
      directoryIdentities.add(identity);
      const directory = await opendir(path);
      if (index === 0) rootReadable = true;
      for await (const entry of directory) {
        if (stopped()) break;
        result.entriesScanned++;
        const filePath = join(path, entry.name);
        try {
          const info = await lstat(filePath, { bigint: true });
          if (info.isSymbolicLink()) { result.skippedLinks++; continue; }
          if (!within(root, await realpath(filePath))) { partial = true; continue; }
          if (info.isDirectory()) {
            if (depth >= maxDepth) { warnings.add('disk_depth_limit'); partial = true; }
            else pending.push({ path: filePath, depth: depth + 1 });
            continue;
          }
          if (!info.isFile()) { partial = true; continue; }
          const logicalBytes = safeNumber(info.size);
          if (logicalBytes === null) { partial = true; continue; }
          const allocatedBytes = process.platform === 'win32' ? null : safeNumber(info.blocks * 512n);
          const key = info.ino ? `${info.dev}:${info.ino}` : filePath;
          const category = categoryFor(relative(root, filePath));
          const old = files.get(key);
          if (!old || DISK_CATEGORIES.indexOf(category) < DISK_CATEGORIES.indexOf(old.category)) {
            files.set(key, { logicalBytes, allocatedBytes, category });
          }
        } catch { partial = true; }
      }
    } catch { partial = true; }
  }
  result.logicalBytes = rootReadable ? 0 : null;
  result.allocatedBytes = rootReadable ? 0 : null;
  if (!rootReadable) { warnings.add('disk_unavailable'); partial = true; }
  for (const file of files.values()) {
    const category = result.categories[file.category];
    result.logicalBytes! += file.logicalBytes;
    category.logicalBytes += file.logicalBytes;
    result.fileCount++;
    category.fileCount++;
    result.allocatedBytes = result.allocatedBytes === null || file.allocatedBytes === null ? null : result.allocatedBytes + file.allocatedBytes;
    category.allocatedBytes = category.allocatedBytes === null || file.allocatedBytes === null ? null : category.allocatedBytes + file.allocatedBytes;
  }
  if (!Number.isSafeInteger(result.logicalBytes)) { result.logicalBytes = null; partial = true; }
  if (result.allocatedBytes !== null && !Number.isSafeInteger(result.allocatedBytes)) { result.allocatedBytes = null; partial = true; }
  try {
    if (options.signal?.aborted) throw new Error('Aborted');
    const volume = await statfs(root, { bigint: true });
    const totalBytes = safeNumber(volume.bsize * volume.blocks);
    const availableBytes = safeNumber(volume.bsize * volume.bavail);
    if (totalBytes === null || availableBytes === null || totalBytes <= 0) throw new Error('Unsupported volume metrics');
    result.volume = { totalBytes, availableBytes };
  } catch { warnings.add('disk_volume_unavailable'); }
  result.complete = !partial;
  if (partial && !warnings.size) warnings.add('disk_scan_incomplete');
  return finish();
}
