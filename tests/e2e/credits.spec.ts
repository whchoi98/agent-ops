import { expect, test, type Page } from '@playwright/test';
import type { SessionDetail } from '../../shared/types';
import { creditBootstrap } from '../../src/features/usage/testFixtures';

/** Every data request stays inside this controlled fixture, including the event stream. */
async function installCreditFixture(page: Page, data = creditBootstrap(), language: 'ko' | 'en' = 'en') {
  const mutations: string[] = [];
  await page.addInitScript(language => {
    localStorage.setItem('agent-ops-language', language);
    class FixtureEventSource extends EventTarget {
      readonly withCredentials = false;
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(readonly url: string) {
        super();
        queueMicrotask(() => {
          if (this.readyState !== 1) return;
          const event = new Event('open');
          this.onopen?.(event);
          this.dispatchEvent(event);
        });
      }
      close() { this.readyState = 2; }
    }
    Object.defineProperty(window, 'EventSource', { value: FixtureEventSource, configurable: true });
  }, language);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      mutations.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 405, json: { error: 'This fixture does not permit mutations.' } });
    }
    if (url.pathname === '/api/bootstrap') return route.fulfill({ json: data });
    if (url.pathname === '/api/sessions') {
      const agent = url.searchParams.get('agent');
      const items = data.sessions.filter(session => !agent || session.agent === agent);
      return route.fulfill({ json: { items, total: items.length } });
    }
    const sessionMatch = /^\/api\/sessions\/([^/]+)(\/messages)?$/.exec(url.pathname);
    if (sessionMatch) {
      const session = data.sessions.find(item => item.id === decodeURIComponent(sessionMatch[1])) as SessionDetail | undefined;
      if (!session) return route.fulfill({ status: 404, json: { error: 'Unknown fixture session.' } });
      if (!sessionMatch[2]) return route.fulfill({ json: { ...session, messages: [] } });
      return route.fulfill({ json: {
        items: session.messages, total: session.messages.length, offset: 0, limit: 50,
        roleCounts: { all: session.messages.length, user: session.messages.length, assistant: 0, tool: 0, system: 0 },
      } });
    }
    const runMatch = /^\/api\/runs\/([^/]+)(\/events)?$/.exec(url.pathname);
    if (runMatch) {
      const run = data.runs.find(item => item.id === decodeURIComponent(runMatch[1]));
      if (!run) return route.fulfill({ status: 404, json: { error: 'Unknown fixture run.' } });
      return route.fulfill({ json: { run, events: [] } });
    }
    return route.fulfill({ status: 404, json: { error: 'This fixture does not provide that endpoint.' } });
  });
  return { data, mutations };
}

function sessionRow(page: Page, title: string) {
  return page.locator('.session-table tbody tr').filter({ has: page.locator('.session-cell-text > strong', { hasText: title }) });
}

test('session credits keep decimals, zero and missing distinct across the language switch and raw details', async ({ page }) => {
  const data = creditBootstrap();
  data.sessions[0].title = '크레딧 원문';
  data.sessions[0].messages[0].content = '기록된 원문을 그대로 유지합니다.';
  const fixture = await installCreditFixture(page, data, 'ko');
  await page.goto('/#/sessions');
  const fractional = sessionRow(page, '크레딧 원문');
  await expect(fractional.locator('td.session-usage-cell')).toContainText('0.125');
  await expect(fractional.locator('td.session-usage-cell')).toContainText('credits');
  await expect(fractional.locator('td.session-usage-cell .partial-indicator')).toHaveAttribute('aria-label', '부분 기록');
  await expect(sessionRow(page, 'Recorded zero fixture').locator('td.session-usage-cell')).toHaveText('0 credits');
  await expect(sessionRow(page, 'Legacy credit fixture').locator('td.session-usage-cell')).toHaveText('미기록 credits');
  await page.getByRole('button', { name: '영어로 전환', exact: true }).click();
  await expect(fractional.locator('.session-cell-text > strong')).toHaveText('크레딧 원문');
  await expect(sessionRow(page, 'Legacy credit fixture').locator('td.session-usage-cell')).toHaveText('Not recorded credits');
  await expect(sessionRow(page, 'Codex token fixture').locator('td.session-usage-cell')).toHaveText('120 Tokens');
  await expect(sessionRow(page, 'Claude token fixture').locator('td.session-usage-cell')).toHaveText('120 Tokens');
  await fractional.locator('.session-open').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.session-summary-strip .credit-value')).toContainText('0.125');
  await expect(dialog.locator('article.conversation-message')).toContainText('기록된 원문을 그대로 유지합니다.');
  await dialog.getByRole('tab', { name: 'Session information', exact: true }).click();
  const credit = dialog.locator('.info-metrics > div').filter({ has: page.locator('dt', { hasText: 'Recorded Kiro credits' }) });
  await expect(credit).toContainText('0.125');
  await expect(dialog.locator('.info-metrics > div').filter({ has: page.locator('dt', { hasText: 'Total tokens' }) })).toContainText('120');
  await expect(dialog.locator('.info-metrics > div').filter({ has: page.locator('dt', { hasText: 'Recorded cost' }) })).toContainText('Not recorded');
  expect(fixture.mutations).toEqual([]);
});

test('credit sort reaches the sessions API and comparisons keep credit and token rows distinct', async ({ page }) => {
  await installCreditFixture(page);
  await page.goto('/#/sessions');
  const sorted = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/api/sessions' && url.searchParams.get('sort') === 'credits';
  });
  await page.getByRole('combobox', { name: 'Session sort order', exact: true }).selectOption('credits');
  await sorted;
  await expect(page).toHaveURL(/sort=credits/);
  await sessionRow(page, 'Fractional credit fixture').getByRole('checkbox').check();
  await sessionRow(page, 'Codex token fixture').getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Compare sessions', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const credit = dialog.locator('.comparison-table tbody tr').filter({ has: page.locator('th', { hasText: /^Recorded Kiro credits$/ }) });
  await expect(credit.getByRole('cell').nth(0)).toContainText('0.125');
  await expect(credit.getByRole('cell').nth(1)).toHaveText('Not applicable');
  const tokens = dialog.locator('.comparison-table tbody tr').filter({ has: page.locator('th', { hasText: /^Total tokens$/ }) });
  await expect(tokens.getByRole('cell').nth(0)).toHaveText('120');
  await expect(tokens.getByRole('cell').nth(1)).toHaveText('120');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Session sort order', exact: true })).toHaveValue('credits');
});

test('overview, analytics, daily groups and projects expose independent Kiro coverage', async ({ page }) => {
  await installCreditFixture(page);
  await page.goto('/#/overview');
  await expect(page.locator('.credit-summary')).toContainText('0.125');
  await expect(page.locator('.credit-summary')).toContainText('2/3 Kiro sessions recorded');
  await expect(page.locator('.credit-summary')).toContainText('1 partial');
  await expect(page.locator('.stats-grid')).toContainText('Recorded tokens');
  await expect(page.locator('.stats-grid')).toContainText('$1.50');
  await page.locator('aside.sidebar a[href="#/analytics"]').click();
  await expect(page.locator('.credit-summary')).toContainText('2/3 Kiro sessions recorded');
  await expect(page.locator('.provider-credit-table tbody tr').filter({ hasText: 'Kiro CLI' })).toContainText('0.125');
  await expect(page.locator('.breakdown-credits')).toHaveCount(2);
  for (const breakdown of await page.locator('.breakdown-credits').all()) {
    await expect(breakdown).toContainText('2/3 Kiro sessions recorded');
    await expect(breakdown).toContainText('0.125');
  }
  await page.locator('.daily-credits > summary').click();
  await expect(page.locator('.daily-credits')).toContainText('Session start date (UTC)');
  await expect(page.locator('.daily-credits tbody tr').filter({ hasText: '2026-09-24' })).toContainText('0.125');
  await expect(page.locator('.daily-credits tbody tr').filter({ hasText: '2026-09-25' })).toContainText('No Kiro sessions');
  await page.locator('aside.sidebar a[href="#/projects"]').click();
  await expect(page.locator('.project-credit-summary')).toContainText('2/3 Kiro sessions recorded');
  await expect(page.locator('.project-card-metrics')).toContainText('360');
});

test('numeric overflow and legacy aggregate fields stay separate from recorded zero', async ({ page }) => {
  const data = creditBootstrap();
  data.analytics.recordedCredits = null;
  await installCreditFixture(page, data);
  await page.goto('/#/analytics');
  await expect(page.locator('.credit-summary')).toContainText('Total overflow');
  await expect(page.locator('.credit-summary')).toContainText('2/3 Kiro sessions recorded');
  await expect(page.locator('.credit-summary')).not.toContainText('0 credits');
  delete data.analytics.recordedCredits;
  delete data.analytics.knownCreditSessions;
  delete data.analytics.partialCreditSessions;
  delete data.analytics.kiroSessions;
  await page.reload();
  await expect(page.locator('.credit-summary')).toContainText('Not recorded credits');
  await expect(page.locator('.credit-summary')).toContainText('Credit recording coverage unknown');
  await expect(page.locator('.credit-summary')).not.toContainText('0 credits');
});

test('run cards, list and detail use only run credits and keep recorded raw tokens and cost', async ({ page }) => {
  const data = creditBootstrap();
  data.sessions[0].usage.credits = 987.625;
  data.runs[0].usage = { ...data.runs[0].usage, inputTokens: 100, outputTokens: 20, costUsd: 0.25 };
  const fixture = await installCreditFixture(page, data);
  await page.goto('/#/runs');
  await expect(page.locator('.run-card-usage')).toHaveText('Not recorded credits');
  await expect(page.locator('main')).not.toContainText('987.625');
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expect(page.locator('.usage-run-table .credit-value')).toHaveText('Not recorded credits');
  await page.locator('.usage-run-table .table-title-button').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.run-recorded-usage')).toContainText('Not recorded credits');
  await expect(dialog.locator('.run-recorded-usage')).toContainText('Only credits recorded for this run are shown.');
  await dialog.locator('.run-request-details > summary').click();
  await expect(dialog.locator('.detail-properties > div').filter({ has: page.locator('dt', { hasText: 'Total tokens' }) })).toContainText('120');
  await expect(dialog.locator('.detail-properties > div').filter({ has: page.locator('dt', { hasText: 'Recorded cost' }) })).toContainText('$0.25');
  await expect(dialog.locator('.run-prompt')).toContainText('Original run prompt');
  await expect(dialog).not.toContainText('987.625');
  expect(fixture.mutations).toEqual([]);
});

test('tiny credits and both languages fit the existing phone layouts', async ({ page }) => {
  const data = creditBootstrap();
  data.sessions[0].usage.credits = 1e-7;
  data.settings.theme = 'dark';
  await installCreditFixture(page, data);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/sessions');
  const usage = sessionRow(page, 'Fractional credit fixture').locator('.session-mobile-meta .credit-value');
  await expect(usage).toBeVisible();
  await expect(usage).toContainText('1.00e-7');
  await expect(usage).toHaveAttribute('title', /Recorded credits: 1e-7 credits/);
  await expect(usage).not.toHaveText('0 credits');
  await page.getByRole('button', { name: 'Switch to Korean', exact: true }).click();
  await expect(usage).toContainText('1.00e-7');
  for (const language of ['ko', 'en'] as const) {
    if (language === 'en') await page.getByRole('button', { name: '영어로 전환', exact: true }).click();
    for (const [route, korean, english] of [
      ['overview', '워크스페이스 개요', 'Workspace overview'], ['analytics', '사용량 분석', 'Usage analytics'],
      ['projects', '프로젝트', 'Projects'], ['runs', '실행 보드', 'Run board'],
    ]) {
      await page.goto(`/#/${route}`);
      await expect(page.locator('main h1')).toHaveText(language === 'ko' ? korean : english);
      if (route === 'analytics') await page.locator('.daily-credits > summary').click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
});
