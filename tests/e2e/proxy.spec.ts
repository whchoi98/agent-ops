import { test, expect } from '@playwright/test';
import { createServer, request as upstreamRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../../server/app';

test('UI, mutations, fonts and live events work behind a prefix-stripping proxy', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-browser-proxy-'));
  const { app } = await createApp({
    dataDir: dir, demo: true, autoSync: false, staticDir: resolve('dist/client'),
    publicUrl: 'https://workbench.example.com/proxy/4327/',
  });
  const base = '/proxy/4327/';
  const upstream = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
  const paths: string[] = [];
  const proxy = createServer((request, response) => {
    const url = request.url || '/';
    paths.push(url.split('?')[0]);
    if (!url.startsWith(base)) { response.writeHead(404); response.end(); return; }
    const forward = upstreamRequest({
      hostname: '127.0.0.1', port: upstream.port,
      path: `/${url.slice(base.length)}`, method: request.method, headers: request.headers,
    }, (result) => { response.writeHead(result.statusCode || 502, result.headers); result.pipe(response); });
    forward.on('error', () => { response.writeHead(502); response.end(); });
    response.on('close', () => forward.destroy());
    request.pipe(forward);
  });
  await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
  const port = (proxy.address() as { port: number }).port;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${port}${base}`);
    await expect(page.getByRole('heading', { name: '워크스페이스 개요', exact: true })).toBeVisible();
    await expect(page.locator('.sidebar-connection')).toContainText('실시간 갱신 중');
    await page.getByRole('button', { name: '다크 모드로 전환', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('aside.sidebar a[href="#/sessions"]').click();
    await page.getByRole('textbox', { name: '세션 전체 내용 검색' }).fill('대규모 로그');
    await expect(page.locator('.session-table tbody tr')).toHaveCount(1);
    await page.locator('.session-table tbody .session-open').click();
    await expect(page.locator('article.conversation-message')).toHaveCount(50);
    await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).first().click();
    await page.locator('aside.sidebar a[href="#/extensions"]').click();
    await page.getByRole('button', { name: '코드 리뷰 내용 보기', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Read');
    expect(paths).toContain('/proxy/4327/api/extensions');
    expect(paths.some((path) => path.startsWith('/proxy/4327/api/extensions/ext-'))).toBe(true);
    await expect.poll(() => paths.includes('/proxy/4327/api/connector-versions')).toBe(true);
    expect(paths).toContain('/proxy/4327/api/bootstrap');
    expect(paths).toContain('/proxy/4327/api/settings');
    expect(paths).toContain('/proxy/4327/api/events');
    expect(paths.some((path) => path.startsWith('/proxy/4327/assets/'))).toBe(true);
    expect(paths.some((path) => path.startsWith('/proxy/4327/fonts/'))).toBe(true);
    expect(paths.every((path) => path.startsWith(base))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.goto('about:blank');
    proxy.closeAllConnections();
    await new Promise<void>((done) => proxy.close(() => done()));
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
