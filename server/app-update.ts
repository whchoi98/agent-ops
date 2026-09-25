import { compare } from 'semver';
import type { FastifyInstance } from 'fastify';
import {
  APP_UPDATE_REPOSITORY_URL, APP_UPDATE_SOURCE_URL, type AppUpdateCommands, type AppUpdateReport,
} from '../shared/app-update.js';
import { AppUpdateFailure, parseAppVersion } from './app-update/release.js';
import { downloadAppRelease } from './app-update/transport.js';

export type { AppUpdateReport } from '../shared/app-update.js';

export interface AppUpdateServiceOptions {
  currentVersion: string;
  demo?: boolean;
  /** Server/test injection only. HTTP callers cannot select a source or pass fetch options. */
  fetcher?: typeof fetch;
  /** Deterministic tests may supply both the timestamp and cooldown clock. */
  now?: () => number;
}

const MIN_CHECK_INTERVAL_MS = 60_000;
const noCommands = (): AppUpdateCommands => ({ npm: null, git: null });

/** One RAM cache and one owned request. Only check() can start an external request. */
export class AppUpdateService {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cooldownNow: () => number;
  private readonly validCurrentVersion: boolean;
  private cached: AppUpdateReport;
  private pending: Promise<AppUpdateReport> | null = null;
  private controller: AbortController | null = null;
  private nextAttemptTick: number | null = null;
  private closed = false;

  constructor(options: AppUpdateServiceOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.cooldownNow = options.now ?? (() => performance.now());
    this.validCurrentVersion = parseAppVersion(options.currentVersion) !== null;
    const demo = options.demo ?? false;
    this.cached = {
      currentVersion: options.currentVersion.slice(0, 256), demo,
      status: demo ? 'demo' : this.validCurrentVersion ? 'not-checked' : 'unavailable',
      checking: false, latest: null, checkedAt: null, nextCheckAt: null,
      sourceUrl: APP_UPDATE_SOURCE_URL,
      error: demo || this.validCurrentVersion ? null : 'invalid-current-version',
      commands: noCommands(),
    };
  }

  snapshot(): AppUpdateReport { return structuredClone(this.cached); }

  check(): Promise<AppUpdateReport> {
    if (this.closed || this.cached.demo || !this.validCurrentVersion) return Promise.resolve(this.snapshot());
    if (this.pending) return this.pending;
    const tick = this.cooldownNow();
    if (this.nextAttemptTick !== null && tick < this.nextAttemptTick) return Promise.resolve(this.snapshot());
    const attemptedAt = this.now();
    this.nextAttemptTick = tick + MIN_CHECK_INTERVAL_MS;
    this.cached = {
      ...this.cached, checking: true, error: null, commands: noCommands(),
      nextCheckAt: new Date(attemptedAt + MIN_CHECK_INTERVAL_MS).toISOString(),
    };
    this.controller = new AbortController();
    this.pending = this.run(this.controller);
    return this.pending;
  }

  private async run(controller: AbortController): Promise<AppUpdateReport> {
    try {
      const latest = await downloadAppRelease(this.fetcher, controller);
      if (this.closed) throw new AppUpdateFailure('closed');
      const order = compare(this.cached.currentVersion, latest.version);
      const status = order === 0 ? 'current' : order < 0 ? 'update-available' : 'ahead';
      const commands = noCommands();
      if (status === 'update-available') {
        // The validator only admits canonical SemVer tags and exact repository URLs.
        if (latest.archive) commands.npm = `npm install -g '${latest.archive.url}'`;
        commands.git = `git fetch --no-tags '${APP_UPDATE_REPOSITORY_URL}.git' 'refs/tags/${latest.tag}' &&\n`
          + 'git merge --ff-only FETCH_HEAD &&\nnpm ci &&\nnpm run build';
      }
      this.cached = { ...this.cached, status, latest, error: null, commands };
    } catch (cause) {
      this.cached = {
        ...this.cached, status: 'unavailable', latest: null, commands: noCommands(),
        error: this.closed ? 'closed' : cause instanceof AppUpdateFailure ? cause.code : 'request-failed',
      };
    } finally {
      this.cached = {
        ...this.cached, checking: false, checkedAt: new Date(this.now()).toISOString(),
        nextCheckAt: this.closed ? null : this.cached.nextCheckAt,
      };
      this.pending = null;
      this.controller = null;
    }
    return this.snapshot();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.cached.demo) {
      this.cached = {
        ...this.cached, status: 'unavailable', error: 'closed', checking: false,
        latest: null, nextCheckAt: null, commands: noCommands(),
      };
    }
    this.controller?.abort(new AppUpdateFailure('closed'));
  }
}

const INVALID_REQUEST = '앱 업데이트 요청에는 매개변수를 지정할 수 없습니다.';

function requireEmpty(value: unknown, optional = false): void {
  if (optional && value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) {
    throw Object.assign(new Error(INVALID_REQUEST), { statusCode: 400 });
  }
}

/** Mount in the guarded parent app. Shutdown aborts checks before HTTP request draining. */
export function registerAppUpdateRoutes(app: FastifyInstance, service: AppUpdateService): void {
  app.addHook('preClose', async () => { service.close(); });
  app.get('/api/app-update', {
    onRequest: async request => {
      if (Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding']) {
        throw Object.assign(new Error(INVALID_REQUEST), { statusCode: 400 });
      }
    },
  }, async (request, reply) => {
    requireEmpty(request.query);
    reply.header('Cache-Control', 'no-store');
    return service.snapshot();
  });
  app.post('/api/app-update/check', {
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
    return service.check();
  });
}
