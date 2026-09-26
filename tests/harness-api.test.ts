import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppContext } from '../server/app.js';
import type { HarnessSettings } from '../shared/harness.js';
import { controlled, python } from './fixtures/harness-bridge.js';

const instances: Array<{ context: AppContext; directory: string }> = [];
const headers = { 'x-agent-ops': '1' };
async function demo() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-ops-harness-api-'));
  const context = await createApp({ dataDir: directory, demo: true, autoSync: false });
  instances.push({ context, directory });
  return context;
}
afterEach(async () => {
  for (const { context, directory } of instances.splice(0)) {
    await context.app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe('harness management API', () => {
  it.skipIf(!python)('cancels preview validation when its HTTP observer disconnects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-ops-preview-cancel-'));
    const projectDir = join(directory, 'project'), homeDir = join(directory, 'home');
    await Promise.all([mkdir(projectDir), mkdir(homeDir)]);
    const bridgePath = await controlled(directory, { validate: 'ignore-term' });
    const context = await createApp({
      dataDir: join(directory, 'data'), autoSync: false, connectorProbe: async () => [],
      harnessOptions: { homeDir, bridgePath, runtimeOptions: { timeoutMs: 3000, cleanupGraceMs: 30 } },
      desktopAppOptions: { platform: 'linux' },
    });
    instances.push({ context, directory });
    const project = context.store.ensureProject(projectDir);
    context.store.saveProject({ ...project, executionEnabled: true });
    await context.harness.saveSettings({ revision: 0, pythonPath: python, retentionDays: 30, maxCacheRecords: 2000 });
    expect((await context.harness.checkRuntime()).state).toBe('ready');
    const policy = (await context.harness.catalog(project.id)).policies[0];
    const address = await context.app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const pending = fetch(`${address}/api/harness/hooks/preview`, {
      method: 'POST', signal: controller.signal,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, policyId: policy.id, revision: policy.revision, client: 'claude-code', action: 'install' }),
    }).catch(() => null);
    try {
      await expect.poll(() => context.harness.status().processCount, { timeout: 1500 }).toBe(1);
      controller.abort();
      await pending;
      await expect.poll(() => context.harness.status(), { timeout: 1200 }).toMatchObject({ busy: false, processCount: 0 });
      expect((await context.app.inject({ method: 'PATCH', url: '/api/harness/settings', headers,
        payload: { ...context.harness.settings, retentionDays: 7 },
      })).statusCode).toBe(200);
    } finally { controller.abort(); await pending; }
  });

  it('exposes a separate demo catalog with policies, client evidence and retained audit metadata', async () => {
    const { app } = await demo();
    const response = await app.inject('/api/harness');
    expect(response.statusCode).toBe(200);
    const catalog = response.json();
    expect(catalog.demo).toBe(true);
    expect(catalog.projectId).toBeNull();
    expect(catalog.policies.length).toBeGreaterThan(0);
    expect(catalog.bindings.map((item: { client: string }) => item.client).sort()).toEqual([
      'claude-code', 'codex', 'kiro-cli', 'kiro-ide',
    ]);
    expect(catalog.settings).toMatchObject({ retentionDays: 30, maxCacheRecords: 2000 });
    const audit = await app.inject('/api/harness/audit?limit=2');
    expect(audit.statusCode).toBe(200);
    expect(audit.json().items).toHaveLength(2);
    expect(audit.json().total).toBeGreaterThan(2);
    expect(audit.body).not.toContain('tool_input');
    expect((await app.inject('/api/harness/status')).json()).toEqual({
      busy: false, processCount: 0, closing: false, demo: true,
    });
  });

  it('rejects arbitrary file paths and keeps existing host, origin and mutation guards', async () => {
    const { app } = await demo();
    expect((await app.inject({ url: '/api/harness', headers: { host: 'unconfigured.invalid' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/harness', headers: { origin: 'https://unconfigured.invalid' } })).statusCode).toBe(403);
    for (const url of ['/api/harness?path=/etc', '/api/harness/audit?path=/etc/passwd', '/api/harness/audit?limit=10001']) {
      expect((await app.inject(url)).statusCode).toBe(400);
    }
    for (const url of ['/api/harness/refresh', '/api/harness/runtime/check', '/api/harness/evaluate',
      '/api/harness/hooks/preview', '/api/harness/hooks/apply', '/api/harness/policies/validate']) {
      expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(403);
    }
  });

  it('does not start a real engine or modify native hooks in demo mode', async () => {
    const { app, store } = await demo();
    const project = store.listProjects()[0];
    const catalog = (await app.inject(`/api/harness?projectId=${project.id}`)).json();
    const policy = catalog.policies[0];
    expect((await app.inject({ method: 'POST', url: '/api/harness/runtime/check', headers, payload: {} })).statusCode).toBe(403);
    const evaluation = await app.inject({ method: 'POST', url: '/api/harness/evaluate', headers, payload: {
      projectId: project.id, policyId: policy.id, revision: policy.revision, client: 'codex',
      toolName: 'Bash', toolInput: { command: 'never execute this input' },
    } });
    expect(evaluation.statusCode).toBe(403);
    const preview = await app.inject({ method: 'POST', url: '/api/harness/hooks/preview', headers, payload: {
      projectId: project.id, policyId: policy.id, revision: policy.revision, client: 'codex', action: 'install',
    } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().canApply).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/harness/hooks/apply', headers,
      payload: { projectId: project.id, previewId: preview.json().id },
    })).statusCode).toBe(403);
  });

  it('keeps concurrent settings edits versioned and refuses unknown fields', async () => {
    const { app } = await demo();
    const before = (await app.inject('/api/harness')).json().settings;
    const first = await app.inject({ method: 'PATCH', url: '/api/harness/settings', headers,
      payload: { ...before, retentionDays: 7, maxCacheRecords: 250 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ revision: 1, retentionDays: 7, maxCacheRecords: 250 });
    const stale = await app.inject({ method: 'PATCH', url: '/api/harness/settings', headers,
      payload: { ...before, retentionDays: 90 },
    });
    expect(stale.statusCode).toBe(409);
    expect((await app.inject('/api/harness')).json().settings.retentionDays).toBe(7);
    expect((await app.inject({ method: 'PATCH', url: '/api/harness/settings', headers,
      payload: { ...first.json<HarnessSettings>(), command: 'never execute this input' },
    })).statusCode).toBe(400);
  });

  it('validates draft policy structure without claiming an engine check or losing stale drafts', async () => {
    const { app } = await demo();
    const catalog = (await app.inject('/api/harness')).json();
    const source = (await app.inject(`/api/harness/policies/${catalog.policies[0].id}`)).json();
    const checked = await app.inject({ method: 'POST', url: '/api/harness/policies/validate', headers,
      payload: { content: source.content },
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({ valid: true, engineValidated: false });
    const saved = await app.inject({ method: 'PUT', url: '/api/harness/policies/managed', headers,
      payload: { content: source.content, expectedRevision: null },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ scope: 'managed', content: source.content });
    const conflict = await app.inject({ method: 'PUT', url: '/api/harness/policies/managed', headers,
      payload: { content: source.content.replace('Demo project protection', 'A separate draft'), expectedRevision: null },
    });
    expect(conflict.statusCode).toBe(409);
    expect((await app.inject(`/api/harness/policies/${saved.json().id}`)).json().content).toBe(source.content);
    const invalid = await app.inject({ method: 'POST', url: '/api/harness/policies/validate', headers,
      payload: { content: 'rules: [unterminated' },
    });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json().valid).toBe(false);
  });

  it('rejects nested unsafe keys, deeply nested inputs and byte-heavy requests before evaluation', async () => {
    const { app } = await demo();
    const policy = (await app.inject('/api/harness')).json().policies[0];
    const request = { policyId: policy.id, revision: policy.revision, client: 'codex', toolName: 'Bash' };
    const unsafe = JSON.parse('{"nested":{"__proto__":{"polluted":true}}}');
    let deep: Record<string, unknown> = { value: 'end' };
    for (let index = 0; index < 30; index++) deep = { child: deep };
    for (const toolInput of [unsafe, deep, { command: '한'.repeat(23000) }, { command: 'contains\0NUL' }]) {
      expect((await app.inject({ method: 'POST', url: '/api/harness/evaluate', headers,
        payload: { ...request, toolInput },
      })).statusCode).toBe(400);
    }
    expect((await app.inject('/api/harness/status')).json().processCount).toBe(0);
  });
});
