import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { AGENTS, type Bootstrap, type ConnectorStatus, type Settings, type RunEvent } from '../shared/types.js';
import type { SyncPolicy, SyncStatus } from '../shared/sync-control.js';
import { Store, newId } from './store.js';
import { VERSION } from './config.js';
import { computeAnalytics } from './analytics.js';
import { redact, buildHandoff, exportSession } from './privacy.js';
import { seedDemo, seedTemplates } from './seed.js';
import { SyncService, type SyncController } from './sync.js';
import { BackgroundSync } from './background-sync.js';
import { retryWrite } from './write-retry.js';
import { Runner } from './runner.js';
import { detectConnectors, invalidateConnectorCache } from './connectors.js';
import { enforceAccess, parsePublicUrl, stripProxyPrefix } from './access.js';
import { ExtensionService, type ExtensionServiceOptions } from './extensions/service.js';
import { registerExtensionRoutes } from './extensions/routes.js';
import { VersionService, type VersionServiceOptions } from './versions.js';
import { ResourceMonitor, type ResourceMonitorOptions } from './resources/monitor.js';
import { McpService, registerMcpRoutes, type McpServiceOptions } from './mcp/index.js';
import { DesktopAppService, registerDesktopAppRoutes, type DesktopAppServiceOptions } from './desktop-apps.js';
import { SyncManager, type SyncDriver } from './sync-manager.js';
import { AppUpdateService, registerAppUpdateRoutes, type AppUpdateServiceOptions } from './app-update.js';

const agentSchema = z.enum(AGENTS);
const policySchema = z.enum(['read-only', 'workspace-write']);
const shortText = z.string().trim().min(1).max(200);
const runSchema = z.object({
  agent: agentSchema, projectId: shortText, prompt: z.string().trim().min(1).max(64000),
  title: shortText.optional(), model: z.string().trim().max(160).optional(),
  policy: policySchema.default('read-only'),
  allowShell: z.boolean().optional(),
  resumeSessionId: shortText.optional(), sourceSessionId: shortText.optional(), templateId: shortText.optional(),
}).strict();
const dateSchema = z.string().max(40).refine((value) => /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && Number.isFinite(Date.parse(value)), 'Invalid date');
const sessionQuerySchema = z.object({
  q: z.string().max(500).optional(), agent: agentSchema.optional(), project: z.string().max(4096).optional(),
  status: z.enum(['completed', 'failed', 'recorded']).optional(),
  bookmarked: z.enum(['true', 'false']).transform((s) => s === 'true').optional(),
  tag: z.string().max(60).optional(), since: dateSchema.optional(), until: dateSchema.optional(),
  sort: z.enum(['recent', 'oldest', 'tokens', 'credits']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100000000).optional(),
});
const templateSchema = z.object({
  name: shortText, description: z.string().max(500), category: z.enum(['review', 'build', 'debug', 'docs', 'custom']),
  prompt: z.string().trim().min(1).max(32000), agent: z.enum([...AGENTS, 'any']), policy: policySchema,
}).strict();
const settingsSchema = z.object({
  concurrency: z.number().int().min(1).max(8),
  timeoutMinutes: z.number().int().min(1).max(240),
  scanIntervalSeconds: z.number().int().min(15).max(3600),
  syncMode: z.enum(['interval', 'idle', 'manual']),
  syncMaxSeconds: z.number().int().min(30).max(1800),
  theme: z.enum(['light', 'dark', 'system']),
  sourceRoots: z.object({
    codex: z.array(z.string().min(1).max(4096)).max(20),
    claude: z.array(z.string().min(1).max(4096)).max(20),
    kiro: z.array(z.string().min(1).max(4096)).max(20),
  }).strict(),
}).partial().strict();

function error(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
const idParam = (params: unknown) => z.object({ id: shortText }).parse(params).id;
type Notice = { type: 'refresh' } | { type: 'run-event'; runId: string; event: RunEvent }
  | { type: 'sync-state'; status: SyncStatus };
export interface AppContext {
  app: FastifyInstance; store: Store; runner: Runner; sync: SyncController;
  resources: ResourceMonitor; mcp: McpService; desktopApps: DesktopAppService;
  syncManager: SyncManager; appUpdate: AppUpdateService;
}
export interface AppOptions {
  dataDir: string;
  demo?: boolean;
  autoSync?: boolean;
  staticDir?: string;
  publicUrl?: string;
  extensionOptions?: Omit<ExtensionServiceOptions, 'demo'>;
  versionOptions?: Omit<VersionServiceOptions, 'demo'>;
  resourceOptions?: Omit<ResourceMonitorOptions, 'dataDir' | 'roots'>;
  mcpOptions?: Omit<McpServiceOptions, 'demo'>;
  desktopAppOptions?: Omit<DesktopAppServiceOptions, 'demo'>;
  appUpdateOptions?: Omit<AppUpdateServiceOptions, 'currentVersion' | 'demo'>;
  /** Host/test injection only; HTTP requests cannot replace the owned import entry. */
  syncDriver?: SyncDriver;
  connectorProbe?: (settings: Settings) => Promise<ConnectorStatus[]>;
}

export async function createApp(options: AppOptions): Promise<AppContext> {
  const address = parsePublicUrl(options.publicUrl);
  const demo = options.demo ?? false;
  const store = new Store(join(options.dataDir, 'agent-ops.sqlite'));
  const previousMode = store.getMeta<string>('mode');
  const mode = demo ? 'demo' : 'live';
  if (previousMode && previousMode !== mode) {
    store.close();
    throw new Error(`This data directory belongs to ${previousMode} mode. Select a separate data directory.`);
  }
  if (demo && !previousMode && store.listSessions({ limit: 1 }).total > 0) {
    store.close();
    throw new Error('This directory already contains unclassified history. Use an empty directory for demo mode.');
  }
  store.setMeta('mode', mode);
  seedTemplates(store);
  if (demo) seedDemo(store);

  const app = Fastify({
    logger: false, bodyLimit: 256 * 1024, requestTimeout: 30000,
    rewriteUrl: (request) => stripProxyPrefix(request.url || '/', address),
  });
  const clients = new Set<FastifyReply>();
  let closing = false;
  const write = <T,>(action: () => T) => retryWrite(store, action, () => closing);
  function broadcast(notice: Notice) {
    if (closing) return;
    const text = `data: ${JSON.stringify(notice)}\n\n`;
    for (const reply of clients) {
      if (reply.raw.destroyed || reply.raw.writableLength > 1024 * 1024) {
        reply.raw.end();
        clients.delete(reply);
      } else reply.raw.write(text);
    }
  }
  const probe = options.connectorProbe || detectConnectors;
  const runner = new Runner(store, { demo, onEvent: broadcast, connectors: () => probe(store.getSettings()) });
  if (!demo) runner.start();
  const refreshNotice = () => broadcast({ type: 'refresh' });
  const sync: SyncController = options.syncDriver ?? (demo
    ? new SyncService(store, () => {}, true)
    : new BackgroundSync({
      dataDir: resolve(options.dataDir),
      entry: resolve(dirname(fileURLToPath(import.meta.url)), import.meta.url.endsWith('.ts') ? 'index.ts' : 'index.js'),
    }));
  const mcp = new McpService({ ...options.mcpOptions, demo }, () => store.listProjects());
  const desktopApps = new DesktopAppService({ ...options.desktopAppOptions, demo });
  const resources = new ResourceMonitor({
    ...options.resourceOptions, dataDir: options.dataDir,
    roots: () => [...runner.resourceRoots, ...(sync instanceof BackgroundSync ? sync.resourceRoots : []), ...mcp.resourceRoots],
  });
  const policyFrom = (settings: Settings): SyncPolicy => ({
    mode: settings.syncMode ?? 'interval', intervalSeconds: settings.scanIntervalSeconds,
    maxSeconds: settings.syncMaxSeconds ?? 1800,
  });
  const syncManager = new SyncManager({
    driver: sync, policy: policyFrom(store.getSettings()), demo,
    autoEnabled: !demo && options.autoSync !== false, isBusy: () => runner.busy,
    onChange: status => broadcast({ type: 'sync-state', status }),
    onFinished: () => {
      if (closing) return;
      invalidateConnectorCache();
      refreshNotice();
    },
  });
  const appUpdate = new AppUpdateService({ ...options.appUpdateOptions, currentVersion: VERSION, demo });

  app.addHook('onRequest', async (request, reply) => {
    enforceAccess(request.headers, request.raw.socket.remoteAddress, address);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-agent-ops'] !== '1') throw error(403, 'X-Agent-Ops: 1 header required.');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', request.url.startsWith('/assets/') ? 'public,max-age=31536000,immutable' : 'no-store');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  });
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ') });
    const failure = err as Error & { statusCode?: number };
    const code = typeof failure.statusCode === 'number' ? failure.statusCode : 500;
    const message = code >= 500 ? '요청을 처리하지 못했습니다. 설정과 서버 상태를 확인해 주세요.' : redact(failure.message);
    return reply.code(code).send({ error: message });
  });
  app.get('/api/health', async () => ({ ok: true, version: VERSION, demo }));
  app.get('/api/resources', async request => {
    z.object({}).strict().parse(request.query);
    return resources.snapshot();
  });
  registerMcpRoutes(app, mcp);
  registerDesktopAppRoutes(app, desktopApps);
  registerAppUpdateRoutes(app, appUpdate);
  registerExtensionRoutes(app, new ExtensionService({ ...options.extensionOptions, demo }, () => store.listProjects()));
  const versions = new VersionService({ ...options.versionOptions, demo }, () => probe(store.getSettings()));
  app.get('/api/connector-versions', async request => {
    z.object({}).strict().parse(request.query);
    return versions.report();
  });
  app.post('/api/connector-versions/check', async request => {
    z.object({}).strict().parse(request.body ?? {});
    return versions.report(true);
  });
  app.get('/api/bootstrap', async (): Promise<Bootstrap> => {
    const settings = store.getSettings();
    const sessions = store.allSessions();
    const counts = Object.fromEntries(AGENTS.map((agent) => [agent, sessions.filter((s) => s.agent === agent).length]));
    const connectors = (await probe(settings)).map((connector) => ({ ...connector, sessionCount: counts[connector.agent] || 0 }));
    const runs = runner.listRuns();
    return {
      version: VERSION, demo, settings, connectors, sessions: store.listSessions({ limit: 60 }).items,
      sessionTotal: sessions.length, runs, projects: store.listProjects(), templates: store.listTemplates(),
      analytics: computeAnalytics(sessions, runner.listRuns(100000), store.toolCounts()),
      sync: store.lastSync(), syncing: sync.active, syncStatus: syncManager.snapshot(),
    };
  });
  app.get('/api/sessions', async (request) => store.listSessions(sessionQuerySchema.parse(request.query)));
  app.get('/api/sessions/:id', async (request) => {
    const query = z.object({ includeMessages: z.enum(['true', 'false']).optional() }).parse(request.query);
    const session = store.getSession(idParam(request.params), query.includeMessages !== 'false');
    if (!session) throw error(404, '세션을 찾을 수 없습니다.');
    return session;
  });
  app.get('/api/sessions/:id/messages', async (request) => {
    const id = idParam(request.params);
    if (!store.getSession(id, false)) throw error(404, '세션을 찾을 수 없습니다.');
    const query = z.object({
      role: z.enum(['user', 'assistant', 'tool', 'system']).optional(),
      q: z.string().max(500).refine((value) => !value.includes('\0'), 'Invalid search text').optional(),
      offset: z.coerce.number().int().min(0).max(1000000).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).parse(request.query);
    return store.listMessages(id, query);
  });
  app.get('/api/sessions/:id/messages/:messageId', async (request) => {
    const { id, messageId } = z.object({ id: shortText, messageId: z.string().min(1).max(500) }).parse(request.params);
    const message = store.getMessage(id, messageId);
    if (!message) throw error(404, '메시지를 찾을 수 없습니다.');
    return message;
  });
  app.patch('/api/sessions/:id', async (request) => {
    const patch = z.object({
      bookmarked: z.boolean().optional(), tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
      note: z.string().max(16000).optional(), title: shortText.optional(),
    }).strict().parse(request.body);
    if (patch.note !== undefined) patch.note = redact(patch.note);
    if (patch.tags) patch.tags = [...new Set(patch.tags)];
    const query = z.object({ includeMessages: z.enum(['true', 'false']).optional() }).parse(request.query);
    const session = await write(() => store.patchSession(idParam(request.params), patch, query.includeMessages !== 'false'));
    if (!session) throw error(404, '세션을 찾을 수 없습니다.');
    broadcast({ type: 'refresh' });
    return session;
  });
  app.get('/api/sessions/:id/export', async (request, reply) => {
    const format = z.object({ format: z.enum(['json', 'md', 'html']).default('md') }).parse(request.query).format;
    const session = store.getSession(idParam(request.params));
    if (!session) throw error(404, '세션을 찾을 수 없습니다.');
    const exported = exportSession(session, format);
    reply.header('Content-Disposition', `attachment; filename="session-${session.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}.${exported.extension}"`);
    return reply.type(exported.type).send(exported.body);
  });
  app.post('/api/handoff', async (request) => {
    const body = z.object({ sessionId: shortText, targetAgent: agentSchema, instruction: z.string().max(8000).optional() }).strict().parse(request.body);
    const session = store.getSession(body.sessionId);
    if (!session) throw error(404, '세션을 찾을 수 없습니다.');
    return buildHandoff(session, body.targetAgent, body.instruction);
  });
  app.get('/api/sync/status', async request => {
    z.object({}).strict().parse(request.query);
    return syncManager.snapshot();
  });
  app.post('/api/sync/cancel', async (request, reply) => {
    z.object({}).strict().parse(request.query);
    z.object({}).strict().parse(request.body ?? {});
    if (closing) throw error(503, '동기화가 종료 중입니다.');
    const stopping = demo ? false : syncManager.stopCurrent();
    return reply.code(202).send({ stopping, status: syncManager.snapshot() });
  });
  app.post('/api/sync', async request => {
    z.object({}).strict().parse(request.query);
    z.object({}).strict().parse(request.body ?? {});
    if (closing) throw error(503, '동기화가 종료 중입니다.');
    if (demo) {
      const at = new Date().toISOString();
      return { startedAt: at, finishedAt: at, imported: 0, skipped: 0, filesScanned: 0, warnings: [] };
    }
    invalidateConnectorCache();
    try { return await syncManager.runManual(); }
    catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') throw error(409, '동기화를 취소했습니다.');
      if (cause instanceof Error && cause.name === 'SyncTimeoutError') throw error(408, '동기화 제한 시간이 초과되었습니다.');
      throw cause;
    }
  });
  app.post('/api/sync/start', async (request, reply) => {
    z.object({}).strict().parse(request.body);
    z.object({}).strict().parse(request.query);
    if (closing) throw error(503, 'Synchronization is stopping.');
    if (demo) return reply.code(202).send({ syncing: false });
    invalidateConnectorCache();
    void syncManager.runManual().catch(() => {});
    return reply.code(202).send({ syncing: sync.active });
  });
  app.post('/api/runs/preview', async (request) => runner.preview(runSchema.parse(request.body)));
  app.post('/api/runs', async (request, reply) => {
    if (demo) throw error(403, '데모 모드에서는 에이전트를 실행할 수 없습니다.');
    const run = await runner.create(runSchema.parse(request.body));
    return reply.code(201).send(run);
  });
  app.get('/api/runs/:id', async (request) => {
    const id = idParam(request.params);
    const run = runner.getRun(id);
    if (!run) throw error(404, '실행을 찾을 수 없습니다.');
    return { run, events: store.getEvents(id) };
  });
  app.get('/api/runs/:id/events', async (request) => {
    const id = idParam(request.params);
    const after = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(request.query).after;
    const run = runner.getRun(id);
    if (!run) throw error(404, '실행을 찾을 수 없습니다.');
    return { run, events: store.getEvents(id, after) };
  });
  app.post('/api/runs/:id/cancel', async (request) => runner.cancel(idParam(request.params)));
  app.post('/api/runs/:id/retry', async (request) => {
    if (demo) throw error(403, '데모 모드에서는 에이전트를 실행할 수 없습니다.');
    return runner.retry(idParam(request.params));
  });
  app.post('/api/projects', async (request, reply) => {
    const input = z.object({
      name: shortText, path: z.string().trim().min(1).max(4096),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      executionEnabled: z.boolean().default(false),
    }).strict().parse(request.body);
    let path = resolve(input.path);
    if (!demo) {
      try { path = realpathSync(path); if (!statSync(path).isDirectory()) throw new Error(); }
      catch { throw error(400, '프로젝트 경로가 존재하는 디렉터리인지 확인해 주세요.'); }
    }
    const project = await write(() => {
      const existing = store.ensureProject(path, input.name);
      return store.saveProject({ ...existing, name: input.name, color: input.color || existing.color, executionEnabled: input.executionEnabled });
    });
    broadcast({ type: 'refresh' });
    return reply.code(201).send(project);
  });
  app.patch('/api/projects/:id', async (request) => {
    const input = z.object({ name: shortText.optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), executionEnabled: z.boolean().optional() }).strict().parse(request.body);
    const updated = await write(() => {
      const project = store.getProject(idParam(request.params));
      if (!project) throw error(404, '프로젝트를 찾을 수 없습니다.');
      if (!demo && input.executionEnabled) {
        try { if (!statSync(project.path).isDirectory()) throw new Error(); }
        catch { throw error(400, '실행을 켜기 전에 프로젝트 경로를 확인해 주세요.'); }
      }
      return store.saveProject({ ...project, ...input });
    });
    broadcast({ type: 'refresh' });
    return updated;
  });
  app.post('/api/templates', async (request, reply) => {
    const input = templateSchema.parse(request.body);
    const template = await write(() => store.saveTemplate({ ...input, id: newId('template'), updatedAt: new Date().toISOString() }));
    broadcast({ type: 'refresh' });
    return reply.code(201).send(template);
  });
  app.patch('/api/templates/:id', async (request) => {
    const id = idParam(request.params);
    const input = templateSchema.partial().parse(request.body);
    const updated = await write(() => {
      const template = store.listTemplates().find((t) => t.id === id);
      if (!template) throw error(404, '템플릿을 찾을 수 없습니다.');
      return store.saveTemplate({ ...template, ...input, updatedAt: new Date().toISOString() });
    });
    broadcast({ type: 'refresh' });
    return updated;
  });
  app.delete('/api/templates/:id', async (request) => {
    if (!await write(() => store.deleteTemplate(idParam(request.params)))) throw error(404, '템플릿을 찾을 수 없습니다.');
    broadcast({ type: 'refresh' });
    return { ok: true };
  });
  app.patch('/api/settings', async (request) => {
    const patch = settingsSchema.parse(request.body);
    if (patch.sourceRoots) {
      patch.sourceRoots = Object.fromEntries(AGENTS.map((agent) => [agent, [...new Set(patch.sourceRoots![agent].map((path) => {
        if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) throw error(400, '수집 경로는 절대 경로로 입력해 주세요.');
        return resolve(path);
      }))]])) as Settings['sourceRoots'];
    }
    const settings = await write(() => store.saveSettings(patch));
    invalidateConnectorCache();
    const policy = policyFrom(settings);
    const previous = syncManager.snapshot().policy;
    if (policy.mode !== previous.mode || policy.intervalSeconds !== previous.intervalSeconds || policy.maxSeconds !== previous.maxSeconds) {
      syncManager.configure(policy);
    }
    runner.pump();
    broadcast({ type: 'refresh' });
    return settings;
  });
  app.get('/api/events', async (request, reply) => {
    if (clients.size >= 50) throw error(429, 'Too many event streams.');
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': agent-ops event stream\n\n');
    clients.add(reply);
    const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n'); }, 15000);
    heartbeat.unref();
    reply.raw.on('close', () => { clearInterval(heartbeat); clients.delete(reply); });
  });

  const staticDir = options.staticDir || resolve(dirname(fileURLToPath(import.meta.url)), '../client');
  if (existsSync(join(staticDir, 'index.html'))) {
    const basePath = address?.basePath || '/';
    const index = readFileSync(join(staticDir, 'index.html'), 'utf8').replace(/<head>/i, `<head><base href="${basePath}">`);
    const serveIndex = async (_request: unknown, reply: FastifyReply) => reply.type('text/html; charset=utf-8').send(index);
    app.get('/', serveIndex);
    app.get('/index.html', serveIndex);
    await app.register(fastifyStatic, { root: staticDir, prefix: '/', etag: true, dotfiles: 'deny' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.includes('.')) return reply.code(404).send({ error: 'Not found' });
      return serveIndex(request, reply);
    });
  } else {
    app.get('/', async (_request, reply) => reply.type('text/plain').send('Agent Ops API is running. Build the UI with npm run build, or use npm run dev.'));
  }
  app.addHook('preClose', async () => {
    closing = true;
    resources.stop();
    syncManager.close();
    appUpdate.close();
    for (const reply of clients) reply.raw.end();
    clients.clear();
    await mcp.close();
    await runner.close();
  });
  app.addHook('onClose', async () => {
    try { await syncManager.wait(); }
    finally { store.close(); }
  });
  await app.ready();
  resources.start();
  syncManager.start();
  return { app, store, runner, sync, resources, mcp, desktopApps, syncManager, appUpdate };
}
