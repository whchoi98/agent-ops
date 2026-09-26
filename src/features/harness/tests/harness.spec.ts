import { expect, test } from '@playwright/test';
import { harnessBrowserApi } from './browser-api';
import { deferred, harnessProject, runtime } from '../testFixtures';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('agent-ops-language', 'en'));
});

test('saved settings, policy conflict recovery, real decision requests and one-use Kiro previews', async ({ page }) => {
  const api = await harnessBrowserApi(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/__harness');
  await expect(page.getByRole('heading', { name: 'Harness management', exact: true })).toBeVisible();
  await expect(page.getByText('Unsupported Python or engine', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Copy installation commands' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('3561e468f9ca9f9bf282512e695bd32e4e90fef4.tar.gz');
  await page.getByLabel('Python interpreter path', { exact: true }).fill('/opt/synthetic/bin/python3');
  expect(api.requests.filter(item => item.path.endsWith('/settings'))).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Probe engine', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByText('Settings saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Probe engine', exact: true }).click();
  await expect(page.getByText('Engine ready', { exact: true })).toBeVisible();

  await page.getByRole('combobox', { name: 'Harness project' }).selectOption(harnessProject.id);
  await expect(page.getByLabel('Tool name', { exact: true })).toHaveCount(1);
  await page.getByRole('tab', { name: 'Policies', exact: true }).click();
  await page.getByRole('button', { name: 'Create managed policy' }).click();
  const draft = page.getByLabel('Managed policy draft', { exact: true });
  await draft.fill('version: "1.0"\nmode: standard\nrules: []\n# 초안 원문');
  await page.getByRole('button', { name: 'Validate structure' }).click();
  await expect(page.getByText('Structure passed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByText('Policy saved.', { exact: true })).toBeVisible();
  await draft.fill('version: "1.0"\nrules: []\n# 보존할 초안');
  api.managed.set(harnessProject.id, { ...api.managed.get(harnessProject.id)!, revision: 'remote-revision', content: '# remote source\nrules: []' });
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByText('Managed policy revision changed. Refresh before saving.', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('version: "1.0"\nrules: []\n# 보존할 초안');
  await page.getByRole('button', { name: 'Reread policy', exact: true }).first().click();
  await expect(page.getByText('# remote source\nrules: []', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('version: "1.0"\nrules: []\n# 보존할 초안');
  await page.getByRole('button', { name: 'Use this revision for my next save' }).click();
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByText('Policy saved.', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Decision test', exact: true }).click();
  await page.getByLabel('Tool name', { exact: true }).fill('Bash');
  await page.getByLabel('Tool input (JSON)', { exact: true }).fill('[]');
  await expect(page.getByRole('button', { name: 'Decision test', exact: true })).toBeDisabled();
  await page.getByLabel('Tool input (JSON)', { exact: true }).fill('{"command":"printf $(literal) `pwd`"}');
  await page.getByRole('button', { name: 'Decision test', exact: true }).click();
  await expect(page.getByText('No tool execution', { exact: true })).toBeVisible();
  expect(api.requests.find(item => item.path.endsWith('/evaluate'))?.body).toMatchObject({
    toolInput: { command: 'printf $(literal) `pwd`' }, projectId: harnessProject.id,
  });
  await page.getByRole('tab', { name: 'Hooks', exact: true }).click();
  await page.getByRole('button', { name: 'Preview Kiro IDE install', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Hook change preview' });
  await expect(dialog.getByText('{"token":"[REDACTED]"}', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog.getByText('Hook preview expired or was already used.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  expect(api.requests.filter(item => item.path.endsWith('/apply'))).toHaveLength(1);
  await dialog.getByRole('button', { name: 'New preview', exact: true }).click();
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog.getByText('Changes applied. Check activation in the native client.', { exact: true })).toBeVisible();
  expect(api.requests.filter(item => item.path.endsWith('/apply')).map(item => item.body)).toEqual([
    { previewId: 'preview-1', projectId: harnessProject.id }, { previewId: 'preview-2', projectId: harnessProject.id },
  ]);
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Preview Kiro IDE update', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview Kiro CLI update', exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Audit', exact: true }).click();
  await page.getByRole('combobox', { name: 'Audit client filter', exact: true }).selectOption('kiro');
  await expect(page.getByText('23 matching records in the retained cache', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByText('21–23 / 23', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Policies', exact: true }).click();
  await draft.fill('# scope draft preserved');
  await page.getByRole('combobox', { name: 'Harness project' }).selectOption('project-other');
  await expect(page.getByRole('button', { name: 'Create managed policy' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Harness project' }).selectOption(harnessProject.id);
  await expect(page.getByLabel('Managed policy draft', { exact: true })).toHaveValue('# scope draft preserved');
  await expect(page.getByLabel('Tool name', { exact: true })).toHaveCount(1);
  expect(api.requests.some(item => item.path.includes('bootstrap') || item.path.includes('/runs'))).toBe(false);
  expect(errors).toEqual([]);
});

test('demo allows policy drafts and structure checks while all four client mutation rows remain disabled', async ({ page }) => {
  const api = await harnessBrowserApi(page, true);
  await page.goto('/__harness?demo');
  await page.getByRole('combobox', { name: 'Harness project' }).selectOption(harnessProject.id);
  await expect(page.getByRole('button', { name: 'Probe engine', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Policies', exact: true }).click();
  await page.getByRole('button', { name: 'Create managed policy' }).click();
  await page.getByLabel('Managed policy draft', { exact: true }).fill('version: "1.0"\nrules: []\n# 새로고침 <script>');
  await page.getByRole('button', { name: 'Validate structure' }).click();
  await expect(page.getByText('Structure passed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByText('Policy saved.', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Decision test', exact: true }).click();
  await page.getByLabel('Tool name', { exact: true }).fill('Bash');
  await page.getByLabel('Tool input (JSON)', { exact: true }).fill('{"command":"literal"}');
  await expect(page.getByRole('button', { name: 'Decision test', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Hooks', exact: true }).click();
  for (const client of ['Codex', 'Claude Code', 'Kiro IDE', 'Kiro CLI']) {
    await expect(page.getByRole('button', { name: `Preview ${client} install`, exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: `Preview ${client} removal`, exact: true })).toBeDisabled();
  }
  expect(api.requests.filter(item => /runtime\/check|evaluate|hooks\//.test(item.path))).toHaveLength(0);
  const reads = api.requests.length;
  await page.getByRole('button', { name: 'Switch to Korean' }).click();
  await expect(page.getByRole('heading', { name: '하니스 관리', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '정책', exact: true }).click();
  await expect(page.getByLabel('앱 관리 정책 초안', { exact: true })).toHaveValue('version: "1.0"\nrules: []\n# 새로고침 <script>');
  expect(api.requests.length).toBe(reads);
});

test('a settings conflict keeps edits across a project change and adopts only an explicitly reviewed revision', async ({ page }) => {
  const api = await harnessBrowserApi(page);
  await page.goto('/__harness');
  const pythonPath = page.getByLabel('Python interpreter path', { exact: true });
  await pythonPath.fill('/opt/my-edited/python3');
  await page.getByRole('tab', { name: 'Policies', exact: true }).click();
  await page.getByRole('combobox', { name: 'Harness project' }).selectOption(harnessProject.id);
  await page.getByRole('tab', { name: 'Engine', exact: true }).click();
  await expect(pythonPath).toHaveValue('/opt/my-edited/python3');
  api.changeSettings();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByText('Harness settings changed. Reload them before saving.', { exact: true })).toBeVisible();
  await expect(pythonPath).toHaveValue('/opt/my-edited/python3');
  expect(api.requests.filter(item => item.path.endsWith('/settings'))).toHaveLength(1);
  await page.getByRole('button', { name: 'Review latest settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Keep my edits with the reviewed settings revision' })).toBeVisible();
  await expect(pythonPath).toHaveValue('/opt/my-edited/python3');
  await expect(page.getByRole('button', { name: 'Save settings', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Keep my edits with the reviewed settings revision' }).click();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByText('Settings saved.', { exact: true })).toBeVisible();
  expect(api.requests.filter(item => item.path.endsWith('/settings')).map(item => item.body)).toEqual([
    { revision: 1, pythonPath: '/opt/my-edited/python3', retentionDays: 30, maxCacheRecords: 2000 },
    { revision: 2, pythonPath: '/opt/my-edited/python3', retentionDays: 30, maxCacheRecords: 2000 },
  ]);
});

test('a late engine probe cannot certify a different saved Python settings revision', async ({ page }) => {
  const api = await harnessBrowserApi(page);
  const started = deferred<void>();
  const result = deferred<void>();
  const probeFailures: string[] = [];
  page.on('requestfailed', request => {
    if (new URL(request.url()).pathname === '/api/harness/runtime/check') probeFailures.push(request.failure()?.errorText ?? 'Request failed');
  });
  await page.route('**/api/harness/runtime/check', async route => {
    started.resolve();
    await result.promise;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(runtime()) });
  });
  await page.goto('/__harness');
  await page.getByRole('button', { name: 'Probe engine', exact: true }).click();
  await started.promise;
  await page.getByRole('tab', { name: 'Policies', exact: true }).click();
  api.changeSettings();
  await page.getByRole('button', { name: 'Refresh harness catalog', exact: true }).click();
  await expect(page.getByLabel('Python interpreter path', { exact: true })).toHaveValue('/opt/other/python3');
  result.resolve();
  await page.getByRole('tab', { name: 'Engine', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Probe engine', exact: true })).toBeEnabled();
  await expect(page.getByText('Engine ready', { exact: true })).toHaveCount(0);
  expect(probeFailures).toEqual([]);
});

test('360px layouts, long literal source paths and keyboard previews work in both themes and languages', async ({ page }, testInfo) => {
  const api = await harnessBrowserApi(page);
  api.ready();
  await page.goto('/__harness');
  await page.getByRole('combobox', { name: 'Harness project' }).selectOption(harnessProject.id);
  await page.getByRole('tab', { name: 'Hooks', exact: true }).click();
  for (const language of ['en', 'ko']) {
    if (language === 'ko') await page.getByRole('button', { name: 'Switch to Korean' }).click();
    await page.setViewportSize({ width: 360, height: 800 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }, theme);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const preview = page.getByRole('button', { name: language === 'en' ? 'Preview Kiro IDE install' : 'Kiro IDE 설치 미리보기', exact: true });
      await preview.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('{"token":"[REDACTED]"}', { exact: true })).toBeVisible();
      await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect.poll(() => dialog.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.top >= 0 && bounds.bottom <= innerHeight;
      })).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${language}-${theme}-preview.png`) });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(preview).toBeFocused();
    }
  }
});
