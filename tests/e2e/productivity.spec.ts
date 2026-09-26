import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const headers = { 'X-Agent-Ops': '1' };
const topDialog = (page: Page) => page.locator('dialog[open]').last();
const unique = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
async function removeVersioned(page: Page, kind: 'work-items' | 'context-packs' | 'saved-views', id?: string) {
  if (!id || test.info().status === 'timedOut') return;
  let value;
  if (kind === 'saved-views') {
    const response = await page.request.get('/api/productivity/saved-views');
    value = (await response.json()).items.find((item: { id: string }) => item.id === id);
  } else {
    const response = await page.request.get(`/api/productivity/${kind}/${id}`);
    if (!response.ok()) return;
    value = await response.json();
  }
  if (value) await page.request.delete(`/api/productivity/${kind}/${id}`, { headers, data: { version: value.version } });
}

test('creates, reopens, archives and deletes a work item through its editor', async ({ page }) => {
  const name = unique('productive-work');
  let itemId: string | undefined;
  try {
    await page.goto('/#/work-items');
    await page.getByRole('button', { name: '새 작업', exact: true }).click();
    await topDialog(page).getByLabel('작업 제목', { exact: true }).fill(name);
    await topDialog(page).getByLabel('다음 할 일', { exact: true }).fill('Add a focused regression check.');
    await topDialog(page).getByLabel('우선순위', { exact: true }).selectOption('high');
    const created = page.waitForResponse(response => response.url().endsWith('/api/productivity/work-items') && response.request().method() === 'POST');
    await topDialog(page).getByRole('button', { name: '작업 저장', exact: true }).click();
    const result = await created;
    expect(result.status()).toBe(201);
    itemId = (await result.json()).id;
    await expect(topDialog(page).getByRole('button', { name: '작업 저장', exact: true })).toBeDisabled();
    await topDialog(page).getByRole('button', { name: '닫기', exact: true }).first().click();
    await page.reload();
    await page.getByRole('button', { name: `${name} 작업 열기`, exact: true }).click();
    await expect(topDialog(page).getByLabel('다음 할 일', { exact: true })).toHaveValue('Add a focused regression check.');
    await topDialog(page).getByRole('button', { name: '작업 보관', exact: true }).click();
    await topDialog(page).getByRole('button', { name: '작업 보관', exact: true }).click();
    await expect(topDialog(page).getByRole('button', { name: '작업 다시 열기', exact: true })).toBeVisible();
    await topDialog(page).getByRole('button', { name: '작업 다시 열기', exact: true }).click();
    await topDialog(page).getByRole('button', { name: '작업 다시 열기', exact: true }).click();
    await expect(topDialog(page).getByRole('button', { name: '실행 준비', exact: true })).toBeEnabled();
    await topDialog(page).getByRole('button', { name: '작업 삭제', exact: true }).click();
    await topDialog(page).getByRole('button', { name: '작업 삭제', exact: true }).click();
    await expect(page.getByRole('button', { name: `${name} 작업 열기`, exact: true })).toHaveCount(0);
    expect((await page.request.get(`/api/productivity/work-items/${itemId}`)).status()).toBe(404);
  } finally { await removeVersioned(page, 'work-items', itemId); }
});

test('keeps the local work draft when another editor changes the saved version', async ({ page }) => {
  const name = unique('concurrent-work');
  const response = await page.request.post('/api/productivity/work-items', { headers,
    data: { title: name, nextAction: 'Original next action' } });
  const item = await response.json();
  try {
    await page.goto(`/#/work-items?id=${item.id}`);
    await topDialog(page).getByLabel('다음 할 일', { exact: true }).fill('My unsaved next action');
    expect((await page.request.patch(`/api/productivity/work-items/${item.id}`, { headers,
      data: { version: item.version, nextAction: 'Remote saved next action' } })).status()).toBe(200);
    const conflict = page.waitForResponse(result => result.url().endsWith(`/work-items/${item.id}`) && result.request().method() === 'PATCH');
    await topDialog(page).getByRole('button', { name: '작업 저장', exact: true }).click();
    expect((await conflict).status()).toBe(409);
    await expect(topDialog(page).getByLabel('다음 할 일', { exact: true })).toHaveValue('My unsaved next action');
    await expect(topDialog(page).locator('.work-editor-error')).toBeVisible();
    const current = await (await page.request.get(`/api/productivity/work-items/${item.id}`)).json();
    expect(current.nextAction).toBe('Remote saved next action');
  } finally { await removeVersioned(page, 'work-items', item.id); }
});

test('captures a displayed message, adds a note, exports redacted context and prepares a run', async ({ page }) => {
  const name = unique('selected-context');
  let packId: string | undefined;
  let workId: string | undefined;
  try {
    await page.goto('/#/sessions');
    await page.locator('.session-table .session-open').first().click();
    await topDialog(page).getByRole('button', { name: '작업으로 저장', exact: true }).click();
    await topDialog(page).getByLabel('다음 할 일', { exact: true }).fill('Continue from this source session.');
    const createdWork = page.waitForResponse(response => response.url().endsWith('/api/productivity/work-items') && response.request().method() === 'POST');
    await topDialog(page).getByRole('button', { name: '작업 저장', exact: true }).click();
    const sourceWork = await (await createdWork).json();
    workId = sourceWork.id;
    expect(sourceWork.sessionIds).toHaveLength(1);
    await topDialog(page).getByRole('button', { name: '컨텍스트 묶음에 추가', exact: true }).first().click();
    await topDialog(page).getByLabel('새 묶음 이름', { exact: true }).fill(name);
    const created = page.waitForResponse(response => response.url().endsWith('/api/productivity/context-packs') && response.request().method() === 'POST');
    await topDialog(page).getByRole('button', { name: '새 묶음을 만들고 선택', exact: true }).click();
    packId = (await (await created).json()).id;
    await expect(topDialog(page).getByRole('button', { name: '인용 저장', exact: true })).toBeEnabled();
    const captured = page.waitForResponse(response => response.url().endsWith(`/context-packs/${packId}/items`) && response.request().method() === 'POST');
    await topDialog(page).getByRole('button', { name: '인용 저장', exact: true }).click();
    const pack = await (await captured).json();
    expect(pack.items[0].kind).toBe('message');
    expect(pack.items[0].text.length).toBeGreaterThan(0);
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    await topDialog(page).getByRole('button', { name: '닫기', exact: true }).first().click();
    await page.locator('aside.sidebar a[href="#/context-packs"]').click();
    await page.getByRole('button', { name: `${name} 묶음 열기`, exact: true }).click();
    await expect(topDialog(page).getByLabel('저장한 인용 (읽기 전용)', { exact: true })).toHaveValue(pack.items[0].text);
    const note = topDialog(page).locator('.context-pack-add-note');
    await note.getByLabel('메모 제목', { exact: true }).fill('Acceptance criteria');
    await note.getByLabel('메모 내용', { exact: true }).fill('Keep behavior. token=productive-fake-secret');
    await note.getByRole('button', { name: '메모 추가', exact: true }).click();
    await expect(topDialog(page).locator('.context-pack-item')).toHaveCount(2);
    await topDialog(page).getByRole('button', { name: '컨텍스트 조합', exact: true }).click();
    const output = topDialog(page).getByLabel('조합한 컨텍스트', { exact: true });
    await expect(output).toHaveValue(/Acceptance criteria/);
    await expect(output).toHaveValue(/\[REDACTED\]/);
    expect(await output.inputValue()).not.toContain('productive-fake-secret');
    const download = page.waitForEvent('download');
    await topDialog(page).getByRole('button', { name: 'JSON', exact: true }).click();
    const file = await download;
    const exported = await readFile((await file.path())!, 'utf8');
    expect(JSON.parse(exported).pack.items).toHaveLength(2);
    expect(exported).not.toContain('productive-fake-secret');
    await topDialog(page).getByRole('button', { name: '실행 준비', exact: true }).click();
    await expect(topDialog(page).getByLabel('프롬프트', { exact: true })).toHaveValue(/Acceptance criteria/);
    await expect(topDialog(page).getByRole('button', { name: '실행 시작', exact: true })).toBeDisabled();
  } finally {
    await removeVersioned(page, 'work-items', workId);
    await removeVersioned(page, 'context-packs', packId);
  }
});

test('attaches saved context to a work item and prepares its current version', async ({ page }) => {
  const name = unique('work-context');
  const pack = await (await page.request.post('/api/productivity/context-packs', { headers, data: { name } })).json();
  await page.request.post(`/api/productivity/context-packs/${pack.id}/items`, { headers,
    data: { version: pack.version, kind: 'note', title: 'Selected evidence', text: 'Check the observed failure before changing the code.' } });
  const item = await (await page.request.post('/api/productivity/work-items', { headers,
    data: { title: name, nextAction: 'Use the selected evidence.' } })).json();
  try {
    await page.goto(`/#/work-items?id=${item.id}`);
    await topDialog(page).getByRole('button', { name: '컨텍스트 선택', exact: true }).click();
    await topDialog(page).getByRole('checkbox', { name: new RegExp(name) }).check();
    await topDialog(page).getByRole('button', { name: '작업 저장', exact: true }).click();
    await expect(topDialog(page).getByRole('button', { name: '실행 준비', exact: true })).toBeEnabled();
    await topDialog(page).getByRole('button', { name: '실행 준비', exact: true }).click();
    await expect(topDialog(page).getByLabel('프롬프트', { exact: true })).toHaveValue(/Check the observed failure/);
    const prepared = page.waitForRequest(request => request.url().endsWith('/api/runs/preview') && request.method() === 'POST');
    await topDialog(page).getByRole('button', { name: '명령 미리보기', exact: true }).click();
    const body = (await prepared).postDataJSON();
    expect(body.workItemId).toBe(item.id);
    expect(body.workItemVersion).toBe(2);
    expect(body.contextPackIds).toEqual([pack.id]);
    await expect(topDialog(page).getByRole('button', { name: '실행 시작', exact: true })).toBeDisabled();
  } finally {
    await removeVersioned(page, 'work-items', item.id);
    await removeVersioned(page, 'context-packs', pack.id);
  }
});

test('applies template inputs once and preserves literal values in an editable run prompt', async ({ page }) => {
  await page.goto('/#/templates');
  const card = page.locator('.template-card').filter({ has: page.getByRole('heading', { name: 'Focused review with inputs', exact: true }) });
  await card.getByRole('button', { name: '템플릿 사용', exact: true }).click();
  await topDialog(page).getByLabel('Review target', { exact: true }).fill('src/service.ts');
  await topDialog(page).getByLabel('Review goal', { exact: true }).fill('Keep literal {{other}} and $(text) as requested.');
  await topDialog(page).getByLabel('Result format', { exact: true }).selectOption('a detailed report');
  await topDialog(page).getByRole('button', { name: '프롬프트 적용', exact: true }).click();
  await expect(topDialog(page).getByLabel('프롬프트', { exact: true })).toHaveValue(/Review src\/service.ts/);
  await expect(topDialog(page).getByLabel('프롬프트', { exact: true })).toHaveValue(/literal \{\{other\}\} and \$\(text\)/);
  await topDialog(page).getByRole('button', { name: '명령 미리보기', exact: true }).click();
  await expect(topDialog(page).locator('.command-preview')).toBeVisible();
  await topDialog(page).getByLabel('프롬프트', { exact: true }).fill('An operator edited the rendered prompt.');
  await expect(topDialog(page).locator('.command-preview')).toHaveCount(0);
  await expect(topDialog(page).getByRole('button', { name: '실행 시작', exact: true })).toBeDisabled();
});

test('restores a template revision through the UI without reloading the native archive', async ({ page }) => {
  const name = unique('revision-template');
  const created = await page.request.post('/api/templates', { headers,
    data: { name, description: 'First description', category: 'review', prompt: 'Review the original scope.', agent: 'any', policy: 'read-only' } });
  const template = await created.json();
  try {
    await page.request.patch(`/api/templates/${template.id}`, { headers,
      data: { expectedRevision: template.revision, prompt: 'Review a changed scope.' } });
    await page.goto('/#/templates');
    await page.getByRole('button', { name: `${name} 템플릿 이력`, exact: true }).click();
    await topDialog(page).getByLabel('미리 볼 개정', { exact: true }).selectOption('1');
    await expect(topDialog(page).locator('.template-revision-prompt')).toContainText('Review the original scope.');
    let archiveReads = 0;
    page.on('request', request => { if (request.url().endsWith('/api/bootstrap')) archiveReads++; });
    const restored = page.waitForResponse(response => response.url().endsWith(`/templates/${template.id}/restore`));
    await topDialog(page).getByRole('button', { name: '새 개정으로 복원', exact: true }).click();
    expect((await restored).status()).toBe(200);
    const card = page.locator('.template-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(card.locator('.template-prompt-preview')).toHaveText('Review the original scope.');
    expect(archiveReads).toBe(0);
    const history = await (await page.request.get(`/api/templates/${template.id}/history`)).json();
    expect(history.map((revision: { revision: number }) => revision.revision)).toEqual([3, 2, 1]);
  } finally { await page.request.delete(`/api/templates/${template.id}`, { headers, data: {} }); }
});

test('reopens saved filters on a new day and replaces previous URL conditions', async ({ page }) => {
  const name = unique('saved-calendar');
  let id: string | undefined;
  try {
    await page.clock.setFixedTime(new Date('2026-09-26T12:00:00Z'));
    await page.goto('/#/sessions?agent=codex&limit=10');
    await page.getByRole('button', { name: '현재 조건 저장', exact: true }).click();
    await topDialog(page).getByLabel('검색 이름', { exact: true }).fill(name);
    await topDialog(page).getByLabel('기간', { exact: true }).selectOption('last7');
    await topDialog(page).getByLabel('빠른 검색에 고정', { exact: true }).check();
    const created = page.waitForResponse(response => response.url().endsWith('/api/productivity/saved-views') && response.request().method() === 'POST');
    await topDialog(page).getByRole('button', { name: '저장', exact: true }).click();
    id = (await (await created).json()).id;
    await page.goto('/#/sessions?q=discard-this&agent=claude&limit=20');
    await page.getByLabel('저장 검색 선택', { exact: true }).selectOption(id!);
    await page.getByRole('button', { name: '저장 검색 열기', exact: true }).click();
    await expect(page).toHaveURL(/agent=codex/);
    let params = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
    expect(params.has('q')).toBe(false);
    expect(params.get('limit')).toBe('10');
    expect(params.get('since')).toBe('2026-09-20T00:00:00.000Z');
    await expect(page.getByLabel('페이지당 세션 수', { exact: true })).toHaveValue('10');
    await page.clock.setFixedTime(new Date('2026-09-28T12:00:00Z'));
    await page.getByRole('button', { name: '저장 검색 열기', exact: true }).click();
    params = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
    expect(params.get('since')).toBe('2026-09-22T00:00:00.000Z');
    expect(params.get('until')).toBe('2026-09-28T23:59:59.999Z');
  } finally { await removeVersioned(page, 'saved-views', id); }
});

test('keeps the selected palette action when asynchronous work results arrive', async ({ page }) => {
  const name = unique('palette-order');
  const work = await (await page.request.post('/api/productivity/work-items', { headers, data: { title: `${name} work` } })).json();
  const template = await (await page.request.post('/api/templates', { headers,
    data: { name: `${name} template`, description: '', category: 'review', prompt: 'Review this exact template.', agent: 'any', policy: 'read-only' } })).json();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let intercepted = false;
  try {
    await page.goto('/');
    await page.route('**/api/productivity/work-items?*', async route => {
      if (new URL(route.request().url()).searchParams.get('q') === name) {
        intercepted = true;
        await gate;
      }
      await route.continue();
    });
    await page.keyboard.press('Control+k');
    const input = topDialog(page).getByRole('combobox');
    await input.fill(name);
    const chosen = topDialog(page).getByRole('option', { name: new RegExp(`${name} template`) });
    await expect(chosen).toBeVisible();
    await input.press('ArrowDown');
    await input.press('ArrowUp');
    await expect(chosen).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => intercepted).toBe(true);
    release();
    await expect(topDialog(page).getByRole('option', { name: new RegExp(`${name} work`) })).toBeVisible();
    await expect(chosen).toHaveAttribute('aria-selected', 'true');
    await input.press('Enter');
    await expect(topDialog(page).getByLabel('프롬프트', { exact: true })).toHaveValue('Review this exact template.');
  } finally {
    release?.();
    await removeVersioned(page, 'work-items', work.id);
    await page.request.delete(`/api/templates/${template.id}`, { headers, data: {} });
  }
});

test('shows both new workspaces in English and fits the mobile navigation and board', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#/work-items');
  await page.getByRole('button', { name: '영어로 전환', exact: true }).click();
  await expect(page.locator('main h1')).toHaveText('Work items');
  await expect(page.locator('.breadcrumb')).toContainText('Work items');
  await page.getByRole('button', { name: 'Board view', exact: true }).click();
  await expect(page.locator('.work-board')).toBeVisible();
  await page.screenshot({ path: 'artifacts/productivity-work-items-en.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await topDialog(page).getByRole('link', { name: 'Context packs', exact: true }).click();
  await expect(page.locator('main h1')).toHaveText('Context packs');
  await page.getByRole('button', { name: 'Switch to Korean', exact: true }).click();
  await expect(page.locator('main h1')).toHaveText('컨텍스트 묶음');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/productivity-context-ko-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});
