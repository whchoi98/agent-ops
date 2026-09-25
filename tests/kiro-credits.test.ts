import { describe, expect, it } from 'vitest';
import { parseKiroRecords } from '../server/providers/kiro.js';

const context = { sourcePath: '/fixture/credit.json', fallbackTimestamp: '2026-09-25T00:00:00Z' };
const credit = (value: unknown, unit = 'credit') => ({ value, unit, unitPlural: 'credits' });
const turn = (id: number, metering?: unknown, extra: Record<string, unknown> = {}) => ({
  loop_id: { agent_id: 'fixture', rand: id },
  message_ids: [`u-${id}`, `a-${id}`],
  end_timestamp: '2026-09-25T00:00:01Z',
  ...(metering === undefined ? {} : { metering_usage: metering }),
  ...extra,
});
const metadata = (turns: unknown[]) => ({
  session_id: 'credit-fixture',
  session_state: { conversation_metadata: { user_turn_metadatas: turns } },
});
function documents(...snapshots: unknown[]) {
  return parseKiroRecords([
    ...snapshots,
    { kind: 'Prompt', data: { message_id: 'u-1', content: 'A recorded prompt' } },
    { kind: 'AssistantMessage', data: { message_id: 'a-1', content: 'A recorded response' } },
  ], context);
}
function parse(...snapshots: unknown[][]) { return documents(...snapshots.map(metadata)); }

describe('recorded Kiro credits', () => {
  it('sums separate fractional metering records and preserves the token and USD fields', () => {
    const result = parse([turn(1, [credit(0.1), credit(0.2)], { input_token_count: 0, output_token_count: 0 })]);
    expect(result.session?.usage.credits).toBeCloseTo(0.3, 12);
    expect(result.session?.usage).toMatchObject({
      inputTokens: 0, outputTokens: 0, costUsd: null, creditsPartial: false,
    });
  });

  it('keeps equal-valued metering entries as distinct records', () => {
    expect(parse([turn(1, [credit(0.25), credit(0.25)])]).session?.usage.credits).toBe(0.5);
  });

  it('preserves recorded zero instead of treating it as missing', () => {
    expect(parse([turn(1, [credit(0)])]).session?.usage).toMatchObject({ credits: 0, creditsPartial: false });
  });

  it.each([undefined, [], [credit(30, 'token')], [{ value: 30, unitPlural: 'credits' }]].map(metering => ({ metering })))(
    'does not infer credit from absent or different units: $metering', ({ metering }) => {
      expect(parse([turn(1, metering, { input_token_count: 100, cost_usd: 4 })]).session?.usage.credits).toBeNull();
    },
  );

  it('does not accumulate repeated snapshots of the same turn', () => {
    const snapshot = [turn(1, [credit(0.25), credit(0.5)])];
    expect(parse(snapshot, snapshot).session?.usage.credits).toBe(0.75);
  });

  it('deduplicates the same loop identity when object keys are reordered', () => {
    const first = turn(1, [credit(0.4)]);
    const second = turn(1, [credit(0.4)], { loop_id: { rand: 1, agent_id: 'fixture' } });
    expect(parse([first], [second]).session?.usage.credits).toBe(0.4);
  });

  it('does not confuse object loop identities with array-shaped identities', () => {
    expect(parse([
      turn(1, [credit(0.25)]),
      turn(2, [credit(0.5)], { loop_id: [['agent_id', 'fixture'], ['rand', 1]] }),
    ]).session?.usage.credits).toBe(0.75);
  });

  it('falls back to message identities when a numeric loop ID cannot retain integer precision', () => {
    const loop_id = { agent_id: 'fixture', rand: Number.MAX_SAFE_INTEGER + 1 };
    expect(parse([
      turn(1, [credit(0.25)], { loop_id }),
      turn(2, [credit(0.5)], { loop_id }),
    ]).session?.usage.credits).toBe(0.75);
  });

  it('replaces a fallback snapshot when its message list grows', () => {
    const loop_id = { agent_id: 'fixture', rand: Number.MAX_SAFE_INTEGER + 1 };
    expect(parse(
      [turn(1, [credit(0.25)], { loop_id, message_ids: ['u1', 'a1'] })],
      [turn(1, [credit(0.5)], { loop_id, message_ids: ['u1', 'a1', 'a2'] })],
    ).session?.usage.credits).toBe(0.5);
  });

  it('reconciles a fallback identity when a later snapshot gains a valid loop ID', () => {
    expect(parse(
      [turn(1, [credit(0.25)], { loop_id: undefined })],
      [turn(1, [credit(0.5)])],
    ).session?.usage.credits).toBe(0.5);
  });

  it('recognizes a later fallback snapshot of an already identified loop', () => {
    expect(parse(
      [turn(1, [credit(0.25)])],
      [turn(1, [credit(0.5)], { loop_id: undefined, message_ids: ['u-1', 'a-1', 'a-2'] })],
    ).session?.usage.credits).toBe(0.5);
  });

  it('does not add unidentifiable metering to a later identified snapshot as a complete total', () => {
    const result = parse(
      [turn(1, [credit(0.25)], { loop_id: undefined, message_ids: [] })],
      [turn(1, [credit(0.5)])],
    );
    expect(result.session?.usage).toMatchObject({ credits: 0.5, creditsPartial: true });
    expect(result.warnings.some(message => /credit/i.test(message))).toBe(true);
  });

  it('does not merge distinct valid loops that share a message reference', () => {
    expect(parse([
      turn(1, [credit(0.25)], { message_ids: ['shared', 'a1'] }),
      turn(2, [credit(0.5)], { message_ids: ['shared', 'a2'] }),
    ]).session?.usage.credits).toBe(0.75);
  });

  it.each([[0, 1, 2], [0, 2, 1], [2, 1, 0]].map(order => ({ order })))('reconciles a fallback when an existing loop later links its messages, order $order', ({ order }) => {
    const snapshots = [
      { ...metadata([turn(1, [credit(0.25)], { loop_id: undefined, message_ids: ['m1'] })]), updated_at: '2026-09-25T00:00:01Z' },
      { ...metadata([turn(1, [credit(0.5)], { message_ids: ['m2'] })]), updated_at: '2026-09-25T00:00:02Z' },
      { ...metadata([turn(1, [credit(0.75)], { message_ids: ['m1', 'm2'] })]), updated_at: '2026-09-25T00:00:03Z' },
    ];
    expect(documents(...order.map(index => snapshots[index])).session?.usage)
      .toMatchObject({ credits: 0.75, creditsPartial: false });
  });

  it.each([[0, 1, 2], [1, 2, 0], [2, 0, 1]].map(order => ({ order })))('rejects provisional credit attribution when a shared identity becomes ambiguous, order $order', ({ order }) => {
    const snapshots = [
      { ...metadata([turn(1, [credit(0.5)], { loop_id: undefined, message_ids: ['shared'] })]), updated_at: '2026-09-25T00:00:03Z' },
      { ...metadata([turn(1, [credit(0.25)], { message_ids: ['shared'] })]), updated_at: '2026-09-25T00:00:01Z' },
      { ...metadata([turn(2, [credit(0.75)], { message_ids: ['shared'] })]), updated_at: '2026-09-25T00:00:04Z' },
    ];
    const result = documents(...order.map(index => snapshots[index]));
    expect(result.session?.usage.credits).toBeNull();
    expect(result.warnings.some(message => /ambiguous/i.test(message))).toBe(true);
  });

  it('uses the metadata envelope revision to reject stale corrections of an ended turn', () => {
    expect(documents(
      { ...metadata([turn(1, [credit(0.5)])]), updated_at: '2026-09-25T00:00:03Z' },
      { ...metadata([turn(1, [credit(0.8)])]), updated_at: '2026-09-25T00:00:02Z' },
    ).session?.usage.credits).toBe(0.5);
  });

  it('accepts a newer envelope correction without requiring the ended turn timestamp to change', () => {
    expect(documents(
      { ...metadata([turn(1, [credit(0.8)])]), updatedAt: '2026-09-25T00:00:02Z' },
      { ...metadata([turn(1, [credit(0.5)])]), updatedAt: '2026-09-25T00:00:03Z' },
    ).session?.usage.credits).toBe(0.5);
  });

  it('uses the newer snapshot even when it corrects the amount downward', () => {
    expect(parse(
      [turn(1, [credit(0.8)])],
      [turn(1, [credit(0.5)], { end_timestamp: '2026-09-25T00:00:02Z' })],
    ).session?.usage.credits).toBe(0.5);
  });

  it('does not replace a newer turn snapshot with an older one', () => {
    expect(parse(
      [turn(1, [credit(0.5)], { end_timestamp: '2026-09-25T00:00:02Z' })],
      [turn(1, [credit(0.8)])],
    ).session?.usage.credits).toBe(0.5);
  });

  it('keeps the more complete snapshot when timestamps match', () => {
    expect(parse(
      [turn(1, [credit(0.2), credit(0.4)])],
      [turn(1, [credit(0.2)])],
    ).session?.usage.credits).toBeCloseTo(0.6, 12);
  });

  it.each([-1, '0.5', null, Number.NaN, Number.POSITIVE_INFINITY])(
    'marks a known partial sum when a credit value is invalid: %j', value => {
      const result = parse([turn(1, [credit(0.25), credit(value)])]);
      expect(result.session?.usage).toMatchObject({ credits: 0.25, creditsPartial: true });
      expect(result.warnings.some(message => /credit/i.test(message))).toBe(true);
    },
  );

  it('marks coverage as partial when another turn has no credit record', () => {
    expect(parse([turn(1, [credit(0.5)]), turn(2)]).session?.usage)
      .toMatchObject({ credits: 0.5, creditsPartial: true });
  });

  it('keeps turns without loop IDs distinct and repeatable using message identities', () => {
    const turns = [
      turn(1, [credit(0.25)], { loop_id: undefined }),
      turn(2, [credit(0.5)], { loop_id: undefined }),
    ];
    expect(parse(turns, turns).session?.usage.credits).toBe(0.75);
  });

  it('returns unknown instead of infinity when the credit sum overflows', () => {
    const result = parse([turn(1, [credit(Number.MAX_VALUE), credit(Number.MAX_VALUE)])]);
    expect(result.session?.usage.credits).toBeNull();
    expect(result.warnings.some(message => /credit/i.test(message))).toBe(true);
  });

  it('bounds turn retention and does not publish a truncated total as complete', () => {
    const result = parse(Array.from({ length: 20_001 }, (_, i) => turn(i, [credit(0.1)])));
    expect(result.session?.usage.credits).toBeNull();
    expect(result.warnings.some(message => /credit/i.test(message))).toBe(true);
  });

  it('continues to reject metadata without a readable companion transcript', () => {
    const result = parseKiroRecords([metadata([turn(1, [credit(0.5)])])], context);
    expect(result.session).toBeNull();
  });
});
