import { AGENTS, emptyUsage, type Analytics, type Bootstrap, type Run, type SessionDetail, type Usage } from '../../../shared/types';

export function creditSession(usage: Partial<Usage> = {}, overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: 'kiro-fraction', nativeId: 'fixture-native', agent: 'kiro', title: 'Fractional credit fixture',
    projectPath: '/fixture/project', projectName: 'Credit fixture', model: 'fixture-model',
    startedAt: '2026-09-24T01:00:00.000Z', updatedAt: '2026-09-25T02:00:00.000Z',
    status: 'completed', messageCount: 1, toolCallCount: 0,
    usage: { ...emptyUsage(), inputTokens: 100, outputTokens: 20, credits: 0.125, creditsPartial: true, ...usage },
    sourcePath: '/fixture/history.json', bookmarked: false, tags: [], note: '', resumable: true,
    messages: [{ id: 'fixture-message', role: 'user', content: 'Original fixture prompt', timestamp: '2026-09-24T01:00:00.000Z' }],
    ...overrides,
  };
}

export function creditRun(usage: Partial<Usage> = {}): Run {
  return {
    id: 'kiro-run', agent: 'kiro', projectId: 'fixture-project', projectName: 'Credit fixture',
    projectPath: '/fixture/project', title: 'Resumed run fixture', prompt: 'Original run prompt',
    policy: 'read-only', resumeSessionId: 'kiro-fraction', model: 'fixture-model', status: 'completed',
    createdAt: '2026-09-25T02:00:00.000Z', startedAt: '2026-09-25T02:00:01.000Z',
    finishedAt: '2026-09-25T02:00:02.000Z', exitCode: 0, error: null, nativeSessionId: 'fixture-native',
    usage: { ...emptyUsage(), ...usage }, command: 'kiro-cli chat',
  };
}

export function creditAnalytics(overrides: Partial<Analytics> = {}): Analytics {
  const credits = { recordedCredits: 0.125, knownCreditSessions: 2, partialCreditSessions: 1, kiroSessions: 3 };
  const noKiro = { recordedCredits: 0, knownCreditSessions: 0, partialCreditSessions: 0, kiroSessions: 0 };
  return {
    ...credits, totalSessions: 5, totalMessages: 5, totalToolCalls: 0, totalTokens: 360,
    knownTokenSessions: 3, recordedCostUsd: 1.5, knownCostSessions: 2,
    daily: [
      { date: '2026-09-24', sessions: 3, tokens: 120, knownTokenSessions: 1, codex: 0, claude: 0, kiro: 3, ...credits },
      { date: '2026-09-25', sessions: 2, tokens: 240, knownTokenSessions: 2, codex: 1, claude: 1, kiro: 0, ...noKiro },
    ],
    agents: [
      { agent: 'codex', sessions: 1, tokens: 120, knownTokenSessions: 1, costUsd: 1.25, knownCostSessions: 1, ...noKiro },
      { agent: 'claude', sessions: 1, tokens: 120, knownTokenSessions: 1, costUsd: 0.25, knownCostSessions: 1, ...noKiro },
      { agent: 'kiro', sessions: 3, tokens: 120, knownTokenSessions: 1, costUsd: 0, knownCostSessions: 0, ...credits },
    ],
    projects: [{ path: '/fixture/project', name: 'Credit fixture', sessions: 5, tokens: 360, knownTokenSessions: 3, ...credits }],
    models: [{ model: 'fixture-model', sessions: 5, tokens: 360, knownTokenSessions: 3, ...credits }],
    tools: [], cacheReadTokens: 0, inputTokens: 300,
    runOutcomes: { completed: 1, failed: 0, cancelled: 0, interrupted: 0, queued: 0, running: 0 },
    ...overrides,
  };
}

/** Synthetic UI data only; no native history, API calls, or executable fixtures. */
export function creditBootstrap(): Bootstrap & { sessions: SessionDetail[] } {
  const sessions = [
    creditSession(),
    creditSession({ ...emptyUsage(), credits: 0, creditsPartial: false }, { id: 'kiro-zero', title: 'Recorded zero fixture' }),
    creditSession({ ...emptyUsage(), credits: undefined, creditsPartial: undefined }, { id: 'kiro-missing', title: 'Legacy credit fixture' }),
    creditSession({ credits: undefined, creditsPartial: undefined, costUsd: 1.25 }, {
      id: 'codex-tokens', agent: 'codex', title: 'Codex token fixture', startedAt: '2026-09-25T01:00:00.000Z',
    }),
    creditSession({ credits: undefined, creditsPartial: undefined, costUsd: 0.25 }, {
      id: 'claude-tokens', agent: 'claude', title: 'Claude token fixture', startedAt: '2026-09-25T01:00:00.000Z',
    }),
  ];
  return {
    version: '1.2.1', demo: true, sessions, sessionTotal: sessions.length, runs: [creditRun()],
    projects: [{ id: 'fixture-project', path: '/fixture/project', name: 'Credit fixture', color: '#3564e8',
      executionEnabled: false, createdAt: '2026-09-24T01:00:00.000Z' }],
    templates: [], connectors: AGENTS.map(agent => ({
      agent, installed: false, version: null, executable: null, roots: [], existingRoots: [],
      sessionCount: agent === 'kiro' ? 3 : 1, error: null, supportsResume: true, supportsStreaming: true,
    })),
    settings: { concurrency: 2, timeoutMinutes: 30, scanIntervalSeconds: 60,
      sourceRoots: { codex: [], claude: [], kiro: [] }, theme: 'light' },
    analytics: creditAnalytics(), sync: null, syncing: false,
  };
}
