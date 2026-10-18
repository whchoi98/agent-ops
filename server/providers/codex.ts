import {
  SessionBuilder, codexTitleCandidate, firstString, hash, json, object, readUsage, string, text, timestamp,
  type ParseContext, type ParseResult, type SessionParser,
} from './common.js';
import type { Message } from '../../shared/types.js';

interface Mirror {
  source: 'event' | 'response';
  key: string;
  time: string | null;
  ordinal: number;
}

export function createCodexParser(context: ParseContext): SessionParser {
  const builder = new SessionBuilder('codex', context);
  const mirrors = new Map<string, Mirror>();
  const aliases = new Map<string, string>();
  const eventIds = new Set<string>();
  const failedCalls = new Set<string>();
  let inheritedUntil = 0;
  let ordinal = 0;
  let turn = '';

  function message(source: Mirror['source'], key: string, role: Message['role'], content: string, time: unknown) {
    if (!content) return;
    const alias = aliases.get(key);
    if (alias) {
      builder.message(alias, role, content, time, builder.model ? { model: builder.model } : {});
      return;
    }
    const signature = hash(`${role}\0${content}`);
    const previous = mirrors.get(signature);
    const at = timestamp(time);
    const near = previous && ordinal - previous.ordinal <= 50
      && (!at || !previous.time || Math.abs(Date.parse(at) - Date.parse(previous.time)) <= 10_000);
    if (previous && previous.source !== source && near) {
      // Native logs often include both a UI event and its response_item. Match
      // these one-for-one, without collapsing repeated utterances of either kind.
      builder.message(previous.key, role, content, time, builder.model ? { model: builder.model } : {});
      if (aliases.size < 40_000) aliases.set(key, previous.key);
      mirrors.delete(signature);
      return;
    }
    builder.message(key, role, content, time, builder.model ? { model: builder.model } : {});
    if (builder.get(key)) {
      if (aliases.size < 40_000) aliases.set(key, key);
      if (mirrors.size >= 20_000) mirrors.delete(mirrors.keys().next().value!);
      mirrors.set(signature, { source, key, time: at, ordinal });
    }
  }

  function response(value: unknown, time: unknown) {
    const item = object(value);
    const type = string(item.type);
    const key = firstString(item.id, item.message_id) || `record:${ordinal}`;
    if (type === 'message') {
      const role = string(item.role);
      if (role === 'user' || role === 'assistant' || role === 'system' || role === 'developer') {
        message('response', `message:${key}`, role === 'developer' ? 'system' : role, text(item.content), time);
      } else builder.warn('An unsupported Codex message role was ignored.');
    } else if (type === 'agent_message') {
      // Inter-agent traffic is neither the user's prompt nor this thread's answer.
      message('response', `agent-message:${key}`, 'system', text(item.content), time);
    } else if (['function_call', 'custom_tool_call', 'tool_call'].includes(type)) {
      builder.toolCall(firstString(item.call_id, item.id) || key, firstString(item.name, item.tool_name),
        item.arguments ?? item.input ?? item.args, time, builder.model);
    } else if (['function_call_output', 'custom_tool_call_output', 'tool_result', 'tool_search_output'].includes(type)) {
      const callId = firstString(item.call_id, item.tool_call_id, item.id) || key;
      builder.toolResult(callId, item.output ?? item.content ?? item.tools, time,
        item.is_error === true || item.status === 'failed' || failedCalls.has(callId));
    } else if (['local_shell_call', 'web_search_call', 'computer_call', 'tool_search_call'].includes(type)) {
      builder.toolCall(firstString(item.call_id, item.id) || key,
        type === 'local_shell_call' ? 'local_shell' : type.replace(/_call$/, ''), item.action ?? item.input ?? item.arguments, time, builder.model);
    }
  }

  return {
    consume(value) {
      ordinal++;
      // A child rollout starts with a copy of its parent's history, which the parent
      // session already holds. subagent_history_start_ordinal is the 0-based line of
      // the first record this thread owns; ordinal is 1-based, so lines 1..start-1 skip.
      if (ordinal > 1 && ordinal <= inheritedUntil) return;
      const record = object(value);
      const payload = object(record.payload);
      const type = string(record.type);
      const time = record.timestamp ?? payload.timestamp;
      builder.observe(time);
      if (type === 'session_meta' || (!type && record.id && record.timestamp)) {
        const metadata = type ? payload : record;
        // Without this boundary, copied parent records cannot be told apart and
        // the copied parent session_meta keeps the rollout withheld.
        const start = metadata.subagent_history_start_ordinal;
        if (ordinal === 1 && typeof start === 'number' && Number.isSafeInteger(start) && start > 1) inheritedUntil = start;
        builder.identify(metadata.id ?? metadata.session_id);
        builder.observe(metadata.timestamp);
        builder.projectPath = firstString(metadata.cwd, metadata.project_path, builder.projectPath);
        builder.model = firstString(metadata.model, builder.model);
        builder.title = firstString(metadata.title, builder.title);
        builder.parentId = firstString(metadata.parent_thread_id, metadata.forked_from_id, metadata.parent_session_id, builder.parentId);
        // Spawned workers and automatic reviews belong to another thread; a user fork is its own root.
        if (['subagent', 'guardian_review'].includes(string(metadata.thread_source))) builder.resumable = false;
      } else if (type === 'turn_context') {
        builder.projectPath = firstString(payload.cwd, builder.projectPath);
        builder.model = firstString(payload.model, builder.model);
        turn = firstString(payload.turn_id, turn);
      } else if (type === 'response_item') {
        response(payload, time);
      } else if (type === 'event_msg') {
        const eventType = string(payload.type);
        if (eventType === 'task_started') turn = firstString(payload.turn_id, payload.task_id, `turn:${ordinal}`);
        if (eventType === 'token_count') {
          const info = object(payload.info);
          builder.usage.total(readUsage(info.total_token_usage));
          const usage = readUsage(info.last_token_usage ?? payload.usage);
          const request = firstString(payload.request_id, info.request_id, payload.response_id, info.response_id);
          builder.usage.add(request || `${turn}:${hash(json(info.last_token_usage ?? payload.usage))}`, usage);
        } else if (['user_message', 'agent_message', 'assistant_message'].includes(eventType)) {
          const eventId = firstString(record.id, payload.event_id) || hash(json({ type: eventType, time, message: payload.message ?? payload.content }));
          if (eventIds.has(eventId)) return;
          if (eventIds.size < 40_000) eventIds.add(eventId);
          // Both UI events and role=user response items can contain injected
          // setup; only a genuine prompt is an automatic title candidate.
          if (eventType === 'user_message' && !builder.title) builder.title = codexTitleCandidate(text(payload.message ?? payload.content));
          message('event', `event:${eventId}`, eventType === 'user_message' ? 'user' : 'assistant',
            text(payload.message ?? payload.content), time);
        } else if (eventType === 'item_completed') {
          // Paginated history mirrors response items here; only the outcome is new,
          // so it annotates the matching tool result instead of adding a call.
          const item = object(payload.item);
          const itemId = string(item.id);
          if (itemId && (item.status === 'failed' || item.status === 'declined')) {
            const result = builder.get(`result:${itemId}`);
            if (result) result.isError = true;
            else if (failedCalls.size < 40_000) failedCalls.add(itemId);
          }
        } else if (eventType === 'session_title' || eventType === 'thread_name_updated') {
          builder.title = firstString(payload.title, payload.name, builder.title);
        }
      } else if (['message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(type)) {
        response(record, time);
      }
    },
    finish() {
      if (inheritedUntil && ordinal <= inheritedUntil) {
        builder.warn('The inherited-history boundary is beyond the recorded lines; no records of this thread were read.');
      }
      return builder.finish();
    },
  };
}

/** Pure, synchronous parser; discovery feeds the same accumulator one JSONL record at a time. */
export function parseCodexSession(records: Iterable<unknown>, context: ParseContext): ParseResult {
  const parser = createCodexParser(context);
  for (const record of records) parser.consume(record);
  return parser.finish();
}
