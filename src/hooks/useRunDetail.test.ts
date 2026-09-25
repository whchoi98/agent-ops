import { test, expect } from 'vitest';
import type { RunEvent } from '../../shared/types';
import { mergeEvents } from './useRunDetail';

test('overlapping polling and SSE events appear once in chronological event order', () => {
  const event = (id: number, text: string): RunEvent => ({
    id, runId: 'owned-run', stream: 'stdout', text, timestamp: '2026-09-24T01:00:00Z',
  });
  const result = mergeEvents(
    [event(2, '테스트 시작'), event(4, '테스트 통과')],
    [event(1, '실행 시작'), event(2, '테스트 시작'), event(3, '빌드 완료')],
  );
  expect(result.map(item => item.id)).toEqual([1, 2, 3, 4]);
  expect(result.map(item => item.text)).toEqual(['실행 시작', '테스트 시작', '빌드 완료', '테스트 통과']);
});
