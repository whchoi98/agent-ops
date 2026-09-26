import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp, type AppContext } from '../../server/app';

test('opens harness management from navigation and uses real demo policy and audit APIs in both languages', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('aside.sidebar a[href="#/harness"]').click();
  await expect(page.getByRole('heading', { name: '하니스 관리', exact: true })).toBeVisible();
  await expect(page.locator('aside.sidebar a[href="#/harness"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: '엔진 확인', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '영어로 전환', exact: true }).click();
  await expect(page).toHaveTitle('Harness management · my-agent-ops');
  await expect(page.getByRole('heading', { name: 'Harness management', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Audit', exact: true }).click();
  await page.getByRole('combobox', { name: 'Audit client filter', exact: true }).selectOption('kiro');
  await expect(page.getByText('1 matching records in the retained cache', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Policies', exact: true }).click();
  await page.getByRole('button', { name: 'Create managed policy', exact: true }).click();
  const draft = page.getByLabel('Managed policy draft', { exact: true });
  await draft.fill('version: "1.0"\nmode: core\nrules: []\n# Preserve 원문 <script>');
  await page.getByRole('button', { name: 'Validate structure', exact: true }).click();
  await expect(page.getByText('Structure passed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByText('Policy saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Switch to Korean', exact: true }).click();
  await expect(page.getByLabel('앱 관리 정책 초안', { exact: true })).toHaveValue('version: "1.0"\nmode: core\nrules: []\n# Preserve 원문 <script>');
  await page.getByRole('tab', { name: '판정 테스트', exact: true }).click();
  await expect(page.getByRole('button', { name: '판정 테스트', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('keeps long policy and interpreter paths inside phone layouts in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#/harness');
  await expect(page.getByRole('heading', { name: '하니스 관리', exact: true })).toBeVisible();
  const path = page.getByLabel('Python 실행 파일 경로', { exact: true });
  await path.fill(`/not-saved/${'long-directory-'.repeat(15)}/python3`);
  for (const language of ['ko', 'en'] as const) {
    if (language === 'en') await page.getByRole('button', { name: '영어로 전환', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.harness-workspace').screenshot({ path: `/tmp/agent-ops-harness-phone-${language}.png` });
  }
  await page.locator('.topbar-theme-button').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.harness-workspace').screenshot({ path: '/tmp/agent-ops-harness-phone-dark.png' });
  await page.locator('.topbar-theme-button').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(errors).toEqual([]);
});

test('uses the installed engine and applies then removes a reviewed hook through the complete workbench', async ({ page }) => {
  test.skip(!process.env.HARNESS_TEST_PYTHON, 'Set HARNESS_TEST_PYTHON to an isolated AutoHarness 0.1.1 environment.');
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), 'agent ops harness browser '));
  const homeDir = join(root, 'home'), projectDir = join(root, 'project');
  await Promise.all([mkdir(homeDir), mkdir(projectDir)]);
  let context: AppContext | undefined;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    context = await createApp({
      dataDir: join(root, 'data'), staticDir: resolve('dist/client'), autoSync: false, connectorProbe: async () => [],
      harnessOptions: { homeDir }, mcpOptions: { homeDir }, extensionOptions: { homeDir },
      desktopAppOptions: { platform: 'linux' },
    });
    const project = context.store.ensureProject(projectDir, 'Harness browser fixture');
    context.store.saveProject({ ...project, executionEnabled: true });
    const address = await context.app.listen({ host: '127.0.0.1', port: 0 });
    await page.addInitScript(() => localStorage.setItem('agent-ops-language', 'en'));
    await page.goto(`${address}/#/harness`);
    await expect(page.getByRole('heading', { name: 'Harness management', exact: true })).toBeVisible();
    await page.getByLabel('Python interpreter path', { exact: true }).fill(process.env.HARNESS_TEST_PYTHON!);
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(page.getByText('Settings saved.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Probe engine', exact: true }).click();
    await expect(page.getByText('Engine ready', { exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Harness project', exact: true }).selectOption(project.id);
    await page.getByRole('tab', { name: 'Policies', exact: true }).click();
    await page.getByRole('button', { name: 'Create managed policy', exact: true }).click();
    const policy = {
      mode: 'core', hooks: { profile: 'minimal' },
      permissions: {
        defaults: { unknown_tool: 'ask', unknown_path: 'allow', on_error: 'deny' },
        tools: { bash: { policy: 'restricted', allow_patterns: ['^echo safe$'], ask_patterns: ['^echo review$'] } },
      },
      risk: { classifier: 'rules', thresholds: { low: 'allow', medium: 'allow', high: 'ask', critical: 'deny' } },
    };
    await page.getByLabel('Managed policy draft', { exact: true }).fill(JSON.stringify(policy, null, 2));
    await page.getByRole('button', { name: 'Save policy', exact: true }).click();
    await expect(page.getByText('Policy saved.', { exact: true })).toBeVisible();
    let archiveReads = 0;
    page.on('request', request => { if (request.url() === `${address}/api/bootstrap`) archiveReads++; });
    await page.getByRole('tab', { name: 'Decision test', exact: true }).click();
    await page.getByLabel('Decision client', { exact: true }).selectOption('claude-code');
    await page.getByLabel('Tool name', { exact: true }).fill('Bash');
    await page.getByLabel('Tool input (JSON)', { exact: true }).fill('{"command":"echo safe"}');
    await page.getByRole('button', { name: 'Decision test', exact: true }).click();
    await expect(page.getByText('No tool execution', { exact: true })).toBeVisible();
    const evaluated = await (await page.request.get(`${address}/api/harness/audit?projectId=${project.id}`)).json();
    expect(evaluated.items[0]).toMatchObject({ action: 'allow', origin: 'agent-ops-test' });
    await page.getByRole('tab', { name: 'Hooks', exact: true }).click();
    await page.getByRole('button', { name: 'Preview Claude Code install', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Hook change preview', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(dialog.getByText('Changes applied. Check activation in the native client.', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    const native = JSON.parse(await readFile(join(projectDir, '.claude/settings.local.json'), 'utf8'));
    expect(JSON.stringify(native.hooks.PreToolUse)).toContain('--binding');
    await page.getByRole('button', { name: 'Preview Claude Code removal', exact: true }).click();
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(dialog.getByText('Changes applied. Check activation in the native client.', { exact: true })).toBeVisible();
    expect(archiveReads).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await page.goto('about:blank');
    await context?.app.close();
    await rm(root, { recursive: true, force: true });
  }
});
