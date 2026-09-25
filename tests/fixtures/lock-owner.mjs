import { acquireLock } from '../../server/lock.ts';

const directory = process.argv[2];
if (!directory || !process.send) throw new Error('A data directory and an IPC parent are required.');

let release;
let attempted = false;
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  try {
    release?.();
    release = undefined;
    process.exitCode = code;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  if (process.connected) process.disconnect();
}

function report(message, exitCode) {
  if (!process.connected) return stop(1);
  process.send({ ...message, pid: process.pid }, (error) => {
    if (error) stop(1);
    else if (exitCode !== undefined) stop(exitCode);
  });
}

process.once('disconnect', () => stop());
process.once('SIGTERM', () => stop());
process.once('SIGINT', () => stop());
process.on('message', (message) => {
  if (stopping) return;
  if (message?.type === 'acquire' && !attempted) {
    attempted = true;
    const started = performance.now();
    report({ type: 'attempting' });
    try {
      release = acquireLock(directory);
      report({ type: 'acquired', elapsedMs: performance.now() - started });
    } catch (error) {
      report({ type: 'rejected', elapsedMs: performance.now() - started, error: error instanceof Error ? error.message : String(error) }, 2);
    }
  } else if (message?.type === 'release' && release) {
    try {
      release();
      release = undefined;
      report({ type: 'released' }, 0);
    } catch (error) {
      console.error(error);
      stop(1);
    }
  } else {
    console.error('Unexpected lock-owner command.');
    stop(1);
  }
});

report({ type: 'ready' });
