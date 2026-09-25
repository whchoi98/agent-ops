import { expect, test, type Page } from '@playwright/test';
import type { McpCheck, McpCheckPreview, McpServerSummary } from '../../shared/mcp';
import {
  fixtureCheckId, fixtureProject, fixtureServerId, mcpCatalog, mcpCheck, mcpConfiguration,
  mcpDetail, mcpPreview, mcpServer,
} from '../../src/features/mcp/testFixtures';

interface FixtureOptions {
  demo?: boolean;
  blocked?: McpServerSummary['checkSupport'];
  running?: boolean;
  missingCheck?: boolean;
  finish?: boolean;
  rejectStart?: boolean;
  expiredPreview?: boolean;
  failCatalog?: boolean;
  holdCatalog?: boolean;
  holdCheck?: boolean;
  dark?: boolean;
}

/** All MCP traffic is intercepted. Non-demo UI fixtures never reach a real probe route. */
async function installMcpFixture(page: Page, options: FixtureOptions = {}) {
  let releaseCatalog = () => {};
  const catalogReady = new Promise<void>(resolve => { releaseCatalog = resolve; });
  if (!options.holdCatalog) releaseCatalog();
  let releaseCheck = () => {};
  const checkReady = new Promise<void>(resolve => { releaseCheck = resolve; });
  if (!options.holdCheck) releaseCheck();
  const source = mcpServer().source;
  const servers: McpServerSummary[] = [
    mcpServer({
      source: { ...source, clients: ['codex-app', 'codex-cli'] }, checkSupport: options.blocked ?? 'supported',
      configuration: mcpConfiguration({ args: ['fixture-argument-secret'], headerNames: ['Authorization'] }),
      findings: options.blocked ? [{
        code: 'headers-helper-unsupported', level: 'error',
        message: 'Dynamic header helper commands are not executed by this workbench.',
      }] : [],
    }),
    mcpServer({ id: 'mcp-aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Code 설정', agent: 'claude',
      source: { ...source, path: '/fixture/code.json', clients: ['claude-code-cli', 'claude-code-desktop'] } }),
    mcpServer({ id: 'mcp-bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Chat 설정', agent: 'claude',
      source: { ...source, path: '/fixture/claude_desktop_config.json', clients: ['claude-desktop-chat'] } }),
    mcpServer({ id: 'mcp-cccccccccccccccccccccccc', name: 'IDE 설정', agent: 'kiro',
      source: { ...source, path: '/fixture/kiro/mcp.json', clients: ['kiro-ide'] } }),
  ];
  const state = {
    mutations: [] as Array<{ path: string; body: Record<string, unknown>; headers: Record<string, string> }>,
    queries: [] as Record<string, string>[],
    checkReads: 0, previewCount: 0,
    result: options.running ? mcpCheck() : null as McpCheck | null,
    preview: null as McpCheckPreview | null,
    rejectStart: Boolean(options.rejectStart),
    failCatalog: Boolean(options.failCatalog),
    missingCheck: Boolean(options.missingCheck),
    releaseCatalog,
    releaseCheck,
    launches: [] as string[],
  };
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/runs$/.test(new URL(request.url()).pathname)) state.launches.push(request.url());
  });
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const bootstrap = await response.json();
    await route.fulfill({ json: {
      ...bootstrap, demo: Boolean(options.demo), projects: [fixtureProject],
      settings: { ...bootstrap.settings, theme: options.dark ? 'dark' : 'light' },
    } });
  });
  await page.route(/\/api\/mcp(?:\/|\?|$)/, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(url.pathname.indexOf('/api/') + 4);
    const method = request.method();
    const body = method === 'POST' ? request.postDataJSON() as Record<string, unknown> : {};
    if (method === 'POST') state.mutations.push({ path, body, headers: request.headers() });
    const scoped = (item: McpServerSummary, projectId: string | null): McpServerSummary => ({
      ...item, projectId,
      scope: projectId && item.id === fixtureServerId ? 'project' : item.scope,
      lastCheck: state.result?.serverId === item.id && state.result.projectId === projectId ? state.result : null,
    });
    if (path === '/mcp' && method === 'GET') {
      state.queries.push(Object.fromEntries(url.searchParams));
      await catalogReady;
      if (state.failCatalog) { await route.fulfill({ status: 503, json: { error: 'fixture catalog unavailable' } }); return; }
      const projectId = url.searchParams.get('projectId');
      const needle = url.searchParams.get('q')?.toLowerCase();
      const items = servers.map(server => scoped(server, projectId)).filter(item =>
        (!needle || item.name.toLowerCase().includes(needle))
        && ['agent', 'scope', 'status', 'transport'].every(key => !url.searchParams.has(key)
          || item[key as 'agent' | 'scope' | 'status' | 'transport'] === url.searchParams.get(key)));
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 20);
      await route.fulfill({ json: mcpCatalog({
        items: items.slice(offset, offset + limit), total: items.length, offset, limit, projectId,
        demo: Boolean(options.demo), activeCheck: state.result?.status === 'running' ? state.result : null,
      }) });
      return;
    }
    if (path === '/mcp/refresh' && method === 'POST') {
      await route.fulfill({ json: { ok: true } }); return;
    }
    if (path === `/mcp/checks/${fixtureCheckId}` && method === 'GET') {
      state.checkReads++;
      if (state.missingCheck) {
        state.result = null;
        await route.fulfill({ status: 404, json: { error: 'MCP check result not found or evicted from bounded memory.' } });
        return;
      }
      if (state.result?.status === 'running' && options.finish !== false && state.checkReads >= 2) {
        state.result = mcpCheck({
          ...state.result, status: 'reachable', finishedAt: '2026-09-25T10:00:01Z', durationMs: 1000,
          protocolVersion: '2025-11-25', serverInfo: { name: '원문 서버', version: 'fixture-1' },
          capabilities: { tools: true, resources: false, prompts: true },
          tools: {
            status: 'ok', count: 1, truncated: true,
            items: [{ name: '원문 도구', title: '설정', description: '사용자가 쓴 원문 설명 <script>fixture</script>' }],
          },
          resources: { status: 'unsupported', count: 0, truncated: false, items: [] },
          prompts: { status: 'ok', count: 0, truncated: false, items: [] },
        });
      }
      await route.fulfill({ json: state.result }); return;
    }
    if (path === `/mcp/checks/${fixtureCheckId}/cancel` && method === 'POST') {
      state.result = mcpCheck({
        ...state.result, status: 'cancelled', finishedAt: '2026-09-25T10:00:02Z', durationMs: 2000,
        error: { code: 'cancelled', message: 'The MCP probe was cancelled.' },
      });
      await route.fulfill({ json: state.result }); return;
    }
    const match = /^\/mcp\/(mcp-[a-f0-9]{24})(?:\/(preview|check))?$/.exec(path);
    const server = servers.find(item => item.id === match?.[1]);
    if (server && !match?.[2] && method === 'GET') {
      const item = scoped(server, url.searchParams.get('projectId'));
      await route.fulfill({ json: mcpDetail({
        ...item, lastResult: item.lastCheck ? state.result : null, demo: Boolean(options.demo),
      }) });
      return;
    }
    if (server && match?.[2] === 'preview' && method === 'POST') {
      state.previewCount++;
      state.preview = mcpPreview({
        serverId: server.id, projectId: typeof body.projectId === 'string' ? body.projectId : null,
        previewId: `mcp-preview-00000000-0000-4000-8000-${String(state.previewCount).padStart(12, '0')}`,
        expiresAt: new Date(Date.now() + (options.expiredPreview ? -5000 : 60000)).toISOString(),
        configuration: server.configuration, demo: Boolean(options.demo),
      });
      await route.fulfill({ json: state.preview }); return;
    }
    if (server && match?.[2] === 'check' && method === 'POST') {
      if (options.demo) { await route.fulfill({ status: 403, json: { error: 'Demo checks are disabled.' } }); return; }
      if (state.result?.status === 'running') {
        await route.fulfill({ status: 409, json: { error: 'Another MCP probe is in progress. Cancel it or wait for cleanup to finish.' } });
        return;
      }
      if (state.rejectStart) {
        state.rejectStart = false;
        await route.fulfill({ status: 409, json: { error: 'Configuration or execution settings changed. Review a new preview.' } });
        return;
      }
      if (!state.preview || body.previewId !== state.preview.previewId) {
        await route.fulfill({ status: 409, json: { error: 'A current preview is required.' } }); return;
      }
      state.checkReads = 0;
      state.result = mcpCheck({ serverId: server.id, projectId: typeof body.projectId === 'string' ? body.projectId : null });
      await checkReady;
      await route.fulfill({ status: 202, json: state.result }); return;
    }
    // Unexpected paths cannot escape the fixture to the real server.
    await route.fulfill({ status: 404, json: { error: 'Unexpected synthetic MCP request.' } });
  });
  return state;
}

async function english(page: Page) {
  await page.addInitScript(() => localStorage.setItem('agent-ops-language', 'en'));
}

async function openDeclaration(page: Page) {
  await page.getByRole('button', { name: 'View 원문 서버 configuration and checks', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Configuration analysis', exact: true })).toBeVisible();
  return dialog;
}

test('MCP navigation, provider filters and client provenance preserve read-only configuration', async ({ page }) => {
  const state = await installMcpFixture(page);
  await page.goto('/');
  await page.locator('aside.sidebar a[href="#/mcp"]').click();
  await expect(page.getByRole('heading', { name: 'MCP 서버', exact: true })).toBeVisible();
  await expect(page.locator('.mcp-server-card')).toHaveCount(4);
  await expect(page.locator('.mcp-workspace')).toContainText('Kiro IDE');
  await expect(page.locator('.mcp-workspace')).toContainText('Claude Desktop Chat');
  await page.getByRole('button', { name: '영어로 전환', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'MCP servers', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Filter MCP assistant' }).selectOption('codex');
  await page.getByRole('textbox', { name: 'Search MCP servers' }).fill('원문');
  await expect(page.locator('.mcp-server-card')).toHaveCount(1);
  const dialog = await openDeclaration(page);
  await expect(dialog).toContainText('Assistant connection');
  await expect(dialog).toContainText('Unknown');
  await expect(dialog).toContainText('Not checked');
  await expect(dialog).toContainText('Codex App');
  await expect(dialog).toContainText('does not establish installation');
  await expect(dialog).toContainText('MCP_ACCESS_KEY');
  await expect(dialog).toContainText('Authorization');
  await expect(dialog).not.toContainText('fixture-argument-secret');
  await expect(dialog.getByRole('button', { name: /Edit|Enable|Disable|Start workbench check/ })).toHaveCount(0);
  expect(state.mutations).toEqual([]);
  expect(state.launches).toEqual([]);
});

test('only explicit preview and confirmation start a metadata check, which stops polling when complete', async ({ page }) => {
  await english(page);
  const state = await installMcpFixture(page, { holdCheck: true });
  await page.goto('/#/mcp');
  const dialog = await openDeclaration(page);
  expect(state.mutations).toEqual([]);
  await dialog.getByRole('button', { name: 'Preview check', exact: true }).click();
  const preview = dialog.getByRole('region', { name: 'Preview check', exact: true });
  await expect(preview).toContainText('starts the configured process');
  await expect(preview).toContainText('side effects');
  for (const method of ['initialize', 'notifications/initialized', 'tools/list', 'resources/list', 'prompts/list']) {
    await expect(preview.getByText(method, { exact: true })).toBeVisible();
  }
  expect(state.mutations.map(item => item.path)).toEqual([`/mcp/${fixtureServerId}/preview`]);
  await dialog.getByRole('button', { name: 'Start workbench check', exact: true }).click();
  await expect(dialog).toContainText('Requesting workbench check');
  await expect(dialog.getByRole('button', { name: 'Start workbench check', exact: true })).toHaveAttribute('aria-busy', 'true');
  expect(state.checkReads).toBe(0);
  state.releaseCheck();
  await expect(dialog.getByRole('heading', { name: 'Returned metadata', exact: true })).toBeVisible();
  await expect(dialog.getByText('Responded at check time', { exact: true }).first()).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Tools', exact: true })).toContainText('Returned: 1');
  await expect(dialog).toContainText('Partial list');
  await expect(dialog).toContainText('Total on the server is unknown');
  await expect(dialog).toContainText('사용자가 쓴 원문 설명 <script>fixture</script>');
  await expect(dialog.locator('script, img')).toHaveCount(0);
  await expect(dialog.getByRole('region', { name: 'Resources', exact: true })).toContainText('Not supported');
  await expect(dialog.getByRole('region', { name: 'Prompts', exact: true })).toContainText('No items returned');
  expect(state.mutations.map(item => item.path)).toEqual([`/mcp/${fixtureServerId}/preview`, `/mcp/${fixtureServerId}/check`]);
  expect(state.mutations[1].body).toEqual({ previewId: state.preview?.previewId });
  expect(state.mutations[1].headers['x-agent-ops']).toBe('1');
  const reads = state.checkReads;
  await page.waitForTimeout(1250);
  expect(state.checkReads).toBe(reads);
  expect(state.launches).toEqual([]);
});

for (const condition of ['demo', 'blocked', 'unsupported'] as const) {
  test(`${condition} declarations keep probes disabled`, async ({ page }) => {
    await english(page);
    const state = await installMcpFixture(page, { demo: condition === 'demo', blocked: condition === 'demo' ? undefined : condition });
    await page.goto('/#/mcp');
    const dialog = await openDeclaration(page);
    await expect(dialog.getByRole('button', { name: 'Preview check', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Start workbench check', exact: true })).toHaveCount(0);
    expect(state.mutations).toEqual([]);
    expect(state.checkReads).toBe(0);
  });
}

test('a configuration-change rejection requires a new preview instead of retrying its token', async ({ page }) => {
  await english(page);
  const state = await installMcpFixture(page, { rejectStart: true });
  await page.goto('/#/mcp');
  const dialog = await openDeclaration(page);
  await dialog.getByRole('button', { name: 'Preview check', exact: true }).click();
  await dialog.getByRole('button', { name: 'Start workbench check', exact: true }).click();
  await expect(dialog).toContainText('Configuration or execution settings changed. Review a new preview.');
  await expect(dialog.getByRole('button', { name: 'Start workbench check', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Preview check', exact: true })).toBeEnabled();
  expect(state.mutations.filter(item => item.path.endsWith('/check'))).toHaveLength(1);
  const previousToken = state.preview?.previewId;
  await dialog.getByRole('button', { name: 'Preview check', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Start workbench check', exact: true })).toBeEnabled();
  expect(state.preview?.previewId).not.toBe(previousToken);
  expect(state.mutations.filter(item => item.path.endsWith('/check'))).toHaveLength(1);
});

test('an expired preview cannot start a check', async ({ page }) => {
  await english(page);
  const state = await installMcpFixture(page, { expiredPreview: true });
  await page.goto('/#/mcp');
  const dialog = await openDeclaration(page);
  await dialog.getByRole('button', { name: 'Preview check', exact: true }).click();
  await expect(dialog).toContainText('The preview expired');
  await expect(dialog.getByRole('button', { name: 'Start workbench check', exact: true })).toBeDisabled();
  expect(state.mutations.filter(item => item.path.endsWith('/check'))).toEqual([]);
});

test('a check started elsewhere after preview is recovered from the global catalog after a busy rejection', async ({ page }) => {
  await english(page);
  const state = await installMcpFixture(page, { finish: false });
  await page.goto('/#/mcp');
  const dialog = await openDeclaration(page);
  await dialog.getByRole('button', { name: 'Preview check', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Start workbench check', exact: true })).toBeEnabled();
  state.result = mcpCheck({ serverId: 'mcp-aaaaaaaaaaaaaaaaaaaaaaaa' });
  await dialog.getByRole('button', { name: 'Start workbench check', exact: true }).click();
  await expect(dialog).toContainText('Another MCP probe is in progress');
  const active = dialog.getByRole('region', { name: 'Active workbench check', exact: true });
  await expect(active).toContainText('Code 설정');
  await expect(dialog.getByRole('button', { name: 'Preview check', exact: true })).toBeDisabled();
  expect(state.mutations.filter(item => item.path.endsWith('/check'))).toHaveLength(1);
});

test('an evicted check result is reported without leaving the global check slot permanently blocked', async ({ page }) => {
  await english(page);
  const state = await installMcpFixture(page, { running: true, missingCheck: true });
  await page.goto('/#/mcp');
  await expect(page.locator('.mcp-workspace')).toContainText('MCP check result not found or evicted');
  await expect(page.locator('.mcp-active-check')).toHaveCount(0);
  const dialog = await openDeclaration(page);
  await expect(dialog.getByRole('button', { name: 'Preview check', exact: true })).toBeEnabled();
  await expect(dialog).toContainText('Not checked');
  expect(state.mutations).toEqual([]);
  expect(state.checkReads).toBe(1);
});

test('a global active check blocks another probe, pauses while hidden, and supports explicit cancellation', async ({ page }) => {
  await english(page);
  const state = await installMcpFixture(page, { running: true, finish: false });
  await page.goto('/#/mcp');
  await expect(page.getByRole('region', { name: 'Active workbench check', exact: true })).toBeVisible();
  const dialog = await openDeclaration(page);
  await expect(dialog.getByRole('button', { name: 'Preview check', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Connectivity and metadata check', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Cancel check', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(dialog).toContainText('Requests are paused');
  await page.waitForTimeout(100);
  const reads = state.checkReads;
  await page.waitForTimeout(1300);
  expect(state.checkReads).toBe(reads);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => state.checkReads).toBeGreaterThan(reads);
  await dialog.getByRole('button', { name: 'Cancel check', exact: true }).click();
  await expect(dialog.getByText('Check cancelled', { exact: true }).first()).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel check', exact: true })).toHaveCount(0);
  expect(state.mutations.map(item => item.path)).toEqual([`/mcp/checks/${fixtureCheckId}/cancel`]);
});

test('leaving MCP stops observation without silently cancelling the server-owned check', async ({ page }) => {
  await english(page);
  const state = await installMcpFixture(page, { running: true, finish: false });
  await page.goto('/#/mcp');
  await expect.poll(() => state.checkReads).toBeGreaterThan(0);
  await page.locator('aside.sidebar a[href="#/analytics"]').click();
  await expect(page.locator('.mcp-workspace')).toHaveCount(0);
  await page.waitForTimeout(100);
  const reads = state.checkReads;
  await page.waitForTimeout(1300);
  expect(state.checkReads).toBe(reads);
  expect(state.mutations).toEqual([]);
});

test('catalog errors, empty results, project context, keyboard focus and mobile dark layout remain usable', async ({ page }) => {
  await english(page);
  const state = await installMcpFixture(page, { failCatalog: true, holdCatalog: true, dark: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/mcp');
  await expect(page.locator('.mcp-explorer .skeleton-group')).toBeVisible();
  state.releaseCatalog();
  await expect(page.locator('.mcp-explorer')).toContainText('fixture catalog unavailable');
  state.failCatalog = false;
  await page.locator('.mcp-explorer').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.mcp-server-card')).toHaveCount(4);
  await page.getByRole('textbox', { name: 'Search MCP servers' }).fill('no-synthetic-match');
  await expect(page.getByRole('heading', { name: 'No MCP servers match', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset filters', exact: true }).first().click();
  await page.getByRole('combobox', { name: 'Select MCP project', exact: true }).selectOption(fixtureProject.id);
  await page.getByRole('combobox', { name: 'Filter MCP scope', exact: true }).selectOption('project');
  await expect(page.locator('.mcp-server-card')).toHaveCount(1);
  expect(state.queries.at(-1)?.projectId).toBe(fixtureProject.id);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const opener = page.getByRole('button', { name: 'View 원문 서버 configuration and checks', exact: true });
  const dialog = await openDeclaration(page);
  await expect(dialog).toContainText(fixtureProject.name);
  const analysis = dialog.getByRole('button', { name: 'Configuration analysis', exact: true });
  await analysis.focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('button', { name: 'Connectivity and metadata check', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Preview check', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Start workbench check', exact: true })).toBeEnabled();
  expect(state.mutations.at(-1)?.body.projectId).toBe(fixtureProject.id);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(state.launches).toEqual([]);
});
