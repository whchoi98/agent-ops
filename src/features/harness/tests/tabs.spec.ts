import { expect, test } from '@playwright/test';
import { harnessBrowserApi } from './browser-api';
import { harnessProject } from '../testFixtures';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('agent-ops-language', 'en'));
});

test('tabs expose one task at a time and support roving focus, arrows, Home and End in both languages', async ({ page }) => {
  await harnessBrowserApi(page);
  await page.goto('/__harness');
  const english = ['Engine', 'Policies', 'Decision test', 'Hooks', 'Audit'];
  const korean = ['엔진', '정책', '판정 테스트', '훅', '감사 기록'];
  const tabs = page.getByRole('tablist', { name: 'Harness sections', exact: true });
  await expect(tabs.getByRole('tab')).toHaveText(english);
  await expect(page.getByRole('tab', { name: 'Engine', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await expect(page.getByRole('tabpanel', { name: 'Engine', exact: true })).toBeVisible();
  await expect(page.locator('[role="tabpanel"]')).toHaveCount(5);
  await expect(page.getByRole('heading', { name: 'Harness management', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Harness project', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Engine', exact: true }).focus();
  for (const [key, label] of [
    ['ArrowRight', 'Policies'], ['End', 'Audit'], ['ArrowRight', 'Engine'],
    ['ArrowLeft', 'Audit'], ['Home', 'Engine'],
  ]) {
    await page.keyboard.press(key);
    const active = page.getByRole('tab', { name: label, exact: true });
    await expect(active).toBeFocused();
    await expect(active).toHaveAttribute('aria-selected', 'true');
    await expect(active).toHaveAttribute('tabindex', '0');
    await expect(page.getByRole('tabpanel', { name: label, exact: true })).toBeVisible();
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
  }
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tabpanel', { name: 'Engine', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('tab', { name: 'Engine', exact: true })).toBeFocused();
  for (const label of english) {
    const tab = page.getByRole('tab', { name: label, exact: true });
    await tab.click();
    const panel = page.getByRole('tabpanel', { name: label, exact: true });
    expect(await panel.getAttribute('id')).toBe(await tab.getAttribute('aria-controls'));
    expect(await panel.getAttribute('aria-labelledby')).toBe(await tab.getAttribute('id'));
    await expect(page.getByRole('combobox', { name: 'Harness project', exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Switch to Korean' }).click();
  await expect(page.getByRole('tablist', { name: '하니스 관리 구역', exact: true }).getByRole('tab')).toHaveText(korean);
  await expect(page.getByRole('tab', { name: '감사 기록', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: '감사 기록', exact: true }).press('Home');
  await expect(page.getByRole('tabpanel', { name: '엔진', exact: true })).toBeVisible();
});

test('tab changes preserve Python edits, policy drafts, decision input and audit filters without new requests', async ({ page }) => {
  const api = await harnessBrowserApi(page);
  await page.goto('/__harness');
  await page.getByRole('combobox', { name: 'Harness project', exact: true }).selectOption(harnessProject.id);
  await page.getByLabel('Python interpreter path', { exact: true }).fill('/opt/unsaved/python3');
  await page.getByRole('tab', { name: 'Policies', exact: true }).click();
  await page.getByRole('button', { name: 'Create managed policy' }).click();
  await page.getByLabel('Managed policy draft', { exact: true }).fill('# 보존할 초안 <script>\nmode: standard');
  await page.getByRole('tab', { name: 'Decision test', exact: true }).click();
  await page.getByLabel('Decision client', { exact: true }).selectOption('kiro-cli');
  await page.getByLabel('Tool name', { exact: true }).fill('execute_bash');
  await page.getByLabel('Tool input (JSON)', { exact: true }).fill('{"command":"echo 원문 $(literal)"}');
  await page.getByRole('tab', { name: 'Audit', exact: true }).click();
  await page.getByRole('combobox', { name: 'Audit client filter', exact: true }).selectOption('kiro');
  await page.getByLabel('Session ID filter', { exact: true }).fill('session-2');
  await expect(page.getByText('1 matching records in the retained cache', { exact: true })).toBeVisible();
  const requests = api.requests.length;
  await page.getByRole('tab', { name: 'Hooks', exact: true }).click();
  await page.getByRole('tab', { name: 'Engine', exact: true }).click();
  await expect(page.getByLabel('Python interpreter path', { exact: true })).toHaveValue('/opt/unsaved/python3');
  await page.getByRole('tab', { name: 'Policies', exact: true }).click();
  await expect(page.getByLabel('Managed policy draft', { exact: true })).toHaveValue('# 보존할 초안 <script>\nmode: standard');
  await page.getByRole('tab', { name: 'Decision test', exact: true }).click();
  await expect(page.getByLabel('Decision client', { exact: true })).toHaveValue('kiro-cli');
  await expect(page.getByLabel('Tool name', { exact: true })).toHaveValue('execute_bash');
  await expect(page.getByLabel('Tool input (JSON)', { exact: true })).toHaveValue('{"command":"echo 원문 $(literal)"}');
  await page.getByRole('tab', { name: 'Audit', exact: true }).click();
  await expect(page.getByLabel('Session ID filter', { exact: true })).toHaveValue('session-2');
  await expect(page.getByRole('combobox', { name: 'Audit client filter', exact: true })).toHaveValue('kiro');
  expect(api.requests.length).toBe(requests);
  expect(api.requests.filter(request => request.method !== 'GET')).toHaveLength(0);
});

test('the default phone page excludes inactive task content and displays the shared demo notice once', async ({ page }, testInfo) => {
  await harnessBrowserApi(page, true);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/__harness?demo');
  await expect(page.getByRole('tabpanel', { name: 'Engine', exact: true })).toBeVisible();
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await expect(page.getByRole('table')).toHaveCount(0);
  const demoNotice = page.getByText('Demo mode disables engine probes, actual decision tests, and hook changes. Policy reading and structural validation are available.', { exact: true });
  await expect(demoNotice).toHaveCount(1);
  for (const label of ['Engine', 'Policies', 'Decision test', 'Hooks', 'Audit']) {
    await expect(page.getByRole('tab', { name: label, exact: true })).toBeInViewport();
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(height).toBeLessThan(3000);
  console.log(`Default 360px demo page height: ${height}px`);
  await page.screenshot({ path: testInfo.outputPath('phone-engine-en.png'), fullPage: true });
  for (const label of ['Policies', 'Decision test', 'Hooks', 'Audit', 'Engine']) {
    await page.getByRole('tab', { name: label, exact: true }).click();
    await expect(demoNotice).toHaveCount(1);
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
  }
  await page.getByRole('button', { name: 'Switch to Korean' }).click();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark'; });
  await expect(page.getByRole('tabpanel', { name: '엔진', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('phone-engine-ko-dark.png'), fullPage: true });
});
