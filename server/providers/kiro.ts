import {
  SessionBuilder, array, firstString, hash, json, object, readUsage, string, text,
  type JsonObject, type ParseContext, type ParseResult, type SessionParser,
} from './common.js';
import type { Message } from '../../shared/types.js';

export function createKiroParser(context: ParseContext): SessionParser {
  const builder = new SessionBuilder('kiro', context);
  const messageTimes = new Map<string, unknown>();
  const metadataResponses = new Map<string, { message: JsonObject; time: unknown }>();
  const eventMessages = new Set<string>();
  let ordinal = 0;
  let transcriptEvents = 0;
  let requiresTranscript = false;

  function toolResult(value: unknown, time: unknown, fallbackId: string) {
    const result = object(value);
    const status = string(result.status).toLowerCase();
    builder.toolResult(firstString(result.tool_use_id, result.toolUseId, result.id) || fallbackId,
      result.content ?? result.output ?? result.result, time,
      result.is_error === true || ['error', 'failed', 'failure'].includes(status), string(result.name));
  }

  function content(value: unknown, role: Message['role'], id: string, time: unknown, model = builder.model) {
    if (typeof value === 'string') {
      builder.message(`${id}:text:0`, role, value, time, model ? { model } : {});
      return;
    }
    array(value).forEach((value, index) => {
      const block = object(value);
      const kind = firstString(block.kind, block.type);
      const data = object(block.data);
      if (kind === 'toolUse' || kind === 'tool_use' || block.toolUse) {
        const tool = block.toolUse ? object(block.toolUse) : kind === 'tool_use' ? block : data;
        builder.toolCall(firstString(tool.toolUseId, tool.id, tool.tool_use_id) || `${id}:call:${index}`,
          firstString(tool.name, tool.orig_name), tool.input ?? tool.args ?? tool.arguments, time, model);
      } else if (kind === 'toolResult' || kind === 'tool_result' || block.toolResult) {
        toolResult(block.toolResult ?? (kind === 'tool_result' ? block : data), time, `${id}:result:${index}`);
      } else if (kind === 'thinking') {
        // Native signatures/redactedContent are not readable conversation text.
        const thought = firstString(data.text, block.thinking);
        if (thought) builder.message(`${id}:thinking:${index}`, 'assistant', thought, time, model ? { model } : {});
      } else {
        const body = text(block);
        if (body) builder.message(`${id}:text:${index}`, role, body, time, model ? { model } : {});
        else if (kind && !['image', 'audio', 'resource', 'redacted_thinking'].includes(kind)) {
          builder.warn('An unsupported Kiro content block was ignored.');
        } else if (kind) builder.warn('Non-text or redacted Kiro message content is not available as text.');
      }
    });
  }

  function genericMessage(value: unknown, fallbackRole?: Message['role'], fallbackId = `record:${ordinal}`, time?: unknown) {
    const message = object(value);
    const role = firstString(message.role, fallbackRole);
    const id = firstString(message.message_id, message.id, message.uuid) || fallbackId;
    const at = message.timestamp ?? object(message.meta).timestamp ?? time ?? messageTimes.get(id);
    const model = firstString(message.model, builder.model);
    if (role === 'user' || role === 'assistant' || role === 'system') {
      content(message.content ?? message.text, role, id, at, model);
      builder.usage.add(id, readUsage(message.usage));
    } else if (role === 'tool') {
      toolResult({ ...message, tool_use_id: message.tool_call_id ?? message.tool_use_id ?? id }, at, id);
    } else builder.warn('An unsupported Kiro message role was ignored.');
  }

  function history(turnValue: unknown, index: number) {
    const turn = object(turnValue);
    const user = object(turn.user);
    const userContent = object(user.content);
    const request = object(turn.request_metadata);
    const userTime = user.timestamp ?? request.request_start_timestamp_ms;
    const assistantTime = request.stream_end_timestamp_ms ?? userTime;
    const env = object(object(user.env_context).env_state);
    builder.projectPath = firstString(env.current_working_directory, builder.projectPath);
    builder.model = firstString(request.model_id, builder.model);
    builder.observe(userTime);
    builder.observe(assistantTime);
    const userId = firstString(user.message_id, user.id) || `history:${index}:user`;
    if (userContent.Prompt !== undefined) {
      content(text(userContent.Prompt), 'user', userId, userTime);
    } else if (userContent.ToolUseResults !== undefined) {
      array(object(userContent.ToolUseResults).tool_use_results).forEach((result, resultIndex) => {
        toolResult(result, userTime, `${userId}:result:${resultIndex}`);
      });
    } else if (typeof user.content === 'string' || Array.isArray(user.content)) {
      content(user.content, 'user', userId, userTime);
    } else if (user.content !== undefined) {
      const body = text(user.content);
      if (body) content(body, 'user', userId, userTime);
      else builder.warn('An unsupported legacy Kiro user-content variant was ignored.');
    }

    const wrapper = object(turn.assistant);
    const variant = wrapper.ToolUse ?? wrapper.ResponseMessage ?? wrapper.Response ?? wrapper.Message;
    const assistant = typeof variant === 'string' ? { content: variant } : object(variant ?? turn.assistant);
    const assistantId = firstString(assistant.message_id, assistant.id, request.message_id) || `history:${index}:assistant`;
    content(assistant.content ?? assistant.text, 'assistant', assistantId, assistant.timestamp ?? assistantTime);
    array(assistant.tool_uses ?? assistant.toolUses).forEach((value, toolIndex) => {
      const tool = object(value);
      builder.toolCall(firstString(tool.id, tool.tool_use_id, tool.toolUseId) || `${assistantId}:call:${toolIndex}`,
        firstString(tool.name, tool.orig_name), tool.args ?? tool.input ?? tool.arguments, assistantTime, builder.model);
    });
    builder.usage.add(firstString(request.request_id, assistant.message_id) || `history:${index}`,
      readUsage(request.usage ?? request.token_usage ?? turn.usage ?? assistant.usage));
    if (turn.assistant !== undefined && variant === undefined && !assistant.content && !assistant.role) {
      builder.warn('An unsupported legacy Kiro assistant variant was ignored.');
    }
  }

  function metadata(record: JsonObject) {
    if (record.session_state !== undefined && !Array.isArray(record.history) && !Array.isArray(record.messages)) {
      requiresTranscript = true;
    }
    builder.identify(record.session_id ?? record.sessionId ?? record.conversation_id ?? record.id);
    builder.projectPath = firstString(record.cwd, record.project_path, record.projectPath, record.working_directory, builder.projectPath);
    builder.title = firstString(record.title, record.name, builder.title);
    builder.parentId = firstString(record.parent_session_id, record.parentSessionId, builder.parentId);
    builder.observe(record.created_at ?? record.createdAt);
    builder.observe(record.updated_at ?? record.updatedAt);
    const state = object(record.session_state);
    const runtime = object(state.rts_model_state);
    const modelInfo = object(record.model_info ?? runtime.model_info);
    builder.model = firstString(modelInfo.model_id, modelInfo.model_name, record.model, builder.model);
    builder.usage.total(readUsage(record.usage ?? record.token_usage));
    const turns = array(object(state.conversation_metadata).user_turn_metadatas);
    turns.forEach((value, index) => {
      const turn = object(value);
      const ids = array(turn.message_ids);
      const identity = turn.loop_id !== undefined ? hash(json(turn.loop_id))
        : ids.length ? hash(json(ids)) : `turn:${index}`;
      builder.usage.add(`turn:${identity}`, readUsage(turn));
      builder.observe(turn.end_timestamp);
      builder.model = firstString(turn.model, builder.model);
      for (const id of ids) {
        if (typeof id === 'string' && messageTimes.size < 40_000) messageTimes.set(id, turn.end_timestamp);
      }
      const result = object(object(turn.result).Ok);
      const id = firstString(result.id, result.message_id);
      if (id && metadataResponses.size < 20_000) {
        metadataResponses.set(id, { message: result, time: object(result.meta).timestamp ?? turn.end_timestamp });
      }
    });
    if (record.history !== undefined) {
      if (!Array.isArray(record.history)) builder.reject('Invalid Kiro history array; prior history was not replaced.');
      else record.history.forEach(history);
    }
    if (Array.isArray(record.messages)) record.messages.forEach((message, index) => genericMessage(message, undefined, `message:${index}`));
  }

  return {
    consume(value) {
      ordinal++;
      if (Array.isArray(value)) {
        value.forEach((message, index) => genericMessage(message, undefined, `message:${index}`));
        return;
      }
      const record = object(value);
      const kind = string(record.kind);
      const type = string(record.type);
      if (record.history !== undefined || record.session_state !== undefined || Array.isArray(record.messages)
        || (!kind && !record.role && !['user', 'assistant', 'tool', 'message'].includes(type) && (record.session_id || record.conversation_id))) {
        metadata(record);
      } else if (['Prompt', 'AssistantMessage', 'ToolResults'].includes(kind)) {
        transcriptEvents++;
        const data = object(record.data);
        const id = firstString(data.message_id, data.id) || `event:${ordinal}`;
        if (eventMessages.size < 40_000) eventMessages.add(id);
        const time = object(data.meta).timestamp ?? data.timestamp ?? record.timestamp ?? messageTimes.get(id);
        builder.observe(time);
        if (kind === 'Prompt') content(data.content, 'user', id, time);
        else if (kind === 'AssistantMessage') content(data.content, 'assistant', id, time);
        else content(data.content, 'tool', id, time);
        // `results` is a second representation of the content's tool results;
        // importing it as well would duplicate the tools and their output.
        builder.usage.add(id, readUsage(data.usage ?? record.usage));
      } else if (record.role || ['user', 'assistant', 'tool', 'system', 'message'].includes(type)) {
        builder.identify(record.session_id ?? record.sessionId);
        builder.projectPath = firstString(record.cwd, builder.projectPath);
        builder.model = firstString(record.model, builder.model);
        const role = ['user', 'assistant', 'tool', 'system'].includes(type) ? type as Message['role'] : undefined;
        genericMessage(record.message ?? record, role, `record:${ordinal}`, record.timestamp);
      } else if (kind || type) {
        builder.warn('Unsupported Kiro event records were ignored; this native history format may be incomplete.');
      }
    },
    finish() {
      if (requiresTranscript && !transcriptEvents) {
        builder.reject('Kiro metadata has no readable matching transcript; empty or unsupported history was not imported.');
      }
      for (const [id, fallback] of metadataResponses) {
        if (!eventMessages.has(id)) {
          genericMessage(fallback.message, 'assistant', id, fallback.time);
          builder.warn(transcriptEvents
            ? 'Some Kiro responses were recovered from metadata because their transcript events were missing.'
            : 'Kiro metadata contains only final responses; a matching transcript is needed for full history.');
        }
      }
      return builder.finish();
    },
  };
}

export function parseKiroSession(document: unknown, context: ParseContext): ParseResult {
  const parser = createKiroParser(context);
  parser.consume(document);
  return parser.finish();
}

export function parseKiroRecords(records: Iterable<unknown>, context: ParseContext): ParseResult {
  const parser = createKiroParser(context);
  for (const record of records) parser.consume(record);
  return parser.finish();
}
