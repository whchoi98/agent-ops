import { expect, test } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyUsage, type CreditTotals } from '../../../shared/types';
import { TokenValue, UsageValue } from '../../components/ui';
import { createI18n, I18nContext } from '../../i18n/I18nProvider';
import { CREDIT_EN_MESSAGES } from '../../i18n/credits.en';
import { AggregateCreditValue, CreditCoverage, CreditValue } from './CreditValue';
import { CreditSummary } from './CreditSummary';
import { DailyCredits } from './DailyCredits';
import { RunUsage } from './RunUsage';
import { creditAnalytics, creditRun } from './testFixtures';

function render(children: ReactNode, language: 'ko' | 'en' = 'en') {
  return renderToStaticMarkup(<I18nContext.Provider value={{ ...createI18n(language), setLanguage: () => {} }}>
    {children}
  </I18nContext.Provider>);
}

function text(html: string) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

test.each([
  { value: 0.125, expected: '0.125 credits' },
  { value: 12.375, expected: '12.375 credits' },
  { value: 0, expected: '0 credits' },
])('Kiro primary usage preserves the recorded value $value with credit units', ({ value, expected }) => {
  const html = render(<UsageValue agent="kiro" usage={{
    ...emptyUsage(), credits: value, inputTokens: 4000, outputTokens: 6000, costUsd: 15,
  }} />);
  expect(text(html)).toBe(expected);
  expect(html).not.toMatch(/tokens|USD|\$/i);
});

test.each([undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY, '1' as unknown as number])(
  'invalid or missing credits %s cannot be inferred from tokens or cost',
  credits => {
    const html = render(<UsageValue agent="kiro" usage={{
      ...emptyUsage(), credits, inputTokens: 20, outputTokens: 30, costUsd: 1,
    }} />);
    expect(text(html)).toBe('Not recorded credits');
    expect(html).not.toMatch(/>0<|NaN|Infinity|\$/);
  },
);

test.each([1e-7, 0.0000000000123, Number.MIN_VALUE])(
  'a positive credit measurement %s never rounds to visible zero and has its exact tooltip',
  credits => {
    const html = render(<CreditValue usage={{ credits }} />);
    expect(text(html)).toMatch(/^[1-9][\d.]*e-\d+ credits$/);
    expect(html).toContain(`Recorded credits: ${String(credits)} credits`);
  },
);

test('rounded compact credits retain all available precision in their tooltip and detail view', () => {
  const usage = { credits: 1234.56789012345 };
  const compact = render(<CreditValue usage={usage} />);
  expect(text(compact)).toBe('1.23K credits');
  expect(compact).toContain('Recorded credits: 1234.56789012345 credits');
  expect(text(render(<CreditValue usage={usage} compact={false} />))).toBe('1234.56789012345 credits');
});

test('large finite credit values remain finite labels rather than zero or overflow', () => {
  const html = render(<CreditValue usage={{ credits: Number.MAX_VALUE }} />);
  expect(text(html)).toBe('1.80e+308 credits');
  expect(html).toContain('1.7976931348623157e+308');
  expect(html).not.toMatch(/Infinity|Total overflow|Not recorded/);
});

test('partial credits have an accessible marker and explain that the numeric value is incomplete', () => {
  const html = render(<CreditValue usage={{ credits: 0, creditsPartial: true }} />);
  expect(text(html)).toBe('0* credits');
  expect(html).toContain('aria-label="Partial record"');
  expect(html).toContain('Only part of the usage was recorded.');
});

test.each(['codex', 'claude'] as const)('primary %s usage remains tokens even if a credit field is present', agent => {
  const html = render(<UsageValue agent={agent} usage={{
    ...emptyUsage(), inputTokens: 100, outputTokens: 20, credits: 9.875,
  }} />);
  expect(text(html)).toBe('120 Tokens');
  expect(html).not.toContain('9.875');
  expect(html).not.toContain('credits');
});

test('explicit raw token details remain token measurements for Kiro records', () => {
  expect(text(render(<TokenValue usage={{
    ...emptyUsage(), inputTokens: 100, outputTokens: 20, credits: 9.875,
  }} compact={false} />))).toBe('120');
});

test('unrecorded aggregate credits do not claim measured zero or fabricate legacy coverage', () => {
  const html = render(<AggregateCreditValue totals={{}} />);
  expect(text(html)).toContain('Not recorded credits');
  expect(text(html)).toContain('Credit recording coverage unknown');
  expect(text(html)).not.toContain('0');
});

test('zero recorded in every Kiro session is a measured zero with complete coverage', () => {
  const html = render(<AggregateCreditValue totals={{
    recordedCredits: 0, knownCreditSessions: 3, kiroSessions: 3, partialCreditSessions: 0,
  }} />);
  expect(text(html)).toContain('0 credits');
  expect(text(html)).toContain('3/3 Kiro sessions recorded');
  expect(html).not.toMatch(/Not recorded|Partial total/);
});

test('a tiny positive credit aggregate stays nonzero and exposes its exact value', () => {
  const html = render(<AggregateCreditValue totals={{
    recordedCredits: 1.23456789e-8, knownCreditSessions: 1, kiroSessions: 1, partialCreditSessions: 0,
  }} />);
  expect(text(html)).toContain('1.23e-8 credits');
  expect(html).toContain('Recorded credits: 1.23456789e-8 credits');
  expect(text(html)).not.toContain('0 credits');
});

test('an empty Kiro group has no observed credits even when its server sum is zero', () => {
  const html = render(<AggregateCreditValue totals={{
    recordedCredits: 0, knownCreditSessions: 0, kiroSessions: 0, partialCreditSessions: 0,
  }} />);
  expect(text(html)).toContain('Not recorded credits');
  expect(text(html)).toContain('No Kiro sessions');
  expect(text(html)).not.toContain('0 credits');
});

test.each([
  { knownCreditSessions: 2, kiroSessions: 3, partialCreditSessions: 0, coverage: '2/3 Kiro sessions recorded' },
  { knownCreditSessions: 3, kiroSessions: 3, partialCreditSessions: 1, coverage: '3/3 Kiro sessions recorded1 partial' },
])('coverage marks an incomplete credit total: $coverage', ({ coverage, ...counts }) => {
  const html = render(<AggregateCreditValue totals={{ recordedCredits: 0.125, ...counts }} />);
  expect(text(html)).toContain('0.125* credits');
  expect(text(html)).toContain(coverage);
  expect(html).toContain('aria-label="Partial total"');
});

test('aggregate overflow retains coverage and cannot become zero through null coalescing', () => {
  const html = render(<AggregateCreditValue totals={{
    recordedCredits: null, knownCreditSessions: 2, kiroSessions: 3, partialCreditSessions: 1,
  }} />);
  expect(text(html)).toContain('Total overflow credits');
  expect(text(html)).toContain('2/3 Kiro sessions recorded1 partial');
  expect(html).toContain('The credit total exceeds the numeric range.');
  expect(text(html)).not.toMatch(/0 credits|Not recorded|Infinity|NaN/);
});

test.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, -1])(
  'an absent or invalid aggregate %s stays unknown even when recorded-session counts exist',
  recordedCredits => {
    const html = render(<AggregateCreditValue totals={{ recordedCredits, knownCreditSessions: 2, kiroSessions: 3 }} />);
    expect(text(html)).toContain('Not recorded credits');
    expect(text(html)).toContain('2/3 Kiro sessions recorded');
    expect(html).not.toMatch(/>0<|Infinity|NaN/);
  },
);

test('a null total with no known records is unrecorded rather than numeric overflow', () => {
  const html = render(<AggregateCreditValue totals={{ recordedCredits: null, knownCreditSessions: 0, kiroSessions: 3 }} />);
  expect(text(html)).toContain('Not recorded credits');
  expect(text(html)).toContain('0/3 Kiro sessions recorded');
  expect(html).not.toContain('Total overflow');
});

test('hiding inline coverage does not erase partial-total semantics', () => {
  const html = render(<AggregateCreditValue showCoverage={false} totals={{
    recordedCredits: 1.25, knownCreditSessions: 2, kiroSessions: 3,
  }} />);
  expect(text(html)).toBe('1.25* credits');
  expect(html).toContain('Partial total');
  expect(html).not.toContain('2/3');
});

test('daily credit presentation keeps server session-start dates and the selected period', () => {
  const daily = creditAnalytics().daily;
  const html = render(<DailyCredits daily={[daily[1], daily[0]]} days={1} />);
  expect(text(html)).toContain('Session start date (UTC)');
  expect(text(html)).toContain('including sessions that span several days.');
  expect(html).toContain('2026-09-25');
  expect(html).not.toContain('2026-09-24');
  expect(text(html)).toContain('Not recorded credits');
  expect(text(html)).toContain('No Kiro sessions');
  const bothDays = render(<DailyCredits daily={daily} days={2} />);
  expect(bothDays).toMatch(/2026-09-24[\s\S]*0\.125[\s\S]*2026-09-25/);
  expect(text(bothDays)).toContain('2/3 Kiro sessions recorded');
});

test('daily presentation distinguishes an empty report from recorded zero days', () => {
  const html = render(<DailyCredits daily={[]} />);
  expect(text(html)).toContain('No daily credit records.');
  expect(html).not.toContain('<table');
});

test('the run usage explanation does not substitute raw tokens for missing Kiro credits', () => {
  const html = render(<RunUsage run={creditRun({ inputTokens: 100, outputTokens: 20 })} />);
  expect(text(html)).toContain('Not recorded credits');
  expect(text(html)).toContain('Only credits recorded for this run are shown.');
  expect(text(html)).not.toContain('120');
});

test('recorded run zero does not receive the missing-output explanation', () => {
  const html = render(<RunUsage run={creditRun({ credits: 0 })} />);
  expect(text(html)).toContain('0 credits');
  expect(html).not.toContain('Plain CLI output');
});

test('all new credit states render English while Korean remains available', () => {
  const totals: CreditTotals = { recordedCredits: 0.125, knownCreditSessions: 2, kiroSessions: 3, partialCreditSessions: 1 };
  const components = <>
    <CreditSummary totals={totals} />
    <AggregateCreditValue totals={{ ...totals, recordedCredits: null }} />
    <AggregateCreditValue totals={{}} />
    <CreditCoverage totals={{ knownCreditSessions: 2 }} />
    <CreditValue usage={{ credits: 0.125, creditsPartial: true }} />
    <CreditValue usage={{}} />
    <DailyCredits daily={creditAnalytics().daily} />
    <DailyCredits daily={[]} />
    <RunUsage run={creditRun()} />
  </>;
  const english = render(components);
  expect(english).not.toMatch(/[가-힣]|\{\w+\}|\[object Object\]/u);
  expect(text(english)).toContain('Recorded Kiro credits');
  expect(text(english)).toContain('2/3 Kiro sessions recorded');
  const korean = render(components, 'ko');
  expect(text(korean)).toContain('기록된 Kiro 크레딧');
  expect(text(korean)).toContain('2/3개 Kiro 세션 기록');
  expect(text(korean)).toContain('합계 범위 초과');
});

test('the exported English dictionary preserves interpolation fields and excludes new middle dots and em dashes', () => {
  for (const [source, target] of Object.entries(CREDIT_EN_MESSAGES)) {
    expect(target).not.toMatch(/[가-힣]/u);
    expect([source, target].join(' ')).not.toMatch(/[·—]/u);
    expect(target.match(/\{\w+\}/g)?.sort() ?? []).toEqual(source.match(/\{\w+\}/g)?.sort() ?? []);
  }
});
