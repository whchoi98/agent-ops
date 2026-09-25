import { expect, test } from 'vitest';
import { createRefreshQueue } from './refreshQueue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('a completion event during bootstrap schedules one trailing read that clears stale syncing', async () => {
  const first = deferred<{ syncing: boolean }>();
  const last = deferred<{ syncing: boolean }>();
  let reads = 0;
  let syncing = false;
  const queue = createRefreshQueue(async () => {
    const data = await (++reads === 1 ? first.promise : last.promise);
    syncing = data.syncing;
  });
  const started = queue.refresh();
  const completed = queue.refresh();
  expect(queue.refresh()).toBe(completed);
  expect(queue.refresh()).toBe(completed);
  first.resolve({ syncing: true });
  await Promise.resolve();
  await Promise.resolve();
  expect(reads).toBe(2);
  expect(syncing).toBe(true);
  last.resolve({ syncing: false });
  await Promise.all([started, completed]);
  expect(syncing).toBe(false);
  expect(reads).toBe(2);
  expect(queue.isPending()).toBe(false);
});

test('coalesced requests retain a forced refresh without producing one request per event', async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const flags: boolean[] = [];
  const queue = createRefreshQueue(async force => {
    flags.push(force);
    await (flags.length === 1 ? first.promise : second.promise);
  });
  const work = queue.refresh();
  queue.refresh(true);
  queue.refresh(false);
  queue.refresh(true);
  first.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(flags).toEqual([false, true]);
  second.resolve();
  await work;
  expect(flags).toHaveLength(2);
});

test('a failed first read does not discard a queued completion refresh', async () => {
  const first = deferred<void>();
  let reads = 0;
  const queue = createRefreshQueue(async () => {
    if (++reads === 1) await first.promise;
  });
  const work = queue.refresh();
  queue.refresh();
  first.reject(new Error('transient failure'));
  await expect(work).resolves.toBeUndefined();
  expect(reads).toBe(2);
  expect(queue.isPending()).toBe(false);
});

test('a failed idle read releases the queue so a later request can recover', async () => {
  let reads = 0;
  const queue = createRefreshQueue(async () => {
    if (++reads === 1) throw new Error('offline');
  });
  await expect(queue.refresh()).rejects.toThrow('offline');
  await expect(queue.refresh()).resolves.toBeUndefined();
  expect(reads).toBe(2);
});
