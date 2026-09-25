import type { McpCheck, McpCheckSummary } from '../../../shared/mcp';
import { errorMessage } from '../../lib/format';

interface PollOptions {
  read: (checkId: string, signal: AbortSignal) => Promise<McpCheck>;
  onResult: (result: McpCheck) => void;
  onError: (message: string, cause?: unknown) => void;
}

/** One outstanding read; callers dispose this observer on hide/unmount. It never starts or cancels a probe. */
export function pollMcpCheck(check: McpCheckSummary, { read, onResult, onError }: PollOptions): () => void {
  if (check.status !== 'running') return () => {};
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => {
    stop();
    onError('점검 상태 조회 한도에 도달했습니다. 점검 종료 여부는 알 수 없습니다. 다시 조회해 주세요.');
  }, 60000);
  function stop() {
    stopped = true;
    controller.abort();
    clearTimeout(timer);
    clearTimeout(deadline);
  }
  async function load() {
    try {
      const result = await read(check.id, controller.signal);
      if (stopped) return;
      if (result.id !== check.id) throw new Error('점검 결과의 식별자가 요청과 일치하지 않습니다.');
      if (result.status !== 'running') stop();
      onResult(result);
      if (!stopped) timer = setTimeout(() => void load(), 1000);
    } catch (cause) {
      if (stopped) return;
      stop();
      onError(errorMessage(cause), cause);
    }
  }
  void load();
  return stop;
}

export interface McpCheckState { active: McpCheckSummary | null; result: McpCheck | null; forgottenId?: string }
export type McpCheckEvent = { type: 'catalog'; active: McpCheckSummary | null }
  | { type: 'result'; result: McpCheck } | { type: 'forget'; id: string };

/** A catalog started before a POST may finish after it; terminal probe results take precedence. */
export function updateCheckState(state: McpCheckState, event: McpCheckEvent): McpCheckState {
  if (event.type === 'forget') return {
    ...state, forgottenId: event.id,
    active: state.active?.id === event.id ? null : state.active,
    result: state.result?.id === event.id ? null : state.result,
  };
  const incoming = event.type === 'catalog' ? event.active : event.result;
  if (!incoming || event.type === 'catalog' && incoming.status !== 'running') return state;
  if (state.forgottenId === incoming.id) return state;
  if (state.result?.id === incoming.id && state.result.status !== 'running' && incoming.status === 'running') return state;
  const latest = state.active ?? state.result;
  if (latest && latest.id !== incoming.id && Date.parse(latest.startedAt) > Date.parse(incoming.startedAt)) return state;
  if (event.type === 'catalog') return state.active?.id === incoming.id ? state : { ...state, active: incoming };
  return {
    ...state,
    active: incoming.status === 'running' ? incoming : state.active?.id === incoming.id ? null : state.active,
    result: event.result,
  };
}
