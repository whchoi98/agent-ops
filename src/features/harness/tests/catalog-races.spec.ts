import { expect, test } from '@playwright/test';
import { harnessBrowserApi } from './browser-api';
import { harnessProject, policy } from '../testFixtures';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('agent-ops-language', 'en'));
});

test('a delayed manual catalog cannot roll back a successfully saved selected policy', async ({ page }) => {
  const api = await harnessBrowserApi(page);
  api.ready();
  api.managed.set(harnessProject.id, policy({
    id: `managed-${harnessProject.id}`, projectId: harnessProject.id, name: 'Selected managed policy',
    revision: 'revision-1', content: 'version: "1.0"\nmode: standard\nrules: []\n# R1',
  }));
  await page.goto('/__harness');
  await page.getByRole('combobox', { name: 'Harness project' }).selectOption(harnessProject.id);
  await page.getByRole('tab', { name: 'Policies', exact: true }).click();
  const draft = page.getByLabel('Managed policy draft', { exact: true });
  await expect(draft).toHaveValue('version: "1.0"\nmode: standard\nrules: []\n# R1');
  await page.getByRole('tab', { name: 'Decision test', exact: true }).click();
  await page.getByLabel('Tool name', { exact: true }).fill('Bash');
  await page.getByRole('tab', { name: 'Policies', exact: true }).click();
  await draft.fill('version: "1.0"\nmode: standard\nrules: []\n# R2');
  const held = api.holdCatalog();
  const refresh = page.getByRole('button', { name: 'Refresh harness catalog', exact: true });
  await refresh.click();
  expect((await held.started).policies.find(item => item.id === `managed-${harnessProject.id}`)?.revision).toBe('revision-1');
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByText('Policy saved.', { exact: true })).toBeVisible();
  expect(api.managed.get(harnessProject.id)?.revision).toBe('revision-2');
  held.release();
  await held.finished;
  await expect(refresh).toBeEnabled();
  await expect(draft).toHaveValue('version: "1.0"\nmode: standard\nrules: []\n# R2');
  await page.getByRole('tab', { name: 'Decision test', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Decision test', exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'Hooks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Preview Kiro IDE install', exact: true })).toBeEnabled();
});

test('a fresh catalog reset after a probe clears engine readiness at the same settings revision', async ({ page }) => {
  const api = await harnessBrowserApi(page);
  await page.goto('/__harness');
  await page.getByRole('combobox', { name: 'Harness project' }).selectOption(harnessProject.id);
  await page.getByRole('tab', { name: 'Decision test', exact: true }).click();
  await page.getByLabel('Tool name', { exact: true }).fill('Bash');
  await page.getByRole('tab', { name: 'Engine', exact: true }).click();
  await page.getByRole('button', { name: 'Probe engine', exact: true }).click();
  await expect(page.getByText('Engine ready', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Decision test', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Decision test', exact: true })).toBeEnabled();
  api.resetRuntime();
  const held = api.holdCatalog();
  const refresh = page.getByRole('button', { name: 'Refresh harness catalog', exact: true });
  await refresh.click();
  expect(await held.started).toMatchObject({
    settings: { revision: 1 }, runtime: { state: 'unchecked', checkedAt: null },
  });
  held.release();
  await held.finished;
  await expect(refresh).toBeEnabled();
  await page.getByRole('tab', { name: 'Engine', exact: true }).click();
  await expect(page.getByText('Engine ready', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Decision test', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Decision test', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Hooks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Preview Kiro IDE install', exact: true })).toBeDisabled();
});

test('a catalog snapshot taken before a successful probe cannot clear its readiness when it arrives late', async ({ page }) => {
  const api = await harnessBrowserApi(page);
  api.resetRuntime();
  await page.goto('/__harness');
  await page.getByRole('combobox', { name: 'Harness project' }).selectOption(harnessProject.id);
  await page.getByRole('tab', { name: 'Decision test', exact: true }).click();
  await page.getByLabel('Tool name', { exact: true }).fill('Bash');
  await page.getByRole('tab', { name: 'Engine', exact: true }).click();
  const held = api.holdCatalog();
  const refresh = page.getByRole('button', { name: 'Refresh harness catalog', exact: true });
  await refresh.click();
  expect((await held.started).runtime).toMatchObject({ state: 'unchecked', checkedAt: null });
  await page.getByRole('button', { name: 'Probe engine', exact: true }).click();
  await expect(page.getByText('Engine ready', { exact: true })).toBeVisible();
  held.release();
  await held.finished;
  await expect(refresh).toBeEnabled();
  await expect(page.getByText('Engine ready', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Decision test', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Decision test', exact: true })).toBeEnabled();
});
