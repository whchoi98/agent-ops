import { expect, test, type Page } from '@playwright/test';
import type { SyncStatus } from '../../shared/sync-control';
import type { AppUpdateReport } from '../../shared/app-update';
import { APP_UPDATE_SOURCE_URL } from '../../shared/app-update';

const idleStatus = (): SyncStatus => ({
  policy: { mode: 'manual', intervalSeconds: 60, maxSeconds: 30 }, demo: false, autoEnabled: true,
  activity: 'idle', automaticState: 'manual', nextCheckAt: null, currentAttempt: null, lastAttempt: null,
});

async function controlledLivePage(page: Page, language: 'ko' | 'en') {
  let state = idleStatus();
  let bootstrapReads = 0, starts = 0, stops = 0;
  await page.addInitScript(language => {
    localStorage.setItem('agent-ops-language', language);
    class ControlledEvents extends EventTarget {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      readyState = 1;
      constructor(_url: string) {
        super();
        (window as unknown as { emitSyncStatus: (status: unknown) => void }).emitSyncStatus = status =>
          this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'sync-state', status }) }));
        queueMicrotask(() => { if (this.readyState === 1) this.onopen?.(new Event('open')); });
      }
      close() { this.readyState = 2; }
    }
    Object.defineProperty(window, 'EventSource', { value: ControlledEvents, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as unknown as { copiedCommand: string }).copiedCommand = text; },
    } });
  }, language);
  await page.route('**/api/bootstrap', async route => {
    bootstrapReads++;
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ json: {
      ...data, demo: false, syncStatus: state, syncing: state.activity !== 'idle',
      settings: { ...data.settings, syncMode: 'manual', syncMaxSeconds: 30 },
    } });
  });
  await page.route('**/api/sync/status', route => route.fulfill({ json: state }));
  await page.route('**/api/sync/start', route => {
    starts++;
    state = { ...state, activity: 'running', currentAttempt: {
      id: `attempt-${starts}`, trigger: 'manual', startedAt: new Date().toISOString(), maxSeconds: 30,
    } };
    return route.fulfill({ status: 202, json: { syncing: true } });
  });
  await page.route('**/api/sync/cancel', route => {
    stops++;
    state = { ...state, activity: 'idle', currentAttempt: null, lastAttempt: {
      ...state.currentAttempt!, finishedAt: new Date().toISOString(), outcome: 'cancelled', error: 'Synchronization cancelled.',
    } };
    return route.fulfill({ status: 202, json: { stopping: true, status: state } });
  });
  return {
    counts: () => ({ bootstrapReads, starts, stops }),
    current: () => state,
    async emit(next = state) {
      state = next;
      await page.evaluate(status => {
        (window as unknown as { emitSyncStatus: (value: SyncStatus) => void }).emitSyncStatus(status);
      }, state);
    },
  };
}

test('persists automatic mode and time budget in isolated demo settings', async ({ page }) => {
  await page.goto('/#/settings');
  const before = await (await page.request.get('/api/bootstrap')).json();
  try {
    await expect(page.getByRole('button', { name: '설정 저장', exact: true })).toBeDisabled();
    await expect(page.locator('.settings-save-bar')).toContainText('설정이 저장되어 있습니다.');
    await page.getByLabel('자동 동기화 방식', { exact: true }).selectOption('manual');
    await page.getByLabel('동기화 시간 제한', { exact: true }).fill('45');
    await page.getByRole('button', { name: '설정 저장', exact: true }).click();
    await expect(page.getByRole('button', { name: '설정 저장', exact: true })).toBeDisabled();
    await page.reload();
    await expect(page.getByLabel('자동 동기화 방식', { exact: true })).toHaveValue('manual');
    await expect(page.getByLabel('동기화 시간 제한', { exact: true })).toHaveValue('45');
    await expect(page.getByRole('button', { name: '설정 저장', exact: true })).toBeDisabled();
    const controls = page.getByRole('region', { name: '수집 제어', exact: true });
    await expect(controls).toContainText('데모에서는 원본 동기화를 실행하지 않습니다.');
    await expect(controls.getByRole('button', { name: '현재 동기화 중단' })).toBeDisabled();
  } finally {
    await page.request.patch('/api/settings', {
      headers: { 'X-Agent-Ops': '1' },
      data: {
        syncMode: before.settings.syncMode ?? 'interval',
        syncMaxSeconds: before.settings.syncMaxSeconds ?? 1800,
      },
    });
  }
});

for (const language of ['ko', 'en'] as const) {
  test(`sync status events avoid archive reloads and allow stop/retry in ${language}`, async ({ page }) => {
    const fixture = await controlledLivePage(page, language);
    await page.goto('/#/settings');
    const region = page.getByRole('region', { name: language === 'ko' ? '수집 제어' : 'Import controls', exact: true });
    const start = region.getByRole('button', { name: language === 'ko' ? '지금 동기화' : 'Sync now', exact: true });
    const stop = region.getByRole('button', { name: language === 'ko' ? '현재 동기화 중단' : 'Stop current sync', exact: true });
    await start.click();
    await expect(stop).toBeEnabled();
    const before = fixture.counts().bootstrapReads;
    for (let i = 0; i < 5; i++) await fixture.emit();
    await page.waitForTimeout(2200);
    expect(fixture.counts().bootstrapReads).toBe(before);
    await expect(region).toContainText(language === 'ko' ? '동기화 진행 중' : 'Sync running');
    await stop.click();
    await expect(region).toContainText(language === 'ko' ? '수집 취소' : 'Sync cancelled');
    await expect(start).toBeEnabled();
    await start.click();
    expect(fixture.counts()).toMatchObject({ starts: 2, stops: 1 });
    if (language === 'en') await expect(region).not.toContainText(/[가-힣]/);
    await region.screenshot({ path: `test-results/import-controls-${language}.png` });
  });
}

function updateReport(archive = true): AppUpdateReport {
  const url = 'https://github.com/whchoi98/agent-ops/releases/download/v1.3.0/agent-ops-local-1.3.0.tgz';
  return {
    currentVersion: '1.2.1', demo: false, status: 'update-available', checking: false,
    latest: {
      version: '1.3.0', tag: 'v1.3.0', publishedAt: '2026-09-25T00:00:00Z',
      releaseUrl: 'https://github.com/whchoi98/agent-ops/releases/tag/v1.3.0',
      archive: archive ? { name: 'agent-ops-local-1.3.0.tgz', url } : null,
    },
    checkedAt: new Date().toISOString(), nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
    sourceUrl: APP_UPDATE_SOURCE_URL, error: null,
    commands: {
      npm: archive ? `npm install -g '${url}'` : null,
      git: "git fetch --no-tags 'https://github.com/whchoi98/agent-ops.git' 'refs/tags/v1.3.0' &&\ngit merge --ff-only FETCH_HEAD &&\nnpm ci &&\nnpm run build",
    },
  };
}

test('checks the app release explicitly and copies the verified npm instruction', async ({ page }) => {
  await controlledLivePage(page, 'en');
  let checks = 0;
  const available = updateReport();
  const initial: AppUpdateReport = {
    ...available, status: 'not-checked', latest: null, checkedAt: null, nextCheckAt: null,
    commands: { npm: null, git: null },
  };
  await page.route('**/api/app-update', route => route.fulfill({ json: initial }));
  await page.route('**/api/app-update/check', route => {
    checks++;
    return route.fulfill({ json: available });
  });
  await page.goto('/#/settings');
  const region = page.getByRole('region', { name: 'my-agent-ops updates', exact: true });
  await expect(region).toContainText('1.2.1');
  expect(checks).toBe(0);
  await page.getByRole('button', { name: 'Check app release', exact: true }).click();
  await expect(region).toContainText('1.3.0');
  await region.getByRole('button', { name: 'Copy npm update command', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copiedCommand: string }).copiedCommand)).toBe(available.commands.npm);
  await expect(page.getByRole('button', { name: 'Check app release', exact: true })).toBeDisabled();
  expect(checks).toBe(1);
  await expect(region).not.toContainText(/[가-힣]/);
  await region.screenshot({ path: 'test-results/app-update-en.png' });
});

test('omits npm instructions when a release has no verified archive', async ({ page }) => {
  await controlledLivePage(page, 'ko');
  await page.route('**/api/app-update', route => route.fulfill({ json: updateReport(false) }));
  await page.goto('/#/settings');
  const region = page.getByRole('region', { name: 'my-agent-ops 업데이트', exact: true });
  await expect(region).toContainText('검증된 npm 설치 파일이 없어 npm 명령을 제공하지 않습니다.');
  await expect(region.getByRole('button', { name: 'npm 업데이트 명령 복사', exact: true })).toHaveCount(0);
  await expect(region.getByRole('button', { name: 'Git 업데이트 명령 복사', exact: true })).toBeVisible();
});
