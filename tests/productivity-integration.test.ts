import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type AppContext } from '../server/app.js';
import type { ContextPack } from '../shared/context-packs.js';
import type { WorkItem, WorkItemPrepared } from '../shared/work-items.js';

const owned: Array<{ directory: string; context: AppContext }> = [];
const headers = { 'x-agent-ops': '1' };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-ops-productivity-'));
  const context = await createApp({ dataDir: directory, demo: true, autoSync: false });
  owned.push({ directory, context });
  return { directory, ...context };
}
afterEach(async () => {
  vi.restoreAllMocks();
  const entries = owned.splice(0);
  for (const { context } of entries) await context.app.close();
  for (const directory of new Set(entries.map(entry => entry.directory))) await rm(directory, { recursive: true, force: true });
});

describe('connected productivity features', () => {
  it('adds isolated examples once and keeps operator edits after reopening the demo', async () => {
    const { app, store, workItems, directory } = await fixture();
    expect(workItems.list({}).total).toBe(4);
    const packs = await app.inject('/api/productivity/context-packs');
    expect(packs.json().total).toBe(1);
    expect((await app.inject('/api/productivity/saved-views')).json().items).toHaveLength(2);
    const template = store.listTemplates().find(item => item.variables?.length);
    expect(template?.revision).toBe(2);
    const task = workItems.list({}).items[0];
    workItems.update(task.id, { version: task.version, nextAction: 'Keep this operator edit' });
    const sessions = store.listSessions({ limit: 1 }).total;
    await app.close();
    const reopened = await createApp({ dataDir: directory, demo: true, autoSync: false });
    owned.push({ directory, context: reopened });
    expect(reopened.workItems.list({}).total).toBe(4);
    expect(reopened.workItems.get(task.id)?.nextAction).toBe('Keep this operator edit');
    expect(reopened.store.listSessions({ limit: 1 }).total).toBe(sessions);
    expect(reopened.contextPacks.list().total).toBe(1);
    expect(reopened.savedViews.list()).toHaveLength(2);
  });

  it('uses selected source, operator context and a work item to prepare a reviewed run without executing it', async () => {
    const { app, store } = await fixture();
    const source = store.listSessions({ agent: 'codex', limit: 1 }).items[0];
    const original = store.getSession(source.id)!;
    const message = original.messages.find(item => item.role === 'user')!;
    const createdPack = await app.inject({ method: 'POST', url: '/api/productivity/context-packs', headers,
      payload: { name: 'Integration context', instructions: 'Check the current code and preserve the scope.' } });
    expect(createdPack.statusCode).toBe(201);
    const pack = createdPack.json<ContextPack>();
    const captured = await app.inject({ method: 'POST', url: `/api/productivity/context-packs/${pack.id}/items`, headers,
      payload: { version: pack.version, kind: 'message', sessionId: source.id, messageId: message.id, offset: 0,
        length: Math.min(message.content.length, 1000) } });
    expect(captured.statusCode).toBe(200);
    const created = await app.inject({ method: 'POST', url: '/api/productivity/work-items', headers,
      payload: { title: 'Review selected evidence', nextAction: 'Describe the remaining checks', sessionIds: [source.id],
        projectId: store.listProjects().find(project => project.path === source.projectPath)!.id,
        contextPackIds: [pack.id] } });
    expect(created.statusCode).toBe(201);
    const task = created.json<WorkItem>();
    const prepared = await app.inject({ method: 'POST', url: `/api/productivity/work-items/${task.id}/prepare`, headers,
      payload: { version: task.version } });
    expect(prepared.statusCode).toBe(200);
    const result = prepared.json<WorkItemPrepared>();
    expect(result.draft.prompt).toContain('Describe the remaining checks');
    expect(result.draft.prompt).toContain(message.content.slice(0, Math.min(message.content.length, 1000)));
    expect(result.draft.contextPackIds).toEqual([pack.id]);
    const preview = await app.inject({ method: 'POST', url: '/api/runs/preview', headers, payload: result.draft });
    expect(preview.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/runs', headers, payload: result.draft })).statusCode).toBe(403);
    expect(store.getSession(source.id)).toEqual(original);
    expect(store.db.pragma('user_version', { simple: true })).toBe(4);
  });

  it('connects compatible template CRUD, literal rendering and revision restoration', async () => {
    const { app } = await fixture();
    const created = await app.inject({ method: 'POST', url: '/api/templates', headers,
      payload: { name: 'Scoped review', description: '', category: 'review', agent: 'any', policy: 'read-only',
        prompt: 'Review {{target}}', variables: [{ name: 'target', label: 'Target', type: 'text', required: true }] } });
    expect(created.statusCode).toBe(201);
    const template = created.json();
    const rendered = await app.inject({ method: 'POST', url: `/api/templates/${template.id}/render`, headers,
      payload: { values: { target: 'literal $(command) {{other}}' } } });
    expect(rendered.statusCode).toBe(200);
    expect(rendered.json().prompt).toBe('Review literal $(command) {{other}}');
    const updated = await app.inject({ method: 'PATCH', url: `/api/templates/${template.id}`, headers,
      payload: { expectedRevision: template.revision, description: 'Changed description' } });
    expect(updated.statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/templates/${template.id}`, headers,
      payload: { expectedRevision: template.revision, name: 'Stale overwrite' } })).statusCode).toBe(409);
    const history = await app.inject(`/api/templates/${template.id}/history`);
    expect(history.statusCode).toBe(200);
    expect(history.json().map((revision: { revision: number }) => revision.revision)).toEqual([2, 1]);
  });

  it('keeps new lists and operator edits away from full-corpus bootstrap queries', async () => {
    const { app, store } = await fixture();
    vi.spyOn(store, 'allSessions').mockImplementation(() => { throw new Error('Unexpected full archive read'); });
    vi.spyOn(store, 'toolCounts').mockImplementation(() => { throw new Error('Unexpected tool aggregation'); });
    for (const url of ['/api/productivity/work-items', '/api/productivity/context-packs', '/api/productivity/saved-views', '/api/templates']) {
      expect((await app.inject(url)).statusCode).toBe(200);
    }
    const created = await app.inject({ method: 'POST', url: '/api/productivity/work-items', headers, payload: { title: 'Metadata only' } });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: 'PATCH', url: `/api/productivity/work-items/${created.json().id}`, headers,
      payload: { version: created.json().version, priority: 'high' } })).statusCode).toBe(200);
  });

  it('inherits local, same-origin and mutation-header guards for all new routes', async () => {
    const { app } = await fixture();
    for (const url of ['/api/productivity/work-items', '/api/productivity/context-packs', '/api/productivity/saved-views']) {
      expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://untrusted.example' }, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url, headers: { host: 'untrusted.example' } })).statusCode).toBe(403);
    }
  });

  it('streams only bounded productivity notices for metadata edits', async () => {
    const { app } = await fixture();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 5000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`${address}/api/events`, { signal: abort.signal });
      reader = response.body!.getReader();
      await reader.read();
      await app.inject({ method: 'POST', url: '/api/productivity/work-items', headers, payload: { title: 'Do not send my title in SSE' } });
      const bytes = await reader.read();
      const frame = new TextDecoder().decode(bytes.value);
      expect(frame).toContain('"type":"productivity-change"');
      expect(frame).toContain('"entity":"work-items"');
      expect(frame).not.toContain('"type":"refresh"');
      expect(frame).not.toContain('Do not send my title');
      expect(frame.length).toBeLessThan(200);
    } finally {
      clearTimeout(deadline);
      abort.abort();
      await reader?.cancel().catch(() => {});
      await app.close();
    }
  });
});
