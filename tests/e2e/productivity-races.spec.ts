import { expect, test, type Page } from '@playwright/test';

const headers = { 'X-Agent-Ops': '1' };
const dialog = (page: Page) => page.locator('dialog[open]').last();
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
async function removePack(page: Page, id: string) {
  if (test.info().status === 'timedOut') return;
  const response = await page.request.get(`/api/productivity/context-packs/${id}`);
  if (response.ok()) await page.request.delete(`/api/productivity/context-packs/${id}`, {
    headers, data: { version: (await response.json()).version },
  });
}

test('a delayed bootstrap cannot overwrite a newer template-only refresh', async ({ page }) => {
  const name = unique('template-snapshot');
  const template = await (await page.request.post('/api/templates', { headers,
    data: { name, description: 'Old description', category: 'review', prompt: 'Review the code.', agent: 'any', policy: 'read-only' } })).json();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const oldResponseReady = new Promise<void>(resolve => { captured = resolve; });
  let delayNext = true;
  try {
    await page.goto('/#/templates');
    const card = page.locator('.template-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(card).toBeVisible();
    await expect(page.locator('.sidebar-connection')).toContainText('실시간 갱신 중');
    await page.route('**/api/bootstrap', async route => {
      if (!delayNext) { await route.continue(); return; }
      delayNext = false;
      const response = await route.fetch();
      const snapshot = await response.json();
      captured();
      await gate;
      await route.fulfill({ json: snapshot }).catch(() => {});
    });
    await page.locator('.topbar-sync-button').click();
    await oldResponseReady;
    await card.getByRole('button', { name: `${name} 템플릿 편집`, exact: true }).click();
    await dialog(page).getByLabel('설명', { exact: true }).fill('Fresh description after the archive request started');
    await dialog(page).getByRole('button', { name: '템플릿 저장', exact: true }).click();
    await expect(card.locator('.template-description')).toHaveText('Fresh description after the archive request started');
    release();
    await expect(page.locator('.topbar-sync-button')).toBeEnabled();
    await expect(card.locator('.template-description')).toHaveText('Fresh description after the archive request started');
  } finally {
    release?.();
    await page.unroute('**/api/bootstrap');
    if (test.info().status !== 'timedOut') await page.request.delete(`/api/templates/${template.id}`, { headers, data: {} });
  }
});

test('context note conflicts preserve the local draft and the remote saved text', async ({ page }) => {
  const name = unique('context-conflict');
  const created = await (await page.request.post('/api/productivity/context-packs', { headers, data: { name } })).json();
  const pack = await (await page.request.post(`/api/productivity/context-packs/${created.id}/items`, {
    headers, data: { version: created.version, kind: 'note', title: 'Working note', text: 'Original saved text' },
  })).json();
  try {
    await page.goto('/#/context-packs');
    await page.getByRole('button', { name: `${name} 묶음 열기`, exact: true }).click();
    const note = dialog(page).locator('.context-pack-item').first();
    await note.getByLabel('메모 내용', { exact: true }).fill('Local draft must remain');
    const remote = await page.request.patch(`/api/productivity/context-packs/${pack.id}/items/${pack.items[0].id}`, {
      headers, data: { version: pack.version, text: 'Remote saved text' },
    });
    expect(remote.status()).toBe(200);
    const conflict = page.waitForResponse(response => response.url().endsWith(`/items/${pack.items[0].id}`) && response.request().method() === 'PATCH');
    await note.getByRole('button', { name: '메모 저장', exact: true }).click();
    expect((await conflict).status()).toBe(409);
    await expect(note.getByLabel('메모 내용', { exact: true })).toHaveValue('Local draft must remain');
    const saved = await (await page.request.get(`/api/productivity/context-packs/${pack.id}`)).json();
    expect(saved.items[0].text).toBe('Remote saved text');
  } finally { await removePack(page, pack.id); }
});

test('a project run can select reusable context without a project assignment', async ({ page }) => {
  const name = unique('shared-context');
  const pack = await (await page.request.post('/api/productivity/context-packs', {
    headers, data: { name, projectId: null },
  })).json();
  await page.request.post(`/api/productivity/context-packs/${pack.id}/items`, {
    headers, data: { version: pack.version, kind: 'note', title: 'Shared guidance', text: 'Keep this reusable guidance with the operator prompt.' },
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '새 실행', exact: true }).first().click();
    await dialog(page).getByLabel('프롬프트', { exact: true }).fill('The operator prompt stays intact.');
    await dialog(page).getByRole('button', { name: '컨텍스트 연결', exact: true }).click();
    const choice = dialog(page).getByRole('checkbox', { name: new RegExp(name) });
    await expect(choice).toBeVisible();
    await choice.check();
    await dialog(page).getByRole('button', { name: '선택한 컨텍스트 추가', exact: true }).click();
    await expect(dialog(page).getByLabel('프롬프트', { exact: true })).toHaveValue(/The operator prompt stays intact/);
    await expect(dialog(page).getByLabel('프롬프트', { exact: true })).toHaveValue(/Keep this reusable guidance/);
    const templates = await (await page.request.get('/api/templates')).json();
    const plain = templates.find((item: { variables?: unknown[] }) => !item.variables?.length);
    await dialog(page).getByLabel('템플릿 (선택)', { exact: true }).selectOption(plain.id);
    await expect(dialog(page).getByRole('button', { name: '명령 미리보기', exact: true })).toBeDisabled();
    await expect(dialog(page).getByRole('button', { name: '선택한 컨텍스트 추가', exact: true })).toBeEnabled();
    await dialog(page).getByRole('button', { name: '선택한 컨텍스트 추가', exact: true }).click();
    const prompt = await dialog(page).getByLabel('프롬프트', { exact: true }).inputValue();
    expect(prompt.match(/Keep this reusable guidance/g)).toHaveLength(1);
    await expect(dialog(page).getByRole('button', { name: '명령 미리보기', exact: true })).toBeEnabled();
  } finally { await removePack(page, pack.id); }
});

test('choosing a template in the palette replaces an existing run preparation and its preview', async ({ page }) => {
  const name = unique('replacement-template');
  const template = await (await page.request.post('/api/templates', { headers,
    data: { name, description: '', category: 'review', prompt: 'The newly selected template prompt.', agent: 'any', policy: 'read-only' } })).json();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '새 실행', exact: true }).first().click();
    await dialog(page).getByLabel('프롬프트', { exact: true }).fill('The previous run preparation.');
    await dialog(page).getByRole('button', { name: '명령 미리보기', exact: true }).click();
    await expect(dialog(page).locator('.command-preview')).toBeVisible();
    await page.keyboard.press('Control+k');
    const palette = page.locator('dialog.command-palette[open]');
    await expect(palette).toBeVisible();
    await palette.getByRole('combobox').fill(name);
    await palette.getByRole('option', { name: `${name} 템플릿으로 실행 준비`, exact: true }).click();
    await expect(dialog(page).getByLabel('프롬프트', { exact: true })).toHaveValue('The newly selected template prompt.');
    await expect(dialog(page).locator('.command-preview')).toHaveCount(0);
  } finally {
    if (test.info().status !== 'timedOut') await page.request.delete(`/api/templates/${template.id}`, { headers, data: {} });
  }
});
