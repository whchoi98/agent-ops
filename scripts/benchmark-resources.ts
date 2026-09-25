import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createApp } from '../server/app.js';
import { scanDisk } from '../server/resources/disk.js';
import { ResourceMonitor } from '../server/resources/monitor.js';
import { OwnedProcessSampler } from '../server/resources/processes.js';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } }, strict: true });
const directory = await mkdtemp(join(tmpdir(), 'agent-ops-resource-benchmark-'));
const monitors: ResourceMonitor[] = [];
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
  };
};
try {
  const monitor = new ResourceMonitor({ dataDir: directory });
  monitors.push(monitor);
  for (let i = 0; i < 20; i++) await monitor.sample();
  (globalThis as { gc?: () => void }).gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const measurements: number[] = [];
  for (let i = 0; i < 250; i++) {
    const started = performance.now();
    await monitor.sample();
    measurements.push(performance.now() - started);
  }
  const cpu = process.cpuUsage(cpuBefore);
  (globalThis as { gc?: () => void }).gc?.();
  const snapshot = monitor.snapshot();
  const serializedBytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (snapshot.history.length !== 180 || serializedBytes > 256 * 1024) throw new Error('Resource retention bounds failed.');
  const sampling = {
    ...summary(measurements),
    cpuMsPerCall: (cpu.user + cpu.system) / 1000 / measurements.length,
    heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
    retainedSamples: snapshot.history.length,
    serializedSnapshotBytes: serializedBytes,
  };

  const sparseDirectory = join(directory, 'metadata-only');
  await mkdir(join(sparseDirectory, 'backups'), { recursive: true });
  const sparse = await open(join(sparseDirectory, 'agent-ops.sqlite'), 'w');
  try { await sparse.truncate(3 * 1024 ** 3); } finally { await sparse.close(); }
  await writeFile(join(sparseDirectory, 'backups', 'example.sqlite.gz'), Buffer.alloc(64 * 1024));
  const sparseDisk = await scanDisk(sparseDirectory);
  if (!sparseDisk.complete || sparseDisk.logicalBytes !== 3 * 1024 ** 3 + 64 * 1024) {
    throw new Error('Metadata-only disk measurement failed.');
  }

  const appDirectory = join(directory, 'api');
  const context = await createApp({ dataDir: appDirectory, autoSync: false, connectorProbe: async () => [] });
  const apiTimes: number[] = [];
  try {
    await context.resources.sample();
    await context.resources.sampleDisk();
    for (let i = 0; i < 100; i++) {
      const started = performance.now();
      const response = await context.app.inject('/api/resources');
      if (response.statusCode !== 200) throw new Error('Resource API failed.');
      apiTimes.push(performance.now() - started);
    }
  } finally { await context.app.close(); }

  let ownedProcess: Record<string, unknown> = { status: 'unsupported platform' };
  if (['linux', 'darwin'].includes(process.platform)) {
    const child = spawn(process.execPath, ['--input-type=module', '--eval',
      'const end=Date.now()+5000; let n=1; while(Date.now()<end){n=Math.sqrt(n+Math.random());}'], {
      stdio: 'ignore', shell: false,
    });
    const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); });
    try {
      if (!child.pid) throw new Error('Synthetic CPU worker did not start.');
      const sampler = new OwnedProcessSampler();
      const roots = [{ pid: child.pid, ownerId: 'synthetic-cpu-worker', kind: 'sync' as const, processGroup: false }];
      await delay(150);
      await sampler.sample(roots);
      await delay(1400);
      const started = performance.now();
      const result = await sampler.sample(roots);
      if (result.scopes.sync.rssBytes === null || result.scopes.sync.cpuPercent === null || result.scopes.sync.cpuPercent <= 0) {
        throw new Error('Actual owned CPU/RSS sampling did not produce measured counters.');
      }
      ownedProcess = { status: 'measured', sampleDurationMs: performance.now() - started, ...result.scopes.sync, warnings: result.warnings };
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
    }
  }
  const liveMetadata = values['data-dir'] ? await scanDisk(resolve(values['data-dir'])) : null;
  console.log(JSON.stringify({
    measuredAt: new Date().toISOString(), node: process.version, platform: process.platform,
    sampling, apiInjection: summary(apiTimes), sparseDisk, ownedProcess, liveMetadata,
    notes: [
      'All writes and the CPU worker use temporary synthetic fixtures.',
      'Sampling timings are a burst microbenchmark, not normal 5-second scheduling.',
      'API timings use Fastify injection and exclude network/proxy latency.',
      'Heap deltas include runtime noise; the exact retained count and serialized size are bounded checks.',
      'Optional --data-dir reads existing file metadata only; it does not open SQLite or change files.',
    ],
  }, null, 2));
} finally {
  for (const monitor of monitors) monitor.stop();
  await rm(directory, { recursive: true, force: true });
}
