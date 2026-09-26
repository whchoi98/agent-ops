import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { OwnedResourceScope, ProcessResourceUsage, ResourceWarning } from '../../shared/resources.js';

export interface OwnedProcessRoot {
  pid: number;
  ownerId: string;
  kind: OwnedResourceScope;
  processGroup: boolean;
}
export interface ProcessRecord {
  pid: number;
  parentPid: number;
  groupId: number;
  cpuSeconds: number;
  rssBytes: number;
  start: string;
}
export interface OwnedProcessSnapshot {
  scopes: Record<OwnedResourceScope, ProcessResourceUsage>;
  warnings: ResourceWarning[];
}
const OUTPUT_LIMIT = 1024 * 1024;
const PROCESS_LIMIT = 512;
const ownedScopes: OwnedResourceScope[] = ['sync', 'agents', 'mcp', 'harness'];
const zero = (): ProcessResourceUsage => ({ cpuPercent: 0, rssBytes: 0, processCount: 0 });
const unknown = (): ProcessResourceUsage => ({ cpuPercent: null, rssBytes: null, processCount: null });
export const emptyOwnedSnapshot = (): OwnedProcessSnapshot => ({
  scopes: { sync: zero(), agents: zero(), mcp: zero(), harness: zero() }, warnings: [],
});

export function parseCpuTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (!match || match[1] !== undefined && match[2] === undefined) return null;
  const [, days, hours, minutes, seconds] = match;
  if (Number(seconds) >= 60 || hours !== undefined && Number(minutes) >= 60) return null;
  const value = Number(days || 0) * 86400 + Number(hours || 0) * 3600 + Number(minutes) * 60 + Number(seconds);
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER / 1000 ? value : null;
}

export function parseProcessTable(text: string): Map<number, ProcessRecord> {
  if (Buffer.byteLength(text) > OUTPUT_LIMIT) throw new Error('Process sample exceeds its limit.');
  const result = new Map<number, ProcessRecord>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error('Unsupported process metadata.');
    const [, pidText, parentText, groupText, time, rssText, start] = match;
    const pid = Number(pidText), parentPid = Number(parentText), groupId = Number(groupText);
    const cpuSeconds = parseCpuTime(time), rssBytes = Number(rssText) * 1024;
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647
      || !Number.isSafeInteger(parentPid) || !Number.isSafeInteger(groupId)
      || cpuSeconds === null || !Number.isSafeInteger(rssBytes) || rssBytes < 0
      || !/^[A-Za-z]{3} [A-Za-z]{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(start)
      || result.has(pid)) throw new Error('Unsupported process metadata.');
    result.set(pid, { pid, parentPid, groupId, cpuSeconds, rssBytes, start });
  }
  return result;
}

function readProcessTable(signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,time=,rss=,lstart='], {
      encoding: 'utf8', timeout: 2000, maxBuffer: OUTPUT_LIMIT, windowsHide: true,
      signal, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }, (error, stdout) => {
      if (error) reject(new Error('Process metrics are unavailable.'));
      else resolve(stdout);
    });
  });
}

type Previous = { seconds: number; at: number; ownerId: string };
export class OwnedProcessSampler {
  private previous = new Map<string, Previous>();
  private rootIdentities = new Map<string, string>();
  private readonly read: (signal?: AbortSignal) => Promise<string>;
  private readonly now: () => number;
  private readonly maxProcesses: number;
  private readonly supported: boolean;

  constructor(options: {
    read?: (signal?: AbortSignal) => Promise<string>;
    now?: () => number; maxProcesses?: number; platform?: NodeJS.Platform;
  } = {}) {
    this.read = options.read ?? readProcessTable;
    this.now = options.now ?? (() => performance.now());
    this.maxProcesses = Math.max(1, Math.min(PROCESS_LIMIT,
      Number.isFinite(options.maxProcesses) ? Math.floor(options.maxProcesses!) : PROCESS_LIMIT));
    this.supported = Boolean(options.read) || ['linux', 'darwin'].includes(options.platform ?? process.platform);
  }

  async sample(input: readonly OwnedProcessRoot[], signal?: AbortSignal): Promise<OwnedProcessSnapshot> {
    const roots = input.filter(root => Number.isSafeInteger(root.pid) && root.pid > 0
      && root.pid !== process.pid && ownedScopes.includes(root.kind)).slice(0, 32);
    const result = emptyOwnedSnapshot();
    const liveKeys = new Set(roots.map(root => `${root.ownerId}:${root.pid}`));
    for (const key of this.rootIdentities.keys()) if (!liveKeys.has(key)) this.rootIdentities.delete(key);
    if (!roots.length) { this.previous.clear(); return result; }
    const fail = (code: ResourceWarning) => {
      this.previous.clear();
      for (const root of roots) result.scopes[root.kind] = unknown();
      result.warnings.push(code);
      return result;
    };
    if (!this.supported) return fail('owned_platform_unsupported');
    if (input.length > 32) return fail('owned_process_limit');
    let table: Map<number, ProcessRecord>;
    try { table = parseProcessTable(await this.read(signal)); }
    catch { return fail('owned_processes_unavailable'); }
    if (signal?.aborted) return fail('owned_processes_unavailable');
    const at = this.now();
    const children = new Map<number, number[]>();
    for (const item of table.values()) {
      const list = children.get(item.parentPid) ?? [];
      list.push(item.pid);
      children.set(item.parentPid, list);
    }
    const selected = new Map<number, { record: ProcessRecord; root: OwnedProcessRoot }>();
    const invalid = new Set<OwnedResourceScope>();
    for (const root of roots) {
      const key = `${root.ownerId}:${root.pid}`;
      const leader = table.get(root.pid);
      const identity = this.rootIdentities.get(key);
      if (leader && identity !== undefined && identity !== leader.start) {
        invalid.add(root.kind);
        result.warnings.push('owned_process_identity_changed');
        continue;
      }
      if (leader) this.rootIdentities.set(key, leader.start);
      const pending = leader ? [root.pid] : [];
      if (root.processGroup) {
        for (const item of table.values()) if (item.groupId === root.pid) pending.push(item.pid);
      }
      const visited = new Set<number>();
      for (let index = 0; index < pending.length; index++) {
        const pid = pending[index];
        if (visited.has(pid)) continue;
        visited.add(pid);
        if (pid !== process.pid) {
          const record = table.get(pid);
          if (record && !selected.has(pid)) selected.set(pid, { record, root });
        }
        if (selected.size > this.maxProcesses || visited.size > this.maxProcesses) return fail('owned_process_limit');
        pending.push(...children.get(pid) ?? []);
      }
      if (!visited.size) invalid.add(root.kind);
    }
    const next = new Map<string, Previous>();
    for (const { record, root } of selected.values()) {
      const scope = result.scopes[root.kind];
      scope.processCount!++;
      scope.rssBytes! += record.rssBytes;
      const key = `${record.pid}:${record.start}`;
      const previous = this.previous.get(key);
      let cpu: number | null = null;
      if (previous && previous.ownerId === root.ownerId && at > previous.at && record.cpuSeconds >= previous.seconds) {
        cpu = (record.cpuSeconds - previous.seconds) * 100_000 / (at - previous.at);
        if (!Number.isFinite(cpu)) cpu = null;
      }
      scope.cpuPercent = scope.cpuPercent === null || cpu === null ? null : scope.cpuPercent + cpu;
      next.set(key, { seconds: record.cpuSeconds, at, ownerId: root.ownerId });
    }
    this.previous = next;
    for (const kind of invalid) {
      result.scopes[kind] = unknown();
      if (!result.warnings.length) result.warnings.push('owned_processes_unavailable');
    }
    result.warnings = [...new Set(result.warnings)];
    return result;
  }
}
