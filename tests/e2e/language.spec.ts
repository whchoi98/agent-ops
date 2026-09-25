import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('switches beside the theme control, preserves pending settings and persists English', async ({ page }) => {
  const errors: string[] = [];
  const writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (['POST', 'PATCH'].includes(request.method()) && /\/api\/settings$/.test(new URL(request.url()).pathname)) writes.push(request.url());
  });
  await page.goto('/#/settings');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await page.getByRole('spinbutton', { name: '최대 동시 실행', exact: true }).fill('4');
  const pending = page.getByRole('spinbutton').first();
  const toggle = page.getByRole('button', { name: '영어로 전환', exact: true });
  await expect(toggle).toBeVisible();
  expect(await toggle.evaluate(element => element.previousElementSibling?.classList.contains('topbar-theme-button'))).toBe(true);
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'Switch to Korean', exact: true })).toBeVisible();
  await expect(pending).toHaveValue('4');
  await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeEnabled();
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('agent-ops-language'))).toBe('en');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  for (const [route, label] of [
    ['overview', 'Overview'], ['sessions', 'Sessions'], ['runs', 'Runs'], ['projects', 'Projects'],
    ['analytics', 'Analytics'], ['templates', 'Templates'], ['extensions', 'Extensions'], ['settings', 'Settings'],
  ]) {
    const link = page.locator(`aside.sidebar a[href="#/${route}"]`);
    await expect(link).toContainText(label);
    await link.click();
    await expect(page.locator('main h1')).toBeVisible();
    await expect(page.locator('main h1')).not.toContainText(/[가-힣]/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/settings-english.png', fullPage: true });
  await page.getByRole('button', { name: 'Switch to Korean', exact: true }).click();
  await expect(page.getByRole('button', { name: '설정 저장', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  expect(errors).toEqual([]);
});

test('keeps Korean transcript searches and skill originals when the interface changes', async ({ page }) => {
  await page.goto('/#/sessions');
  const search = page.getByRole('textbox', { name: '세션 전체 내용 검색', exact: true });
  await search.fill('대규모 로그');
  await expect(page.locator('.session-table tbody tr')).toHaveCount(1);
  const title = await page.locator('.session-open .session-cell-text > strong').first().innerText();
  await page.getByRole('button', { name: '영어로 전환', exact: true }).click();
  await expect(page.locator('.session-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.session-open .session-cell-text > strong').first()).toHaveText(title);
  expect(await page.locator('input').evaluateAll(inputs => inputs.some(input => (input as HTMLInputElement).value === '대규모 로그'))).toBe(true);
  await page.locator('.session-open').first().click();
  const conversation = page.getByRole('dialog');
  await expect(conversation.locator('article.conversation-message').first()).toBeVisible();
  await expect(conversation.getByRole('tab').first()).not.toContainText(/[가-힣]/);
  await page.keyboard.press('Escape');
  await page.locator('aside.sidebar a[href="#/extensions"]').click();
  const card = page.locator('.extension-card').filter({ has: page.getByRole('heading', { name: '코드 리뷰', exact: true }) });
  await expect(card).toBeVisible();
  await card.getByRole('button').click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: '코드 리뷰', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('회귀 테스트');
});

test('keeps the language control and English navigation usable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const toggle = page.getByRole('button', { name: '영어로 전환', exact: true });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Switch to Korean', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.locator('main h1')).not.toContainText(/[가-힣]/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/settings-english-mobile.png', fullPage: true });
});
