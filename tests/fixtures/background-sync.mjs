import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const report = {
  startedAt: '2026-09-25T00:00:00.000Z',
  finishedAt: '2026-09-25T00:00:01.000Z',
  imported: 3, filesScanned: 4, skipped: 1, warnings: ['Synthetic import warning.'],
};

async function main() {
  const [command, flag, dataDir, ...extra] = process.argv.slice(2);
  if (command !== 'sync' || flag !== '--data-dir' || !dataDir || extra.length) process.exit(97);
  const config = JSON.parse(readFileSync(join(dataDir, 'fixture.json'), 'utf8'));
  const mode = config.mode ?? 'report';
  // A broken test implementation must not leave fixture processes running indefinitely.
  setTimeout(() => process.exit(98), 15_000).unref();
  if (mode === 'hold' || mode === 'ignore-term') {
    process.on('SIGTERM', () => {
      writeFileSync(join(dataDir, 'terminated'), 'SIGTERM');
      if (mode === 'hold') process.exit(0);
    });
  }
  const ready = {
    pid: process.pid, executable: process.execPath, args: process.argv.slice(2),
    execArgv: process.execArgv, stdin: readFileSync(0, 'utf8'),
  };
  appendFileSync(join(dataDir, 'starts.jsonl'), JSON.stringify(ready) + '\n');
  writeFileSync(join(dataDir, 'ready.json'), JSON.stringify(ready));
  if (mode === 'hold' || mode === 'ignore-term') {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'cpu') {
    while (!existsSync(join(dataDir, 'go'))) await delay(5);
    const until = Date.now() + 350;
    while (Date.now() < until) { /* Deliberately occupy only this child event loop. */ }
  } else await delay(config.delayMs ?? 20);
  if (mode === 'failure') {
    process.stdout.write('fixture-private-stdout');
    process.stderr.write('fixture-private-stderr');
    process.exitCode = 7;
    return;
  }
  if (mode === 'stdout-limit' || mode === 'stderr-limit') {
    const stream = mode === 'stdout-limit' ? process.stdout : process.stderr;
    stream.on('error', () => {});
    stream.write(Buffer.alloc(2 * 1024 * 1024, 'x'));
    return;
  }
  if (mode === 'held-pipes') {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      stdio: ['ignore', process.stdout, process.stderr], shell: false,
    });
    writeFileSync(join(dataDir, 'pipe-owner'), String(child.pid));
    child.unref();
    process.stdout.write(JSON.stringify(report) + '\n', () => process.exit(0));
    return;
  }
  if (config.stderr) process.stderr.write(config.stderr);
  if (Object.hasOwn(config, 'raw')) process.stdout.write(config.raw);
  else process.stdout.write(JSON.stringify(Object.hasOwn(config, 'report') ? config.report : report, null, 2) + '\n');
}

void main().catch(() => { process.stderr.write('Synthetic fixture failure.\n'); process.exitCode = 99; });
