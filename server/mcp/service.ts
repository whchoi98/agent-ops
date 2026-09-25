import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Project } from '../../shared/types.js';
import type { McpCatalog, McpCheck, McpCheckPreview, McpCheckSummary, McpDetail, McpQuery, McpResourceRoot } from '../../shared/mcp.js';
import { demoMcp, discoverMcp } from './discovery.js';
import { bounded, fail, type DiscoveryOptions, type Locations, type McpRecord, type McpSnapshot } from './types.js';
import { emptyList, probe, ProbeError } from './protocol.js';

export interface McpServiceOptions {
  demo?: boolean;
  homeDir?: string;
  codexHome?: string;
  claudeHome?: string;
  claudeConfigPath?: string;
  claudeDesktopConfigPath?: string;
  kiroHome?: string;
  /** Discovery path selection only; process ownership always uses the real host platform. */
  platform?: NodeJS.Platform;
  /** Tests should provide an isolated environment; values never enter public responses. */
  env?: NodeJS.ProcessEnv;
  cacheTtlMs?: number;
  previewTtlMs?: number;
  probeTimeoutMs?: number;
  cleanupGraceMs?: number;
  maxConfigBytes?: number;
  maxDiscoveryBytes?: number;
  maxServers?: number;
  maxResults?: number;
  maxListItems?: number;
  maxPages?: number;
  maxMessageBytes?: number;
  maxProbeBytes?: number;
}

interface PreviewRecord {
  serverId: string; projectId: string | null; fingerprint: string; expires: number;
  generation: number; canCheck: boolean;
}
interface OwnedCheck {
  result: McpCheck; controller: AbortController; done: Promise<void>; root: McpResourceRoot | null;
}
// Enforce the single probe limit across all projects/providers, even if an embedder creates two services.
let globalProbe: symbol | null = null;
const summary = (value: McpCheck): McpCheckSummary => ({
  id: value.id, status: value.status, startedAt: value.startedAt, finishedAt: value.finishedAt,
});

export class McpService {
  private readonly locations: Locations;
  private readonly env: NodeJS.ProcessEnv;
  private readonly salt = randomBytes(32);
  private readonly cache = new Map<string, { created: number; path: string; promise: Promise<McpSnapshot> }>();
  private scans = 0;
  private closed = false;
  private generation = 0;
  private readonly previews = new Map<string, PreviewRecord>();
  private readonly results = new Map<string, { result: McpCheck; fingerprint: string }>();
  private active: OwnedCheck | null = null;
  private closePromise: Promise<void> | null = null;
  constructor(private readonly options: McpServiceOptions, private readonly getProjects: () => Project[]) {
    this.env = { ...options.env ?? process.env };
    const homeDir = resolve(options.homeDir || homedir());
    this.locations = {
      homeDir,
      codexHome: resolve(options.codexHome || this.env.CODEX_HOME || join(homeDir, '.codex')),
      claudeHome: resolve(options.claudeHome || this.env.CLAUDE_CONFIG_DIR || join(homeDir, '.claude')),
      claudeConfigPath: resolve(options.claudeConfigPath || join(homeDir, '.claude.json')),
      claudeDesktopConfigPath: options.claudeDesktopConfigPath ? resolve(options.claudeDesktopConfigPath)
        : (options.platform ?? process.platform) === 'darwin' ? join(homeDir, 'Library/Application Support/Claude/claude_desktop_config.json') : null,
      kiroHome: resolve(options.kiroHome || join(homeDir, '.kiro')),
    };
  }
  private project(id?: string): Project | null {
    if (this.closed) return fail(503, 'The MCP service is closed.');
    if (!id) return null;
    const project = this.getProjects().find(item => item.id === id) ?? fail(404, 'Registered project not found.');
    return { ...project };
  }
  private context(project: Project | null): DiscoveryOptions {
    return {
      ...this.locations, options: this.options, env: this.env, project,
      id: key => `mcp-${createHmac('sha256', this.salt).update(`${project?.id ?? ''}\0${key}`).digest('hex').slice(0, 24)}`,
    };
  }
  private async snapshot(projectId?: string, fresh = false): Promise<McpSnapshot> {
    const project = this.project(projectId);
    const key = project?.id ?? '';
    const previous = this.cache.get(key);
    if (!fresh && previous && previous.path === (project?.path ?? '') && Date.now() - previous.created < bounded(this.options.cacheTtlMs, 60000, 0, 300000)) return previous.promise;
    if (this.scans >= 2) return fail(429, 'MCP discovery is busy; retry shortly.');
    this.scans++;
    const context = this.context(project);
    const pending = (this.options.demo ? Promise.resolve(demoMcp(context)) : discoverMcp(context))
      .finally(() => { this.scans--; })
      .catch(error => { if (this.cache.get(key)?.promise === pending) this.cache.delete(key); throw error; });
    if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { created: Date.now(), path: project?.path ?? '', promise: pending });
    return pending;
  }
  refresh(projectId?: string): { ok: true } {
    this.project(projectId);
    this.cache.clear();
    this.generation++;
    this.previews.clear();
    return { ok: true };
  }
  private last(record: McpRecord): McpCheck | null {
    const values = [...this.results.values()].reverse();
    return values.find(value => value.result.serverId === record.item.id && value.fingerprint === record.fingerprint)?.result ?? null;
  }
  async list(query: McpQuery = {}): Promise<McpCatalog> {
    const snapshot = await this.snapshot(query.projectId);
    const needle = query.q?.trim().toLocaleLowerCase();
    const filtered = [...snapshot.records.values()].map(record => record.item).filter(item =>
      (!query.agent || item.agent === query.agent) && (!query.scope || item.scope === query.scope)
      && (!query.transport || item.transport === query.transport) && (!query.status || item.status === query.status)
      && (!needle || [item.name, item.source.path, item.source.pluginName, item.source.agentName].join(' ').toLocaleLowerCase().includes(needle)));
    const offset = bounded(query.offset, 0, 0, 100000);
    const limit = bounded(query.limit, 50, 1, 100);
    return {
      items: filtered.slice(offset, offset + limit).map(item => {
        const result = this.last(snapshot.records.get(item.id)!);
        return { ...structuredClone(item), lastCheck: result ? summary(result) : null };
      }), total: filtered.length, offset, limit, scannedAt: snapshot.scannedAt,
      projectId: snapshot.projectId, warnings: [...snapshot.warnings], usageNotice, demo: Boolean(this.options.demo),
      activeCheck: this.active ? summary(this.active.result) : null,
    };
  }
  async detail(id: string, projectId?: string): Promise<McpDetail> {
    const snapshot = await this.snapshot(projectId);
    const record = snapshot.records.get(id) ?? fail(404, 'MCP declaration not found in the selected scope.');
    const result = this.last(record);
    return { ...structuredClone(record.item), lastCheck: result ? summary(result) : null, lastResult: result ? structuredClone(result) : null, usageNotice, demo: Boolean(this.options.demo) };
  }
  private timeout() { return bounded(this.options.probeTimeoutMs, 10000, 100, 30000); }
  async preview(id: string, projectId?: string): Promise<McpCheckPreview> {
    const generation = this.generation;
    const snapshot = await this.snapshot(projectId, true);
    this.project(projectId);
    if (generation !== this.generation) return fail(409, 'The catalog changed while preparing the preview. Try again.', 'stale-preview');
    const record = snapshot.records.get(id) ?? fail(404, 'MCP declaration not found in the selected scope.');
    const now = Date.now();
    for (const [key, preview] of this.previews) if (preview.expires <= now) this.previews.delete(key);
    if (this.previews.size >= 64) this.previews.delete(this.previews.keys().next().value!);
    const previewId = `mcp-preview-${randomUUID()}`;
    const expires = now + bounded(this.options.previewTtlMs, 60000, 50, 300000);
    const canCheck = !this.options.demo && record.item.checkSupport === 'supported';
    this.previews.set(previewId, {
      serverId: id, projectId: projectId ?? null, fingerprint: record.fingerprint, generation, expires, canCheck,
    });
    const startsProcess = record.target.transport === 'stdio';
    return {
      serverId: id, projectId: projectId ?? null, previewId, expiresAt: new Date(expires).toISOString(),
      canCheck, startsProcess, transport: record.item.transport, configuration: structuredClone(record.item.configuration),
      blockedReasons: structuredClone(record.item.findings.filter(issue => issue.level === 'error')),
      notices: [
        startsProcess ? 'This check starts the configured process. Its startup can have side effects; this is not a native CLI connection status.'
          : 'This check connects to the configured endpoint and sends its configured headers. Native OAuth sessions are not reused.',
        'Only initialization and metadata lists are requested. No tool, resource content, prompt execution, or model inference is requested.',
        'The workbench inherits a minimal process environment plus explicitly configured variables. Active CLI flags, profiles and managed policies are not reproduced.',
      ],
      timeoutMs: this.timeout(),
      methods: ['initialize', 'notifications/initialized', 'tools/list', 'resources/list', 'prompts/list'],
      demo: Boolean(this.options.demo),
    };
  }
  async check(id: string, previewId: string, projectId?: string): Promise<McpCheck> {
    const requestedProject = this.project(projectId);
    const preview = this.previews.get(previewId);
    if (!preview || preview.serverId !== id || preview.projectId !== (projectId ?? null) || preview.generation !== this.generation
      || preview.expires <= Date.now()) return fail(409, 'The check requires a current preview for this exact declaration and scope.', 'stale-preview');
    if (this.options.demo || !preview.canCheck) return fail(403, 'This preview does not permit a connectivity check.', 'probe-blocked');
    if (globalProbe) return fail(409, 'Another MCP probe is in progress. Cancel it or wait for cleanup to finish.', 'probe-busy');
    const reservation = Symbol('mcp-probe');
    globalProbe = reservation;
    let accepted = false;
    try {
      const snapshot = await this.snapshot(projectId, true);
      const project = this.project(projectId);
      const record = snapshot.records.get(id);
      if (!record || requestedProject?.path !== project?.path || requestedProject?.executionEnabled !== project?.executionEnabled
        || preview.fingerprint !== record.fingerprint || preview.generation !== this.generation
        || !this.previews.has(previewId) || preview.expires <= Date.now()) {
        this.previews.delete(previewId);
        return fail(409, 'Configuration or execution settings changed. Review a new preview.', 'stale-preview');
      }
      if (record.item.checkSupport !== 'supported' || (record.target.transport === 'stdio' && project && !project.executionEnabled)) {
        return fail(403, 'The current declaration cannot be probed.', 'probe-blocked');
      }
      this.previews.delete(previewId);
      const result: McpCheck = {
        id: `mcp-check-${randomUUID()}`, serverId: id, projectId: projectId ?? null,
        status: 'running', transport: record.item.transport, startedAt: new Date().toISOString(), finishedAt: null,
        durationMs: null, protocolVersion: null, serverInfo: null, capabilities: null,
        tools: emptyList(), resources: emptyList(), prompts: emptyList(), error: null, warnings: [], usageNotice,
      };
      const capacity = bounded(this.options.maxResults, 64, 1, 128);
      while (this.results.size >= capacity) this.results.delete(this.results.keys().next().value!);
      this.results.set(result.id, { result, fingerprint: record.fingerprint });
      const controller = new AbortController();
      const owned: OwnedCheck = { result, controller, root: null, done: Promise.resolve() };
      this.active = owned;
      const final = structuredClone(result);
      const timer = setTimeout(() => controller.abort(new ProbeError('timeout', 'The MCP probe exceeded its overall time limit.')), this.timeout());
      timer.unref();
      // Keep status running until owned process/session cleanup has completed.
      owned.done = probe(record, final, this.options, controller.signal, root => { owned.root = root; })
        .then(() => { Object.assign(result, final); })
        .finally(() => {
          clearTimeout(timer);
          if (this.active === owned) this.active = null;
          if (globalProbe === reservation) globalProbe = null;
        });
      accepted = true;
      return structuredClone(result);
    } finally { if (!accepted && globalProbe === reservation) globalProbe = null; }
  }
  getCheck(id: string): McpCheck {
    const entry = this.results.get(id) ?? fail(404, 'MCP check result not found or evicted from bounded memory.');
    return structuredClone(entry.result);
  }
  async cancel(id: string): Promise<McpCheck> {
    const owned = this.active;
    if (owned?.result.id === id) {
      owned.controller.abort(new ProbeError('cancelled', 'The MCP probe was cancelled.'));
      await owned.done;
    }
    return this.getCheck(id);
  }
  get resourceRoots(): McpResourceRoot[] { return this.active?.root ? [{ ...this.active.root }] : []; }
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.generation++;
      this.cache.clear();
      this.previews.clear();
      const owned = this.active;
      owned?.controller.abort(new ProbeError('cancelled', 'The MCP service closed and cancelled its owned probe.'));
      this.closePromise = owned ? owned.done : Promise.resolve();
    }
    return this.closePromise;
  }
}

export const usageNotice = 'Configuration presence is not proof of a native CLI connection. Checks are independent, timestamped workbench probes and never invoke MCP tools.';
