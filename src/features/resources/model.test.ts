import { describe, expect, it } from 'vitest';
import { RESOURCE_SCOPES, type ResourceSample } from '../../../shared/resources';
import { formatBytes, formatCpu, resourcePaths } from './model';

function sample(at: number, cpu: number | null): ResourceSample {
  return {
    at: new Date(Date.UTC(2026, 8, 25, 10) + at).toISOString(),
    scopes: Object.fromEntries(RESOURCE_SCOPES.map(scope => [scope, { cpuPercent: cpu, rssBytes: 1024, processCount: 1 }])) as ResourceSample['scopes'],
    heapUsedBytes: 0, heapTotalBytes: 0, cpuWindowMs: 5000, durationMs: 0, warnings: [],
  };
}
describe('resource presentation semantics', () => {
  it('distinguishes measured zero, unavailable values, CPU percentages, and binary byte units', () => {
    expect(formatCpu(0)).toBe('0%');
    expect(formatCpu(null)).toBe('—');
    expect(formatCpu(150.25, 'en')).toBe('150.25%');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1 KiB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3 GiB');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
  it('does not connect unknown samples or large collection gaps', () => {
    const gaps = resourcePaths([sample(0, 0), sample(5000, null), sample(10000, 50)], 'cpuPercent');
    expect(gaps.paths.server.match(/M/g)).toHaveLength(2);
    expect(gaps.paths.server).not.toContain('L');
    const delayed = resourcePaths([sample(0, 0), sample(5000, 1), sample(60000, 2)], 'cpuPercent');
    expect(delayed.paths.server.match(/M/g)).toHaveLength(2);
    expect(delayed.paths.server.match(/L/g)).toHaveLength(1);
  });
});
