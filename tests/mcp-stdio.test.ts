import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { finished, mcpFixture, waitFor, type McpFixture } from './fixtures/mcp-test-helpers.js';

const fixtures: McpFixture[] = [];
const executable = fileURLToPath(new URL('./fixtures/mcp-stdio.cjs', import.meta.url));
async function setup(mode = 'normal', options: Parameters<typeof mcpFixture>[0] = {}) {
  const fixture = await mcpFixture(options);
  fixtures.push(fixture);
  const log = join(fixture.base, 'synthetic-protocol.jsonl');
  await fixture.config({ test: { command: process.execPath, args: [executable, log, mode], env: { FIXTURE_TOKEN: 'synthetic-credential-839' } } });
  const item = (await fixture.service.list()).items[0];
  const messages = async (): Promise<Array<Record<string, any>>> => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { ...fixture, item, log, messages };
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose()));
});

describe('explicit owned stdio MCP checks', () => {
  it('starts nothing during discovery/refresh/preview and requires the opaque preview to check', async () => {
    const { service, item, messages } = await setup();
    service.refresh();
    await service.detail(item.id);
    const preview = await service.preview(item.id);
    expect(preview).toMatchObject({ serverId: item.id, canCheck: true, startsProcess: true, transport: 'stdio' });
    expect(preview.notices.join(' ')).toMatch(/starts.*configured process/i);
    expect(preview.methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'resources/list', 'prompts/list']);
    expect(await messages()).toEqual([]);
    expect(service.resourceRoots).toEqual([]);
    await expect(service.check(item.id, 'not-a-preview')).rejects.toMatchObject({ statusCode: 409 });
    expect(await messages()).toEqual([]);
  });

  it('performs initialization and paginated metadata lists without tool execution, and redacts returned metadata', async () => {
    const { service, item, messages } = await setup();
    const preview = await service.preview(item.id);
    expect(JSON.stringify(preview)).not.toContain('synthetic-credential-839');
    const accepted = await service.check(item.id, preview.previewId);
    expect(accepted.status).toBe('running');
    const result = await finished(service, accepted.id);
    expect(result.status).toBe('reachable');
    expect(result.serverInfo).toEqual({ name: 'synthetic-mcp', version: '1.0.0' });
    expect(result.tools).toMatchObject({ status: 'ok', count: 2, truncated: false });
    expect(result.tools.items.map(item => item.name)).toEqual(['first', 'second']);
    expect(result.resources.count).toBe(1);
    expect(result.prompts.count).toBe(1);
    expect(result.finishedAt).toBeTruthy();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-credential-839|schema-is-never-public|synthetic-private-path/);
    const requests = (await messages()).filter(message => message.method);
    expect(requests.map(message => message.method)).toEqual([
      'initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'resources/list', 'prompts/list',
    ]);
    expect(requests[0].params.capabilities).toEqual({});
    expect(requests[0].params.clientInfo.name).toBe('agent-ops');
    expect(requests[3].params.cursor).toBe('second');
    expect(service.resourceRoots).toEqual([]);
    expect((await service.detail(item.id)).lastResult?.status).toBe('reachable');
    expect((await service.list()).items[0].lastCheck?.finishedAt).toBe(result.finishedAt);
  });

  it('uses one probe slot across projects/providers and reports only owned probe roots', async () => {
    const { service, item, messages } = await setup('hang');
    const first = await service.preview(item.id);
    const second = await service.preview(item.id);
    const accepted = await service.check(item.id, first.previewId);
    await waitFor(messages, rows => rows.some(row => row.event === 'started'));
    expect(service.resourceRoots).toEqual([{ pid: expect.any(Number), ownerId: accepted.id, kind: 'mcp', processGroup: true }]);
    const copy = service.resourceRoots;
    copy[0].pid = -1;
    expect(service.resourceRoots[0].pid).toBeGreaterThan(0);
    await expect(service.check(item.id, second.previewId)).rejects.toMatchObject({ statusCode: 409 });
    const cancelled = await service.cancel(accepted.id);
    expect(cancelled.status).toBe('cancelled');
    expect(service.resourceRoots).toEqual([]);
    expect((await service.cancel(accepted.id)).status).toBe('cancelled');
  });

  it('invalidates a preview if configuration changes without a refresh', async () => {
    const { service, item, config, messages } = await setup();
    const preview = await service.preview(item.id);
    await config({ test: { command: process.execPath, args: ['--version'] } });
    await expect(service.check(item.id, preview.previewId)).rejects.toMatchObject({ statusCode: 409, code: 'stale-preview' });
    expect(await messages()).toEqual([]);
  });

  it('invalidates a preview after refresh and after use', async () => {
    const { service, item } = await setup();
    const stale = await service.preview(item.id);
    service.refresh();
    await expect(service.check(item.id, stale.previewId)).rejects.toMatchObject({ statusCode: 409 });
    const preview = await service.preview(item.id);
    const check = await service.check(item.id, preview.previewId);
    await finished(service, check.id);
    await expect(service.check(item.id, preview.previewId)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects stale configuration symlinks and mismatched server/selection IDs', async () => {
    const { service, item, homeDir, projectPath, put, projects, messages } = await setup();
    const preview = await service.preview(item.id);
    await expect(service.check('mcp-unknown', preview.previewId)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.check(item.id, preview.previewId, projects[0].id)).rejects.toMatchObject({ statusCode: 409 });
    await put(join(projectPath, 'outside.json'), { mcpServers: { test: { command: process.execPath } } });
    await rm(join(homeDir, '.claude.json'));
    await symlink(join(projectPath, 'outside.json'), join(homeDir, '.claude.json'));
    await expect(service.check(item.id, preview.previewId)).rejects.toMatchObject({ statusCode: 409 });
    expect(await messages()).toEqual([]);
  });

  it('enforces project executionEnabled both at preview and just before starting', async () => {
    const { service, projects, projectPath, put, log, messages } = await setup();
    await put(join(projectPath, '.mcp.json'), { mcpServers: { project: { command: process.execPath, args: [executable, log] } } });
    const item = (await service.list({ projectId: projects[0].id, scope: 'project' })).items[0];
    const blocked = await service.preview(item.id, projects[0].id);
    expect(blocked.canCheck).toBe(false);
    expect(blocked.blockedReasons.some(reason => reason.code === 'project-execution-disabled')).toBe(true);
    await expect(service.check(item.id, blocked.previewId, projects[0].id)).rejects.toMatchObject({ statusCode: 403 });
    projects[0].executionEnabled = true;
    const preview = await service.preview(item.id, projects[0].id);
    expect(preview.canCheck).toBe(true);
    projects[0].executionEnabled = false;
    await expect(service.check(item.id, preview.previewId, projects[0].id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await messages()).toEqual([]);
  });

  it.each([
    ['hang', 'timeout', 'timeout'],
    ['stderr-limit', 'failed', 'buffer-limit'],
    ['stdout-limit', 'failed', 'buffer-limit'],
    ['malformed', 'failed', 'invalid-json'],
    ['wrong-id', 'failed', 'unexpected-response'],
    ['bad-version', 'unsupported', 'protocol-version'],
    ['bad-list', 'failed', 'invalid-list'],
    ['rpc-error', 'failed', 'rpc-error'],
  ])('bounds %s servers and cleans up their process', async (mode, status, code) => {
    const { service, item } = await setup(mode, { probeTimeoutMs: 350, maxProbeBytes: 32 * 1024, maxMessageBytes: 16 * 1024 });
    const preview = await service.preview(item.id);
    const check = await service.check(item.id, preview.previewId);
    const result = await finished(service, check.id);
    expect(result.status).toBe(status);
    expect(result.error?.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain('synthetic-private-error');
    expect(service.resourceRoots).toEqual([]);
  });

  it('honors advertised capabilities and treats absent list methods honestly', async () => {
    const noCapabilities = await setup('no-capabilities');
    let preview = await noCapabilities.service.preview(noCapabilities.item.id);
    let check = await noCapabilities.service.check(noCapabilities.item.id, preview.previewId);
    let result = await finished(noCapabilities.service, check.id);
    expect(result.status).toBe('reachable');
    expect(result.tools.status).toBe('unsupported');
    expect((await noCapabilities.messages()).filter(row => row.method).map(row => row.method)).toEqual(['initialize', 'notifications/initialized']);
    const missing = await setup('method-missing');
    preview = await missing.service.preview(missing.item.id);
    check = await missing.service.check(missing.item.id, preview.previewId);
    result = await finished(missing.service, check.id);
    expect(result.tools.status).toBe('unsupported');
    expect(result.resources.status).toBe('ok');
    expect(result.status).toBe('reachable');
  });

  it.each(['many-items', 'repeated-cursor'])('bounds %s metadata and marks observed lists as truncated', async mode => {
    const { service, item } = await setup(mode, { maxListItems: 3, maxPages: 2 });
    const preview = await service.preview(item.id);
    const result = await finished(service, (await service.check(item.id, preview.previewId)).id);
    expect(result.status).toBe('reachable');
    expect(result.tools.truncated).toBe(true);
    expect(result.tools.items.length).toBeLessThanOrEqual(3);
  });

  it('rejects server-initiated sampling instead of invoking a model or tool', async () => {
    const { service, item, messages } = await setup('server-request');
    const preview = await service.preview(item.id);
    const result = await finished(service, (await service.check(item.id, preview.previewId)).id);
    expect(result.status).toBe('reachable');
    expect((await messages()).find(row => row.id === 'server-owned-request')).toMatchObject({ error: { code: -32601 } });
  });

  it('closes owned same-group descendants on cancellation and leaves no roots after shutdown', async () => {
    const { service, item, messages } = await setup('descendant');
    const preview = await service.preview(item.id);
    const check = await service.check(item.id, preview.previewId);
    const rows = await waitFor(messages, rows => rows.some(row => row.event === 'descendant'));
    const descendant = rows.find(row => row.event === 'descendant')!.pid;
    await service.close();
    expect(service.getCheck(check.id).status).toBe('cancelled');
    expect(service.resourceRoots).toEqual([]);
    await waitFor(async () => {
      try {
        const stat = await readFile(`/proc/${descendant}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
      } catch { return true; }
    }, gone => gone);
    await expect(service.preview(item.id)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('cleans up inherited pipes when the process leader exits before its descendant', async () => {
    const { service, item, messages } = await setup('exit-with-child');
    const preview = await service.preview(item.id);
    const result = await finished(service, (await service.check(item.id, preview.previewId)).id);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('process-exited');
    const descendant = (await messages()).find(row => row.event === 'descendant')!.pid;
    await waitFor(async () => {
      try {
        const stat = await readFile(`/proc/${descendant}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
      } catch { return true; }
    }, gone => gone);
    expect(service.resourceRoots).toEqual([]);
  });

  it('does not signal an independent synthetic process while cancelling its own probe', async () => {
    const independent = spawn(process.execPath, [executable, '--mcp-owned-descendant'], { detached: true, stdio: 'ignore' });
    const closed = new Promise<void>(resolve => independent.once('close', () => resolve()));
    try {
      const { service, item, messages } = await setup('hang');
      const preview = await service.preview(item.id);
      const check = await service.check(item.id, preview.previewId);
      await waitFor(messages, rows => rows.some(row => row.event === 'started'));
      expect((await service.cancel(check.id)).status).toBe('cancelled');
      expect(independent.kill(0)).toBe(true);
      expect(independent.exitCode).toBeNull();
    } finally {
      independent.kill('SIGKILL');
      await closed;
    }
  });

  it('shares the probe admission limit across service instances and releases it after cleanup', async () => {
    const first = await setup('hang');
    const second = await setup();
    const firstPreview = await first.service.preview(first.item.id);
    const secondPreview = await second.service.preview(second.item.id);
    const active = await first.service.check(first.item.id, firstPreview.previewId);
    await expect(second.service.check(second.item.id, secondPreview.previewId)).rejects.toMatchObject({ code: 'probe-busy' });
    await first.service.cancel(active.id);
    const accepted = await second.service.check(second.item.id, secondPreview.previewId);
    expect((await finished(second.service, accepted.id)).status).toBe('reachable');
  });
});
