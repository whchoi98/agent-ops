import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type AppContext } from '../server/app.js';
import { Runner } from '../server/runner.js';
import { AGENTS, type ConnectorStatus, type Run, type RunRequest } from '../shared/types.js';
import type { WorkItem } from '../shared/work-items.js';

const fixtureCode = readFileSync(new URL('./fixtures/runner/process.cjs', import.meta.url), 'utf8');
const open: Array<{ context: AppContext; directory: string }> = [];
async function fixture(exitCode = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-ops-work-item-runs-'));
  const workspace = join(directory, 'workspace');
  mkdirSync(join(workspace, '.git'), { recursive: true });
  writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const executable = join(directory, 'controlled-cli');
  writeFileSync(executable, `#!${process.execPath}\n${fixtureCode}`, { mode: 0o700 });
  writeFileSync(`${executable}.json`, JSON.stringify({ controlDir: directory, exitCode }));
  const connectors: ConnectorStatus[] = AGENTS.map(agent => ({
    agent, installed: true, version: 'fixture 1.0.0', executable, roots: [], existingRoots: [],
    sessionCount: 0, error: null, supportsResume: true, supportsStreaming: true,
  }));
  const context = await createApp({
    dataDir: join(directory, 'state'), autoSync: false, connectorProbe: async () => connectors,
  });
  open.push({ context, directory });
  const project = context.store.saveProject({
    ...context.store.ensureProject(workspace, 'Workspace'), executionEnabled: true,
  });
  const headers = { 'x-agent-ops': '1' };
  const created = await context.app.inject({ method: 'POST', url: '/api/productivity/work-items', headers,
    payload: { title: 'Check the login flow', projectId: project.id, nextAction: 'Inspect the controlled example' } });
  expect(created.statusCode).toBe(201);
  const workItem = created.json<WorkItem>();
  const request: RunRequest = {
    agent: 'codex', projectId: project.id, prompt: 'Only inspect the controlled example', policy: 'read-only',
    workItemId: workItem.id, workItemVersion: workItem.version,
  };
  const calls = (): Array<{ argv: string[] }> => existsSync(`${executable}.calls`)
    ? readFileSync(`${executable}.calls`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  async function finished(id: string): Promise<Run> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const run = context.runner.getRun(id)!;
      if (!['queued', 'running'].includes(run.status)) return run;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error('Controlled work-item run did not finish');
  }
  return { ...context, project, workItem, request, headers, calls, finished, connectors };
}
afterEach(async () => {
  for (const { context, directory } of open.splice(0)) {
    await context.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('work-item linkage at the real run boundary', () => {
  it('does not accept queued work when shutdown starts just after the insert transaction', async () => {
    const { store, project, connectors, calls } = await fixture();
    const instance = new Runner(store, {
      connectors: async () => connectors,
      onCreated: () => { queueMicrotask(() => { void instance.close(); }); },
    });
    try {
      await expect(instance.create({
        agent: 'codex', projectId: project.id, prompt: 'Controlled shutdown boundary', policy: 'read-only',
      })).rejects.toThrow(/closed/i);
      expect(instance.busy).toBe(false);
      expect(store.listRuns()[0].status).toBe('interrupted');
      expect(calls()).toHaveLength(0);
    } finally { await instance.close(); }
  });

  it('starts only one controlled CLI for concurrent submissions of the same work version', async () => {
    const { app, store, request, headers, workItem, calls, finished } = await fixture();
    const results = await Promise.all([1, 2].map(() =>
      app.inject({ method: 'POST', url: '/api/runs', headers, payload: request })));
    expect(results.map(result => result.statusCode).sort()).toEqual([201, 409]);
    const accepted = results.find(result => result.statusCode === 201)!.json<Run>();
    const result = await finished(accepted.id);
    expect(result.status).toBe('completed');
    expect(calls()).toHaveLength(1);
    expect(calls()[0].argv.join(' ')).not.toContain(workItem.id);
    expect(store.listRuns()).toHaveLength(1);
    const linked = (await app.inject(`/api/productivity/work-items/${workItem.id}`)).json<WorkItem>();
    expect(linked).toMatchObject({ lastRunId: accepted.id, version: 2, status: 'in_progress' });
  });

  it('rejects a prepared run after another editor has changed the work item, without inserting or launching it', async () => {
    const { app, store, headers, workItem, request, calls } = await fixture();
    const updated = await app.inject({ method: 'PATCH', url: `/api/productivity/work-items/${workItem.id}`, headers,
      payload: { version: workItem.version, nextAction: 'Updated operator instructions' } });
    expect(updated.statusCode).toBe(200);
    const result = await app.inject({ method: 'POST', url: '/api/runs', headers, payload: request });
    expect(result.statusCode).toBe(409);
    expect(store.listRuns()).toHaveLength(0);
    expect(calls()).toHaveLength(0);
  });

  it('retries the linked run while work is unchanged, then requires fresh preparation after a work edit', async () => {
    const { app, headers, request, workItem, calls, finished } = await fixture(17);
    const first = await app.inject({ method: 'POST', url: '/api/runs', headers, payload: request });
    expect(first.statusCode).toBe(201);
    const original = first.json<Run>();
    expect((await finished(original.id)).status).toBe('failed');
    const retry = await app.inject({ method: 'POST', url: `/api/runs/${original.id}/retry`, headers, payload: {} });
    expect(retry.statusCode).toBe(200);
    const retried = retry.json<Run>();
    expect(retried.workItemId).toBe(workItem.id);
    expect((await finished(retried.id)).status).toBe('failed');
    const current = (await app.inject(`/api/productivity/work-items/${workItem.id}`)).json<WorkItem>();
    await app.inject({ method: 'PATCH', url: `/api/productivity/work-items/${workItem.id}`, headers,
      payload: { version: current.version, description: 'A different goal now' } });
    const stale = await app.inject({ method: 'POST', url: `/api/runs/${retried.id}/retry`, headers, payload: {} });
    expect(stale.statusCode).toBe(409);
    expect(calls()).toHaveLength(2);
  });
});
