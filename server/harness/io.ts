import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redactor, secretValues } from '../mcp/redaction.js';
import { harnessError } from './types.js';

const MAX_PATH_DEPTH = 16;
const sensitiveName = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|auth(?:entication)?\.json|credentials(?:\.[^.]+)?|\.credentials\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|(?:api[-_]?keys?|tokens?|secrets?)(?:\.[^.]+)?)$|\.(?:pem|p12|pfx|key|sqlite\w*|db)(?:[-.].*)?$/i;
const sensitiveDirectories = new Set(['.git', '.ssh', '.aws', '.gnupg', 'node_modules', '__pycache__']);
const sameFile = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino;
const sameVersion = (left: Stats, right: Stats) => sameFile(left, right)
  && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

export const contentHash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const missingHarnessFile = (error: unknown): boolean =>
  ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');
export function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : fallback;
}
export function harnessObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function withinHarnessRoot(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

/** Check the owning root, not a union of otherwise approved projects. */
function lexicalPath(root: string, path: string): { owner: string; target: string; parts: string[] } {
  if (root.length > 4096 || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(root + path)) {
    throw harnessError(400, 'Unsupported harness file path.');
  }
  const owner = resolve(root);
  const target = resolve(path);
  const parts = relative(owner, target).split(sep).filter(Boolean);
  if (!withinHarnessRoot(owner, target) || parts.length > MAX_PATH_DEPTH
    || parts.some(part => sensitiveDirectories.has(part) || sensitiveName.test(part))) {
    throw harnessError(400, 'Harness file is outside its owner or uses a restricted path.');
  }
  return { owner, target, parts };
}

/** Missing paths may be advertised, but every existing component must be safe. */
export async function inspectHarnessPath(root: string, path: string, allowMissing = false): Promise<Stats | null> {
  const { owner, target, parts } = lexicalPath(root, path);
  let rootInfo: Stats;
  try { rootInfo = await lstat(owner); }
  catch (error) {
    if (allowMissing && missingHarnessFile(error)) return null;
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw harnessError(400, 'Harness owner must be a regular directory, without links.');
  }
  const canonicalRoot = await realpath(owner);
  let current = owner;
  let info = rootInfo;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    try { info = await lstat(current); }
    catch (error) {
      if (allowMissing && missingHarnessFile(error)) return null;
      throw error;
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
      throw harnessError(400, 'Harness paths cannot traverse links or non-directories.');
    }
  }
  const canonical = await realpath(target);
  if (!withinHarnessRoot(canonicalRoot, canonical)) {
    throw harnessError(400, 'Harness file is outside its canonical owner.');
  }
  lexicalPath(canonicalRoot, canonical);
  return info;
}

export interface HarnessOpenFile {
  handle: FileHandle;
  info: Stats;
  verify(unchanged?: boolean): Promise<Stats>;
}

export async function openHarnessFile(root: string, path: string): Promise<HarnessOpenFile> {
  const before = await inspectHarnessPath(root, path);
  if (!before?.isFile() || before.nlink !== 1) {
    throw harnessError(400, 'Harness sources must be regular files with a single link.');
  }
  // NONBLOCK also prevents a raced-in FIFO from hanging the request.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || !sameFile(before, info)) {
      throw harnessError(409, 'Harness file changed while opening it.');
    }
    const verify = async (unchanged = false) => {
      const [named, held] = await Promise.all([inspectHarnessPath(root, path), handle.stat()]);
      if (!named?.isFile() || !held.isFile() || named.nlink !== 1 || held.nlink !== 1
        || !sameFile(info, named) || !sameFile(info, held)
        || (unchanged && (!sameVersion(info, named) || !sameVersion(info, held)))) {
        throw harnessError(409, 'Harness file changed while reading it.');
      }
      return held;
    };
    await verify();
    return { handle, info, verify };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** No readFile(): allocation and actual reads are limited before touching source bytes. */
export async function readHarnessBytes(root: string, path: string, maximum: number): Promise<Buffer> {
  const file = await openHarnessFile(root, path);
  try {
    if (file.info.size > maximum) throw harnessError(400, 'Harness policy exceeds the byte limit.');
    const bytes = Buffer.alloc(file.info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    await file.verify(true);
    if (offset !== bytes.length) throw harnessError(409, 'Harness file changed while reading it.');
    return bytes;
  } finally { await file.handle.close(); }
}

export function decodeHarnessText(bytes: Buffer): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes('\u0000')) throw new Error('binary');
    return text;
  } catch { throw harnessError(400, 'Harness source must be UTF-8 text.'); }
}

async function createOwner(root: string): Promise<void> {
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw harnessError(400, 'Unsafe harness directory.');
  } catch (error) {
    if (!missingHarnessFile(error)) throw error;
    const parent = dirname(root);
    if (parent === root) throw error;
    await createOwner(parent);
    try { await mkdir(root, { mode: 0o700 }); }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure; }
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw harnessError(400, 'Unsafe harness directory.');
  }
}

async function ensureDirectory(root: string, path: string): Promise<void> {
  const { owner, parts } = lexicalPath(root, path);
  await createOwner(owner);
  let current = owner;
  for (const part of parts) {
    current = join(current, part);
    await inspectHarnessPath(owner, current, true);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await inspectHarnessPath(owner, current);
    if (!info?.isDirectory()) throw harnessError(400, 'Unsafe harness directory.');
  }
}

async function writableTarget(root: string, path: string): Promise<void> {
  const info = await inspectHarnessPath(root, path, true);
  if (info && (!info.isFile() || info.nlink !== 1)) throw harnessError(400, 'Unsafe managed harness file.');
}

async function removeOwned(path: string, info: Stats): Promise<void> {
  try { if (sameFile(await lstat(path), info)) await unlink(path); }
  catch (error) { if (!missingHarnessFile(error)) throw error; }
}

/** An exclusive on-disk lock makes competing store instances/processes fail with 409. */
export async function withHarnessWriteLock<T>(root: string, path: string, operation: () => Promise<T>): Promise<T> {
  await ensureDirectory(root, dirname(path));
  const lockPath = join(dirname(path), '.policy-write.lock');
  await writableTarget(root, lockPath);
  let handle: FileHandle;
  try { handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw harnessError(409, 'Another managed policy save is in progress.');
    throw error;
  }
  const info = await handle.stat();
  try {
    await inspectHarnessPath(root, lockPath);
    return await operation();
  } finally {
    await handle.close();
    await removeOwned(lockPath, info);
  }
}

/** Replace only app-owned files; the caller holds the policy lock and verifies its revision. */
export async function replaceHarnessBytes(root: string, path: string, bytes: Buffer): Promise<void> {
  await writableTarget(root, path);
  const temporary = join(dirname(path), `.policy-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const info = await handle.stat();
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    await inspectHarnessPath(root, temporary);
    await writableTarget(root, path);
    await rename(temporary, path);
  } finally { await removeOwned(temporary, info); }
}

/** Collect secrets before projecting fields, so an innocent-looking identifier cannot echo one. */
export function harnessRedactor(value: unknown, hidePayload = false): (input: string, limit?: number) => string {
  const values = new Set(secretValues(value));
  const stack = [{ value, hidden: false }];
  let visited = 0;
  while (stack.length) {
    if (++visited > 10000) return input => input ? '[REDACTED]' : '';
    const current = stack.pop()!;
    if (typeof current.value === 'string' && current.hidden) {
      if (current.value) values.add(current.value);
      if (current.value.trim()) values.add(current.value.trim());
    } else if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, hidden: current.hidden });
    } else if (harnessObject(current.value)) {
      for (const [key, child] of Object.entries(current.value)) {
        const hidden = current.hidden
          || /env|headers|tokens?|password|passwd|passphrase|secret|credential|authorization|cookie|oauth|api[_-]?key|private[_-]?key|access[_-]?key/i.test(key)
          || (hidePayload && /^(?:tool_input|tool_output|output|modified_input|sanitized_output)$/i.test(key));
        stack.push({ value: child, hidden });
      }
    }
  }
  const clean = redactor([...values]);
  return (input, limit = 512) => clean(input, Math.max(input.length, limit))
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\[redacted\]/gi, '[REDACTED]')
    .slice(0, limit);
}
