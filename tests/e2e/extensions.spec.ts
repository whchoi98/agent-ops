import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('inspects assistant skills and prepares analysis without executing a CLI', async ({ page }) => {
  const launches: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/runs$/.test(new URL(request.url()).pathname)) launches.push(request.url());
  });
  await page.goto('/');
  const menu = page.locator('aside.sidebar').getByRole('link', { name: '스킬·플러그인', exact: true });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(page.getByRole('heading', { name: '스킬·플러그인', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '어시스턴트 필터' }).selectOption('codex');
  await page.getByRole('textbox', { name: '스킬·플러그인 검색' }).fill('코드 리뷰');
  await page.getByRole('button', { name: '코드 리뷰 내용 보기', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '코드 리뷰', exact: true })).toBeVisible();
  await expect(dialog).toContainText('Read');
  await dialog.getByRole('button', { name: '원문', exact: true }).click();
  await expect(dialog).toContainText('회귀 테스트');
  await dialog.getByRole('button', { name: '파일', exact: true }).click();
  await dialog.getByRole('button', { name: /checklist\.md/ }).click();
  await expect(dialog).toContainText('변경 범위');
  await dialog.getByRole('button', { name: 'CLI 분석 작업 준비', exact: true }).click();
  await expect(page.getByRole('heading', { name: '새 실행', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '프롬프트', exact: true })).toHaveValue(/코드 리뷰/);
  await expect(page.getByRole('radio', { name: /읽기 전용/ })).toBeChecked();
  await expect(page.getByRole('button', { name: '실행 시작', exact: true })).toBeDisabled();
  expect(launches).toEqual([]);
});

test('filters status and project scope and reads plugin configuration safely', async ({ page }) => {
  await page.goto('/#/extensions');
  await expect(page.getByRole('heading', { name: '스킬·플러그인', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '어시스턴트 필터' }).selectOption('claude');
  await page.getByRole('combobox', { name: '설정 상태 필터' }).selectOption('disabled');
  await expect(page.getByRole('button', { name: '배포 점검 내용 보기', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'review-kit 내용 보기', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: '설정 상태 필터' }).selectOption('enabled');
  await page.getByRole('button', { name: 'review-kit 내용 보기', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('PreToolUse');
  await expect(dialog).toContainText('docs');
  await dialog.getByRole('button', { name: '파일', exact: true }).click();
  await dialog.getByRole('button', { name: /\.mcp\.json/ }).click();
  await expect(dialog).toContainText('DEMO_VALUE');
  await expect(dialog).not.toContainText('sample-value-to-redact');
  await dialog.getByRole('button', { name: '닫기', exact: true }).first().click();
  const data = await page.request.get('/api/bootstrap').then(response => response.json());
  await page.getByRole('combobox', { name: '어시스턴트 필터' }).selectOption('codex');
  await page.getByRole('combobox', { name: '설정 상태 필터' }).selectOption('');
  await page.getByRole('combobox', { name: '프로젝트 선택' }).selectOption(data.projects[0].id);
  await page.getByRole('combobox', { name: '범위 필터' }).selectOption('project');
  await expect(page.getByRole('button', { name: '프로젝트 규칙 내용 보기', exact: true })).toBeVisible();
  await expect(page.locator('.extension-card')).toHaveCount(1);
});

test('extension discovery and Power details fit mobile and desktop layouts', async ({ page }) => {
  await mkdir('artifacts', { recursive: true });
  await page.goto('/#/extensions');
  await expect(page.getByRole('button', { name: '코드 리뷰 내용 보기', exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'artifacts/extensions-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: '스킬·플러그인', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('combobox', { name: '어시스턴트 필터' }).selectOption('kiro');
  await page.getByRole('combobox', { name: '종류 필터' }).selectOption('power');
  await page.getByRole('button', { name: '프로젝트 탐색 내용 보기', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('활성화');
  await page.getByRole('dialog').getByRole('button', { name: '원문', exact: true }).click();
  expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: 'artifacts/extensions-mobile.png', fullPage: true });
});
