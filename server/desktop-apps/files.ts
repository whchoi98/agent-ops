import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { DesktopAppCandidate, DesktopAppInstallation, DesktopAppLocation } from '../../shared/desktop-apps.js';
import { DesktopAppProbeError } from './errors.js';
import { MAX_PLIST_BYTES, PLIST_KEYS, type DesktopMetadata } from './plist.js';

interface Snapshot { path: string; info: Stats }
interface CandidateResult { candidate: DesktopAppCandidate; installation: DesktopAppInstallation | null }
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const sameIdentity = (before: Stats, after: Stats) => before.dev === after.dev && before.ino === after.ino;

async function directory(path: string): Promise<Snapshot> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new DesktopAppProbeError('unsafe-path');
  return { path, info };
}

async function unchanged(snapshots: Snapshot[]): Promise<boolean> {
  for (const snapshot of snapshots) {
    try {
      const after = await lstat(snapshot.path);
      if (after.isSymbolicLink() || !sameIdentity(snapshot.info, after)) return false;
      if (snapshot.info.isDirectory() && !after.isDirectory()) return false;
      if (snapshot.info.isFile() && (!after.isFile() || after.nlink !== 1 || after.size !== snapshot.info.size
        || after.mtimeMs !== snapshot.info.mtimeMs || after.ctimeMs !== snapshot.info.ctimeMs)) return false;
    } catch { return false; }
  }
  return true;
}

async function readMetadataFile(path: string, snapshots: Snapshot[]): Promise<Buffer> {
  let before: Stats;
  try { before = await lstat(path); }
  catch (error) { throw new DesktopAppProbeError(missing(error) ? 'plist-missing' : 'plist-unreadable'); }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new DesktopAppProbeError('unsafe-path');
  if (before.size > MAX_PLIST_BYTES) throw new DesktopAppProbeError('plist-too-large');
  snapshots.push({ path, info: before });
  if (!(await unchanged(snapshots))) throw new DesktopAppProbeError('changed-during-read');
  // O_NONBLOCK also prevents a raced replacement with a FIFO from hanging open().
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || !sameIdentity(before, info)) throw new DesktopAppProbeError('changed-during-read');
    if (info.size > MAX_PLIST_BYTES) throw new DesktopAppProbeError('plist-too-large');
    const buffer = Buffer.alloc(Math.min(MAX_PLIST_BYTES + 1, info.size + 1));
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > MAX_PLIST_BYTES) throw new DesktopAppProbeError('plist-too-large');
    if (count !== before.size || !(await unchanged(snapshots))) throw new DesktopAppProbeError('changed-during-read');
    return buffer.subarray(0, count);
  } finally { await handle.close(); }
}

/** No directory enumeration: one fixed bundle and its Contents/Info.plist within one owning root. */
export async function inspectDesktopCandidate(
  root: string, bundleName: string, location: DesktopAppLocation,
  parse: (input: Buffer) => Promise<DesktopMetadata>,
): Promise<CandidateResult> {
  const candidate: DesktopAppCandidate = { path: join(root, bundleName), location, status: 'not-found', issues: [] };
  let rootSnapshot: Snapshot;
  let bundleSnapshot: Snapshot;
  try {
    const original = await directory(root);
    // Canonicalize a trusted root's parents (e.g. macOS /var -> /private/var), never a bundle/Contents/plist link.
    rootSnapshot = await directory(await realpath(root));
    if (!sameIdentity(original.info, rootSnapshot.info) || !(await unchanged([original]))) {
      throw new DesktopAppProbeError('changed-during-read');
    }
    bundleSnapshot = await directory(join(rootSnapshot.path, bundleName));
    if (!(await unchanged([rootSnapshot, bundleSnapshot]))) throw new DesktopAppProbeError('changed-during-read');
  } catch (error) {
    if (!missing(error)) {
      candidate.status = 'unverified';
      candidate.issues.push({ code: error instanceof DesktopAppProbeError ? error.code : 'path-unavailable' });
    }
    return { candidate, installation: null };
  }

  candidate.status = 'found';
  const installation: DesktopAppInstallation = {
    path: candidate.path, location, version: null, build: null, bundleIdentifier: null,
    metadataStatus: 'unavailable', issues: [],
    source: { type: 'info-plist', path: join(candidate.path, 'Contents', 'Info.plist'), keys: { ...PLIST_KEYS } },
  };
  try {
    let contents: Snapshot;
    try { contents = await directory(join(bundleSnapshot.path, 'Contents')); }
    catch (error) {
      if (missing(error)) throw new DesktopAppProbeError('plist-missing');
      throw error;
    }
    const snapshots = [rootSnapshot, bundleSnapshot, contents];
    const bytes = await readMetadataFile(join(contents.path, 'Info.plist'), snapshots);
    const metadata = await parse(bytes);
    if (!(await unchanged(snapshots))) throw new DesktopAppProbeError('changed-during-read');
    Object.assign(installation, metadata);
  } catch (error) {
    installation.issues.push({ code: error instanceof DesktopAppProbeError ? error.code : 'plist-unreadable' });
  }
  return { candidate, installation };
}
