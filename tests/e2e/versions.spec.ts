import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('compares current/latest CLI versions without changing pending settings or launching updates', async ({ page }) => {
  const changes: string[] = [];
  page.on('request', request => {
    if (['POST', 'PATCH'].includes(request.method()) && /\/api\/(?:settings|runs)$/.test(new URL(request.url()).pathname)) changes.push(request.url());
  });
  await page.goto('/#/settings');
  const versions = page.getByRole('region', { name: 'CLI 버전 비교', exact: true });
  await expect(versions).toBeVisible();
  await expect(versions).toContainText('현재 버전');
  await expect(versions).toContainText('최신 버전');
  await expect(versions).toContainText('1.0.0');
  await expect(versions).toContainText('1.1.0');
  await expect(versions).toContainText('2.1.0');
  await expect(versions).toContainText('3.0.0-preview.1');
  await expect(versions).toContainText('2.9.0');
  await expect(versions).toContainText('데모');
  await page.getByRole('spinbutton', { name: '최대 동시 실행', exact: true }).fill('3');
  await versions.getByRole('button', { name: '최신 버전 확인', exact: true }).click();
  await expect(versions.getByRole('button', { name: '최신 버전 확인', exact: true })).toBeEnabled();
  await expect(page.getByRole('spinbutton', { name: '최대 동시 실행', exact: true })).toHaveValue('3');
  await expect(page.getByRole('button', { name: '설정 저장', exact: true })).toBeEnabled();
  expect(changes).toEqual([]);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/versions-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await versions.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/versions-mobile.png' });
});
