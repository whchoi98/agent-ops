import { expect, test, type Page } from '@playwright/test';
import type { DesktopAppReport, DesktopApp } from '../../shared/desktop-apps';

function desktopReport(supported: boolean): DesktopAppReport {
  const bundles = { 'codex-app': 'Codex.app', 'claude-desktop': 'Claude.app', 'kiro-ide': 'Kiro.app' };
  const definitions: Array<Pick<DesktopApp, 'id' | 'agent' | 'name' | 'versionScope'>> = [
    { id: 'codex-app', agent: 'codex', name: 'Codex App', versionScope: 'app' },
    { id: 'claude-desktop', agent: 'claude', name: 'Claude Desktop', versionScope: 'app-container' },
    { id: 'kiro-ide', agent: 'kiro', name: 'Kiro IDE', versionScope: 'ide' },
  ];
  return {
    status: supported ? 'supported' : 'unsupported-host', platform: supported ? 'darwin' : 'linux',
    scope: 'server-host', demo: false, cacheTtlMs: 600000,
    checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
    items: definitions.map(item => ({
      ...item, status: supported ? 'installed' : 'unsupported-host', installed: supported ? true : null,
      candidates: [],
      installations: supported ? [{
        path: `/Applications/${bundles[item.id]}`, location: 'system', version: '1.2.3', build: '0099',
        bundleIdentifier: `example.${item.id}`, metadataStatus: 'complete', issues: [],
        source: { type: 'info-plist', path: `/Applications/${bundles[item.id]}/Contents/Info.plist`,
          keys: { version: 'CFBundleShortVersionString', build: 'CFBundleVersion', bundleIdentifier: 'CFBundleIdentifier' } },
      }] : [],
      unverified: { authentication: 'unverified', cloudChats: 'unverified', privateHistories: 'unverified', codeEngineVersion: 'unverified' },
    })),
  };
}
async function livePresentation(page: Page) {
  // Only the presentation is changed: the real test server remains an isolated demo.
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ json: { ...data, demo: false } });
  });
}

test('shows desktop app/IDE versions separately from CLI versions and preserves build strings', async ({ page }) => {
  await livePresentation(page);
  let reads = 0, refreshes = 0;
  await page.route('**/api/desktop-apps', route => { reads++; return route.fulfill({ json: desktopReport(true) }); });
  await page.route('**/api/desktop-apps/refresh', route => { refreshes++; return route.fulfill({ json: desktopReport(true) }); });
  await page.goto('/#/settings');
  const section = page.getByRole('region', { name: 'macOS 데스크톱 앱', exact: true });
  await expect(section.getByRole('heading', { name: 'Kiro IDE', exact: true })).toBeVisible();
  await expect(section).toContainText('0099');
  await expect(section).toContainText('앱/컨테이너 버전이며 내부 Code 엔진·CLI 버전과 별개입니다.');
  await section.getByRole('button', { name: '설치 정보 새로고침' }).click();
  await expect.poll(() => refreshes).toBe(1);
  expect(reads).toBeGreaterThan(0);
  await page.getByRole('button', { name: '영어로 전환' }).click();
  await expect(page.getByRole('region', { name: 'macOS desktop apps' })).toContainText('Kiro IDE');
  await expect(page.getByRole('region', { name: 'macOS desktop apps' })).not.toContainText(/[가-힣]/);
  await page.screenshot({ path: 'test-results/desktop-apps-en.png', fullPage: true });
});

test('does not call apps missing when the server host is not macOS', async ({ page }) => {
  await livePresentation(page);
  await page.route('**/api/desktop-apps', route => route.fulfill({ json: desktopReport(false) }));
  await page.goto('/#/settings');
  const section = page.getByRole('region', { name: 'macOS 데스크톱 앱', exact: true });
  await expect(section).toContainText('브라우저 연결만으로 사용자의 Mac을 검사하지 않습니다.');
  await expect(section.getByText('지원하지 않는 호스트', { exact: true })).toHaveCount(3);
  await expect(section.getByText('후보 경로에서 찾지 못함', { exact: true })).toHaveCount(0);
});
