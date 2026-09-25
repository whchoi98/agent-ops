import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DesktopApp, DesktopAppReport, DesktopAppLocation } from '../shared/desktop-apps.js';
import { inspectDesktopCandidate } from './desktop-apps/files.js';
import { convertPlist, MAX_CONVERTER_MS, readPlistMetadata, type PlistConverter } from './desktop-apps/plist.js';

export type { PlistConverter, PlistConverterOptions } from './desktop-apps/plist.js';
export type { DesktopAppReport } from '../shared/desktop-apps.js';

export interface DesktopAppServiceOptions {
  demo?: boolean;
  /** Host/test injection only; neither platform nor paths can be supplied through the HTTP API. */
  platform?: NodeJS.Platform;
  applicationsDir?: string;
  homeDir?: string;
  converter?: PlistConverter;
  converterTimeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
interface BundleCandidate { name: string; expectedIdentifier?: string }
const definitions: Array<Pick<DesktopApp, 'id' | 'agent' | 'name' | 'versionScope'> & { bundles: BundleCandidate[] }> = [
  { id: 'codex-app', agent: 'codex', name: 'Codex App', versionScope: 'app', bundles: [
    { name: 'Codex.app' }, { name: 'ChatGPT.app', expectedIdentifier: 'com.openai.codex' },
  ] },
  { id: 'claude-desktop', agent: 'claude', name: 'Claude Desktop', versionScope: 'app-container', bundles: [{ name: 'Claude.app' }] },
  { id: 'kiro-ide', agent: 'kiro', name: 'Kiro IDE', versionScope: 'ide', bundles: [{ name: 'Kiro.app' }] },
];

function bounded(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.min(Math.floor(value), fallback)) : fallback;
}

/** One service per server: lazy discovery, a ten-minute cache and one shared in-flight discovery. */
export class DesktopAppService {
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly converterTimeoutMs: number;
  private cached: DesktopAppReport | null = null;
  private cachedUntil = 0;
  private pending: Promise<DesktopAppReport> | null = null;

  constructor(private readonly options: DesktopAppServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = bounded(options.cacheTtlMs, CACHE_TTL_MS);
    this.converterTimeoutMs = bounded(options.converterTimeoutMs, MAX_CONVERTER_MS);
  }

  report(force = false): Promise<DesktopAppReport> {
    if (this.pending) return this.pending;
    if (!force && this.cached && this.now() < this.cachedUntil) return Promise.resolve(this.cached);
    this.pending = this.discover().then(report => {
      this.cached = report;
      this.cachedUntil = Date.parse(report.expiresAt);
      return report;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  refresh(): Promise<DesktopAppReport> { return this.report(true); }

  private async discover(): Promise<DesktopAppReport> {
    const demo = this.options.demo ?? false;
    const status = demo ? 'demo' : this.platform === 'darwin' ? 'supported' : 'unsupported-host';
    const items: DesktopApp[] = definitions.map(({ bundles: _bundles, ...definition }) => ({
      ...definition, status: status === 'unsupported-host' ? 'unsupported-host' : 'unverified', installed: null,
      installations: [], candidates: [],
      unverified: { authentication: 'unverified', cloudChats: 'unverified', privateHistories: 'unverified', codeEngineVersion: 'unverified' },
    }));
    // Do not even resolve the user's home or stat candidates on unsupported hosts or in demo mode.
    if (status === 'supported') {
      const roots: Array<{ path: string; location: DesktopAppLocation }> = [
        { path: resolve(this.options.applicationsDir ?? '/Applications'), location: 'system' },
        { path: join(resolve(this.options.homeDir ?? homedir()), 'Applications'), location: 'user' },
      ];
      const converter = this.options.converter ?? convertPlist;
      for (const [index, definition] of definitions.entries()) {
        const item = items[index];
        for (const root of roots) {
          for (const bundle of definition.bundles) {
            const result = await inspectDesktopCandidate(root.path, bundle.name, root.location,
              input => readPlistMetadata(input, converter, this.converterTimeoutMs), bundle.expectedIdentifier);
            item.candidates.push(result.candidate);
            if (result.installation) item.installations.push(result.installation);
          }
        }
        item.installed = item.installations.length ? true : item.candidates.some(candidate => candidate.status === 'unverified') ? null : false;
        item.status = item.installed === true ? 'installed' : item.installed === false ? 'not-installed' : 'unverified';
      }
    }
    const checked = this.now();
    return {
      status, platform: this.platform, scope: 'server-host', demo,
      checkedAt: new Date(checked).toISOString(), expiresAt: new Date(checked + this.cacheTtlMs).toISOString(),
      cacheTtlMs: this.cacheTtlMs, items,
    };
  }
}

function requireEmpty(value: unknown, optional = false) {
  if (optional && value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) {
    throw Object.assign(new Error('데스크톱 앱 요청에는 매개변수를 지정할 수 없습니다.'), { statusCode: 400 });
  }
}

/** Mount in the existing app so its Host, Origin, local-peer and proxy guards remain authoritative. */
export function registerDesktopAppRoutes(app: FastifyInstance, service: DesktopAppService) {
  app.get('/api/desktop-apps', {
    onRequest: async request => {
      if (Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding']) {
        throw Object.assign(new Error('데스크톱 앱 요청에는 매개변수를 지정할 수 없습니다.'), { statusCode: 400 });
      }
    },
  }, async (request, reply) => {
    requireEmpty(request.query);
    reply.header('Cache-Control', 'no-store');
    return service.report();
  });
  app.post('/api/desktop-apps/refresh', {
    bodyLimit: 1024,
    onRequest: async request => {
      if (request.headers['x-agent-ops'] !== '1') {
        throw Object.assign(new Error('X-Agent-Ops: 1 header required.'), { statusCode: 403 });
      }
    },
  }, async (request, reply) => {
    requireEmpty(request.query);
    requireEmpty(request.body, true);
    reply.header('Cache-Control', 'no-store');
    return service.refresh();
  });
}
