import { describe, expect, it } from 'vitest';
import { computeAnalytics } from '../server/analytics.js';
import { emptyUsage, type Agent, type Session } from '../shared/types.js';

function session(id: string, agent: Agent, credits?: number | null, partial = false): Session {
  return {
    id, nativeId: id, agent, title: id, projectPath: '/fixture/project', projectName: 'Fixture',
    model: 'fixture-model', startedAt: '2026-09-24T10:00:00Z', updatedAt: '2026-09-25T10:00:00Z',
    status: 'completed', messageCount: 2, toolCallCount: 0, sourcePath: '/fixture/history',
    bookmarked: false, tags: [], note: '',
    usage: { ...emptyUsage(), credits, creditsPartial: partial },
  };
}

describe('independent recorded credit analytics', () => {
  it('tracks Kiro credits, missing records and partial coverage independently of tokens and USD', () => {
    const codex = session('codex', 'codex', 99);
    codex.usage.inputTokens = 10; codex.usage.outputTokens = 2; codex.usage.costUsd = 0.04;
    const result = computeAnalytics([
      session('partial', 'kiro', 0.25, true), session('zero', 'kiro', 0),
      session('missing', 'kiro'), codex,
    ], [], [], new Date('2026-09-25T12:00:00Z'));
    const expected = { recordedCredits: 0.25, knownCreditSessions: 2, partialCreditSessions: 1, kiroSessions: 3 };
    expect(result).toMatchObject({ ...expected, totalTokens: 12, recordedCostUsd: 0.04 });
    expect(result.agents.find(item => item.agent === 'kiro')).toMatchObject(expected);
    expect(result.agents.find(item => item.agent === 'codex')).toMatchObject({
      recordedCredits: 0, knownCreditSessions: 0, partialCreditSessions: 0, kiroSessions: 0,
    });
    expect(result.models[0]).toMatchObject(expected);
    expect(result.projects[0]).toMatchObject(expected);
    expect(result.daily.find(day => day.date === '2026-09-24')).toMatchObject(expected);
    expect(result.daily.find(day => day.date === '2026-09-25')).toMatchObject({ recordedCredits: 0, knownCreditSessions: 0 });
  });

  it('distinguishes an empty recorded sum from a recorded zero using coverage', () => {
    const missing = computeAnalytics([session('missing', 'kiro')], [], []);
    expect(missing).toMatchObject({ recordedCredits: 0, knownCreditSessions: 0, kiroSessions: 1 });
    const zero = computeAnalytics([session('zero', 'kiro', 0)], [], []);
    expect(zero).toMatchObject({ recordedCredits: 0, knownCreditSessions: 1, kiroSessions: 1 });
  });

  it('treats invalid persisted amounts as unrecorded', () => {
    const result = computeAnalytics([
      session('negative', 'kiro', -1), session('nan', 'kiro', Number.NaN),
      session('infinity', 'kiro', Number.POSITIVE_INFINITY),
    ], [], []);
    expect(result).toMatchObject({ recordedCredits: 0, knownCreditSessions: 0, kiroSessions: 3 });
  });

  it('reports aggregate overflow as unknown instead of recovering a fabricated smaller sum', () => {
    const result = computeAnalytics([
      session('first', 'kiro', Number.MAX_VALUE), session('second', 'kiro', Number.MAX_VALUE),
      session('third', 'kiro', 1),
    ], [], []);
    expect(result).toMatchObject({ recordedCredits: null, knownCreditSessions: 3, kiroSessions: 3 });
    expect(result.models[0].recordedCredits).toBeNull();
    expect(result.projects[0].recordedCredits).toBeNull();
  });
});
