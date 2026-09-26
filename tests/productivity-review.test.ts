import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { SavedViewService } from '../server/productivity/saved-views.js';
import { WorkItemService } from '../server/productivity/work-items.js';
import { createApp, type AppContext } from '../server/app.js';
import { resolveSavedView, savedViewRangeError } from '../shared/saved-views.js';

const stores: Store[] = [];
const apps: Array<{ context: AppContext; directory: string }> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const store of stores.splice(0)) store.close();
  for (const { context, directory } of apps.splice(0)) {
    await context.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe('productivity review regressions', () => {
  it('preserves a server-accepted naive date filter when opened in a different browser timezone', () => {
    const store = new Store(':memory:');
    stores.push(store);
    const views = new SavedViewService(store);
    vi.stubEnv('TZ', 'UTC');
    const query = { since: '2026-09-26T10:00:00', until: '2026-09-26T11:00:00Z' };
    const view = views.create({ name: 'Server local range', period: 'custom', query });
    vi.stubEnv('TZ', 'America/New_York');
    expect(resolveSavedView(view)).toEqual({ ...query, offset: 0 });
    expect(savedViewRangeError(query, 'custom')).toBeNull();
    vi.stubEnv('TZ', 'UTC');
    expect(() => views.create({ name: 'Reversed', period: 'custom',
      query: { since: '2026-09-26T12:00:00', until: '2026-09-26T11:00:00Z' } })).toThrow();
    vi.stubEnv('TZ', 'America/New_York');
    expect(savedViewRangeError({ since: '2026-09-26T12:00:00Z', until: '2026-09-26T11:00:00Z' }, 'custom')).not.toBeNull();
    expect(resolveSavedView({ period: 'custom', query: { since: '2026-09-26', until: '2026-09-26' } }))
      .toEqual({ since: '2026-09-26', until: '2026-09-26', offset: 0 });
  });

  it.each(['title', 'description', 'nextAction'] as const)('rejects NUL in %s before saving an unlaunchable work item', field => {
    const store = new Store(':memory:');
    stores.push(store);
    const work = new WorkItemService(store);
    expect(() => work.create({ title: 'Valid title', [field]: 'invalid\0text' })).toThrow();
    const original = work.create({ title: 'Valid title' });
    expect(() => work.update(original.id, { version: original.version, [field]: 'invalid\0text' })).toThrow();
    expect(work.get(original.id)).toEqual(original);
  });

  it('rejects an incompatible assembled context instead of returning a run draft that cannot be previewed', () => {
    const store = new Store(':memory:');
    stores.push(store);
    const work = new WorkItemService(store, {
      contextPackInfo: () => ({ name: 'Legacy context' }),
      compileContextPack: () => 'a legacy\0context fragment',
    });
    const item = work.create({ title: 'Prepare context', contextPackIds: ['fixture-pack'] });
    expect(() => work.prepare(item.id, { version: item.version })).toThrow(/NUL|invalid|incompatible/i);
    expect(work.get(item.id)?.version).toBe(1);
  });

  it('checks work eligibility during preview without consuming its version or inserting a run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-ops-preview-review-'));
    const context = await createApp({ dataDir: directory, demo: true, autoSync: false });
    apps.push({ context, directory });
    const { app, store, workItems } = context;
    const projects = store.listProjects();
    const item = workItems.create({ title: 'Preview eligibility', projectId: projects[0].id });
    const beforeRuns = store.listRuns().length;
    const input = { agent: 'codex', projectId: projects[0].id, prompt: 'Inspect the workspace', policy: 'read-only',
      workItemId: item.id, workItemVersion: item.version };
    const preview = (payload: object) => app.inject({
      method: 'POST', url: '/api/runs/preview', headers: { 'x-agent-ops': '1' }, payload,
    });
    expect((await preview(input)).statusCode).toBe(200);
    expect(workItems.get(item.id)?.version).toBe(1);
    expect((await preview({ ...input, projectId: projects[1].id })).statusCode).toBe(409);
    expect((await preview({ ...input, workItemId: 'missing-work-item' })).statusCode).toBe(404);
    const updated = workItems.update(item.id, { version: item.version, nextAction: 'Changed before preview' });
    expect((await preview(input)).statusCode).toBe(409);
    const completed = workItems.update(item.id, { version: updated.version, status: 'done' });
    expect((await preview({ ...input, workItemVersion: completed.version })).statusCode).toBe(409);
    expect((await preview({ agent: 'codex', projectId: projects[0].id, prompt: 'Inspect', policy: 'read-only',
      contextPackIds: ['missing-pack'] })).statusCode).toBe(400);
    expect(store.listRuns()).toHaveLength(beforeRuns);
  });
});
