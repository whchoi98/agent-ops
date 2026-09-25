import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AGENTS, type ConnectorStatus } from '../shared/types.js';
import { createApp, type AppContext } from '../server/app.js';

const contexts: AppContext[] = [];
const dirs: string[] = [];
const connectors = (): ConnectorStatus[] => AGENTS.map(agent => ({
  agent, installed: true, executable: `/fixture/${agent}`,
  version: agent === 'codex' ? 'codex-cli 0.157.0' : agent === 'claude' ? '2.1.282 (Claude Code)' : 'kiro-cli 3.0.0',
  roots: [], existingRoots: [], sessionCount: 0, error: null, supportsResume: true, supportsStreaming: true,
}));
async function setup(demo = false, publicUrl?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-versions-api-'));
  dirs.push(dir);
  const outbound: string[] = [];
  let probes = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    outbound.push(url);
    expect(init?.body).toBeUndefined();
    if (url === 'https://registry.npmjs.org/@openai/codex/latest') {
      return new Response(JSON.stringify({ name: '@openai/codex', version: '0.158.0' }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url === 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest') {
      return new Response(JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.282' }), { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('Kiro source unavailable in this fixture');
  };
  const context = await createApp({
    dataDir: dir, autoSync: false, demo, publicUrl,
    connectorProbe: async () => { probes++; return connectors(); },
    versionOptions: { fetcher },
  });
  contexts.push(context);
  return { ...context, outbound, probes: () => probes };
}
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.app.close()));
  dirs.splice(0).forEach(path => rmSync(path, { force: true, recursive: true }));
});

describe('installed and latest CLI version API', () => {
  it('shows both actual version numbers and keeps local information when one source fails', async () => {
    const { app, outbound, runner } = await setup();
    const response = await app.inject('/api/connector-versions');
    expect(response.statusCode).toBe(200);
    const report = response.json();
    expect(report.items).toHaveLength(3);
    expect(report.items.find((item: { agent: string }) => item.agent === 'codex')).toMatchObject({
      currentVersion: '0.157.0', latestVersion: '0.158.0', status: 'update-available',
    });
    expect(report.items.find((item: { agent: string }) => item.agent === 'claude')).toMatchObject({
      currentVersion: '2.1.282', latestVersion: '2.1.282', status: 'current',
    });
    expect(report.items.find((item: { agent: string }) => item.agent === 'kiro')).toMatchObject({
      currentVersion: '3.0.0', latestVersion: null, status: 'check-failed',
    });
    expect(outbound.every(url => !url.includes('0.157.0') && !url.includes('/fixture/'))).toBe(true);
    expect(runner.listRuns()).toEqual([]);
  });

  it('protects refresh and rejects arbitrary source/query input', async () => {
    const { app } = await setup();
    expect((await app.inject('/api/connector-versions?url=https://example.com')).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/connector-versions/check', payload: {} })).statusCode).toBe(403);
    expect((await app.inject({
      method: 'POST', url: '/api/connector-versions/check', headers: { 'x-agent-ops': '1' }, payload: { url: 'https://example.com' },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: 'POST', url: '/api/connector-versions/check', headers: { 'x-agent-ops': '1' }, payload: {},
    })).statusCode).toBe(200);
  });

  it('uses fixed demo values without host/version-network probes and works under a proxy prefix', async () => {
    const { app, probes, outbound } = await setup(true, 'https://workbench.example.com/proxy/4327/');
    const response = await app.inject({ url: '/proxy/4327/api/connector-versions', headers: { host: 'workbench.example.com' } });
    expect(response.statusCode).toBe(200);
    const report = response.json();
    expect(report.demo).toBe(true);
    expect(report.items.find((item: { agent: string }) => item.agent === 'codex')).toMatchObject({
      currentVersion: '1.0.0', latestVersion: '1.1.0', status: 'update-available',
    });
    expect(report.items.find((item: { agent: string }) => item.agent === 'claude')).toMatchObject({
      currentVersion: '2.1.0', latestVersion: '2.1.0', status: 'current',
    });
    expect(report.items.find((item: { agent: string }) => item.agent === 'kiro')).toMatchObject({
      currentVersion: '3.0.0-preview.1', latestVersion: '2.9.0', status: 'ahead',
    });
    expect(probes()).toBe(0);
    expect(outbound).toEqual([]);
  });
});
