import type { Agent, Message } from './types.js';

/** Text limits and ranges use UTF-16 code units, as browser selections do. */
export const CONTEXT_PACK_LIMITS = {
  packs: 200,
  items: 20,
  itemChars: 8_000,
  totalChars: 48_000,
  sourceBytes: 8 * 1024 * 1024,
  nameChars: 200,
  descriptionChars: 500,
  instructionsChars: 8_000,
  promptChars: 64_000,
  defaultPageSize: 25,
  maxPageSize: 100,
} as const;

export interface ContextPackSource {
  readonly sessionId: string;
  readonly messageId: string;
  readonly agent: Agent;
  readonly sessionTitle: string;
  readonly role: Message['role'];
  readonly messageTimestamp: string;
  readonly capturedAt: string;
  /** Zero-based UTF-16 offset. Neither end may bisect a surrogate pair. */
  readonly offset: number;
  readonly length: number;
}

interface ContextPackItemBase {
  id: string;
  title: string;
  createdAt: string;
}
export interface ContextPackMessageItem extends ContextPackItemBase {
  kind: 'message';
  readonly text: string;
  readonly source: ContextPackSource;
  /** Current ID availability only; the source may have changed since capture. */
  sourceAvailable: boolean;
}
export interface ContextPackNoteItem extends ContextPackItemBase {
  kind: 'note';
  text: string;
  source: null;
  sourceAvailable: null;
}
export type ContextPackItem = ContextPackMessageItem | ContextPackNoteItem;

/** List responses intentionally exclude instructions and item bodies. */
export interface ContextPackSummary {
  id: string;
  name: string;
  description: string;
  projectId: string | null;
  itemCount: number;
  totalChars: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface ContextPack extends ContextPackSummary {
  instructions: string;
  items: ContextPackItem[];
}
export interface ContextPackQuery {
  q?: string;
  projectId?: string;
  offset?: number;
  limit?: number;
}
export interface ContextPackPage {
  items: ContextPackSummary[];
  total: number;
  offset: number;
  limit: number;
}
export interface CreateContextPackInput {
  name: string;
  description?: string;
  projectId?: string | null;
  instructions?: string;
}
export interface ContextPackVersion { version: number }
export type UpdateContextPackInput = ContextPackVersion & Partial<CreateContextPackInput>;
export interface CaptureContextMessageInput {
  kind: 'message';
  sessionId: string;
  messageId: string;
  offset: number;
  length: number;
}
export interface ContextNoteInput {
  kind: 'note';
  title: string;
  text: string;
}
export type ContextPackItemInput = ContextPackVersion & (CaptureContextMessageInput | ContextNoteInput);
export interface UpdateContextPackItemInput extends ContextPackVersion {
  title?: string;
  /** Accepted only for an operator note. Captured message text is immutable. */
  text?: string;
}
export interface ReorderContextPackInput extends ContextPackVersion { itemIds: string[] }
export interface ContextPackCompilation {
  packId: string;
  version: number;
  prompt: string;
  characters: number;
  itemCount: number;
  redacted: boolean;
}
export type ContextPackExportFormat = 'md' | 'json';
export interface ContextPackExport {
  type: 'text/markdown; charset=utf-8' | 'application/json; charset=utf-8';
  extension: ContextPackExportFormat;
  filename: string;
  body: string;
}
export interface ContextPackExportDocument {
  formatVersion: 1;
  pack: ContextPack;
}
