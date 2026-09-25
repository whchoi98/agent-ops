import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpCheck } from '../../shared/mcp.js';
import type { Project } from '../../shared/types.js';
import { McpService, type McpServiceOptions } from '../../server/mcp/service.js';

/** All roots, configuration and credentials created here are synthetic and temporary. */
export async function mcpFixture(options: McpServiceOptions = {}) {
  const base = await mkdtemp(join(tmpdir(), 'agent-ops-mcp-probe-'));
  const homeDir = join(base, 'home');
  const projectPath = join(base, 'project');
  await mkdir(homeDir);
  await mkdir(projectPath);
  const projects: Project[] = [{
    id: 'synthetic-project', name: 'Synthetic project', path: projectPath,
    executionEnabled: false, color: '#000000', createdAt: '2026-09-25T00:00:00.000Z',
  }];
  const service = new McpService({
    homeDir, env: { PATH: dirname(process.execPath) }, probeTimeoutMs: 2000, cleanupGraceMs: 80, ...options,
  }, () => projects);
  const put = async (path: string, data: object | string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof data === 'string' ? data : JSON.stringify(data));
  };
  return {
    base, homeDir, projectPath, projects, service, put,
    async config(servers: object) { await put(join(homeDir, '.claude.json'), { mcpServers: servers }); },
    async dispose() { await service.close(); await rm(base, { recursive: true, force: true }); },
  };
}
export type McpFixture = Awaited<ReturnType<typeof mcpFixture>>;
export async function waitFor<T>(action: () => T | Promise<T>, accept: (value: T) => boolean, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout;
  while (true) {
    const value = await action();
    if (accept(value)) return value;
    if (Date.now() >= end) throw new Error('Synthetic MCP test condition timed out.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
export async function finished(service: McpService, id: string): Promise<McpCheck> {
  return waitFor(() => service.getCheck(id), result => result.status !== 'running');
}
