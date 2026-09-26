import { CONTEXT_PACK_LIMITS, type ContextPackCompilation } from '../../../shared/context-packs';
import { contextPacksApi } from '../context-packs/api';

export interface RunContextInput {
  prompt: string;
  selectedIds: readonly string[];
  appliedIds: readonly string[];
}
export interface RunContextApplication {
  prompt: string;
  selectedIds: string[];
  appliedIds: string[];
}

export function assertRunContextIds(ids: readonly string[]): void {
  if (!Array.isArray(ids) || ids.length > 5 || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))) {
    throw new Error('컨텍스트 연결은 중복 없이 최대 5개까지 선택하세요.');
  }
}

export function runContextInputSignature(input: RunContextInput): string {
  return JSON.stringify([input.prompt, input.selectedIds, input.appliedIds]);
}

function cancelled(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}

function checkCompilation(id: string, result: ContextPackCompilation) {
  if (!result || result.packId !== id || !Number.isSafeInteger(result.version) || result.version < 1
    || typeof result.prompt !== 'string' || result.prompt.length > CONTEXT_PACK_LIMITS.promptChars
    || result.characters !== result.prompt.length || !Number.isInteger(result.itemCount)
    || result.itemCount < 0 || result.itemCount > CONTEXT_PACK_LIMITS.items || typeof result.redacted !== 'boolean') {
    throw new Error('조합한 컨텍스트 응답을 확인할 수 없습니다. 다시 시도하세요.');
  }
}

/** No draft is mutated until all new packs have compiled and fit the final prompt. */
export async function compileRunContext(input: RunContextInput, signal: AbortSignal): Promise<RunContextApplication> {
  cancelled(signal);
  assertRunContextIds(input.selectedIds);
  if (typeof input.prompt !== 'string' || input.prompt.length > CONTEXT_PACK_LIMITS.promptChars) {
    throw new Error('컨텍스트를 포함한 프롬프트는 64,000자 이하여야 합니다.');
  }
  const selectedIds = [...input.selectedIds];
  const applied = new Set(input.appliedIds);
  let prompt = input.prompt;
  for (const id of selectedIds) {
    if (applied.has(id)) continue;
    cancelled(signal);
    const result = await contextPacksApi.compile(id, signal);
    cancelled(signal);
    checkCompilation(id, result);
    const separator = prompt ? '\n\n' : '';
    if (prompt.length + separator.length + result.prompt.length > CONTEXT_PACK_LIMITS.promptChars) {
      throw new Error('컨텍스트를 포함한 프롬프트는 64,000자 이하여야 합니다.');
    }
    prompt += separator + result.prompt;
    applied.add(id);
  }
  cancelled(signal);
  return { prompt, selectedIds, appliedIds: [...applied] };
}
