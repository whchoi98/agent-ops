import {
  CONTEXT_PACK_LIMITS as limits, type ContextPack, type ContextPackCompilation, type ContextPackItem,
  type ContextPackItemInput, type UpdateContextPackItemInput, type ReorderContextPackInput,
} from '../../../shared/context-packs';
import type { NewRunDraft } from '../../state/AppProvider';
import { ApiError } from '../../lib/api';
import type { ContextPackItemDraft } from './ContextPackItemEditor';

export function captureInput(
  version: number, source: { sessionId: string; messageId: string }, offset: number, length: number,
): ContextPackItemInput {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length)
    || length < 1 || length > limits.itemChars || !Number.isSafeInteger(offset + length)) {
    throw new ApiError('Select an existing character range without splitting a Unicode character.', 400);
  }
  return { version, kind: 'message', sessionId: source.sessionId, messageId: source.messageId, offset, length };
}

export function selectionLimit(maxSelected = 5): number {
  return Math.max(1, Math.min(5, Number.isFinite(maxSelected) ? Math.floor(maxSelected) : 5));
}
export function toggleContextPack(selectedIds: string[], id: string, maxSelected = 5): string[] {
  if (selectedIds.includes(id)) return selectedIds.filter(selected => selected !== id);
  return selectedIds.length < selectionLimit(maxSelected) ? [...selectedIds, id] : selectedIds;
}

export function contextPackRunDraft(
  pack: ContextPack, compilation: ContextPackCompilation,
): NewRunDraft & { contextPackIds: string[] } {
  if (compilation.packId !== pack.id || compilation.version !== pack.version || compilation.itemCount !== pack.itemCount
    || compilation.characters !== compilation.prompt.length || compilation.prompt.length > limits.promptChars) {
    throw new ApiError('Compiled context does not match the current pack. Reload and compile again.', 409);
  }
  return {
    title: pack.name, prompt: compilation.prompt, projectId: pack.projectId ?? undefined,
    policy: 'read-only', contextPackIds: [pack.id],
  };
}

export function contextPackItemPatch(
  version: number, item: ContextPackItem, draft: ContextPackItemDraft,
): UpdateContextPackItemInput {
  return { version, title: draft.title, ...(item.kind === 'note' ? { text: draft.text } : {}) };
}

export function reconcileItemDrafts(
  pack: ContextPack, current: Record<string, ContextPackItemDraft>, savedItemId?: string,
): Record<string, ContextPackItemDraft> {
  return Object.fromEntries(pack.items.map(item => [item.id,
    item.id !== savedItemId && current[item.id] ? current[item.id] : { title: item.title, text: item.text },
  ]));
}

export function moveContextPackItem(order: string[], itemId: string, direction: -1 | 1): string[] {
  const from = order.indexOf(itemId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= order.length) return order;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
export function reconcileItemOrder(pack: ContextPack, current: string[]): string[] {
  const ids = pack.items.map(item => item.id);
  return [...current.filter(id => ids.includes(id)), ...ids.filter(id => !current.includes(id))];
}
export function contextPackReorderInput(pack: ContextPack, order: string[]): ReorderContextPackInput {
  return { version: pack.version, itemIds: [...order] };
}
