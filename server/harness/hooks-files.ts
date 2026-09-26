import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { harnessError } from './types.js';

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 128;
const noFollow = constants.O_NOFOLLOW ?? 0;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export const hookHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const identity = (info: Stats) => `${info.dev}:${info.ino}:${info.mode}`;
const fileIdentity = (info: Stats) =>
  `${identity(info)}:${info.nlink}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
const conflict = () => harnessError(409, 'Hook preview inputs or filesystem identity changed; create a new preview.');

export function hookAbsolute(path: string) {
  if (!isAbsolute(path) || path.includes('\0') || path.length > 4096 || path.split(sep).length > 80) {
    throw harnessError(400, 'Hook paths must be bounded absolute paths.');
  }
  return resolve(path);
}

interface HookFile {
  path: string;
  text: string | null;
  hash: string | null;
  identity: string | null;
  mode: number;
  limit: number;
  binary: boolean;
}
export interface HookFileChange { path: string; after: string | null }
interface Directory { path: string; identity: string | null }
interface InterpreterPath { path: string; endpoint: string; fingerprint: string }

/**
 * Hook-specific optimistic transactions. All source reads are bounded and every
 * ancestor is checked, including absent parents. Never follow a config link or
 * write through a hard link. Rollback only replaces bytes written by this
 * transaction; a concurrent outside edit is left intact with its backup.
 */
export class HookFiles {
  readonly files = new Map<string, HookFile>();
  private readonly directories = new Map<string, Directory>();
  private readonly listings = new Map<string, string>();
  private interpreter: InterpreterPath | null = null;

  get bytes() {
    return [...this.files.values()].reduce((sum, file) => sum + Buffer.byteLength(file.text ?? '') + 512, 0) +
      Buffer.byteLength(JSON.stringify(this.interpreter));
  }

  private async directory(path: string): Promise<Directory> {
    try {
      const info = await fs.lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw harnessError(400, 'Unsafe hook directory: symbolic links and non-directory parents are not allowed.');
      }
      return { path, identity: identity(info) };
    } catch (error) {
      if (missing(error)) return { path, identity: null };
      throw error;
    }
  }

  async parents(path: string, includeSelf = false) {
    const absolute = hookAbsolute(includeSelf ? path : dirname(path));
    let current = parse(absolute).root;
    for (const part of ['', ...absolute.slice(current.length).split(sep).filter(Boolean)]) {
      if (part) current = join(current, part);
      const found = await this.directory(current);
      const expected = this.directories.get(current);
      if (expected && expected.identity !== found.identity) throw conflict();
      this.directories.set(current, found);
    }
  }

  async project(path: string) {
    await this.parents(path, true);
    if (!this.directories.get(hookAbsolute(path))?.identity) throw harnessError(400, 'Registered project directory is missing.');
    const canonical = await fs.realpath(path);
    if (canonical !== hookAbsolute(path)) throw harnessError(400, 'Unsafe project canonical path.');
    return canonical;
  }

  private async capture(path: string, limit: number, binary: boolean): Promise<HookFile> {
    await this.parents(path);
    let before: Stats;
    try { before = await fs.lstat(path); }
    catch (error) {
      if (!missing(error)) throw error;
      return { path, text: null, hash: null, identity: null, mode: 0o600, limit, binary };
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw harnessError(400, 'Unsafe hook input: only regular files without symbolic or hard links are allowed.');
    }
    if (before.size > limit) throw harnessError(413, 'Hook input exceeds the file size limit.');
    const handle = await fs.open(path, constants.O_RDONLY | noFollow | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || fileIdentity(info) !== fileIdentity(before)) throw conflict();
      const hash = createHash('sha256');
      const chunks: Buffer[] = [];
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1));
      let count = 0;
      while (true) {
        const read = await handle.read(buffer, 0, Math.min(buffer.length, limit + 1 - count), count);
        if (!read.bytesRead) break;
        count += read.bytesRead;
        if (count > limit) throw harnessError(413, 'Hook input exceeds the file size limit.');
        const chunk = buffer.subarray(0, read.bytesRead);
        hash.update(chunk);
        if (!binary) chunks.push(Buffer.from(chunk));
      }
      const after = await handle.stat();
      const current = await fs.lstat(path);
      if (fileIdentity(info) !== fileIdentity(after) || fileIdentity(current) !== fileIdentity(info)) throw conflict();
      await this.parents(path);
      const bytes = binary ? null : Buffer.concat(chunks);
      if (bytes?.includes(0)) throw harnessError(400, 'Invalid binary content in hook configuration.');
      const text = bytes?.toString('utf8') ?? null;
      if (bytes && !Buffer.from(text!, 'utf8').equals(bytes)) throw harnessError(400, 'Invalid UTF-8 hook configuration.');
      return { path, text, hash: hash.digest('hex'), identity: fileIdentity(info), mode: info.mode & 0o777, limit, binary };
    } finally { await handle.close(); }
  }

  async read(path: string, options: { limit?: number; binary?: boolean; required?: boolean } = {}) {
    path = hookAbsolute(path);
    let file = this.files.get(path);
    if (!file) {
      file = await this.capture(path, options.limit ?? (options.binary ? MAX_BINARY_BYTES : MAX_TEXT_BYTES), options.binary ?? false);
      this.files.set(path, file);
    }
    if (options.required && file.hash === null) throw harnessError(400, 'Required hook input file is missing.');
    return file;
  }

  private async interpreterPath(path: string): Promise<InterpreterPath> {
    hookAbsolute(path);
    let current = parse(path).root;
    let pending = path.slice(current.length).split(sep).filter(Boolean);
    const components: Array<{ path: string; identity: string; target?: string }> = [];
    const root = await fs.lstat(current);
    if (!root.isDirectory()) throw harnessError(400, 'Invalid Python interpreter root directory.');
    components.push({ path: current, identity: identity(root) });
    let links = 0;
    let steps = 0;
    while (pending.length) {
      if (++steps > 256 || pending.length > 256) throw harnessError(413, 'Python interpreter path depth limit exceeded.');
      const part = pending.shift()!;
      if (part === '.') continue;
      if (part === '..') {
        current = dirname(current);
        continue;
      }
      const candidate = hookAbsolute(join(current, part));
      const info = await fs.lstat(candidate);
      if (info.isSymbolicLink()) {
        if (++links > 32) throw harnessError(413, 'Python interpreter symlink chain or cycle limit exceeded.');
        if (info.nlink !== 1) throw harnessError(400, 'Hardlinked Python interpreter links are not allowed.');
        const target = await fs.readlink(candidate);
        if (!target || target.length > 4096 || target.includes('\0')) throw harnessError(400, 'Invalid Python interpreter symlink target.');
        if (fileIdentity(await fs.lstat(candidate)) !== fileIdentity(info)) throw conflict();
        components.push({ path: candidate, identity: fileIdentity(info), target });
        if (isAbsolute(target)) {
          current = parse(target).root;
          pending = [...target.slice(current.length).split(sep).filter(Boolean), ...pending];
        } else pending = [...target.split(sep).filter(Boolean), ...pending];
      } else if (info.isDirectory()) {
        components.push({ path: candidate, identity: identity(info) });
        current = candidate;
      } else if (info.isFile() && !pending.length && info.nlink === 1) {
        components.push({ path: candidate, identity: fileIdentity(info) });
        return { path, endpoint: candidate, fingerprint: hookHash(JSON.stringify(components)) };
      } else throw harnessError(400, 'Python interpreter endpoint must be a regular file without hard links.');
    }
    throw harnessError(400, 'Python interpreter endpoint must be a regular file, not a directory.');
  }

  /**
   * The only link-following read. Preserve the selected path for venv semantics,
   * while pinning every traversed link/parent and hashing the final regular file.
   * Config, policy, bridge and binding reads continue to use strict read().
   */
  async readInterpreter(path: string) {
    const selected = await this.interpreterPath(path);
    if (this.interpreter && (this.interpreter.path !== path || this.interpreter.fingerprint !== selected.fingerprint)) throw conflict();
    await this.read(selected.endpoint, { binary: true, required: true });
    this.interpreter = selected;
    await this.verifyInterpreter();
  }

  private async verifyInterpreter() {
    if (!this.interpreter) return;
    try {
      const current = await this.interpreterPath(this.interpreter.path);
      if (current.endpoint !== this.interpreter.endpoint || current.fingerprint !== this.interpreter.fingerprint) throw conflict();
    } catch { throw conflict(); }
  }

  private async names(path: string) {
    await this.parents(path, true);
    if (!this.directories.get(path)?.identity) return [];
    const names: string[] = [];
    const directory = await fs.opendir(path);
    for await (const entry of directory) {
      names.push(entry.name);
      if (names.length > MAX_DIRECTORY_ENTRIES) throw harnessError(413, 'Hook directory entry limit exceeded.');
    }
    await this.parents(path, true);
    return names.sort();
  }

  async jsonFiles(path: string) {
    path = hookAbsolute(path);
    const names = await this.names(path);
    const signature = JSON.stringify(names);
    if (this.listings.has(path) && this.listings.get(path) !== signature) throw conflict();
    this.listings.set(path, signature);
    return names.filter(name => name.endsWith('.json')).map(name => join(path, name));
  }

  private async verifyFile(file: HookFile) {
    const current = await this.capture(file.path, file.limit, file.binary);
    if (current.identity !== file.identity || current.hash !== file.hash) throw conflict();
  }

  async verify() {
    await this.verifyInterpreter();
    for (const expected of this.directories.values()) {
      if ((await this.directory(expected.path)).identity !== expected.identity) throw conflict();
    }
    for (const [path, expected] of this.listings) {
      if (JSON.stringify(await this.names(path)) !== expected) throw conflict();
    }
    for (const file of this.files.values()) await this.verifyFile(file);
    await this.verifyInterpreter();
  }

  private async ensureParents(path: string, beforeWrite?: () => void) {
    await this.parents(path);
    let current = parse(path).root;
    for (const part of dirname(path).slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      const expected = this.directories.get(current)!;
      if (expected.identity === null) {
        beforeWrite?.();
        try { await fs.mkdir(current, { mode: 0o700 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw conflict();
          throw error;
        }
        const created = await this.directory(current);
        if (!created.identity) throw conflict();
        this.directories.set(current, created);
      } else if ((await this.directory(current)).identity !== expected.identity) throw conflict();
    }
  }

  private async refreshListing(path: string) {
    const parent = dirname(path);
    if (this.listings.has(parent)) this.listings.set(parent, JSON.stringify(await this.names(parent)));
  }

  private async discardCreated(path: string, created: Stats) {
    try {
      await this.parents(path);
      const current = await fs.lstat(path);
      if (current.isFile() && current.nlink === 1 && current.dev === created.dev && current.ino === created.ino) {
        await fs.unlink(path);
      }
    } catch { /* Missing, unsafe or replaced paths must not be removed. */ }
  }

  private async writeNew(path: string, text: string, mode: number, beforeWrite?: () => void) {
    await this.parents(path);
    beforeWrite?.();
    const handle = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, mode);
    let created: Stats | null = null;
    try {
      created = await handle.stat();
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      const saved = await this.capture(path, Math.max(MAX_TEXT_BYTES, Buffer.byteLength(text)), false);
      if (saved.hash !== hookHash(text) || saved.identity !== fileIdentity(await handle.stat())) throw conflict();
      await handle.close();
      return saved;
    } catch (error) {
      // Keep the descriptor open during cleanup so its inode cannot be reused
      // for a foreign replacement. Never delete a different inode at this path.
      if (created) await this.discardCreated(path, created);
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async replace(expected: HookFile, after: string | null, record?: (file: HookFile, confirmed: boolean) => void, beforeWrite?: () => void) {
    await this.ensureParents(expected.path, beforeWrite);
    if (after === null) {
      await this.verifyFile(expected);
      beforeWrite?.();
      if (expected.hash !== null) await fs.unlink(expected.path);
      record?.({ ...expected, text: null, hash: null, identity: null }, false);
    } else {
      const temporary = join(dirname(expected.path), `.agent-ops-hook-${randomUUID()}.tmp`);
      let staged: HookFile | null = null;
      try {
        staged = await this.writeNew(temporary, after, expected.mode, beforeWrite);
        await this.verifyFile(expected);
        await this.verifyFile(staged);
        beforeWrite?.();
        await fs.rename(temporary, expected.path);
        // Record the mutation before any fallible post-rename read. Rename may
        // change ctime, but the staged inode, bytes and mtime still identify our
        // write if the following read fails.
        record?.({ ...staged, path: expected.path }, false);
      } finally {
        if (staged) {
          try {
            await this.verifyFile(staged);
            await fs.unlink(temporary);
          } catch { /* Renamed, or changed externally: never unlink another writer's file. */ }
        }
      }
    }
    const current = await this.capture(expected.path, expected.limit, false);
    if (current.hash !== (after === null ? null : hookHash(after))) throw conflict();
    this.files.set(expected.path, current);
    record?.(current, true);
    await this.refreshListing(expected.path);
    return current;
  }

  private async backup(changes: HookFileChange[], directory: string, client: string, projectId: string, beforeWrite?: () => void) {
    await this.ensureParents(join(directory, 'placeholder'), beforeWrite);
    const pattern = /^(codex|claude-code|kiro)-\d{13}-[a-f0-9-]{36}\.json$/;
    const names = (await this.names(directory)).filter(name => pattern.test(name) && name.startsWith(`${client}-`));
    const backups: HookFile[] = [];
    for (const name of names) {
      const file = await this.capture(join(directory, name), MAX_BACKUP_BYTES, false);
      let value: Record<string, unknown>;
      try { value = JSON.parse(file.text!); }
      catch { throw harnessError(400, 'Invalid app-owned hook backup.'); }
      if (value.owner !== 'agent-ops-harness-hooks' || value.protocol !== 1 || value.projectId !== projectId || value.client !== client) {
        throw harnessError(400, 'Hook backup ownership could not be verified.');
      }
      backups.push(file);
    }
    for (const file of backups.sort((a, b) => b.path.localeCompare(a.path)).slice(2)) {
      await this.verifyFile(file);
      beforeWrite?.();
      await fs.unlink(file.path);
    }
    const contents = JSON.stringify({
      owner: 'agent-ops-harness-hooks', protocol: 1, client, projectId,
      files: changes.map(change => ({ path: change.path, before: this.files.get(change.path)!.text })),
    });
    if (Buffer.byteLength(contents) > MAX_BACKUP_BYTES) throw harnessError(413, 'Hook backup size limit exceeded.');
    const temporary = join(directory, `.agent-ops-hook-backup-${randomUUID()}.tmp`);
    const destination = join(directory, `${client}-${Date.now()}-${randomUUID()}.json`);
    let staged: HookFile | null = null;
    try {
      staged = await this.writeNew(temporary, contents, 0o600, beforeWrite);
      const absent = await this.capture(destination, MAX_BACKUP_BYTES, false);
      if (absent.hash !== null) throw conflict();
      await this.verifyFile(staged);
      await this.verifyFile(absent);
      beforeWrite?.();
      // Only fully written, synced and verified JSON is published as a backup.
      await fs.rename(temporary, destination);
    } finally {
      if (staged) {
        try {
          await this.verifyFile(staged);
          await fs.unlink(temporary);
        } catch { /* Published, or replaced externally: preserve foreign files. */ }
      }
    }
  }

  async commit(changes: HookFileChange[], backupsDir: string, client: string, projectId: string, beforeWrite?: () => void) {
    changes = changes.filter(change => this.files.get(change.path)!.text !== change.after);
    await this.verify();
    beforeWrite?.();
    if (!changes.length) return;
    for (const change of changes) await this.ensureParents(change.path, beforeWrite);
    await this.backup(changes, backupsDir, client, projectId, beforeWrite);
    const completed: Array<{ before: HookFile; after: HookFile; confirmed: boolean }> = [];
    try {
      for (const change of changes) {
        await this.verify();
        const before = this.files.get(change.path)!;
        let recorded: typeof completed[number] | undefined;
        await this.replace(before, change.after, (after, confirmed) => {
          if (!recorded) {
            recorded = { before, after, confirmed };
            completed.push(recorded);
          } else {
            recorded.after = after;
            recorded.confirmed = confirmed;
          }
        }, beforeWrite);
      }
      await this.verify();
      beforeWrite?.();
    } catch (error) {
      let preservedOutsideEdit = false;
      for (const change of completed.reverse()) {
        try {
          const current = await this.capture(change.after.path, change.after.limit, false);
          const withoutCtime = (value: string | null) => value?.slice(0, value.lastIndexOf(':')) ?? null;
          if (current.hash !== change.after.hash || (change.confirmed
            ? current.identity !== change.after.identity
            : withoutCtime(current.identity) !== withoutCtime(change.after.identity))) throw conflict();
          await this.replace(current, change.before.text);
        } catch {
          // Leave the remaining binding/metadata in place if a native config was
          // concurrently edited: it may still refer to that binding.
          preservedOutsideEdit = true;
          break;
        }
      }
      if (preservedOutsideEdit) {
        throw harnessError(409, 'Hook transaction failed; concurrent outside edits were preserved. An app-owned backup is available.');
      }
      throw error;
    }
  }
}
