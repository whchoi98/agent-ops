import { afterEach, describe, expect, it } from 'vitest';
import { link, mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanDisk } from '../server/resources/disk.js';

const directories: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-ops-resource-disk-'));
  directories.push(dir);
  return dir;
}
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

describe('application disk metadata', () => {
  it('separates database, WAL, backups and other data without opening file contents', async () => {
    const dir = await fixture();
    await mkdir(join(dir, 'backups'));
    await writeFile(join(dir, 'agent-ops.sqlite'), Buffer.alloc(4096));
    await writeFile(join(dir, 'agent-ops.sqlite-wal'), Buffer.alloc(100));
    await writeFile(join(dir, 'agent-ops.sqlite-shm'), Buffer.alloc(20));
    await writeFile(join(dir, 'backups', 'before.sqlite.gz'), Buffer.alloc(500));
    await writeFile(join(dir, 'config.json'), '12345');
    const result = await scanDisk(dir);
    expect(result.complete).toBe(true);
    expect(result.logicalBytes).toBe(4721);
    expect(result.categories.database.logicalBytes).toBe(4096);
    expect(result.categories.wal.logicalBytes).toBe(120);
    expect(result.categories.backups.logicalBytes).toBe(500);
    expect(result.categories.other.logicalBytes).toBe(5);
    expect(result.volume?.availableBytes).toBeGreaterThanOrEqual(0);
    expect(result.volume?.totalBytes).toBeGreaterThan(0);
  });

  it('deduplicates hardlinks and does not follow external symbolic links', async () => {
    const dir = await fixture();
    const outside = await fixture();
    await writeFile(join(dir, 'agent-ops.sqlite'), Buffer.alloc(100));
    await mkdir(join(dir, 'backups'));
    await link(join(dir, 'agent-ops.sqlite'), join(dir, 'backups', 'hardlink.sqlite'));
    await writeFile(join(outside, 'private'), Buffer.alloc(100000));
    await symlink(outside, join(dir, 'linked-directory'), 'dir');
    await symlink(join(outside, 'private'), join(dir, 'linked-file'));
    const result = await scanDisk(dir);
    expect(result.logicalBytes).toBe(100);
    expect(result.fileCount).toBe(1);
    expect(result.skippedLinks).toBe(2);
    expect(result.categories.database.logicalBytes).toBe(100);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('handles a large sparse file using metadata instead of reading gigabytes', async () => {
    const dir = await fixture();
    const file = await open(join(dir, 'agent-ops.sqlite'), 'w');
    try { await file.truncate(3 * 1024 ** 3); } finally { await file.close(); }
    const result = await scanDisk(dir);
    expect(result.logicalBytes).toBe(3 * 1024 ** 3);
    expect(result.fileCount).toBe(1);
    expect(result.allocatedBytes).toBeLessThan(result.logicalBytes!);
  });

  it('exposes entry and depth limits instead of claiming complete totals', async () => {
    const dir = await fixture();
    await mkdir(join(dir, 'one', 'two'), { recursive: true });
    for (let i = 0; i < 5; i++) await writeFile(join(dir, `file-${i}`), 'x');
    await writeFile(join(dir, 'one', 'two', 'nested'), 'abc');
    expect((await scanDisk(dir, { maxEntries: 2 })).complete).toBe(false);
    const shallow = await scanDisk(dir, { maxDepth: 0 });
    expect(shallow.complete).toBe(false);
    expect(shallow.warnings).toContain('disk_depth_limit');
  });

  it('distinguishes an empty directory from a missing/unreadable data directory', async () => {
    const dir = await fixture();
    expect((await scanDisk(dir)).logicalBytes).toBe(0);
    const missing = await scanDisk(join(dir, 'absent'));
    expect(missing.logicalBytes).toBeNull();
    expect(missing.complete).toBe(false);
  });

  it('does not report zero file usage when a scan is cancelled before reading entries', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'agent-ops.sqlite'), Buffer.alloc(100));
    const controller = new AbortController();
    controller.abort();
    const result = await scanDisk(dir, { signal: controller.signal });
    expect(result.complete).toBe(false);
    expect(result.logicalBytes).toBeNull();
    expect(result.warnings).toContain('disk_time_limit');
  });
});
