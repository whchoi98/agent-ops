import { expect, test, type Page } from '@playwright/test';
import type { ResourceReport, ResourceSample } from '../../shared/resources';

function report(): ResourceReport {
  const now = Date.now();
  const samples: ResourceSample[] = [null, 0, 150].map((cpuPercent, index) => ({
    at: new Date(now - (2 - index) * 5000).toISOString(),
    scopes: {
      server: { cpuPercent, rssBytes: 64 * 1024 ** 2, processCount: 1 },
      sync: { cpuPercent: null, rssBytes: null, processCount: null },
      agents: { cpuPercent: 0, rssBytes: 0, processCount: 0 },
      mcp: { cpuPercent: 0, rssBytes: 0, processCount: 0 },
      harness: { cpuPercent: 4, rssBytes: 4 * 1024 ** 2, processCount: 1 },
    },
    heapUsedBytes: 16 * 1024 ** 2, heapTotalBytes: 32 * 1024 ** 2,
    cpuWindowMs: index ? 5000 : null, durationMs: 1.25, warnings: ['owned_processes_unavailable'],
  }));
  return {
    server: { pid: 12345, platform: 'linux', logicalCpuCount: 4, totalMemoryBytes: 8 * 1024 ** 3, startedAt: new Date(now - 60000).toISOString() },
    sampleIntervalSeconds: 5, diskIntervalSeconds: 60, retentionSeconds: 900,
    current: samples[2], history: samples,
    disk: {
      at: new Date(now).toISOString(), dataDirectory: '/synthetic/app-data', logicalBytes: 4 * 1024 ** 3,
      allocatedBytes: 3 * 1024 ** 3, fileCount: 2, entriesScanned: 3, skippedLinks: 0, complete: true, durationMs: 2.5,
      categories: {
        database: { logicalBytes: 3 * 1024 ** 3, allocatedBytes: 2 * 1024 ** 3, fileCount: 1 },
        wal: { logicalBytes: 0, allocatedBytes: 0, fileCount: 0 },
        backups: { logicalBytes: 1024 ** 3, allocatedBytes: 1024 ** 3, fileCount: 1 },
        other: { logicalBytes: 0, allocatedBytes: 0, fileCount: 0 },
      },
      volume: { totalBytes: 100 * 1024 ** 3, availableBytes: 5 * 1024 ** 3 }, warnings: [],
    },
    collector: { sampling: false, scanningDisk: false, skippedSamples: 0, maxDurationMs: 2.75 },
  };
}
async function openResources(page: Page) {
  await page.goto('/#/resources');
  await expect(page.getByRole('heading', { name: '자원 모니터링', exact: true })).toBeVisible();
}

test('shows actual demo-server measurements and resource navigation', async ({ page }) => {
  await openResources(page);
  await expect(page.locator('nav a[href="#/resources"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('대화는 샘플 데이터이며, 자원 값은 현재 데모 서버의 실제 측정값입니다.')).toBeVisible();
  await expect(page.getByRole('heading', { name: '프로세스 범위', exact: true })).toBeVisible();
  await expect(page.locator('.resource-facts')).toContainText('PID');
  const current = await (await page.request.get('/api/resources')).json() as ResourceReport;
  expect(current.current?.scopes.server.rssBytes).toBeGreaterThan(0);
  expect(current.history.length).toBeLessThanOrEqual(180);
  expect(current.server.pid).toBeGreaterThan(0);
});

test('keeps unavailable values distinct from zero and translates the complete monitoring view', async ({ page }) => {
  await page.route('**/api/resources', route => route.fulfill({ json: report() }));
  await openResources(page);
  const scopeRows = page.locator('.resource-table').first().locator('tbody tr');
  await expect(scopeRows.filter({ hasText: '동기화 작업' })).toContainText('—');
  await expect(scopeRows.filter({ hasText: '에이전트 실행' })).toContainText('0%');
  await expect(scopeRows.filter({ hasText: '하니스 검사' })).toContainText('4%');
  await expect(page.getByText('데이터 파일시스템의 여유 공간이 10% 미만입니다. 백업을 포함한 사용량을 확인해 주세요.')).toBeVisible();
  await page.getByRole('button', { name: '영어로 전환' }).click();
  await expect(page.getByRole('heading', { name: 'Resource monitoring', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'App data storage', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Collection cost and retention', exact: true })).toBeVisible();
  await expect(page.locator('.page-content')).not.toContainText(/[가-힣]/);
  await page.getByLabel('Resource trend period').selectOption('5');
  await page.getByRole('slider', { name: 'Select CPU utilization sample' }).fill('1');
  await expect(page.locator('.resource-trend').first().locator('.resource-legend')).toContainText('0%');
  await page.screenshot({ path: 'test-results/resources-en-desktop.png', fullPage: true });
});

test('stops resource polling while paused or hidden and supports manual refresh and recovery', async ({ page }) => {
  await page.clock.install();
  let reads = 0, fail = false;
  await page.route('**/api/resources', route => {
    reads++;
    return route.fulfill(fail ? { status: 503, json: { error: 'Synthetic resource failure' } } : { json: report() });
  });
  await openResources(page);
  await expect(page.locator('.resource-stats')).toContainText('150%');
  await page.getByRole('button', { name: '자동 조회 일시정지', exact: true }).click();
  const paused = reads;
  await page.clock.fastForward(15000);
  expect(reads).toBe(paused);
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect.poll(() => reads).toBe(paused + 1);
  await page.clock.fastForward(15000);
  expect(reads).toBe(paused + 1);
  await page.getByRole('button', { name: '자동 조회 재개', exact: true }).click();
  await expect.poll(() => reads).toBe(paused + 2);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hidden = reads;
  await page.clock.fastForward(15000);
  expect(reads).toBe(hidden);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => reads).toBe(hidden + 1);
  fail = true;
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Synthetic resource failure' })).toBeVisible();
  await expect(page.locator('.resource-stats')).toContainText('150%');
  fail = false;
  await page.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Synthetic resource failure' })).toHaveCount(0);
});

test('fits the mobile dark view with keyboard-accessible trend controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/resources', route => route.fulfill({ json: report() }));
  await openResources(page);
  await page.getByRole('button', { name: '다크 모드로 전환' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const slider = page.getByRole('slider', { name: 'CPU 사용률 표본 선택' });
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveValue('0');
  await page.screenshot({ path: 'test-results/resources-ko-mobile-dark.png', fullPage: true });
});
