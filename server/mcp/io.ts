import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';
import { parseDocument } from 'yaml';
import { ExtensionReader } from '../extensions/io.js';
import { bounded, object, type Dictionary } from './types.js';

/** Fixed discovery roots, bounded reads, and canonical owner checks reuse the extension IO boundary. */
export class McpReader {
  private readonly reader: ExtensionReader;
  private readonly fingerprint = createHash('sha256');
  private reads = 0;
  private bytes = 0;
  private entries = 0;
  readonly warnings: string[] = [];
  constructor(roots: string[], private readonly maxTotal: number, maxBytes?: number) {
    this.reader = new ExtensionReader({
      roots, maxBytes: bounded(maxBytes, 256 * 1024, 256, 512 * 1024), maxEntries: 4096, maxDepth: 4,
    });
  }
  private warn(message: string) {
    if (this.warnings.length < 32 && !this.warnings.includes(message)) this.warnings.push(message);
  }
  async document(path: string, owner: string, format: 'json' | 'toml' | 'yaml' = 'json'): Promise<Dictionary | null> {
    if (++this.reads > 256 || this.bytes >= this.maxTotal) {
      this.warn('MCP discovery reached its configuration read limit.');
      return null;
    }
    const warningCount = this.reader.warnings.length;
    const entry = await this.reader.readText(path, owner);
    if (this.reader.warnings.length > warningCount) this.warn('A configuration file was omitted because it was unreadable, too large, or outside its owner root.');
    this.fingerprint.update(path).update('\0');
    if (!entry) { this.fingerprint.update('missing\0'); return null; }
    this.bytes += Buffer.byteLength(entry.text);
    if (entry.truncated || this.bytes > this.maxTotal) {
      this.warn('MCP discovery reached its configuration byte limit.');
      this.fingerprint.update('oversized\0');
      return null;
    }
    this.fingerprint.update(entry.text).update('\0');
    try {
      const canonical = await realpath(path);
      const info = await stat(canonical);
      this.fingerprint.update(`${canonical}\0${info.dev}:${info.ino}\0`);
      let text = entry.text.replace(/^\uFEFF/, '');
      let value: unknown;
      if (format === 'toml') {
        value = parseToml(text, { maxDepth: 32, unsafeKeyBehaviour: 'throw' });
      } else if (format === 'yaml') {
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
        if (!frontmatter) return null;
        text = frontmatter[1];
        const doc = parseDocument(text, { schema: 'core', uniqueKeys: true, prettyErrors: false, logLevel: 'silent' });
        if (doc.errors.length || doc.warnings.length) throw new Error('Invalid frontmatter');
        value = doc.toJS({ maxAliasCount: 0 });
      } else value = JSON.parse(text);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
      // A byte bound alone does not limit depth or the cost of later recursive processing.
      const pending = [{ value, depth: 0 }];
      let nodes = 0;
      while (pending.length) {
        const current = pending.pop()!;
        if (++nodes > 16000 || current.depth > 32) throw new Error('Structure limit');
        if (current.value && typeof current.value === 'object') {
          for (const [key, child] of Object.entries(current.value)) {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe key');
            pending.push({ value: child, depth: current.depth + 1 });
          }
        }
      }
      return object(value);
    } catch {
      this.warn('A configuration document has an invalid or unsupported structure; its contents were not included.');
      return null;
    }
  }
  async children(path: string, owner: string, directories: boolean): Promise<string[]> {
    if (this.entries >= 4096) { this.warn('MCP discovery reached its directory entry limit.'); return []; }
    if (!await this.reader.contains(owner, path)) {
      if (await this.reader.exists(path)) this.warn('A plugin or agent directory was outside its owner root.');
      return [];
    }
    const before = this.reader.warnings.length;
    const entries = directories ? await this.reader.directories(path) : await this.reader.files(path);
    if (before !== this.reader.warnings.length) this.warn('Some directory entries were outside the safe discovery bounds.');
    const accepted = entries.slice(0, Math.min(128, 4096 - this.entries));
    this.entries += entries.length;
    if (accepted.length < entries.length) this.warn('MCP discovery reached its directory entry limit.');
    const owned: string[] = [];
    for (const entry of accepted) {
      if (await this.reader.contains(owner, entry)) owned.push(entry);
      else this.warn('A plugin or agent entry was outside its owner root.');
    }
    return owned;
  }
  digest() { return this.fingerprint.digest('hex'); }
}
