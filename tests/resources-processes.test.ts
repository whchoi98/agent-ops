import { describe, expect, it, vi } from 'vitest';
import { OwnedProcessSampler, parseCpuTime, parseProcessTable, type OwnedProcessRoot } from '../server/resources/processes.js';

const start = 'Fri Sep 25 10:00:00 2026';
const line = (pid: number, parent: number, group: number, time: string, rss = 100, born = start) =>
  `${pid} ${parent} ${group} ${time} ${rss} ${born}`;
const root: OwnedProcessRoot = { pid: 10, ownerId: 'run-a', kind: 'agents', processGroup: true };

describe('resource process counters', () => {
  it('parses cumulative POSIX CPU time rather than a lifetime percentage', () => {
    expect(parseCpuTime('01:02:03')).toBe(3723);
    expect(parseCpuTime('2-01:02:03.50')).toBe(176523.5);
    expect(parseCpuTime('12:34.56')).toBe(754.56);
    expect(parseCpuTime('00:00:00')).toBe(0);
    for (const input of ['NaN', '-1:00', '1:60', '1:02:99', '1', '1:2:3:4']) expect(parseCpuTime(input)).toBeNull();
  });

  it('reads only the requested metadata columns and rejects malformed samples', () => {
    const table = parseProcessTable(line(10, 1, 10, '00:00:02', 1234));
    expect(table.get(10)).toMatchObject({ pid: 10, parentPid: 1, groupId: 10, cpuSeconds: 2, rssBytes: 1234 * 1024, start });
    expect(() => parseProcessTable('10 1 10 secret-command-line')).toThrow();
    expect(() => parseProcessTable(line(10, 1, 10, '00:00:02') + '\n' + line(10, 1, 10, '00:00:03'))).toThrow();
  });

  it('does not run ps without app-owned workers or jobs', async () => {
    const read = vi.fn(async () => '');
    const sampler = new OwnedProcessSampler({ read });
    expect((await sampler.sample([])).scopes.agents).toEqual({ cpuPercent: 0, rssBytes: 0, processCount: 0 });
    expect(read).not.toHaveBeenCalled();
  });

  it('counts descendants once, excludes unrelated processes, and preserves detached groups', async () => {
    let now = 1000;
    let text = [
      line(10, 1, 10, '00:00:01'), line(11, 10, 10, '00:00:02'),
      line(12, 11, 12, '00:00:00'), line(99, 1, 99, '99:00:00', 999999),
    ].join('\n');
    const sampler = new OwnedProcessSampler({ read: async () => text, now: () => now });
    const first = await sampler.sample([root]);
    expect(first.scopes.agents).toEqual({ cpuPercent: null, rssBytes: 300 * 1024, processCount: 3 });
    now = 6000;
    text = [
      line(10, 1, 10, '00:00:02'), line(11, 10, 10, '00:00:04'),
      line(12, 11, 12, '00:00:01'), line(99, 1, 99, '99:00:05', 999999),
    ].join('\n');
    expect((await sampler.sample([root])).scopes.agents.cpuPercent).toBe(80);
    // The leader exited, but its owned process group is still being drained.
    now = 11000;
    text = line(11, 1, 10, '00:00:05');
    expect((await sampler.sample([root])).scopes.agents).toEqual({ cpuPercent: 20, rssBytes: 100 * 1024, processCount: 1 });
  });

  it('does not include a reused PID under the old ownership identity', async () => {
    let now = 1000;
    let text = line(10, 1, 10, '00:00:01');
    const sampler = new OwnedProcessSampler({ read: async () => text, now: () => now });
    await sampler.sample([root]);
    now += 5000;
    text = line(10, 1, 10, '00:00:01', 999999, 'Fri Sep 25 10:10:00 2026');
    const result = await sampler.sample([root]);
    expect(result.scopes.agents).toEqual({ cpuPercent: null, rssBytes: null, processCount: null });
    expect(result.warnings).toContain('owned_process_identity_changed');
  });

  it('does not count the parent process group as belonging to an import worker', async () => {
    const sampler = new OwnedProcessSampler({ read: async () => [
      line(20, 1, 1, '00:00:00'), line(21, 20, 1, '00:00:00'), line(90, 1, 1, '99:00:00', 999999),
    ].join('\n') });
    const result = await sampler.sample([{ pid: 20, ownerId: 'sync-a', kind: 'sync', processGroup: false }]);
    expect(result.scopes.sync).toEqual({ cpuPercent: null, rssBytes: 200 * 1024, processCount: 2 });
    expect(result.scopes.agents.processCount).toBe(0);
  });

  it('reports failed or over-limit owned samples as unknown, not zero', async () => {
    const failed = new OwnedProcessSampler({ read: async () => { throw new Error('private process diagnostic'); } });
    const result = await failed.sample([root]);
    expect(result.scopes.agents.rssBytes).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private');
    const limited = new OwnedProcessSampler({ read: async () => [line(10, 1, 10, '00:00:01'), line(11, 10, 10, '00:00:01')].join('\n'), maxProcesses: 1 });
    expect((await limited.sample([root])).warnings).toContain('owned_process_limit');
  });
});
