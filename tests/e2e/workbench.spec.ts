import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

let pageErrors: string[] = [];
const topDialog = (page: Page) => page.locator('dialog[open]').last();
const closeDialog = async (page: Page) => { await topDialog(page).getByRole('button', { name: '닫기', exact: true }).first().click(); };

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const health = await page.request.get('/api/health');
  expect((await health.json()).demo).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '워크스페이스 개요', exact: true })).toBeVisible();
});
test.afterEach(() => { expect(pageErrors).toEqual([]); });

test('all seven workspaces load real data without runtime errors or desktop overflow', async ({ page }) => {
  await expect(page.locator('.demo-banner')).toContainText('데모 워크스페이스');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => [...document.fonts].some((font) => font.family === 'NanumSquare' && font.status === 'loaded'))).toBe(true);
  await expect(page.locator('.agent-lane')).toHaveCount(3);
  const pages = ['overview', 'sessions', 'runs', 'projects', 'analytics', 'templates', 'settings'];
  for (const name of pages) {
    await page.locator(`aside.sidebar a[href="#/${name}"]`).click();
    await expect(page.locator('main h1')).toBeVisible();
    await expect(page.locator('main')).not.toContainText('화면을 표시하지 못했습니다');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  }
  await page.locator('aside.sidebar a[href="#/overview"]').click();
  await page.screenshot({ path: 'artifacts/overview-e2e.png', fullPage: true });
});

test('searches Korean transcript text, filters providers and paginates the archive', async ({ page }) => {
  await page.locator('aside.sidebar a[href="#/sessions"]').click();
  const rows = page.locator('.session-table tbody tr');
  await expect(rows).toHaveCount(20);
  await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
  await expect(page.getByRole('button', { name: '2페이지', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('textbox', { name: '세션 전체 내용 검색' }).fill('동시에 들어오는 요청');
  await expect(rows).toHaveCount(20);
  await page.getByRole('button', { name: 'Codex', exact: true }).click();
  await expect(page.locator('.provider-cell').filter({ hasText: 'Claude' })).toHaveCount(0);
  await expect(page.locator('.results-heading')).toContainText('28');
  await page.getByRole('textbox', { name: '세션 전체 내용 검색' }).fill('존재하지않는검색어-e2e');
  await expect(page.getByRole('heading', { name: '검색 조건에 맞는 세션이 없습니다' })).toBeVisible();
  await page.getByRole('button', { name: '필터 초기화', exact: true }).click();
  await expect(rows).toHaveCount(20);
});

test('saves searchable notes and tags, preserves bookmarks, and exports all three formats', async ({ page }) => {
  await page.locator('aside.sidebar a[href="#/sessions"]').click();
  await page.locator('.session-table tbody .session-open').first().click();
  let dialog = topDialog(page);
  await expect(dialog.getByRole('tab', { name: '대화', exact: true })).toBeVisible();
  await dialog.getByRole('tab', { name: '메모·태그', exact: true }).click();
  const note = '브라우저검증-메모-e2e token=e2e-private-secret';
  await dialog.getByRole('textbox', { name: '메모', exact: true }).fill(note);
  await dialog.getByRole('tab', { name: '대화', exact: true }).click();
  await dialog.getByRole('tab', { name: '메모·태그', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '메모', exact: true })).toHaveValue(note);
  await dialog.getByRole('textbox', { name: '태그', exact: true }).fill('e2e-verified, 회귀 검증');
  await dialog.getByRole('button', { name: '메모·태그 저장', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '메모', exact: true })).toHaveValue('브라우저검증-메모-e2e token=[REDACTED]');
  const bookmark = dialog.getByRole('button', { name: /북마크 (추가|해제)/ });
  const wasBookmarked = await bookmark.getAttribute('aria-pressed');
  await bookmark.click();
  await expect(bookmark).toHaveAttribute('aria-pressed', wasBookmarked === 'true' ? 'false' : 'true');
  for (const format of ['json', 'md', 'html']) {
    await dialog.getByRole('combobox', { name: '내보내기 형식' }).selectOption(format);
    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '내보내기', exact: true }).click();
    const download = await downloadPromise;
    const body = await readFile((await download.path())!, 'utf8');
    expect(body).toContain('브라우저검증-메모-e2e');
    expect(body).not.toContain('e2e-private-secret');
    if (format === 'json') expect(JSON.parse(body).tags).toContain('e2e-verified');
    if (format === 'html') expect(body).toContain('<!doctype html>');
  }
  await closeDialog(page);
  await page.getByRole('textbox', { name: '세션 전체 내용 검색' }).fill('브라우저검증-메모-e2e');
  await expect(page.locator('.session-table tbody tr')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.session-table tbody tr')).toHaveCount(1);
  await page.locator('.session-table .session-open').first().click();
  dialog = topDialog(page);
  await dialog.getByRole('tab', { name: '메모·태그', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '태그', exact: true })).toHaveValue('e2e-verified, 회귀 검증');
});

test('compares two selected sessions and prepares an editable cross-agent handoff', async ({ page }) => {
  await page.locator('aside.sidebar a[href="#/sessions"]').click();
  await page.locator('.session-table tbody input[type="checkbox"]').nth(0).check();
  await page.locator('.session-table tbody input[type="checkbox"]').nth(1).check();
  await page.getByRole('button', { name: '세션 비교', exact: true }).click();
  await expect(topDialog(page)).toContainText('codex-default');
  await expect(topDialog(page)).toContainText('claude-default');
  await closeDialog(page);
  await page.locator('.session-table tbody .session-open').first().click();
  await topDialog(page).getByRole('button', { name: '다른 에이전트에 전달', exact: true }).click();
  await topDialog(page).getByRole('button', { name: 'Kiro CLI', exact: true }).click();
  await topDialog(page).getByRole('textbox', { name: '추가 지시사항 (선택)' }).fill('회귀 테스트를 이어서 확인하세요.');
  await topDialog(page).getByRole('button', { name: '전달 프롬프트 준비', exact: true }).click();
  await expect(topDialog(page).getByRole('textbox', { name: '프롬프트', exact: true })).toHaveValue(/회귀 테스트를 이어서 확인하세요/);
  await expect(topDialog(page).getByRole('button', { name: 'Kiro CLI', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(topDialog(page).getByRole('button', { name: '실행 시작', exact: true })).toBeDisabled();
});

test('previews commands for all providers and keeps demo execution disabled', async ({ page }) => {
  await page.getByRole('button', { name: '새 실행', exact: true }).first().click();
  const dialog = topDialog(page);
  await dialog.getByRole('textbox', { name: '프롬프트', exact: true }).fill('현재 프로젝트를 읽고 개선점을 정리하세요.');
  for (const provider of ['Codex', 'Claude Code', 'Kiro CLI']) {
    await dialog.getByRole('button', { name: provider, exact: true }).click();
    await dialog.getByRole('button', { name: '명령 미리보기', exact: true }).click();
    await expect(dialog.getByText('실행 명령 확인', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '실행 시작', exact: true })).toBeDisabled();
  }
  await dialog.getByRole('radio', { name: /워크스페이스 쓰기/ }).check();
  await dialog.getByRole('checkbox', { name: /터미널 명령 허용/ }).check();
  await dialog.getByRole('button', { name: '명령 미리보기', exact: true }).click();
  await expect(dialog.locator('.command-preview pre')).toContainText('trust-tools');
  await dialog.getByRole('textbox', { name: '프롬프트', exact: true }).fill('미리보기 뒤에 변경한 작업');
  await expect(dialog.locator('.command-preview')).toHaveCount(0);
});

test('keeps subagent history separate, blocks unsupported resume and opens its parent', async ({ page }) => {
  await page.locator('aside.sidebar a[href="#/sessions"]').click();
  await page.getByRole('textbox', { name: '세션 전체 내용 검색' }).fill('subagent');
  await expect(page.locator('.session-table tbody tr')).toHaveCount(1);
  await page.locator('.session-table tbody .session-open').click();
  await expect(topDialog(page).getByRole('button', { name: '이어가기', exact: true })).toBeDisabled();
  await topDialog(page).getByRole('tab', { name: '세션 정보', exact: true }).click();
  await topDialog(page).getByText('원본 기록 정보', { exact: true }).click();
  await topDialog(page).getByRole('button', { name: '상위 세션 열기', exact: true }).click();
  await expect(topDialog(page).getByRole('heading', { name: '검색 결과 페이지의 접근성 점검', exact: true })).toBeVisible();
});

test('pages long conversations and searches text beyond a bounded preview', async ({ page }) => {
  await page.locator('aside.sidebar a[href="#/sessions"]').click();
  await page.getByRole('textbox', { name: '세션 전체 내용 검색' }).fill('대규모 로그');
  await expect(page.locator('.session-table tbody tr')).toHaveCount(1);
  await page.locator('.session-table tbody .session-open').click();
  const dialog = topDialog(page);
  await expect(dialog.locator('article.conversation-message')).toHaveCount(50);
  await expect(dialog.getByRole('navigation', { name: '메시지 페이지' })).toContainText('1–50 / 180');
  await dialog.getByRole('button', { name: '마지막 메시지', exact: true }).click();
  await expect(dialog.getByRole('navigation', { name: '메시지 페이지' })).toContainText('151–180 / 180');
  await dialog.getByRole('button', { name: '처음 메시지', exact: true }).click();
  await expect(dialog.getByRole('navigation', { name: '메시지 페이지' })).toContainText('1–50 / 180');
  await dialog.getByRole('button', { name: '다음 메시지', exact: true }).click();
  await expect(dialog.getByRole('navigation', { name: '메시지 페이지' })).toContainText('51–100 / 180');
  await dialog.getByRole('textbox', { name: '대화에서 찾기' }).fill('후반부 점검 결과');
  await expect(dialog.locator('article.conversation-message')).toHaveCount(1);
  await expect(dialog.locator('mark').first()).toContainText('후반부 점검 결과');
  await expect(dialog.locator('.message-expansion-controls')).toContainText('미리보기');
  const fullResponse = page.waitForResponse((response) => response.url().endsWith('/messages/long-message-80'));
  await dialog.getByRole('button', { name: '전체 메시지 보기', exact: true }).click();
  expect((await (await fullResponse).json()).content.length).toBeGreaterThan(64000);
  await expect(dialog.locator('.message-expansion-controls')).toContainText('전체 내용');
  await expect(dialog.getByRole('button', { name: '미리보기로 접기', exact: true })).toBeVisible();
});

test('creates, edits, uses and deletes a reusable prompt template', async ({ page }) => {
  const name = `브라우저 검증 템플릿 ${Date.now()}`;
  await page.locator('aside.sidebar a[href="#/templates"]').click();
  await page.getByRole('button', { name: '새 템플릿', exact: true }).click();
  await topDialog(page).getByRole('textbox', { name: '템플릿 이름', exact: true }).fill(name);
  await topDialog(page).getByRole('textbox', { name: '설명', exact: true }).fill('반복 가능한 운영 검증');
  await topDialog(page).getByRole('textbox', { name: '프롬프트', exact: true }).fill('현재 상태를 읽고 검증 결과를 정리하세요.');
  await topDialog(page).getByRole('button', { name: '템플릿 저장', exact: true }).click();
  const card = page.locator('.template-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: `${name} 템플릿 편집`, exact: true }).click();
  await topDialog(page).getByRole('textbox', { name: '프롬프트', exact: true }).fill('변경된 프롬프트로 검증하세요.');
  await topDialog(page).getByRole('button', { name: '템플릿 저장', exact: true }).click();
  await card.getByRole('button', { name: '템플릿 사용', exact: true }).click();
  await expect(topDialog(page).getByRole('textbox', { name: '프롬프트', exact: true })).toHaveValue('변경된 프롬프트로 검증하세요.');
  await closeDialog(page);
  await card.getByRole('button', { name: `${name} 템플릿 삭제`, exact: true }).click();
  await topDialog(page).getByRole('button', { name: '템플릿 삭제', exact: true }).click();
  await expect(card).toHaveCount(0);
});

test('registers a project, changes execution permission and persists configuration', async ({ page }) => {
  const name = `검증 프로젝트 ${Date.now()}`;
  await page.locator('aside.sidebar a[href="#/projects"]').click();
  await page.getByRole('button', { name: '프로젝트 추가', exact: true }).click();
  await topDialog(page).getByRole('textbox', { name: '프로젝트 이름', exact: true }).fill(name);
  await topDialog(page).getByRole('textbox', { name: '프로젝트 경로', exact: true }).fill(`/workspace/e2e-${Date.now()}`);
  await topDialog(page).getByRole('button', { name: '프로젝트 추가', exact: true }).click();
  const card = page.locator('.project-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const permission = card.getByRole('switch', { name: `${name} 에이전트 실행 허용`, exact: true });
  await expect(permission).toHaveAttribute('aria-checked', 'false');
  await permission.click();
  await expect(permission).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await expect(permission).toHaveAttribute('aria-checked', 'true');
  await page.locator('aside.sidebar a[href="#/settings"]').click();
  await page.getByRole('spinbutton', { name: '최대 동시 실행', exact: true }).fill('3');
  await page.getByRole('button', { name: '설정 저장', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('spinbutton', { name: '최대 동시 실행', exact: true })).toHaveValue('3');
  await page.getByRole('button', { name: /다크 눈이 편안한/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'artifacts/settings-dark.png', fullPage: true });
  await page.getByRole('button', { name: /라이트 밝고 선명한/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('uses the command palette with a keyboard and returns focus on dismissal', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const dialog = topDialog(page);
  const input = dialog.getByRole('combobox', { name: '빠른 검색 및 이동', exact: true });
  await expect(input).toBeFocused();
  await input.fill('템플릿');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '프롬프트 템플릿', exact: true })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(topDialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
});

test('reads failure output and filters recorded execution logs', async ({ page }) => {
  await page.locator('aside.sidebar a[href="#/runs"]').click();
  await page.getByText('배포 파이프라인 점검', { exact: true }).click();
  await expect(topDialog(page).getByRole('region', { name: '실행 출력', exact: true })).toContainText('missing cache namespace');
  await topDialog(page).getByRole('combobox', { name: '로그 스트림 필터' }).selectOption('stderr');
  await expect(topDialog(page).locator('.log-line')).toHaveCount(1);
  await topDialog(page).getByRole('textbox', { name: '실행 로그 검색' }).fill('no-matching-output');
  await expect(topDialog(page).getByText('조건에 맞는 로그가 없습니다', { exact: true })).toBeVisible();
  await topDialog(page).getByRole('textbox', { name: '실행 로그 검색' }).fill('');
  await page.screenshot({ path: 'artifacts/run-log-desktop.png', fullPage: true });
});

test('mobile navigation, conversations and run forms remain usable without document overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: 'artifacts/overview-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
  await topDialog(page).getByRole('link', { name: /^세션/ }).click();
  await expect(page.getByRole('heading', { name: '세션 탐색', exact: true })).toBeVisible();
  await page.locator('.session-table tbody .session-open').first().click();
  await expect(topDialog(page).getByRole('tab', { name: '대화', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/session-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await closeDialog(page);
  await page.getByRole('button', { name: '새 실행', exact: true }).first().click();
  await topDialog(page).getByRole('textbox', { name: '프롬프트', exact: true }).fill('모바일에서 작업 미리보기');
  await topDialog(page).getByRole('button', { name: '명령 미리보기', exact: true }).click();
  await expect(topDialog(page).getByText('실행 명령 확인', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
