import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp, type AppContext } from '../server/app.js';
import { Store } from '../server/store.js';
import type { ConnectorStatus } from '../shared/types.js';

const contexts: AppContext[] = [];
const dirs: string[] = [];
async function setup(demo = true) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-api-'));
  dirs.push(dir);
  const ctx = await createApp({ dataDir: dir, demo, autoSync: false });
  contexts.push(ctx);
  return ctx;
}
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.app.close();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const headers = { 'x-agent-ops': '1' };

describe('local API boundary', () => {
  it('rejects cross-origin and rebinding requests including read APIs', async () => {
    const { app } = await setup();
    expect((await app.inject({ url: '/api/bootstrap', headers: { host: 'evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/bootstrap', headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/bootstrap', headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
  });
  it('requires the mutation header and validates settings', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'PATCH', url: '/api/settings', payload: { concurrency: 3 } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: { concurrency: 0 } })).statusCode).toBe(400);
    const response = await app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: { concurrency: 3 } });
    expect(response.statusCode).toBe(200);
    expect(response.json().concurrency).toBe(3);
  });
  it('isolates demo data and rejects every execution route', async () => {
    const { app, store } = await setup();
    const bootstrap = (await app.inject({ url: '/api/bootstrap' })).json();
    expect(bootstrap.demo).toBe(true);
    expect(bootstrap.sessions.length).toBeGreaterThan(3);
    expect(bootstrap.analytics.totalSessions).toBeGreaterThan(bootstrap.sessions.length);
    const project = store.listProjects()[0];
    const response = await app.inject({
      method: 'POST', url: '/api/runs', headers,
      payload: { agent: 'codex', projectId: project.id, prompt: 'Review the project', policy: 'read-only' },
    });
    expect(response.statusCode).toBe(403);
    const run = store.listRuns().find((r) => r.status === 'failed')!;
    const retry = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/retry`, headers, payload: {} });
    expect(retry.statusCode).toBe(403);
    const real = await setup(false);
    expect((await real.app.inject({ url: '/api/sessions' })).json()).toEqual({ items: [], total: 0 });
  });
  it('persists metadata, searches it, and downloads a safe export', async () => {
    const { app, store } = await setup();
    const id = store.listSessions().items[0].id;
    const encoded = encodeURIComponent(id);
    const patch = await app.inject({ method: 'PATCH', url: `/api/sessions/${encoded}`, headers, payload: { note: '분석완료-marker', tags: ['reviewed'], bookmarked: true } });
    expect(patch.statusCode).toBe(200);
    const search = await app.inject({ url: '/api/sessions?q=' + encodeURIComponent('분석완료-marker') + '&bookmarked=true' });
    expect(search.json().items.map((s: { id: string }) => s.id)).toEqual([id]);
    const exported = await app.inject({ url: `/api/sessions/${encoded}/export?format=html` });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-disposition']).toContain('attachment');
    expect(exported.body).toContain('<!doctype html>');
    expect((await app.inject({ url: '/api/sessions?q=x&limit=-1' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/sessions/does-not-exist' })).statusCode).toBe(404);
  });
  it('creates an editable handoff without adding a run', async () => {
    const { app, store } = await setup();
    const session = store.listSessions().items[0];
    const before = store.listRuns().length;
    const response = await app.inject({
      method: 'POST', url: '/api/handoff', headers,
      payload: { sessionId: session.id, targetAgent: 'kiro', instruction: '회귀 테스트 추가' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ sourceSessionId: session.id, targetAgent: 'kiro' });
    expect(response.json().prompt).toContain('회귀 테스트 추가');
    expect(store.listRuns()).toHaveLength(before);
  });
  it('serves bounded message pages while retaining complete exports and full-message retrieval', async () => {
    const { app } = await setup();
    const summary = (await app.inject({ url: '/api/sessions/demo-kiro-long?includeMessages=false' })).json();
    expect(summary.messageCount).toBe(180);
    expect(summary.messages).toHaveLength(0);
    const page = (await app.inject({ url: '/api/sessions/demo-kiro-long/messages?offset=150&limit=50' })).json();
    expect(page.items).toHaveLength(30);
    expect(page.items[0].id).toBe('long-message-150');
    const result = (await app.inject({ url: '/api/sessions/demo-kiro-long/messages?q=' + encodeURIComponent('후반부 점검 결과') })).json();
    expect(result.total).toBe(1);
    expect(result.items[0].truncated).toBe(true);
    expect(result.items[0].content.length).toBeLessThanOrEqual(16000);
    expect(result.items[0].content).toContain('후반부 점검 결과');
    const full = (await app.inject({ url: '/api/sessions/demo-kiro-long/messages/long-message-80' })).json();
    expect(full.content.length).toBeGreaterThan(64000);
    expect((await app.inject({ url: '/api/sessions/demo-kiro-long/export?format=json' })).json().messages).toHaveLength(180);
    expect((await app.inject({ url: '/api/sessions/demo-kiro-long/messages?limit=100000' })).statusCode).toBe(400);
  });
  it('saves and deletes custom prompt templates', async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: 'POST', url: '/api/templates', headers,
      payload: { name: 'Regression review', description: 'Check changes', category: 'review', prompt: 'Review {{target}}', agent: 'any', policy: 'read-only' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const updated = await app.inject({ method: 'PATCH', url: `/api/templates/${id}`, headers, payload: { name: 'Updated review' } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().name).toBe('Updated review');
    expect((await app.inject({ method: 'DELETE', url: `/api/templates/${id}`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/templates/${id}`, headers, payload: { name: 'Again' } })).statusCode).toBe(404);
  });
  it('marks CLI imports as live so demo cannot relabel their storage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-ops-cli-mode-'));
    dirs.push(dir);
    const dataDir = join(dir, 'demo');
    const store = new Store(join(dataDir, 'agent-ops.sqlite'));
    store.saveSettings({ sourceRoots: { codex: [], claude: [], kiro: [] } });
    store.close();
    execFileSync(process.execPath, ['--import', 'tsx', resolve('server/index.ts'), 'sync', '--data-dir', dataDir], { cwd: resolve('.'), timeout: 15000 });
    const outcome = await createApp({ dataDir, demo: true, autoSync: false }).catch((error: unknown) => error);
    if (outcome && typeof outcome === 'object' && 'app' in outcome) contexts.push(outcome as AppContext);
    expect(outcome instanceof Error).toBe(true);
    expect((outcome as Error).message).toMatch(/live mode/);
  });
  it('exposes effective terminal failures and reconciles them after storage recovers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-ops-api-recovery-'));
    dirs.push(dir);
    const executable = join(dir, 'fixture-cli.cjs');
    writeFileSync(executable, `#!${process.execPath}\n${readFileSync(resolve('tests/fixtures/runner/process.cjs'), 'utf8')}`, { mode: 0o700 });
    writeFileSync(`${executable}.json`, JSON.stringify({
      controlDir: dir, finalRecords: [{ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }],
    }));
    const connector: ConnectorStatus = {
      agent: 'codex', installed: true, version: 'fixture', executable, roots: [], existingRoots: [],
      sessionCount: 0, error: null, supportsResume: true, supportsStreaming: true,
    };
    const context = await createApp({ dataDir: dir, autoSync: false, connectorProbe: async () => [connector] });
    contexts.push(context);
    const project = context.store.saveProject({ ...context.store.ensureProject(dir), executionEnabled: true });
    const created = (await context.app.inject({
      method: 'POST', url: '/api/runs', headers,
      payload: { agent: 'codex', projectId: project.id, prompt: 'hold:api-recovery', policy: 'read-only' },
    })).json();
    await expect.poll(() => context.store.getEvents(created.id).some((event) => event.text === 'fixture ready')).toBe(true);
    const original = context.store.updateRun.bind(context.store);
    let failed = false;
    context.store.updateRun = (id, patch) => {
      if (!failed && patch.status === 'completed') {
        failed = true;
        throw new Error('SQLITE_FULL: synthetic one-time storage failure');
      }
      return original(id, patch);
    };
    writeFileSync(join(dir, 'api-recovery.release'), 'release');
    await expect.poll(async () => (await context.app.inject({ url: `/api/runs/${created.id}` })).json().run.status).toBe('failed');
    const bootstrap = (await context.app.inject({ url: '/api/bootstrap' })).json();
    expect(bootstrap.runs.find((run: { id: string }) => run.id === created.id).status).toBe('failed');
    expect(bootstrap.analytics.runOutcomes.failed).toBe(1);
    await expect.poll(async () => {
      await context.app.inject({ url: `/api/runs/${created.id}` });
      return context.store.getRun(created.id)?.status;
    }, { timeout: 8000 }).toBe('failed');
    expect(context.store.getRun(created.id)?.finishedAt).not.toBeNull();
  }, 15000);
});
