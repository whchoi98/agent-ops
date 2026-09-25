import { AGENTS, type Analytics, type CreditTotals, type Run, type Session, type Usage } from '../shared/types.js';
import { creditValue } from '../shared/credits.js';

export const totalTokens = (usage: Usage) => (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
export const knownTokens = (usage: Usage) => usage.inputTokens !== null || usage.outputTokens !== null;

const emptyCredits = (): Required<CreditTotals> => ({
  recordedCredits: 0, knownCreditSessions: 0, partialCreditSessions: 0, kiroSessions: 0,
});

function addCredits(target: CreditTotals, session: Session) {
  if (session.agent !== 'kiro') return;
  target.kiroSessions = (target.kiroSessions ?? 0) + 1;
  const amount = creditValue(session.usage);
  if (amount === null) return;
  target.knownCreditSessions = (target.knownCreditSessions ?? 0) + 1;
  target.partialCreditSessions = (target.partialCreditSessions ?? 0) + Number(session.usage.creditsPartial === true);
  if (target.recordedCredits !== null) {
    const total = (target.recordedCredits ?? 0) + amount;
    target.recordedCredits = Number.isFinite(total) ? total : null;
  }
}

export function computeAnalytics(
  sessions: Session[], runs: Run[], tools: Array<{ name: string; count: number }>,
  now = new Date(),
): Analytics {
  const daily = Array.from({ length: 30 }, (_, i) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - (29 - i));
    return { date: date.toISOString().slice(0, 10), sessions: 0, tokens: 0, knownTokenSessions: 0, codex: 0, claude: 0, kiro: 0, ...emptyCredits() };
  });
  const days = new Map(daily.map((day) => [day.date, day]));
  const models = new Map<string, Analytics['models'][number]>();
  const projects = new Map<string, Analytics['projects'][number]>();
  const agents = AGENTS.map((agent) => ({ agent, sessions: 0, tokens: 0, knownTokenSessions: 0, costUsd: 0, knownCostSessions: 0, ...emptyCredits() }));
  const result: Analytics = {
    totalSessions: sessions.length, totalMessages: 0, totalToolCalls: 0, totalTokens: 0,
    knownTokenSessions: 0, recordedCostUsd: 0, knownCostSessions: 0, daily, agents,
    models: [], projects: [], tools, cacheReadTokens: 0, inputTokens: 0,
    runOutcomes: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 },
    ...emptyCredits(),
  };
  for (const session of sessions) {
    const tokens = totalTokens(session.usage);
    const known = Number(knownTokens(session.usage));
    result.totalMessages += session.messageCount;
    result.totalToolCalls += session.toolCallCount;
    result.totalTokens += tokens;
    result.knownTokenSessions += known;
    result.knownCostSessions += Number(session.usage.costUsd !== null);
    result.recordedCostUsd += session.usage.costUsd ?? 0;
    result.cacheReadTokens += session.usage.cacheReadTokens ?? 0;
    result.inputTokens += session.usage.inputTokens ?? 0;
    addCredits(result, session);
    const day = days.get(session.startedAt.slice(0, 10));
    if (day) { day.sessions++; day[session.agent]++; day.tokens += tokens; day.knownTokenSessions += known; addCredits(day, session); }
    const agent = agents.find((a) => a.agent === session.agent)!;
    agent.sessions++;
    agent.tokens += tokens;
    agent.knownTokenSessions += known;
    agent.costUsd += session.usage.costUsd ?? 0;
    agent.knownCostSessions += Number(session.usage.costUsd !== null);
    addCredits(agent, session);
    const modelName = session.model || 'Unknown';
    const model = models.get(modelName) || { model: modelName, sessions: 0, tokens: 0, knownTokenSessions: 0, ...emptyCredits() };
    model.sessions++; model.tokens += tokens; model.knownTokenSessions += known; addCredits(model, session); models.set(modelName, model);
    const project = projects.get(session.projectPath) || { path: session.projectPath, name: session.projectName || 'Unknown', sessions: 0, tokens: 0, knownTokenSessions: 0, ...emptyCredits() };
    project.sessions++; project.tokens += tokens; project.knownTokenSessions += known; addCredits(project, session); projects.set(session.projectPath, project);
  }
  for (const run of runs) result.runOutcomes[run.status]++;
  result.models = [...models.values()].sort((a, b) => b.tokens - a.tokens);
  result.projects = [...projects.values()].sort((a, b) => b.sessions - a.sessions);
  return result;
}
