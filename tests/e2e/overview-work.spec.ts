import { expect, test, type Page } from '@playwright/test';
import type { WorkItem } from '../../shared/work-items';

const headers = { 'X-Agent-Ops': '1' };
const widget = (page: Page) => page.locator('.open-work-items');
async function createWork(page: Page, title = `Checklist ${Date.now()}`): Promise<WorkItem> {
  const response = await page.request.post('/api/productivity/work-items', { headers, data: {
    title, description: 'Keep the full description.', nextAction: 'Review the saved result.',
    status: 'in_progress', priority: 'high', dueDate: '2020-01-01',
  } });
  expect(response.status()).toBe(201);
  return response.json();
}
async function removeWork(page: Page, id: string) {
  if (test.info().status === 'timedOut') return;
  const response = await page.request.get(`/api/productivity/work-items/${id}`);
  if (response.ok()) await page.request.delete(`/api/productivity/work-items/${id}`, {
    headers, data: { version: (await response.json()).version },
  });
}

test('completes an Overview work item by keyboard with one versioned write and no archive reload', async ({ page }) => {
  const item = await createWork(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writes: unknown[] = [];
  let archiveReads = 0;
  try {
    await page.goto('/');
    const checkbox = widget(page).getByRole('checkbox', { name: `${item.title} 작업 완료`, exact: true });
    await expect(checkbox).toBeVisible();
    await page.route(`**/api/productivity/work-items/${item.id}`, async route => {
      if (route.request().method() === 'PATCH') {
        writes.push(route.request().postDataJSON());
        await gate;
      }
      await route.continue();
    });
    page.on('request', request => { if (request.url().endsWith('/api/bootstrap')) archiveReads++; });
    await checkbox.focus();
    await page.keyboard.press('Space');
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toBeDisabled();
    await page.keyboard.press('Space');
    release();
    await expect(checkbox).toHaveCount(0);
    await expect(widget(page).locator('.work-widget-count')).toBeVisible();
    const saved = await (await page.request.get(`/api/productivity/work-items/${item.id}`)).json();
    expect(saved).toMatchObject({ ...item, status: 'done', version: 2, updatedAt: expect.any(String) });
    expect(writes).toEqual([{ version: 1, status: 'done' }]);
    expect(archiveReads).toBe(0);
    await page.reload();
    await expect(widget(page).getByRole('heading', { name: '진행할 작업', exact: true })).toBeVisible();
    await expect(checkbox).toHaveCount(0);
  } finally {
    release?.();
    await removeWork(page, item.id);
  }
});

test('keeps a failed completion unchecked and lets the operator retry', async ({ page }) => {
  const item = await createWork(page);
  const path = `**/api/productivity/work-items/${item.id}`;
  try {
    await page.goto('/');
    const checkbox = widget(page).getByRole('checkbox', { name: `${item.title} 작업 완료`, exact: true });
    await expect(checkbox).toBeVisible();
    await page.route(path, route => route.request().method() === 'PATCH'
      ? route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }) : route.continue());
    await checkbox.click();
    await expect(widget(page).getByRole('alert')).toContainText('Temporarily unavailable');
    await expect(checkbox).not.toBeChecked();
    await expect(checkbox).toBeEnabled();
    const saved = await (await page.request.get(`/api/productivity/work-items/${item.id}`)).json();
    expect(saved).toMatchObject({ ...item });
    await page.unroute(path);
    await checkbox.click();
    await expect(checkbox).toHaveCount(0);
    expect((await (await page.request.get(`/api/productivity/work-items/${item.id}`)).json()).status).toBe('done');
  } finally {
    await page.unroute(path);
    await removeWork(page, item.id);
  }
});

test('preserves another edit when a checkbox completion conflicts and reloads before retry', async ({ page }) => {
  const item = await createWork(page);
  const path = `**/api/productivity/work-items/${item.id}`;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let intercepted = false;
  try {
    await page.goto('/');
    const checkbox = widget(page).getByRole('checkbox', { name: `${item.title} 작업 완료`, exact: true });
    await expect(checkbox).toBeVisible();
    await page.route(path, async route => {
      if (route.request().method() === 'PATCH') { intercepted = true; await gate; }
      await route.continue();
    });
    await checkbox.click();
    await expect.poll(() => intercepted).toBe(true);
    expect((await page.request.patch(`/api/productivity/work-items/${item.id}`, { headers,
      data: { version: 1, status: 'blocked', nextAction: 'Preserve the other editor’s next action.' },
    })).status()).toBe(200);
    const conflict = page.waitForResponse(response =>
      response.url().endsWith(`/work-items/${item.id}`) && response.request().method() === 'PATCH');
    release();
    expect((await conflict).status()).toBe(409);
    await expect(widget(page).getByRole('alert')).toContainText('다른 곳에서 이 작업을 수정했습니다.');
    await expect(checkbox).not.toBeChecked();
    expect(await (await page.request.get(`/api/productivity/work-items/${item.id}`)).json()).toMatchObject({
      version: 2, status: 'blocked', nextAction: 'Preserve the other editor’s next action.',
    });
    await widget(page).getByRole('button', { name: '작업 새로고침', exact: true }).click();
    await expect(widget(page).getByRole('alert')).toHaveCount(0);
    await expect(checkbox).toBeEnabled();
    await checkbox.click();
    await expect(checkbox).toHaveCount(0);
    expect(await (await page.request.get(`/api/productivity/work-items/${item.id}`)).json()).toMatchObject({
      version: 3, status: 'done', nextAction: 'Preserve the other editor’s next action.',
    });
  } finally {
    release?.();
    await page.unroute(path);
    await removeWork(page, item.id);
  }
});

test('keeps the checklist inset and long titles readable on desktop and phone in both languages', async ({ page }) => {
  const item = await createWork(page, `설정 검토 ${'long-title-'.repeat(12)}`);
  try {
    await page.goto('/');
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 900 });
      for (const language of ['ko', 'en'] as const) {
        if (await page.locator('html').getAttribute('lang') !== language) {
          await page.getByRole('button', { name: language === 'en' ? '영어로 전환' : 'Switch to Korean', exact: true }).click();
        }
        const panel = widget(page);
        const checkbox = panel.getByRole('checkbox', {
          name: language === 'ko' ? `${item.title} 작업 완료` : `Complete work item: ${item.title}`, exact: true,
        });
        const title = panel.getByRole('link', { name: item.title, exact: true });
        await expect(checkbox).toBeVisible();
        const panelBox = (await panel.boundingBox())!;
        const countBox = (await panel.locator('.work-widget-count').boundingBox())!;
        const headingBox = (await panel.getByRole('heading').boundingBox())!;
        const inputBox = (await checkbox.boundingBox())!;
        const titleBox = (await title.boundingBox())!;
        expect(countBox.x - panelBox.x).toBeGreaterThanOrEqual(16);
        expect(Math.abs(countBox.x - headingBox.x)).toBeLessThanOrEqual(1);
        expect(inputBox.x - panelBox.x).toBeGreaterThanOrEqual(16);
        expect(titleBox.x - inputBox.x - inputBox.width).toBeGreaterThanOrEqual(8);
        expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width - 16);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await panel.screenshot({ path: `/tmp/agent-ops-overview-${width}-${language}.png` });
      }
    }
    await widget(page).getByRole('link', { name: item.title, exact: true }).click();
    await expect(page.locator('dialog[open]').getByLabel('Work item title', { exact: true })).toHaveValue(item.title);
    expect((await (await page.request.get(`/api/productivity/work-items/${item.id}`)).json()).status).toBe('in_progress');
  } finally { await removeWork(page, item.id); }
});
