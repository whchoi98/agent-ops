import { afterEach, expect, test, vi } from 'vitest';
import type { McpCheck } from '../../../shared/mcp';
import { ApiError } from '../../lib/api';
import { pollMcpCheck, updateCheckState } from './polling';
import { mcpCheck } from './testFixtures';

afterEach(() => vi.useRealTimers());

test('only running checks are polled and a final response stops all timers', async () => {
  vi.useFakeTimers();
  const updates: McpCheck[] = [];
  let calls = 0;
  const read = async () => { calls++; return mcpCheck({ status: 'reachable' }); };
  const stop = pollMcpCheck(mcpCheck({ status: 'reachable' }), { read, onResult: result => updates.push(result), onError: () => {} });
  expect(calls).toBe(0);
  stop();
  pollMcpCheck(mcpCheck(), { read, onResult: result => updates.push(result), onError: () => {} });
  await vi.advanceTimersByTimeAsync(10000);
  expect(updates.map(result => result.status)).toEqual(['reachable']);
  expect(calls).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('slow status requests never overlap and disposal aborts the outstanding read', async () => {
  vi.useFakeTimers();
  let calls = 0;
  let signal: AbortSignal | undefined;
  let complete: ((result: McpCheck) => void) | undefined;
  const updates: McpCheck[] = [];
  const stop = pollMcpCheck(mcpCheck(), {
    read: async (_id, ownSignal) => {
      calls++; signal = ownSignal;
      return new Promise<McpCheck>(resolve => { complete = resolve; });
    },
    onResult: result => updates.push(result), onError: () => {},
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(calls).toBe(1);
  stop();
  expect(signal?.aborted).toBe(true);
  complete?.(mcpCheck({ status: 'reachable' }));
  await vi.advanceTimersByTimeAsync(10000);
  expect(updates).toEqual([]);
  expect(calls).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('a stalled running check reaches a bounded observation limit without inventing a timeout result', async () => {
  vi.useFakeTimers();
  const updates: McpCheck[] = [];
  const errors: string[] = [];
  let reads = 0;
  pollMcpCheck(mcpCheck(), {
    read: async () => { reads++; return mcpCheck(); },
    onResult: result => updates.push(result), onError: error => errors.push(error),
  });
  await vi.advanceTimersByTimeAsync(61000);
  expect(reads).toBeLessThanOrEqual(60);
  expect(errors).toHaveLength(1);
  expect(updates.every(result => result.status === 'running')).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('a failed status fetch stops polling and does not create an automatic retry storm', async () => {
  vi.useFakeTimers();
  const errors: string[] = [];
  let reads = 0;
  pollMcpCheck(mcpCheck(), {
    read: async () => { reads++; throw new Error('fixture unavailable'); },
    onResult: () => { throw new Error('No result should be inferred.'); }, onError: error => errors.push(error),
  });
  await vi.advanceTimersByTimeAsync(30000);
  expect(errors).toEqual(['fixture unavailable']);
  expect(reads).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('stale catalog summaries cannot resurrect a completed check or clear a newly accepted check', () => {
  const running = mcpCheck();
  const completed = mcpCheck({ status: 'reachable' });
  let state = updateCheckState({ active: null, result: null }, { type: 'result', result: running });
  state = updateCheckState(state, { type: 'catalog', active: null });
  expect(state.active?.id).toBe(running.id);
  state = updateCheckState(state, { type: 'result', result: completed });
  state = updateCheckState(state, { type: 'catalog', active: running });
  expect(state.active).toBeNull();
  expect(state.result?.status).toBe('reachable');
});

test('a late detail result from another server cannot displace the current global check', () => {
  const current = mcpCheck({ id: 'mcp-check-11111111-1111-4111-8111-111111111111', startedAt: '2026-09-25T10:01:00Z' });
  const state = updateCheckState({ active: current, result: current }, {
    type: 'result', result: mcpCheck({ status: 'reachable' }),
  });
  expect(state.active?.id).toBe(current.id);
  expect(state.result?.id).toBe(current.id);
});

test('a missing result retains its 404 cause so the page can release an obsolete check slot', async () => {
  const missing = new ApiError('MCP check result not found or evicted from bounded memory.', 404);
  const errors: unknown[] = [];
  pollMcpCheck(mcpCheck(), {
    read: async () => { throw missing; }, onResult: () => {},
    onError: (_message, cause) => errors.push(cause),
  });
  await Promise.resolve();
  expect(errors).toEqual([missing]);
});

test('forgetting an evicted result releases only that slot and ignores its late catalog summary', () => {
  const running = mcpCheck();
  let state = updateCheckState({ active: running, result: running }, { type: 'forget', id: running.id });
  expect(state.active).toBeNull();
  expect(state.result).toBeNull();
  state = updateCheckState(state, { type: 'catalog', active: running });
  expect(state.active).toBeNull();
  const current = mcpCheck({ id: 'mcp-check-22222222-2222-4222-8222-222222222222' });
  state = updateCheckState(state, { type: 'catalog', active: current });
  state = updateCheckState(state, { type: 'forget', id: running.id });
  expect(state.active?.id).toBe(current.id);
});
