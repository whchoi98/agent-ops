import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  chmod, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, truncate, utimes, writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Agent, ImportedSession } from '../shared/types.js';
import { discoverSessions, parseClaudeSession, parseCodexSession } from '../server/providers/index.js';

const temporaryDirectories: string[] = [];
const firstTime = '2026-01-02T03:00:00.000Z';
const secondTime = '2026-01-02T03:01:00.000Z';
const thirdTime = '2026-01-02T03:02:00.000Z';
const unknownUsage = {
  inputTokens: null, outputTokens: null, cacheReadTokens: null,
  cacheWriteTokens: null, costUsd: null,
};

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-ops-providers-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function jsonl(path: string, records: unknown[]) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  return path;
}

async function paddedFile(path: string, prefix: string, padding: Buffer, repetitions: number, suffix: string) {
  const handle = await open(path, 'w');
  try {
    await handle.writeFile(prefix);
    for (let index = 0; index < repetitions; index++) await handle.writeFile(padding);
    await handle.writeFile(suffix);
  } finally {
    await handle.close();
  }
}

function roots(agent: Agent, ...paths: string[]): Record<Agent, string[]> {
  return { codex: [], claude: [], kiro: [], [agent]: paths };
}

async function discover(
  sources: Record<Agent, string[]>,
  options?: Parameters<typeof discoverSessions>[2],
) {
  const sessions: ImportedSession[] = [];
  const report = await discoverSessions(sources, session => { sessions.push(session); }, options);
  return { sessions, ...report };
}

function codexRecords(id = 'codex-native'): unknown[] {
  return [
    { type: 'session_meta', timestamp: firstTime, payload: { id, cwd: '/work/synthetic', timestamp: firstTime } },
    { type: 'turn_context', timestamp: firstTime, payload: { model: 'codex-test-model', cwd: '/work/synthetic' } },
    { type: 'response_item', timestamp: firstTime, payload: {
      type: 'message', id: 'user-one', role: 'user', content: [{ type: 'input_text', text: 'Review the sample parser' }],
    } },
    { type: 'response_item', timestamp: secondTime, payload: {
      type: 'message', id: 'assistant-one', role: 'assistant', content: [{ type: 'output_text', text: 'The sample is ready.' }],
    } },
  ];
}

function claudeChat(sessionId: string, properties: Record<string, unknown> = {}, prompt = 'Synthetic native request'): unknown[] {
  return [
    { type: 'user', uuid: 'shared-parent-user-uuid', sessionId, cwd: '/work/claude-tree', timestamp: firstTime,
      message: { role: 'user', content: prompt }, ...properties },
    { type: 'assistant', uuid: 'shared-parent-assistant-uuid', sessionId, cwd: '/work/claude-tree', timestamp: secondTime,
      message: { id: 'shared-response-id', role: 'assistant', model: 'claude-test-model',
        content: [{ type: 'text', text: 'Synthetic native answer' }], usage: { input_tokens: 10, output_tokens: 2 } },
      ...properties },
  ];
}

function kiroHistory(id = 'legacy-conversation') {
  return {
    conversation_id: id,
    model_info: { model_id: 'kiro-test-model', model_name: 'Synthetic model', context_window_tokens: 200000 },
    history: [
      {
        user: {
          content: { Prompt: { prompt: 'Inspect a synthetic workspace' } },
          timestamp: firstTime,
          env_context: { env_state: { current_working_directory: '/work/kiro-fixture' } },
        },
        assistant: { ToolUse: {
          message_id: 'kiro-assistant-one',
          content: 'I will inspect it.',
          tool_uses: [{ id: 'kiro-call', name: 'fs_read', args: { path: 'sample.txt' } }],
        } },
        request_metadata: {
          request_id: 'request-one', model_id: 'kiro-test-model',
          request_start_timestamp_ms: Date.parse(firstTime),
          stream_end_timestamp_ms: Date.parse(secondTime),
          context_usage_percentage: 12, user_prompt_length: 900, response_size: 300,
        },
      },
      {
        user: {
          content: { ToolUseResults: { tool_use_results: [
            { tool_use_id: 'kiro-call', status: 'Success', content: [{ Text: 'Synthetic file contents' }] },
          ] } },
          timestamp: secondTime,
        },
        assistant: { ResponseMessage: { message_id: 'kiro-assistant-two', content: 'Inspection finished.' } },
        request_metadata: { stream_end_timestamp_ms: Date.parse(thirdTime) },
      },
    ],
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('native Codex sessions', () => {
  it('captures canonical messages and tool results without duplicating event mirrors or cumulative usage', async () => {
    const directory = await temporaryDirectory();
    const records = codexRecords();
    records.splice(3, 0,
      { type: 'event_msg', timestamp: firstTime, payload: { type: 'user_message', message: 'Review the sample parser' } },
      { type: 'event_msg', timestamp: firstTime, payload: { type: 'task_started' } },
      { type: 'response_item', timestamp: firstTime, payload: {
        type: 'function_call', call_id: 'call-one', name: 'exec_command', arguments: '{"cmd":"pwd"}',
      } },
      { type: 'response_item', timestamp: secondTime, payload: {
        type: 'function_call_output', call_id: 'call-one', output: '/work/synthetic',
      } },
      { type: 'event_msg', timestamp: secondTime, payload: { type: 'agent_message', message: 'The sample is ready.' } },
    );
    const counts = (input: number, output: number) => ({
      type: 'event_msg', timestamp: thirdTime, payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 20 },
        last_token_usage: { input_tokens: 50, output_tokens: 5 },
      } },
    });
    const path = await jsonl(join(directory, 'rollout.jsonl'), [...records, counts(100, 10), counts(150, 15), counts(150, 15)]);
    const { sessions, warnings } = await discover(roots('codex', directory));
    expect(warnings).toEqual([]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'codex:codex-native', nativeId: 'codex-native', agent: 'codex',
      title: 'Review the sample parser', projectPath: '/work/synthetic', projectName: 'synthetic',
      model: 'codex-test-model', startedAt: firstTime, updatedAt: thirdTime, status: 'recorded',
      messageCount: 4, toolCallCount: 1, sourcePath: path,
      usage: { inputTokens: 150, outputTokens: 15, cacheReadTokens: 20, cacheWriteTokens: null, costUsd: null },
    });
    expect(sessions[0].messages.map(message => [message.role, message.content, message.toolName])).toEqual([
      ['user', 'Review the sample parser', undefined],
      ['assistant', '{"cmd":"pwd"}', 'exec_command'],
      ['tool', '/work/synthetic', 'exec_command'],
      ['assistant', 'The sample is ready.', undefined],
    ]);
    expect(new Set(sessions[0].messages.map(message => message.id)).size).toBe(4);
  });

  it('deduplicates last-usage events by request while retaining equal usage from distinct requests', async () => {
    const directory = await temporaryDirectory();
    const count = (requestId: string, timestamp: string) => ({
      type: 'event_msg', timestamp, payload: { type: 'token_count', request_id: requestId, info: {
        last_token_usage: { input_tokens: 12, output_tokens: 3 },
      } },
    });
    await jsonl(join(directory, 'last.jsonl'), [
      ...codexRecords(), count('request-one', firstTime), count('request-one', secondTime),
      count('request-two', thirdTime),
    ]);
    const { sessions } = await discover(roots('codex', directory));
    expect(sessions[0].usage).toEqual({ ...unknownUsage, inputTokens: 24, outputTokens: 6 });
  });

  it('keeps repeated utterances with distinct native message IDs and unknown usage', async () => {
    const directory = await temporaryDirectory();
    await jsonl(join(directory, 'unknown.jsonl'), [
      ...codexRecords(),
      { type: 'response_item', timestamp: thirdTime, payload: {
        type: 'message', id: 'user-two', role: 'user', content: [{ type: 'input_text', text: 'Review the sample parser' }],
      } },
    ]);
    const { sessions } = await discover(roots('codex', directory));
    expect(sessions[0].usage).toEqual(unknownUsage);
    expect(sessions[0].messages.filter(message => message.role === 'user')).toHaveLength(2);
  });

  it('reads archive roots, custom tools, and event-only history with stable fallback IDs', async () => {
    const directory = await temporaryDirectory();
    const path = await jsonl(join(directory, 'archived_sessions', 'without-id.jsonl'), [
      { type: 'event_msg', timestamp: '2026-01-02T12:00:00+09:00', payload: { type: 'user_message', message: 'Synthetic archived request' } },
      { type: 'response_item', timestamp: secondTime, payload: { type: 'custom_tool_call', call_id: 'custom-one', name: 'apply_patch', input: 'synthetic patch' } },
      { type: 'response_item', timestamp: thirdTime, payload: { type: 'custom_tool_call_output', call_id: 'custom-one', output: 'Applied sample patch' } },
    ]);
    const initial = await discover(roots('codex', join(directory, 'archived_sessions')));
    await utimes(path, new Date(thirdTime), new Date(thirdTime));
    const repeated = await discover(roots('codex', path));
    expect(initial.sessions[0].id).toBe(repeated.sessions[0].id);
    expect(initial.sessions[0].id).toMatch(/^codex:.+/);
    expect(initial.sessions[0].startedAt).toBe(firstTime);
    expect(initial.sessions[0].toolCallCount).toBe(1);
    expect(initial.sessions[0].messages[2]).toMatchObject({ role: 'tool', toolName: 'apply_patch' });
  });

  it('prefers the recorded user prompt as the title while retaining injected context messages', async () => {
    const directory = await temporaryDirectory();
    await jsonl(join(directory, 'context.jsonl'), [
      codexRecords()[0],
      { type: 'response_item', timestamp: firstTime, payload: {
        type: 'message', id: 'environment', role: 'user', content: [{ type: 'input_text', text: '<environment_context>synthetic context</environment_context>' }],
      } },
      codexRecords()[2],
      { type: 'event_msg', timestamp: firstTime, payload: { type: 'user_message', message: 'Review the sample parser' } },
    ]);
    const result = await discover(roots('codex', directory));
    expect(result.sessions[0]).toMatchObject({ title: 'Review the sample parser', messageCount: 2 });
  });

  it.each([false, true])('skips scaffold titles and preserves original messages with event mirrors=%s', (withEvents) => {
    const scaffolds = [
      '# AGENTS.md instructions for /work/synthetic\n\n<INSTRUCTIONS>Synthetic repository guidance.</INSTRUCTIONS>',
      '<environment_context>cwd: /work/synthetic</environment_context>',
      '<INSTRUCTIONS>Synthetic injected instructions.</INSTRUCTIONS>',
      '<skills_instructions>Synthetic skill metadata.</skills_instructions>',
      '<skills-context>Synthetic available skills.</skills-context>',
    ];
    const contents = [...scaffolds, 'Repair the synthetic parser regression'];
    const records = [
      codexRecords()[0],
      ...contents.flatMap((content, index) => [
        { type: 'response_item', timestamp: firstTime, payload: {
          type: 'message', id: `scaffold-test-${index}`, role: 'user', content: [{ type: 'input_text', text: content }],
        } },
        ...(withEvents ? [{ type: 'event_msg', timestamp: firstTime, payload: { type: 'user_message', message: content } }] : []),
      ]),
    ];
    const result = parseCodexSession(records, { sourcePath: '/synthetic/scaffold-session.jsonl' });
    expect(result.warnings).toEqual([]);
    expect(result.session?.title).toBe('Repair the synthetic parser regression');
    expect(result.session?.messages.map(message => message.content)).toEqual(contents);
  });

  it('extracts a prompt after leading scaffold wrappers without changing the stored message', () => {
    const content = '# AGENTS.md instructions for /work/synthetic\n\n<INSTRUCTIONS>Injected guidance.</INSTRUCTIONS>\n'
      + '<environment_context>Synthetic workspace.</environment_context>\n'
      + '<skills>Injected skill list.</skills>\n\nExplain the synthetic state machine';
    const result = parseCodexSession([
      codexRecords()[0],
      { type: 'response_item', timestamp: firstTime, payload: {
        type: 'message', id: 'wrapped-prompt', role: 'user', content: [{ type: 'input_text', text: content }],
      } },
      { type: 'event_msg', timestamp: firstTime, payload: { type: 'user_message', message: content } },
    ], { sourcePath: '/synthetic/wrapped-prompt.jsonl' });
    expect(result.session?.title).toBe('Explain the synthetic state machine');
    expect(result.session?.messages.map(message => message.content)).toEqual([content]);
  });

  it.each([
    { cwd: '/work/synthetic', title: 'Codex · synthetic' },
    { cwd: undefined, title: 'Codex session' },
  ])('uses an agent/project title when only scaffolding was recorded: $title', ({ cwd, title }) => {
    const content = '# AGENTS.md instructions for a synthetic workspace\nUnterminated injected guidance.';
    const result = parseCodexSession([
      { type: 'session_meta', timestamp: firstTime, payload: { id: 'scaffold-only', cwd } },
      { type: 'response_item', timestamp: firstTime, payload: {
        type: 'message', id: 'scaffold-only-user', role: 'user', content: [{ type: 'input_text', text: content }],
      } },
      { type: 'event_msg', timestamp: firstTime, payload: { type: 'user_message', message: content } },
    ], { sourcePath: '/synthetic/scaffold-only.jsonl' });
    expect(result.session?.title).toBe(title);
    expect(result.session?.messages[0].content).toBe(content);
  });
});

describe('native Claude sessions', () => {
  it('merges streamed assistant snapshots, tool blocks, and response usage by native message ID', async () => {
    const directory = await temporaryDirectory();
    const assistant = (uuid: string, content: unknown[], outputTokens: number) => ({
      type: 'assistant', uuid, sessionId: 'claude-native', cwd: '/work/claude-fixture', timestamp: secondTime,
      message: { id: 'response-one', role: 'assistant', model: 'claude-test-model', content,
        usage: { input_tokens: 100, output_tokens: outputTokens, cache_read_input_tokens: 40, cache_creation_input_tokens: 8 } },
    });
    await jsonl(join(directory, 'claude-native.jsonl'), [
      { type: 'user', uuid: 'user-one', sessionId: 'claude-native', cwd: '/work/claude-fixture',
        timestamp: firstTime, message: { role: 'user', content: 'Test the sample feature' } },
      assistant('snapshot-one', [{ type: 'text', text: 'Checking' }], 1),
      assistant('snapshot-two', [{ type: 'text', text: 'Checking the sample.' }], 5),
      assistant('tool-block', [{ type: 'tool_use', id: 'claude-call', name: 'Read', input: { file_path: '/work/claude-fixture/sample.ts' } }], 5),
      assistant('tool-block-copy', [{ type: 'tool_use', id: 'claude-call', name: 'Read', input: { file_path: '/work/claude-fixture/sample.ts' } }], 5),
      { type: 'user', uuid: 'result-one', sessionId: 'claude-native', timestamp: thirdTime, message: {
        role: 'user', content: [{ type: 'tool_result', tool_use_id: 'claude-call', is_error: true,
          content: [{ type: 'text', text: 'Synthetic missing file' }] }],
      } },
      { ...assistant('response-two', [{ type: 'text', text: 'The fixture is missing.' }], 9),
        timestamp: thirdTime,
        message: { id: 'response-two', role: 'assistant', model: 'claude-test-model',
          content: [{ type: 'text', text: 'The fixture is missing.' }],
          usage: { input_tokens: 30, output_tokens: 9, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } } },
      { type: 'custom-title', sessionId: 'claude-native', customTitle: 'Synthetic Claude title' },
    ]);
    const { sessions, warnings } = await discover(roots('claude', directory));
    expect(warnings).toEqual([]);
    expect(sessions[0]).toMatchObject({
      id: 'claude:claude-native', title: 'Synthetic Claude title', projectPath: '/work/claude-fixture',
      model: 'claude-test-model', status: 'recorded', messageCount: 5, toolCallCount: 1,
      usage: { inputTokens: 188, outputTokens: 14, cacheReadTokens: 50, cacheWriteTokens: 8, costUsd: null },
    });
    expect(sessions[0].messages.filter(message => message.role === 'assistant' && !message.toolName).map(message => message.content))
      .toEqual(['Checking the sample.', 'The fixture is missing.']);
    expect(sessions[0].messages.find(message => message.role === 'tool'))
      .toMatchObject({ content: 'Synthetic missing file', toolName: 'Read', isError: true });
  });

  it('normalizes uncached input plus both cache counters once per response', async () => {
    const directory = await temporaryDirectory();
    const response = {
      type: 'assistant', uuid: 'response-snapshot', sessionId: 'claude-cache', timestamp: firstTime,
      message: { id: 'cache-response', role: 'assistant', content: [{ type: 'text', text: 'Synthetic cached response' }],
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } },
    };
    await jsonl(join(directory, 'cache.jsonl'), [response, { ...response, uuid: 'response-copy' }]);
    const { sessions } = await discover(roots('claude', directory));
    expect(sessions[0].usage).toEqual({
      inputTokens: 60, outputTokens: 2, cacheReadTokens: 20, cacheWriteTokens: 30, costUsd: null,
    });
    expect(sessions[0].messageCount).toBe(1);
  });

  it('retains known cache counters when a later cumulative result omits those fields', async () => {
    const directory = await temporaryDirectory();
    await jsonl(join(directory, 'partial-result.jsonl'), [
      { type: 'assistant', uuid: 'partial-cache-snapshot', sessionId: 'partial-cache', timestamp: firstTime,
        message: { id: 'partial-cache-response', role: 'assistant', content: [{ type: 'text', text: 'Synthetic cached result' }],
          usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } } },
      { type: 'result', session_id: 'partial-cache', usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0 },
    ]);
    const { sessions } = await discover(roots('claude', directory));
    expect(sessions[0].usage).toEqual({
      inputTokens: 60, outputTokens: 2, cacheReadTokens: 20, cacheWriteTokens: 30, costUsd: 0,
    });
  });

  it('reconciles raw stream deltas with final snapshots and records only explicit cost', async () => {
    const directory = await temporaryDirectory();
    const stream = (event: unknown) => ({ type: 'stream_event', sessionId: 'claude-stream', timestamp: secondTime, event });
    await jsonl(join(directory, 'stream.jsonl'), [
      { type: 'user', uuid: 'user-one', sessionId: 'claude-stream', timestamp: firstTime,
        message: { role: 'user', content: 'Stream a synthetic answer' } },
      stream({ type: 'message_start', message: { id: 'stream-response', model: 'claude-stream-model',
        usage: { input_tokens: 15, output_tokens: 0 } } }),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture.' } }),
      stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'stream-tool', name: 'Read', input: {} } }),
      stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } }),
      stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"sample.ts"}' } }),
      stream({ type: 'content_block_stop', index: 1 }),
      stream({ type: 'message_delta', usage: { output_tokens: 7 } }),
      { type: 'assistant', uuid: 'final-snapshot', sessionId: 'claude-stream', timestamp: thirdTime, message: {
        id: 'stream-response', model: 'claude-stream-model', role: 'assistant',
        content: [{ type: 'text', text: 'Hello fixture.' }, { type: 'tool_use', id: 'stream-tool', name: 'Read', input: { file_path: 'sample.ts' } }],
        usage: { input_tokens: 15, output_tokens: 7 },
      } },
      { type: 'result', session_id: 'claude-stream', total_cost_usd: 0.0123, usage: { input_tokens: 15, output_tokens: 7 } },
    ]);
    const { sessions } = await discover(roots('claude', directory));
    expect(sessions[0]).toMatchObject({
      messageCount: 3, toolCallCount: 1,
      usage: { ...unknownUsage, inputTokens: 15, outputTokens: 7, costUsd: 0.0123 },
    });
    expect(sessions[0].messages.map(message => message.content))
      .toEqual(['Stream a synthetic answer', 'Hello fixture.', '{"file_path":"sample.ts"}']);
  });

  it('does not confuse repeated user text or distinct assistant response IDs with stream duplicates', async () => {
    const directory = await temporaryDirectory();
    await jsonl(join(directory, 'repeat.jsonl'), [
      ...['one', 'two'].flatMap((id, index) => [
        { type: 'user', uuid: `user-${id}`, sessionId: 'claude-repeat', timestamp: index ? thirdTime : firstTime,
          message: { role: 'user', content: 'Again' } },
        { type: 'assistant', uuid: `assistant-${id}`, sessionId: 'claude-repeat', timestamp: index ? thirdTime : secondTime,
          message: { id: `response-${id}`, role: 'assistant', content: [{ type: 'text', text: 'Acknowledged' }] } },
      ]),
    ]);
    const { sessions } = await discover(roots('claude', directory));
    expect(sessions[0].messageCount).toBe(4);
    expect(sessions[0].usage).toEqual(unknownUsage);
  });

  it('keeps roots and children separate even with shared UUIDs and an agent ID reused under two parents', async () => {
    const directory = await temporaryDirectory();
    const parentAlpha = await jsonl(join(directory, 'parent-alpha.jsonl'),
      claudeChat('parent-alpha', {}, 'Synthetic parent alpha request'));
    const alphaWorkerOne = await jsonl(join(directory, 'parent-alpha', 'subagents', 'agent-worker-one.jsonl'),
      claudeChat('parent-alpha', { agentId: 'worker-one', isSidechain: true, timestamp: thirdTime }, 'Synthetic alpha child one'));
    const alphaWorkerTwo = await jsonl(join(directory, 'parent-alpha', 'subagents', 'agent-worker-two.jsonl'),
      claudeChat('parent-alpha', { agentId: 'worker-two', isSidechain: true, timestamp: thirdTime }, 'Synthetic alpha child two'));
    const parentBeta = await jsonl(join(directory, 'parent-beta.jsonl'),
      claudeChat('parent-beta', {}, 'Synthetic parent beta request'));
    const betaWorkerOne = await jsonl(join(directory, 'parent-beta', 'subagents', 'agent-worker-one.jsonl'),
      claudeChat('parent-beta', { agentId: 'worker-one', isSidechain: true, timestamp: thirdTime }, 'Synthetic beta child one'));
    const stored = new Map<string, ImportedSession>();
    const result = await discoverSessions(roots('claude', parentAlpha, alphaWorkerOne, alphaWorkerTwo, parentBeta, betaWorkerOne),
      session => { stored.set(session.id, session); });
    expect(result.warnings).toEqual([]);
    expect([...stored.keys()].sort()).toEqual([
      'claude:parent-alpha',
      'claude:parent-alpha:subagent:worker-one',
      'claude:parent-alpha:subagent:worker-two',
      'claude:parent-beta',
      'claude:parent-beta:subagent:worker-one',
    ]);
    expect(stored.get('claude:parent-alpha')).toMatchObject({ nativeId: 'parent-alpha', title: 'Synthetic parent alpha request' });
    expect(stored.get('claude:parent-beta')).toMatchObject({ nativeId: 'parent-beta', title: 'Synthetic parent beta request' });
    expect(stored.get('claude:parent-alpha:subagent:worker-one')).toMatchObject({
      nativeId: 'worker-one', parentId: 'claude:parent-alpha', resumable: false, messageCount: 2,
    });
    expect(stored.get('claude:parent-alpha:subagent:worker-two')).toMatchObject({
      nativeId: 'worker-two', parentId: 'claude:parent-alpha', resumable: false,
    });
    expect(stored.get('claude:parent-beta:subagent:worker-one')).toMatchObject({
      nativeId: 'worker-one', parentId: 'claude:parent-beta', resumable: false, messageCount: 2,
    });
    const messageIds = [...stored.values()].flatMap(session => session.messages.map(message => message.id));
    expect(new Set(messageIds).size).toBe(10);
  });

  it.each([
    { name: 'sidechain and agentId in a relocated file', path: '/synthetic/archive/relocated.jsonl', properties: { isSidechain: true, agentId: 'worker-one' } },
    { name: 'subagents path and matching agentId', path: '/synthetic/parent-alpha/subagents/agent-worker-one.jsonl', properties: { agentId: 'worker-one' } },
    { name: 'subagents path and sidechain marker', path: '/synthetic/parent-alpha/subagents/agent-worker-one.jsonl', properties: { isSidechain: true } },
    { name: 'subagents path and matching parent sessionId', path: '/synthetic/parent-alpha/subagents/agent-worker-one.jsonl', properties: {} },
  ])('identifies a child using corroborated $name', ({ path, properties }) => {
    const parsed = parseClaudeSession(claudeChat('parent-alpha', properties), { sourcePath: path });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.session).toMatchObject({
      id: 'claude:parent-alpha:subagent:worker-one', nativeId: 'worker-one',
      parentId: 'claude:parent-alpha', resumable: false,
    });
  });

  it.each([
    { agentId: 'mentioned-worker' },
    { agentId: 'mentioned-worker', isSidechain: false },
    { isSidechain: true },
  ])('does not treat uncorroborated root markers as a child: %j', (properties) => {
    const parsed = parseClaudeSession([
      { type: 'agent_started', sessionId: 'parent-alpha', agentId: 'helper-worker', isSidechain: true },
      ...claudeChat('parent-alpha', properties),
    ], { sourcePath: '/synthetic/projects/project/parent-alpha.jsonl' });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.session).toMatchObject({ id: 'claude:parent-alpha', nativeId: 'parent-alpha' });
    expect(parsed.session).not.toHaveProperty('parentId');
    expect(parsed.session).not.toHaveProperty('resumable', false);
  });

  it('uses the latest ai-title record while preserving a child’s identity', () => {
    const records = [
      ...claudeChat('parent-alpha', { isSidechain: true, agentId: 'worker-one' }),
      { type: 'ai-title', sessionId: 'parent-alpha', aiTitle: 'Older synthetic AI title' },
      { type: 'ai-title', sessionId: 'parent-alpha', aiTitle: 'Latest synthetic AI title' },
    ];
    const parsed = parseClaudeSession(records, { sourcePath: '/synthetic/parent-alpha/subagents/agent-worker-one.jsonl' });
    const relocated = parseClaudeSession(records, { sourcePath: '/synthetic/archive/copied-child.jsonl' });
    expect(parsed.session).toMatchObject({
      id: 'claude:parent-alpha:subagent:worker-one', nativeId: 'worker-one', parentId: 'claude:parent-alpha',
      title: 'Latest synthetic AI title', resumable: false,
    });
    expect(relocated.session?.id).toBe(parsed.session?.id);
    expect(relocated.session?.messages.map(message => message.id)).toEqual(parsed.session?.messages.map(message => message.id));
  });

  it('ignores launched/started/result-only helper files without native chat', async () => {
    const directory = await temporaryDirectory();
    await jsonl(join(directory, 'helper.jsonl'), [
      { type: 'launched', sessionId: 'helper-parent', agentId: 'helper-worker', isSidechain: true },
      { type: 'started', sessionId: 'helper-parent', agentId: 'helper-worker', isSidechain: true },
      { type: 'system', sessionId: 'helper-parent', content: 'Synthetic helper process started' },
      { type: 'result', session_id: 'helper-parent', result: 'Synthetic helper result', usage: { input_tokens: 12, output_tokens: 2 } },
    ]);
    const marked: string[] = [];
    const parsed = await discover(roots('claude', directory), { onRead: path => { marked.push(path); } });
    expect(parsed.sessions).toEqual([]);
    expect(parsed.warnings.join(' ')).toMatch(/native.*chat|helper|no supported messages/i);
    expect(marked).toEqual([]);
  });
});

describe('native Kiro sessions', () => {
  it('reads legacy key/value SQLite payloads without guessing tokens from context and response sizes', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'data.sqlite3');
    const database = new Database(path);
    database.exec('CREATE TABLE conversations (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    database.prepare('INSERT INTO conversations VALUES (?, ?)').run('/work/kiro-fixture', JSON.stringify(kiroHistory()));
    database.close();
    await chmod(path, 0o444);
    const before = await readFile(path);
    const { sessions, warnings } = await discover(roots('kiro', path));
    expect(warnings).toEqual([]);
    expect(await readFile(path)).toEqual(before);
    expect(sessions[0]).toMatchObject({
      id: 'kiro:legacy-conversation', projectPath: '/work/kiro-fixture', model: 'kiro-test-model',
      startedAt: firstTime, updatedAt: thirdTime, title: 'Inspect a synthetic workspace',
      messageCount: 5, toolCallCount: 1, usage: unknownUsage, status: 'recorded',
    });
    expect(sessions[0].messages.map(message => message.role)).toEqual(['user', 'assistant', 'assistant', 'tool', 'assistant']);
    expect(sessions[0].messages.find(message => message.role === 'tool'))
      .toMatchObject({ content: 'Synthetic file contents', toolName: 'fs_read' });
  });

  it('keeps V2 conversations sharing a workspace key separate and uses row IDs and timestamps', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'data.sqlite3');
    const database = new Database(path);
    database.exec('CREATE TABLE conversations_v2 (key TEXT, conversation_id TEXT PRIMARY KEY, value TEXT, created_at INTEGER, updated_at INTEGER)');
    const insert = database.prepare('INSERT INTO conversations_v2 VALUES (?, ?, ?, ?, ?)');
    for (const id of ['v2-one', 'v2-two']) {
      const payload = { ...kiroHistory('stale-payload-id'), history: [{
        user: { content: { Prompt: { prompt: `Synthetic ${id}` } } },
        assistant: { Response: { message_id: `${id}-answer`, content: 'Recorded answer' } },
      }] };
      insert.run('/work/shared-key', id, JSON.stringify(payload), Date.parse(firstTime) / 1000, Date.parse(thirdTime));
    }
    database.close();
    const { sessions } = await discover(roots('kiro', directory));
    expect(sessions.map(session => session.id).sort()).toEqual(['kiro:v2-one', 'kiro:v2-two']);
    for (const session of sessions) {
      expect(session).toMatchObject({ projectPath: '/work/shared-key', startedAt: firstTime, updatedAt: thirdTime, usage: unknownUsage });
      expect(session.messages.every(message => !Number.isNaN(Date.parse(message.timestamp)))).toBe(true);
    }
  });

  it('combines current JSON metadata and matching JSONL events, deduplicating per-turn counters', async () => {
    const directory = await temporaryDirectory();
    const turn = {
      loop_id: { agent_id: { name: 'synthetic', parent_id: null, rand: null }, rand: 1 },
      message_ids: ['prompt-one', 'answer-one'], input_token_count: 10, output_token_count: 4,
      cache_read_input_token_count: 2, cache_write_input_token_count: 0, model: 'kiro-current-model',
      end_timestamp: secondTime,
      metering_usage: [{ value: 5, unit: 'credits' }],
    };
    await writeFile(join(directory, 'current.json'), JSON.stringify({
      session_id: 'kiro-current', cwd: '/work/current-kiro', title: 'Synthetic current Kiro session',
      created_at: firstTime, updated_at: thirdTime,
      session_state: {
        conversation_metadata: { user_turn_metadatas: [turn, { ...turn }, {
          ...turn, loop_id: { ...turn.loop_id, rand: 2 }, message_ids: ['prompt-two', 'answer-two'],
          input_token_count: 6, output_token_count: 3, cache_read_input_token_count: 1,
        }] },
        rts_model_state: { conversation_id: 'runtime-id', model_info: { model_id: 'kiro-current-model', model_name: 'Synthetic current model' } },
      },
    }));
    await jsonl(join(directory, 'current.jsonl'), [
      { version: '1', kind: 'Prompt', data: { message_id: 'prompt-one', content: [{ kind: 'text', data: 'Read the synthetic sample' }], meta: { timestamp: Date.parse(firstTime) } } },
      { version: '1', kind: 'AssistantMessage', data: { message_id: 'answer-one', content: [
        { kind: 'text', data: 'Reading the sample.' },
        { kind: 'toolUse', data: { toolUseId: 'current-call', name: 'fs_read', input: { path: 'sample.txt' } } },
      ] } },
      { version: '1', kind: 'ToolResults', data: { message_id: 'tool-result-one', content: [
        { kind: 'toolResult', data: { toolUseId: 'current-call', status: 'success', content: [{ kind: 'text', data: 'Synthetic sample body' }] } },
      ] }, results: { 'current-call': { result: { Success: { items: [{ Text: 'Synthetic sample body' }] } } } } },
      { version: '1', kind: 'AssistantMessage', data: { message_id: 'answer-two', content: [{ kind: 'text', data: 'Done reading.' }] } },
    ]);
    const { sessions, filesScanned, warnings } = await discover(roots('kiro', directory));
    expect(warnings).toEqual([]);
    expect(filesScanned).toBe(2);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'kiro:kiro-current', title: 'Synthetic current Kiro session', projectPath: '/work/current-kiro',
      model: 'kiro-current-model', messageCount: 5, toolCallCount: 1, status: 'recorded',
      usage: { inputTokens: 16, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0, costUsd: null },
    });
    expect(sessions[0].messages.find(message => message.role === 'tool'))
      .toMatchObject({ toolName: 'fs_read', content: 'Synthetic sample body' });
  });

  it('imports standalone JSON history and leaves unknown usage null', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'legacy.json'), JSON.stringify(kiroHistory('json-native')));
    const { sessions } = await discover(roots('kiro', directory));
    expect(sessions[0]).toMatchObject({ id: 'kiro:json-native', messageCount: 5, usage: unknownUsage });
  });

  it('fingerprints WAL updates and reads newly committed rows while the writer stays open', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'data.sqlite3');
    const database = new Database(path);
    try {
      database.pragma('journal_mode = WAL');
      database.pragma('wal_autocheckpoint = 0');
      database.exec('CREATE TABLE conversations_v2 (key TEXT, conversation_id TEXT PRIMARY KEY, value TEXT, created_at INTEGER, updated_at INTEGER)');
      const insert = database.prepare('INSERT INTO conversations_v2 VALUES (?, ?, ?, ?, ?)');
      insert.run('/work/wal', 'wal-one', JSON.stringify(kiroHistory('wal-one')), 1, 2);
      database.pragma('wal_checkpoint(TRUNCATE)');
      const fingerprints = new Map<string, string>();
      const options = {
        shouldRead: (source: string, fingerprint: string) => fingerprints.get(source) !== fingerprint,
        onRead: (source: string, fingerprint: string) => { fingerprints.set(source, fingerprint); },
      };
      const initial = await discover(roots('kiro', path), options);
      const oldFingerprint = fingerprints.get(path);
      const mainBefore = await lstat(path);
      insert.run('/work/wal', 'wal-two', JSON.stringify(kiroHistory('wal-two')), 3, 4);
      const mainAfter = await lstat(path);
      expect([mainAfter.size, mainAfter.mtimeMs]).toEqual([mainBefore.size, mainBefore.mtimeMs]);
      const refreshed = await discover(roots('kiro', path), options);
      expect(initial.sessions).toHaveLength(1);
      expect(refreshed.sessions.map(session => session.id).sort()).toEqual(['kiro:wal-one', 'kiro:wal-two']);
      expect(fingerprints.get(path)).not.toBe(oldFingerprint);
      const unchanged = await discover(roots('kiro', path), options);
      expect(unchanged).toMatchObject({ sessions: [], filesScanned: 1, skipped: 1 });
    } finally {
      database.close();
    }
  });

  it('isolates malformed SQLite rows, retries the database, and continues scanning other sources', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'data.sqlite3');
    const database = new Database(path);
    database.exec('CREATE TABLE conversations (key TEXT, value TEXT)');
    database.prepare('INSERT INTO conversations VALUES (?, ?)').run('/work/bad', '{"history":');
    database.prepare('INSERT INTO conversations VALUES (?, ?)').run('/work/good', JSON.stringify(kiroHistory('good-row')));
    database.close();
    const marked: string[] = [];
    const result = await discover(roots('kiro', path), { onRead: source => { marked.push(source); } });
    expect(result.sessions.map(session => session.id)).toEqual(['kiro:good-row']);
    expect(result.warnings.join(' ')).toMatch(/malformed|invalid|parse/i);
    expect(marked).toEqual([]);
    const writable = new Database(path);
    writable.exec('DELETE FROM conversations WHERE key = \'/work/bad\'');
    writable.close();
    const retry = await discover(roots('kiro', path), { onRead: source => { marked.push(source); } });
    expect(retry.warnings).toEqual([]);
    expect(marked).toEqual([path]);
  });

  it('imports small conversations from a SQLite database larger than 64 MiB', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'data.sqlite3');
    const database = new Database(path);
    try {
      database.exec('CREATE TABLE conversations (key TEXT, value TEXT); CREATE TABLE padding (value BLOB)');
      database.prepare('INSERT INTO conversations VALUES (?, ?)').run('/work/large-db', JSON.stringify(kiroHistory('large-db')));
      database.prepare('INSERT INTO padding VALUES (zeroblob(?))').run(65 * 1024 * 1024);
    } finally {
      database.close();
    }
    const before = await lstat(path);
    expect(before.size).toBeGreaterThan(64 * 1024 * 1024);
    const marked: string[] = [];
    const result = await discover(roots('kiro', path), { onRead: source => { marked.push(source); } });
    expect(result.warnings).toEqual([]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ id: 'kiro:large-db', messageCount: 5, usage: unknownUsage });
    expect(marked).toEqual([path]);
    const after = await lstat(path);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
  });

  it('imports committed conversations when the SQLite WAL is larger than 64 MiB', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'data.sqlite3');
    const database = new Database(path);
    try {
      database.pragma('journal_mode = WAL');
      database.pragma('wal_autocheckpoint = 0');
      database.exec('CREATE TABLE conversations (key TEXT, value TEXT); CREATE TABLE padding (value BLOB)');
      database.prepare('INSERT INTO conversations VALUES (?, ?)').run('/work/large-wal', JSON.stringify(kiroHistory('large-wal')));
      database.pragma('wal_checkpoint(TRUNCATE)');
      database.prepare('INSERT INTO padding VALUES (zeroblob(?))').run(65 * 1024 * 1024);
      expect((await lstat(`${path}-wal`)).size).toBeGreaterThan(64 * 1024 * 1024);
      const fingerprints = new Map<string, string>();
      const options = {
        shouldRead: (source: string, fingerprint: string) => fingerprints.get(source) !== fingerprint,
        onRead: (source: string, fingerprint: string) => { fingerprints.set(source, fingerprint); },
      };
      const result = await discover(roots('kiro', path), options);
      expect(result.warnings).toEqual([]);
      expect(result.sessions.map(session => session.id)).toEqual(['kiro:large-wal']);
      expect(fingerprints.has(path)).toBe(true);
      expect(await discover(roots('kiro', path), options)).toMatchObject({ sessions: [], skipped: 1, warnings: [] });
    } finally {
      database.close();
    }
  });

  it('rejects SQLite rows larger than 64 MiB while importing healthy rows without checkpointing the database', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'data.sqlite3');
    const database = new Database(path);
    try {
      database.exec('CREATE TABLE conversations (key TEXT, value TEXT)');
      database.prepare('INSERT INTO conversations VALUES (?, ?)').run('/work/small-row', JSON.stringify(kiroHistory('small-row')));
      database.prepare('INSERT INTO conversations VALUES (?, zeroblob(?))').run('/work/oversized-row', 64 * 1024 * 1024 + 1);
    } finally {
      database.close();
    }
    const marked: string[] = [];
    const result = await discover(roots('kiro', path), { onRead: source => { marked.push(source); } });
    expect(result.sessions.map(session => session.id)).toEqual(['kiro:small-row']);
    expect(result.warnings.join(' ')).toMatch(/payload.*64 MiB|64 MiB.*payload/i);
    expect(marked).toEqual([]);
  });
});

describe('bounded, read-only source discovery', () => {
  it('fingerprints paths and changes, deduplicates overlapping roots, and awaits successful imports before onRead', async () => {
    const directory = await temporaryDirectory();
    const path = await jsonl(join(directory, 'session.jsonl'), codexRecords());
    const fingerprints = new Map<string, string>();
    const order: string[] = [];
    const options = {
      shouldRead: (source: string, fingerprint: string) => fingerprints.get(source) !== fingerprint,
      onRead: (source: string, fingerprint: string) => { order.push('read'); fingerprints.set(source, fingerprint); },
    };
    const first = await discoverSessions(roots('codex', directory, path), async () => {
      await new Promise(resolve => setTimeout(resolve, 2));
      order.push('session');
    }, options);
    expect(order).toEqual(['session', 'read']);
    expect(first.filesScanned).toBe(1);
    const oldFingerprint = fingerprints.get(path);
    const unchanged = await discover(roots('codex', directory), options);
    expect(unchanged).toMatchObject({ sessions: [], filesScanned: 1, skipped: 1, warnings: [] });
    await jsonl(path, [...codexRecords(), { type: 'event_msg', timestamp: thirdTime, payload: { type: 'agent_message', message: 'One more recorded message' } }]);
    const updated = await discover(roots('codex', directory), options);
    expect(updated.sessions[0].messageCount).toBe(3);
    expect(fingerprints.get(path)).not.toBe(oldFingerprint);
  });

  it('refreshes paired Kiro files together when only the transcript changes', async () => {
    const directory = await temporaryDirectory();
    const metadata = join(directory, 'paired.json');
    const transcript = join(directory, 'paired.jsonl');
    await writeFile(metadata, JSON.stringify({ session_id: 'paired-id', title: 'A synthetic title', cwd: '/work/paired',
      session_state: {}, created_at: firstTime, updated_at: secondTime }));
    const prompt = { kind: 'Prompt', data: { message_id: 'paired-user', content: [{ kind: 'text', data: 'A synthetic prompt' }] } };
    await jsonl(transcript, [prompt]);
    const fingerprints = new Map<string, string>();
    const options = {
      shouldRead: (source: string, fingerprint: string) => fingerprints.get(source) !== fingerprint,
      onRead: (source: string, fingerprint: string) => { fingerprints.set(source, fingerprint); },
    };
    const initial = await discover(roots('kiro', directory), options);
    expect(initial.sessions).toHaveLength(1);
    expect(fingerprints.size).toBe(2);
    expect((await discover(roots('kiro', directory), options)).skipped).toBe(2);
    await jsonl(transcript, [prompt, { kind: 'AssistantMessage', data: {
      message_id: 'paired-answer', content: [{ kind: 'text', data: 'A synthetic reply' }],
    } }]);
    const refreshed = await discover(roots('kiro', directory), options);
    expect(refreshed.sessions).toHaveLength(1);
    expect(refreshed.sessions[0]).toMatchObject({ id: 'kiro:paired-id', title: 'A synthetic title', messageCount: 2 });
  });

  it('withholds empty or unrecognized paired Kiro transcripts instead of importing metadata over prior history', async () => {
    const directory = await temporaryDirectory();
    const metadata = join(directory, 'empty.json');
    const transcript = join(directory, 'empty.jsonl');
    await writeFile(metadata, JSON.stringify({
      session_id: 'metadata-only', title: 'Synthetic metadata', session_state: {
        conversation_metadata: { user_turn_metadatas: [{
          result: { Ok: { id: 'metadata-answer', role: 'assistant', content: [{ kind: 'text', data: 'Only the final response' }] } },
        }] },
      },
    }));
    await writeFile(transcript, '');
    const marked: string[] = [];
    const empty = await discover(roots('kiro', directory), { onRead: source => { marked.push(source); } });
    expect(empty.sessions).toEqual([]);
    expect(empty.warnings.join(' ')).toMatch(/empty|transcript/i);
    expect(marked).toEqual([]);
    await jsonl(transcript, [{ version: 'future', kind: 'UnknownMessageEncoding', data: {} }]);
    const unsupported = await discover(roots('kiro', directory), { onRead: source => { marked.push(source); } });
    expect(unsupported.sessions).toEqual([]);
    expect(unsupported.warnings.join(' ')).toMatch(/unsupported|unrecognized/i);
    expect(marked).toEqual([]);
  });

  it('preserves UTF-8 across chunks and accepts BOM, CRLF, and a complete final line without a newline', async () => {
    const directory = await temporaryDirectory();
    const prompt = '합성 테스트 '.repeat(8000);
    const records = [
      { type: 'session_meta', timestamp: firstTime, payload: { id: 'utf8-native' } },
      { type: 'response_item', timestamp: secondTime, payload: {
        type: 'message', id: 'utf8-message', role: 'user', content: [{ type: 'input_text', text: prompt }],
      } },
    ];
    await writeFile(join(directory, 'utf8.jsonl'), '\uFEFF' + records.map(record => JSON.stringify(record)).join('\r\n'));
    const result = await discover(roots('codex', directory));
    expect(result.warnings).toEqual([]);
    expect(result.sessions[0].messages[0].content).toBe(prompt);
  });

  it('does not replace a prior import or checkpoint a malformed/truncated file', async () => {
    const directory = await temporaryDirectory();
    const path = await jsonl(join(directory, 'broken.jsonl'), codexRecords());
    const imported = new Map<string, ImportedSession>();
    const fingerprints = new Map<string, string>();
    const options = {
      shouldRead: (source: string, fingerprint: string) => fingerprints.get(source) !== fingerprint,
      onRead: (source: string, fingerprint: string) => { fingerprints.set(source, fingerprint); },
    };
    await discoverSessions(roots('codex', path), session => { imported.set(session.id, session); }, options);
    const oldFingerprint = fingerprints.get(path);
    await writeFile(path, JSON.stringify(codexRecords()[0]) + '\n{"type":"response_item"\n' + JSON.stringify(codexRecords()[2]) + '\n{"truncated":');
    await jsonl(join(directory, 'good.jsonl'), codexRecords('healthy-sibling'));
    const result = await discoverSessions(roots('codex', directory), session => { imported.set(session.id, session); }, options);
    expect(result.warnings.join(' ')).toMatch(/line|malformed|truncated/i);
    expect(imported.get('codex:codex-native')?.messageCount).toBe(2);
    expect(imported.has('codex:healthy-sibling')).toBe(true);
    expect(fingerprints.get(path)).toBe(oldFingerprint);
  });

  it('skips symlinks, unrelated extensions, and paths outside the configured roots', async () => {
    const directory = await temporaryDirectory();
    const inside = join(directory, 'inside');
    const outside = join(directory, 'outside');
    await mkdir(inside);
    const external = await jsonl(join(outside, 'external.jsonl'), codexRecords('external'));
    await jsonl(join(inside, 'allowed.jsonl'), codexRecords('allowed'));
    await jsonl(join(inside, 'not-a-session.txt'), codexRecords('text-file'));
    await writeFile(join(inside, 'not-codex.json'), JSON.stringify(kiroHistory()));
    await symlink(external, join(inside, 'file-link.jsonl'));
    await symlink(outside, join(inside, 'directory-link'));
    await symlink(outside, join(directory, 'root-link'));
    const result = await discover(roots('codex', inside, join(directory, 'root-link')));
    expect(result.sessions.map(session => session.id)).toEqual(['codex:allowed']);
    expect(result.filesScanned).toBe(1);
    expect(result.warnings.join(' ')).toMatch(/symlink|symbolic/i);
  });

  it('does not read an unconfigured companion when a single Kiro JSON file is the root', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'one.json');
    await writeFile(path, JSON.stringify(kiroHistory('one-file')));
    await jsonl(join(directory, 'one.jsonl'), [{ kind: 'Prompt', data: {
      message_id: 'out-of-scope', content: [{ kind: 'text', data: 'Unconfigured sibling content' }],
    } }]);
    const { sessions, filesScanned } = await discover(roots('kiro', path));
    expect(filesScanned).toBe(1);
    expect(sessions[0].messageCount).toBe(5);
    expect(sessions[0].messages.some(message => message.content.includes('Unconfigured'))).toBe(false);
  });

  it('caps traversal depth and file count with diagnostics', async () => {
    const directory = await temporaryDirectory();
    const deep = join(directory, ...Array.from({ length: 10 }, (_, index) => `level-${index}`));
    await jsonl(join(deep, 'at-limit.jsonl'), codexRecords('at-depth-limit'));
    await jsonl(join(deep, 'too-deep', 'over-limit.jsonl'), codexRecords('over-depth-limit'));
    const depthResult = await discover(roots('codex', directory));
    expect(depthResult.sessions.map(session => session.id)).toEqual(['codex:at-depth-limit']);
    expect(depthResult.warnings.join(' ')).toMatch(/depth/i);
    await jsonl(join(directory, 'top-level.jsonl'), codexRecords('top-level'));
    const limited = await discover(roots('codex', directory), { maxFiles: 1 });
    expect(limited.filesScanned).toBe(1);
    expect(limited.sessions).toHaveLength(1);
    expect(limited.warnings.join(' ')).toMatch(/limit|maxFiles/i);
  });

  it('streams valid JSONL larger than 64 MiB and reads records after the padding', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'large-valid.jsonl');
    const padding = Buffer.alloc(1024 * 1024, ' ');
    padding[padding.length - 1] = 10;
    await paddedFile(path,
      codexRecords().slice(0, 3).map(record => JSON.stringify(record)).join('\n') + '\n',
      padding, 65,
      [
        codexRecords()[3],
        { type: 'event_msg', timestamp: thirdTime, payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: 99, output_tokens: 8 },
        } } },
      ].map(record => JSON.stringify(record)).join('\n') + '\n');
    expect((await lstat(path)).size).toBeGreaterThan(64 * 1024 * 1024);
    const marked: string[] = [];
    const result = await discover(roots('codex', path), { onRead: source => { marked.push(source); } });
    expect(result.warnings).toEqual([]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      id: 'codex:codex-native', messageCount: 2, updatedAt: thirdTime,
      usage: { ...unknownUsage, inputTokens: 99, outputTokens: 8 },
    });
    expect(marked).toEqual([path]);
  });

  it('rejects a single JSONL line larger than 64 MiB without replacing prior history or its fingerprint', async () => {
    const directory = await temporaryDirectory();
    const path = await jsonl(join(directory, 'large-line.jsonl'), codexRecords());
    const imported = new Map<string, ImportedSession>();
    const fingerprints = new Map<string, string>();
    const options = {
      shouldRead: (source: string, fingerprint: string) => fingerprints.get(source) !== fingerprint,
      onRead: (source: string, fingerprint: string) => { fingerprints.set(source, fingerprint); },
    };
    await discoverSessions(roots('codex', path), session => { imported.set(session.id, session); }, options);
    const previous = imported.get('codex:codex-native');
    const oldFingerprint = fingerprints.get(path);
    await paddedFile(path,
      codexRecords().slice(0, 3).map(record => JSON.stringify(record)).join('\n') + '\n{"padding":"',
      Buffer.alloc(1024 * 1024, 'x'), 65, '"}\n' + JSON.stringify(codexRecords()[3]) + '\n');
    expect((await lstat(path)).size).toBeLessThan(512 * 1024 * 1024);
    await jsonl(join(directory, 'healthy.jsonl'), codexRecords('healthy-next-to-large-line'));
    const result = await discoverSessions(roots('codex', directory), session => { imported.set(session.id, session); }, options);
    expect(result.warnings.join(' ')).toMatch(/\bline\s+\d+.*64 MiB/i);
    expect(imported.get('codex:codex-native')).toBe(previous);
    expect(fingerprints.get(path)).toBe(oldFingerprint);
    expect(imported.has('codex:healthy-next-to-large-line')).toBe(true);
  });

  it.each([
    { agent: 'codex', filename: 'large.jsonl', limitMiB: 512 },
    { agent: 'kiro', filename: 'large.json', limitMiB: 64 },
  ] as const)('rejects $filename larger than $limitMiB MiB without reading or checkpointing it', async ({ agent, filename, limitMiB }) => {
    const directory = await temporaryDirectory();
    const path = join(directory, filename);
    await writeFile(path, '');
    await truncate(path, limitMiB * 1024 * 1024 + 1);
    const marked: string[] = [];
    const result = await discover(roots(agent, directory), { onRead: source => { marked.push(source); } });
    expect(result.sessions).toEqual([]);
    expect(result.warnings.join(' ')).toContain(`${limitMiB} MiB`);
    expect(marked).toEqual([]);
  });

  it('truncates excessive messages explicitly while still consuming later usage records', async () => {
    const directory = await temporaryDirectory();
    const records: unknown[] = [codexRecords()[0]];
    for (let index = 0; index < 20003; index++) {
      records.push({ type: 'response_item', timestamp: firstTime, payload: {
        type: 'message', id: `many-${index}`, role: 'user', content: [{ type: 'input_text', text: `Synthetic message ${index}` }],
      } });
    }
    records.push({ type: 'event_msg', timestamp: thirdTime, payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 99, output_tokens: 8 },
    } } });
    await jsonl(join(directory, 'many.jsonl'), records);
    const result = await discover(roots('codex', directory));
    expect(result.sessions[0].messages).toHaveLength(20000);
    expect(result.sessions[0].usage).toMatchObject({ inputTokens: 99, outputTokens: 8 });
    expect(result.warnings.join(' ')).toMatch(/truncat|20000/i);
  });

  it('reports unreadable or unsupported sources and does not checkpoint failed callbacks', async () => {
    const directory = await temporaryDirectory();
    const path = await jsonl(join(directory, 'good.jsonl'), codexRecords());
    const badDatabase = join(directory, 'data.sqlite3');
    await writeFile(badDatabase, 'not a sqlite database');
    await writeFile(join(directory, 'unknown.jsonl'), '{"unrecognized":true}\n');
    const marked: string[] = [];
    const result = await discoverSessions({
      codex: [directory, join(directory, 'missing-root')],
      claude: [],
      kiro: [badDatabase],
    }, () => { throw new Error('Synthetic callback failure'); }, { onRead: source => { marked.push(source); } });
    expect(marked).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/missing|ENOENT/i);
    expect(result.warnings.join(' ')).toMatch(/sqlite|database/i);
    expect(result.warnings.join(' ')).toMatch(/callback|import|Synthetic callback failure/i);
    expect((await readFile(path, 'utf8')).length).toBeGreaterThan(0);
  });
});
