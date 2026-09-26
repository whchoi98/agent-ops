import type { Store } from '../../store.js';
import { AGENTS, type Message } from '../../../shared/types.js';
import {
  CONTEXT_PACK_LIMITS as limits, type CaptureContextMessageInput, type ContextPackMessageItem,
} from '../../../shared/context-packs.js';
import { problem } from '../common.js';

function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export function captureMessage(
  store: Store, input: CaptureContextMessageInput, id: string, capturedAt: string,
): ContextPackMessageItem {
  // The identity expression matches messages_identity. The CASE stays in SQLite:
  // an oversized serialized message never crosses the SQLite/Node boundary.
  const row = store.db.prepare(`
    SELECT length(CAST(data AS BLOB)) AS bytes,
      CASE WHEN length(CAST(data AS BLOB)) <= ? THEN data ELSE NULL END AS data
    FROM messages WHERE session_id=? AND json_extract(data,'$.id')=?
    ORDER BY ordinal LIMIT 1
  `).get(limits.sourceBytes, input.sessionId, input.messageId) as { bytes: number; data: string | null } | undefined;
  if (!row) throw problem(404, 'The source message is unavailable. No excerpt was captured.');
  if (row.bytes > limits.sourceBytes || row.data === null) {
    throw problem(413, 'The serialized source message exceeds the 8 MiB capture limit.');
  }
  const message = JSON.parse(row.data) as Message;
  if (typeof message.content !== 'string' || !['user', 'assistant', 'tool', 'system'].includes(message.role)
    || typeof message.timestamp !== 'string' || message.timestamp.length > 100) {
    throw problem(400, 'The source message cannot be captured as a text excerpt.');
  }
  const end = input.offset + input.length;
  if (!Number.isSafeInteger(end) || end > message.content.length
    || splitsSurrogate(message.content, input.offset) || splitsSurrogate(message.content, end)) {
    throw problem(400, 'Select an existing character range without splitting a Unicode character.');
  }
  // Read only provenance, never the full session JSON. A title that alone could
  // exceed the compiled prompt bound is rejected rather than silently shortened.
  const session = store.db.prepare(`
    SELECT agent, CASE WHEN length(CAST(COALESCE(title_override,json_extract(data,'$.title')) AS BLOB)) <= ?
      THEN COALESCE(title_override,json_extract(data,'$.title')) ELSE NULL END AS title
    FROM sessions WHERE id=?
  `).get(limits.promptChars * 4, input.sessionId) as { agent: typeof AGENTS[number]; title: string | null } | undefined;
  if (!session) throw problem(404, 'The source message is unavailable. No excerpt was captured.');
  if (typeof session.title !== 'string' || session.title.length > limits.promptChars) {
    throw problem(413, 'The source title is too large to include its provenance.');
  }
  if (!AGENTS.includes(session.agent)) throw problem(400, 'The source message cannot be captured as a text excerpt.');
  return {
    id, kind: 'message', title: session.title.length <= limits.nameChars && session.title.trim() ? session.title : 'Captured message',
    text: message.content.slice(input.offset, end), createdAt: capturedAt, sourceAvailable: true,
    source: {
      sessionId: input.sessionId, messageId: input.messageId, agent: session.agent,
      sessionTitle: session.title, role: message.role, messageTimestamp: message.timestamp,
      capturedAt, offset: input.offset, length: input.length,
    },
  };
}
