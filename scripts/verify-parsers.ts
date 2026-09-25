import { AGENTS, type Agent } from '../shared/types.js';
import { defaultSettings } from '../server/config.js';
import { discoverSessions } from '../server/providers/index.js';

// Full-corpus parser preflight without writing transcript content or building FTS.
// Only aggregate counts leave this process.
interface Item {
  agent: Agent; parentId?: string; resumable?: boolean; messages: number;
  scaffold: boolean; tokens: boolean; model: boolean;
}
const items = new Map<string, Item>();
let conflictingIdentity = 0;
const started = Date.now();
const scan = await discoverSessions(defaultSettings().sourceRoots, (session) => {
  const previous = items.get(session.id);
  if (previous && Boolean(previous.parentId) !== Boolean(session.parentId)) conflictingIdentity++;
  items.set(session.id, {
    agent: session.agent, parentId: session.parentId, resumable: session.resumable,
    messages: session.messageCount,
    scaffold: /^(?:# AGENTS\.md instructions|<environment_context>|<skills|<INSTRUCTIONS>)/i.test(session.title),
    tokens: session.usage.inputTokens !== null || session.usage.outputTokens !== null,
    model: Boolean(session.model && session.model !== 'unknown'),
  });
}, { maxFiles: 20000 });
const providers = Object.fromEntries(AGENTS.map((agent) => {
  const sessions = [...items.values()].filter((session) => session.agent === agent);
  const children = sessions.filter((session) => session.parentId);
  return [agent, {
    sessions: sessions.length,
    messages: sessions.reduce((total, session) => total + session.messages, 0),
    withTokenRecords: sessions.filter((session) => session.tokens).length,
    withModel: sessions.filter((session) => session.model).length,
    scaffoldTitles: sessions.filter((session) => session.scaffold).length,
    children: children.length,
    knownParents: children.filter((session) => items.has(session.parentId!)).length,
    nonResumableChildren: children.filter((session) => session.resumable === false).length,
  }];
}));
console.log(JSON.stringify({
  mode: 'read-only full-corpus parser preflight; no transcript content saved',
  elapsedMs: Date.now() - started, filesScanned: scan.filesScanned, uniqueSessions: items.size,
  warningCount: scan.warnings.length, conflictingIdentity, providers,
}, null, 2));
if (conflictingIdentity > 0 || providers.codex.scaffoldTitles > 0
  || providers.claude.children !== providers.claude.nonResumableChildren) process.exitCode = 1;
