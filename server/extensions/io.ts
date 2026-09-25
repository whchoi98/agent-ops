import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { DiscoveryIO } from './types.js';

const skipped = new Set(['.git', '.aws', '.ssh', '.data', 'node_modules', '__pycache__', 'sessions', 'archived_sessions']);
const sensitive = /^(?:\.env(?:\..*)?|\.npmrc|auth(?:entication)?\.json|credentials(?:\.json)?|\.credentials\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|(?:api[-_]?keys?|tokens?|secrets?)(?:\.json|\.ya?ml|\.toml))$|\.(?:pem|p12|pfx|key|sqlite\w*|db)(?:[-.].*)?$/i;
export const within = (root: string, path: string) => {
  const suffix = relative(root, path);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};
export interface ExtensionReaderOptions { roots: string[]; maxBytes?: number; maxDepth?: number; maxEntries?: number }
export interface ExtensionText { text: string; bytes: number; truncated: boolean }

/** All operations are bounded and revalidate paths; no input is interpreted as code. */
export class ExtensionReader implements DiscoveryIO {
  readonly warnings: string[] = [];
  private readonly roots: string[];
  private readonly canonicalRoots: Promise<string[]>;
  private readonly maxBytes: number;
  private readonly maxDepth: number;
  private readonly maxEntries: number;
  private visitedEntries = 0;

  constructor(options: ExtensionReaderOptions) {
    this.roots = [...new Set(options.roots.map(path => resolve(path)))];
    this.canonicalRoots = Promise.all(this.roots.map(path => realpath(path).catch(() => null)))
      .then(paths => paths.filter((path): path is string => path !== null));
    this.maxBytes = Math.max(16, Math.min(options.maxBytes ?? 128 * 1024, 512 * 1024));
    this.maxDepth = Math.max(0, Math.min(options.maxDepth ?? 8, 16));
    this.maxEntries = Math.max(1, Math.min(options.maxEntries ?? 20000, 50000));
  }
  private warn(message: string) {
    if (!this.warnings.includes(message) && this.warnings.length < 80) this.warnings.push(message);
  }
  private excluded(path: string) {
    return path.split(sep).some(part => skipped.has(part)) || sensitive.test(basename(path));
  }
  private async safe(path: string): Promise<string | null> {
    const absolute = resolve(path);
    if (this.excluded(absolute) || !this.roots.some(root => within(root, absolute))) {
      this.warn(`조회 범위 또는 파일 유형에 따라 제외했습니다: ${absolute}`);
      return null;
    }
    try {
      const canonical = await realpath(absolute);
      if (this.excluded(canonical) || !(await this.canonicalRoots).some(root => within(root, canonical))) {
        this.warn(`허용 범위 밖의 링크를 제외했습니다: ${absolute}`);
        return null;
      }
      return canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warn(`경로를 확인하지 못했습니다: ${absolute}`);
      return null;
    }
  }
  async exists(path: string): Promise<boolean> { return await this.safe(path) !== null; }
  async contains(ownerRoot: string, path: string): Promise<boolean> {
    if (!within(resolve(ownerRoot), resolve(path))) return false;
    const [owner, target] = await Promise.all([this.safe(ownerRoot), this.safe(path)]);
    return Boolean(owner && target && within(owner, target));
  }
  async fileSize(path: string): Promise<number | null> {
    const canonical = await this.safe(path);
    if (!canonical) return null;
    try { const info = await stat(canonical); return info.isFile() ? info.size : null; }
    catch { return null; }
  }

  async readText(path: string, ownerRoot?: string): Promise<ExtensionText | null> {
    const canonical = await this.safe(path);
    if (!canonical) return null;
    const owner = ownerRoot ? await this.safe(ownerRoot) : null;
    if (ownerRoot && (!owner || !within(resolve(ownerRoot), resolve(path)) || !within(owner, canonical))) {
      this.warn(`소속 확장 범위 밖의 파일을 제외했습니다: ${path}`);
      return null;
    }
    try {
      const before = await lstat(canonical);
      if (!before.isFile()) return null;
      const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) {
          this.warn(`읽는 동안 변경된 파일을 제외했습니다: ${path}`);
          return null;
        }
        const buffer = Buffer.alloc(Math.min(this.maxBytes + 1, info.size + 1));
        let count = 0;
        while (count < buffer.length) {
          const result = await handle.read(buffer, count, buffer.length - count, count);
          if (!result.bytesRead) break;
          count += result.bytesRead;
        }
        if (buffer.subarray(0, count).includes(0)) {
          this.warn(`바이너리 파일의 본문은 표시하지 않습니다: ${path}`);
          return null;
        }
        const afterPath = await this.safe(path);
        const after = afterPath ? await stat(afterPath) : null;
        if (afterPath !== canonical || !after || after.dev !== info.dev || after.ino !== info.ino) {
          this.warn(`읽는 동안 변경된 경로를 제외했습니다: ${path}`);
          return null;
        }
        const truncated = count > this.maxBytes || info.size > this.maxBytes;
        if (truncated) this.warn(`파일 앞부분 ${this.maxBytes}바이트만 읽었습니다: ${path}`);
        return { text: buffer.subarray(0, Math.min(count, this.maxBytes)).toString('utf8'), bytes: info.size, truncated };
      } finally { await handle.close(); }
    } catch {
      this.warn(`파일을 읽지 못했습니다: ${path}`);
      return null;
    }
  }
  async text(path: string, ownerRoot?: string): Promise<string | null> { return (await this.readText(path, ownerRoot))?.text ?? null; }
  private async structured(path: string, parser: (text: string) => unknown, ownerRoot?: string): Promise<Record<string, unknown> | null> {
    const content = await this.readText(path, ownerRoot);
    if (!content || content.truncated) return null;
    try {
      const value = parser(content.text.replace(/^\uFEFF/, ''));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
      this.warn(`설정 파일의 최상위 객체 형식을 확인해 주세요: ${path}`);
    } catch { this.warn(`설정 파일 형식을 해석하지 못했습니다: ${path}`); }
    return null;
  }
  async json(path: string, ownerRoot?: string) { return this.structured(path, JSON.parse, ownerRoot); }
  async toml(path: string) { return this.structured(path, parseToml); }

  private async entries(path: string): Promise<Array<{ path: string; directory: boolean }>> {
    const canonical = await this.safe(path);
    if (!canonical) return [];
    const result: Array<{ path: string; directory: boolean }> = [];
    try {
      const directory = await opendir(canonical);
      for await (const entry of directory) {
        if (++this.visitedEntries > this.maxEntries) {
          this.warn(`확장 조회 파일 수 한도(${this.maxEntries})에 도달했습니다.`);
          break;
        }
        if (skipped.has(entry.name) || sensitive.test(entry.name)) continue;
        const child = join(path, entry.name);
        if (entry.isDirectory()) result.push({ path: child, directory: true });
        else if (entry.isFile()) result.push({ path: child, directory: false });
        else if (entry.isSymbolicLink()) {
          const target = await this.safe(child);
          if (target) {
            const info = await stat(target);
            if (info.isFile() || info.isDirectory()) result.push({ path: child, directory: info.isDirectory() });
          }
        }
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) this.warn(`디렉터리를 읽지 못했습니다: ${path}`);
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }
  async directories(path: string): Promise<string[]> {
    return (await this.entries(path)).filter(entry => entry.directory).map(entry => entry.path);
  }
  async files(path: string): Promise<string[]> {
    return (await this.entries(path)).filter(entry => !entry.directory).map(entry => entry.path);
  }
  private async walk(root: string, matches: (path: string) => boolean, limit: number, ownerRoot?: string): Promise<string[]> {
    const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    const visited = new Set<string>();
    const files = new Map<string, string>();
    const owner = ownerRoot ? await this.safe(ownerRoot) : null;
    if (ownerRoot && (!owner || !within(resolve(ownerRoot), resolve(root)))) return [];
    while (queue.length && files.size < limit && this.visitedEntries <= this.maxEntries) {
      const current = queue.shift()!;
      const canonical = await this.safe(current.path);
      if (!canonical || visited.has(canonical)) continue;
      if (owner && !within(owner, canonical)) {
        this.warn(`소속 확장 범위 밖의 링크를 제외했습니다: ${root}`);
        continue;
      }
      visited.add(canonical);
      for (const entry of await this.entries(current.path)) {
        if (entry.directory) {
          if (current.depth < this.maxDepth) queue.push({ path: entry.path, depth: current.depth + 1 });
          else this.warn(`확장 조회 깊이 한도에 도달했습니다: ${entry.path}`);
        } else if (matches(entry.path)) {
          const target = await this.safe(entry.path);
          if (target && owner && !within(owner, target)) {
            this.warn(`소속 확장 범위 밖의 파일 링크를 제외했습니다: ${root}`);
          } else if (target && !files.has(target)) files.set(target, entry.path);
          if (files.size >= limit) {
            this.warn(`조회 목록을 ${limit}개 파일로 제한했습니다: ${root}`);
            break;
          }
        }
      }
    }
    return [...files.values()].sort();
  }
  skills(path: string, ownerRoot?: string): Promise<string[]> { return this.walk(path, item => basename(item) === 'SKILL.md', 5000, ownerRoot); }
  markdown(path: string, ownerRoot?: string): Promise<string[]> { return this.walk(path, item => /\.md$/i.test(item), 5000, ownerRoot); }
  allFiles(path: string, limit = 160): Promise<string[]> { return this.walk(path, () => true, limit); }
}
