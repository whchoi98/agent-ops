import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENTS } from '../shared/types.js';
import { defaultSettings } from '../server/config.js';
import { Store } from '../server/store.js';
import { SyncService } from '../server/sync.js';

// This opt-in diagnostic never prints transcript text, paths, native IDs, or prompts.
const directory = mkdtempSync(join(tmpdir(), 'agent-ops-native-verification-'));
const store = new Store(join(directory, 'verification.sqlite'));
const started = Date.now();
try {
  store.saveSettings({ sourceRoots: defaultSettings().sourceRoots });
  let lastReport = 0;
  const sync = new SyncService(store, () => {}, false, (imported) => {
    if (Date.now() - lastReport >= 15000) {
      lastReport = Date.now();
      console.error(`Native verification: ${imported} sessions imported (${Math.round((Date.now() - started) / 1000)}s).`);
    }
  });
  const first = await sync.run();
  const sessions = store.allSessions();
  const firstCounts = Object.fromEntries(AGENTS.map((agent) => {
    const items = sessions.filter((session) => session.agent === agent);
    return [agent, {
      sessions: items.length,
      messages: items.reduce((sum, session) => sum + session.messageCount, 0),
      toolCalls: items.reduce((sum, session) => sum + session.toolCallCount, 0),
      withTokenRecords: items.filter((session) => session.usage.inputTokens !== null || session.usage.outputTokens !== null).length,
      withCostRecords: items.filter((session) => session.usage.costUsd !== null).length,
      withProject: items.filter((session) => Boolean(session.projectPath)).length,
      withModel: items.filter((session) => session.model !== 'unknown' && session.model !== '').length,
      scaffoldingTitles: items.filter((session) => /^(?:# AGENTS\.md|<environment_context>|<skills|<INSTRUCTIONS>)/i.test(session.title)).length,
    }];
  }));
  let searchChecked = false;
  for (const item of sessions) {
    const detail = store.getSession(item.id)!;
    const text = detail.messages.find((message) => message.role === 'user' && message.content.length >= 12)?.content;
    if (!text) continue;
    const q = text.slice(0, 12);
    searchChecked = store.listSessions({ q, project: item.projectPath, limit: 200 }).items.some((session) => session.id === item.id);
    if (searchChecked) break;
  }
  const repeat = await sync.run();
  const warnings = [...first.warnings, ...repeat.warnings];
  const diagnostics = {
    sourceChanged: warnings.filter((message) => /changed|stable read/i.test(message)).length,
    sizeOrDepthLimit: warnings.filter((message) => /size|large|depth|limit|truncat/i.test(message)).length,
    unsupportedOrEmpty: warnings.filter((message) => /unsupported|empty|No supported/i.test(message)).length,
    missingOrUnreadable: warnings.filter((message) => /ENOENT|missing|unreadable|permission|EACCES/i.test(message)).length,
    malformed: warnings.filter((message) => /malformed|invalid|JSON|parse|line/i.test(message)).length,
  };
  console.log(JSON.stringify({
    source: 'local native history; read-only import into a temporary database',
    elapsedMs: Date.now() - started,
    firstPass: { imported: first.imported, filesScanned: first.filesScanned, skipped: first.skipped, warningCount: first.warnings.length },
    repeatPass: { imported: repeat.imported, filesScanned: repeat.filesScanned, skipped: repeat.skipped, warningCount: repeat.warnings.length },
    providers: firstCounts, transcriptSearchVerified: searchChecked,
    uniqueSessions: store.listSessions().total, diagnostics,
    note: 'Changing/open files may be deferred or refreshed. Unknown values are not inferred. Temporary database is removed after this report.',
  }, null, 2));
  if (sessions.length && !searchChecked) process.exitCode = 1;
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
