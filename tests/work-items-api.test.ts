import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type AppContext } from '../server/app.js';

const opened: Array<{ context: AppContext; directory: string }> = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-ops-work-items-api-'));
  const context = await createApp({ dataDir: directory, demo: true, autoSync: false });
  opened.push({ context, directory });
  return context;
}
afterEach(async () => {
  for (const { context, directory } of opened.splice(0)) {
    await context.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe('work-item API', () => {
  it('lists bounded work-item metadata without copying the native archive into the response', async () => {
    const { app } = await fixture();
    const response = await app.inject('/api/productivity/work-items?limit=2');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.limit).toBe(2);
    expect(body.items.length).toBeLessThanOrEqual(2);
    expect(body).not.toHaveProperty('sessions');
    for (const item of body.items) {
      expect(item).not.toHaveProperty('description');
      expect(item).not.toHaveProperty('nextAction');
    }
  });

  it('persists an operator work item and rejects an outdated edit without overwriting it', async () => {
    const { app } = await fixture();
    const headers = { 'x-agent-ops': '1' };
    const created = await app.inject({ method: 'POST', url: '/api/productivity/work-items', headers,
      payload: { title: 'Review login', nextAction: 'Check the failing example' } });
    expect(created.statusCode).toBe(201);
    const item = created.json();
    const updated = await app.inject({ method: 'PATCH', url: `/api/productivity/work-items/${item.id}`, headers,
      payload: { version: item.version, nextAction: 'Write the regression check' } });
    expect(updated.statusCode).toBe(200);
    const stale = await app.inject({ method: 'PATCH', url: `/api/productivity/work-items/${item.id}`, headers,
      payload: { version: item.version, nextAction: 'outdated text' } });
    expect(stale.statusCode).toBe(409);
    const current = await app.inject(`/api/productivity/work-items/${item.id}`);
    expect(current.json().nextAction).toBe('Write the regression check');
  });
});
