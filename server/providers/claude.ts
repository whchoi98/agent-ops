import {
  SessionBuilder, array, firstString, hash, object, readUsage, string, text,
  type ParseContext, type ParseResult, type SessionParser,
} from './common.js';

interface Block {
  key: string;
  type: string;
  text: string;
  id: string;
  name: string;
  input: unknown;
  partial: string;
}
interface Response {
  id: string;
  model: string;
  blocks: Map<string, Block>;
  streamIndices: Map<number, string>;
}

export function createClaudeParser(context: ParseContext): SessionParser {
  const builder = new SessionBuilder('claude', context, true);
  const responses = new Map<string, Response>();
  const active = new Map<string, string>();
  const streamEvents = new Set<string>();
  const childPath = /(?:^|\/)([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/i.exec(context.sourcePath.replace(/\\/g, '/'));
  let observedSessionId = '';
  let sidechainAgentId = '';
  let ordinal = 0;

  function observeIdentity(record: Record<string, unknown>, type: string) {
    const sessionId = firstString(record.sessionId, record.session_id);
    if (sessionId) {
      if (observedSessionId && observedSessionId !== sessionId) {
        builder.reject('Conflicting native session IDs; import withheld to preserve prior history.');
      } else observedSessionId = sessionId;
    }
    builder.identify(sessionId);
    // Agent launch/progress metadata in a root transcript is not evidence that
    // the transcript itself belongs to the mentioned subagent.
    if (!['user', 'assistant', 'stream_event', 'tool_result'].includes(type)) return;
    const agentId = firstString(record.agentId, record.agent_id);
    const matchesChildPath = childPath && observedSessionId === childPath[1];
    if (matchesChildPath && agentId && agentId !== childPath[2]) {
      builder.reject('Conflicting Claude subagent identities; prior history was not replaced.');
      return;
    }
    if (agentId && (record.isSidechain === true || (matchesChildPath && agentId === childPath[2]))) {
      if (sidechainAgentId && sidechainAgentId !== agentId) {
        builder.reject('Conflicting Claude subagent identities; prior history was not replaced.');
      } else sidechainAgentId = agentId;
    }
  }

  function response(id: string, model = ''): Response {
    let current = responses.get(id);
    if (!current) {
      current = { id, model, blocks: new Map(), streamIndices: new Map() };
      if (responses.size < 20_000) responses.set(id, current);
      else builder.warn('Assistant response history truncated after 20000 responses.');
    }
    if (model) current.model = model;
    if (current.model) builder.model = current.model;
    return current;
  }

  function render(current: Response, block: Block, time: unknown) {
    if (block.type === 'tool_use') {
      builder.toolCall(block.id, block.name, block.partial || block.input, time, current.model);
    } else if (block.type === 'text' || block.type === 'thinking') {
      builder.message(block.key, 'assistant', block.text, time, current.model ? { model: current.model } : {});
    }
  }

  function block(current: Response, value: unknown, index: number, time: unknown, streamed = false): Block {
    const content = object(value);
    const type = firstString(content.type, 'text');
    const nativeId = firstString(content.id, content.tool_use_id) || `${current.id}:${index}`;
    let key = type === 'tool_use' ? `tool:${nativeId}` : `${type}:${index}`;
    const incomingText = type === 'thinking' ? string(content.thinking) : text(content);
    let existing = current.blocks.get(key);
    if (existing && incomingText && existing.text && !incomingText.startsWith(existing.text) && !existing.text.startsWith(incomingText)) {
      // Separate non-overlapping text blocks can share index zero in Claude's
      // persisted assistant records. Prefix-compatible records are snapshots.
      key = `${key}:${hash(incomingText)}`;
      existing = current.blocks.get(key);
    }
    if (!existing) {
      existing = {
        key: `${current.id}:${key}`, type, text: incomingText, id: nativeId,
        name: string(content.name), input: content.input, partial: '',
      };
      current.blocks.set(key, existing);
    } else {
      if (incomingText.length >= existing.text.length) existing.text = incomingText;
      if (content.input !== undefined) {
        existing.input = content.input;
        if (!streamed) existing.partial = '';
      }
      if (typeof content.name === 'string') existing.name = content.name;
    }
    if (streamed) current.streamIndices.set(index, key);
    render(current, existing, time);
    return existing;
  }

  function stream(record: Record<string, unknown>, time: unknown) {
    const event = object(record.event);
    const eventType = string(event.type);
    const eventId = firstString(record.uuid, record.event_id, event.id);
    if (eventId) {
      const identity = `${eventId}:${hash(JSON.stringify(event))}`;
      if (streamEvents.has(identity)) return;
      if (streamEvents.size < 100_000) streamEvents.add(identity);
    }
    const channel = firstString(record.parent_tool_use_id, 'root');
    if (eventType === 'message_start') {
      const message = object(event.message);
      const id = firstString(message.id) || `stream:${ordinal}`;
      active.set(channel, id);
      response(id, string(message.model));
      builder.usage.add(id, readUsage(message.usage));
      return;
    }
    const id = firstString(event.message_id, active.get(channel));
    if (!id) {
      builder.warn('Claude stream events without a message_start were ignored.');
      return;
    }
    const current = response(id);
    const index = typeof event.index === 'number' ? event.index : 0;
    if (eventType === 'content_block_start') {
      block(current, event.content_block, index, time, true);
    } else if (eventType === 'content_block_delta') {
      const key = current.streamIndices.get(index);
      const currentBlock = key ? current.blocks.get(key) : undefined;
      if (!currentBlock) {
        builder.warn('Claude content deltas without their block start were ignored.');
        return;
      }
      const delta = object(event.delta);
      if (delta.type === 'text_delta') currentBlock.text += string(delta.text);
      if (delta.type === 'thinking_delta') currentBlock.text += string(delta.thinking);
      if (delta.type === 'input_json_delta') currentBlock.partial += string(delta.partial_json);
      render(current, currentBlock, time);
    } else if (eventType === 'content_block_stop') {
      const key = current.streamIndices.get(index);
      const currentBlock = key ? current.blocks.get(key) : undefined;
      if (currentBlock?.partial) {
        try {
          currentBlock.input = JSON.parse(currentBlock.partial);
          currentBlock.partial = '';
        } catch {
          builder.warn('Incomplete Claude tool arguments were kept as recorded text.');
        }
        render(current, currentBlock, time);
      }
    } else if (eventType === 'message_delta') {
      builder.usage.add(id, readUsage(event.usage));
    }
  }

  return {
    consume(value) {
      ordinal++;
      const record = object(value);
      const type = string(record.type);
      const time = record.timestamp;
      builder.observe(time);
      observeIdentity(record, type);
      builder.projectPath = firstString(record.cwd, builder.projectPath);
      builder.parentId = firstString(record.parentSessionId, record.parent_session_id, builder.parentId);
      if (type === 'summary' || type === 'custom-title' || type === 'ai-title') {
        builder.title = firstString(record.customTitle, record.aiTitle, record.summary, builder.title);
      } else if (type === 'stream_event') {
        stream(record, time);
      } else if (type === 'assistant') {
        const message = object(record.message);
        const id = firstString(message.id, record.requestId, record.uuid) || `assistant:${ordinal}`;
        const current = response(id, firstString(message.model, record.model));
        const content = message.content ?? record.content;
        const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : array(content);
        blocks.forEach((item, index) => block(current, item, index, time));
        builder.usage.add(id, readUsage(message.usage ?? record.usage));
        if (record.cost_usd !== undefined) builder.usage.add(id, readUsage({ cost_usd: record.cost_usd }));
      } else if (type === 'user' || type === 'system') {
        const message = object(record.message);
        const id = firstString(record.uuid, message.id) || `record:${ordinal}`;
        const content = message.content ?? record.content;
        if (typeof content === 'string') {
          builder.message(id, type, content, time);
        } else {
          array(content).forEach((item, index) => {
            const content = object(item);
            if (content.type === 'tool_result') {
              builder.toolResult(firstString(content.tool_use_id, content.id) || `${id}:${index}`,
                content.content, time, content.is_error === true, string(content.name));
            } else if (content.type === 'text' || typeof content.text === 'string') {
              builder.message(`${id}:${index}`, type, text(content), time);
            }
          });
        }
      } else if (type === 'result') {
        // SDK result counters and cost describe the whole run, not another response.
        builder.usage.total(readUsage(record.usage));
        builder.usage.total(readUsage(record));
      } else if (type === 'tool_result') {
        builder.toolResult(firstString(record.tool_use_id, record.id) || `result:${ordinal}`,
          record.content, time, record.is_error === true, string(record.name));
      }
    },
    finish() {
      const matchesChildPath = childPath && (!observedSessionId || observedSessionId === childPath[1]);
      if (sidechainAgentId || matchesChildPath) {
        const parentNative = firstString(observedSessionId, childPath?.[1]);
        const agentId = firstString(sidechainAgentId, childPath?.[2]);
        if (!parentNative || !agentId) {
          builder.reject('Claude subagent parent/agent identity is missing; prior history was not replaced.');
        } else {
          // Keep the actual native agent ID for attribution, but namespace both
          // session/message keys by the parent. A child is not a resumable root.
          builder.nativeId = agentId;
          builder.sessionKey = `${parentNative}:subagent:${agentId}`;
          builder.parentId = `claude:${parentNative}`;
          builder.resumable = false;
        }
      }
      const parsed = builder.finish();
      if (parsed.session && !parsed.session.messages.some(message => message.role !== 'system')) {
        builder.warn('No native Claude chat messages found; helper/status-only file was not imported.');
        return { session: null, warnings: builder.warnings };
      }
      return parsed;
    },
  };
}

export function parseClaudeSession(records: Iterable<unknown>, context: ParseContext): ParseResult {
  const parser = createClaudeParser(context);
  for (const record of records) parser.consume(record);
  return parser.finish();
}
