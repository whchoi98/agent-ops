import { compare, parse as parseSemver } from 'semver';
import { stripVTControlCharacters } from 'node:util';
import { AGENTS, type Agent, type ConnectorStatus } from '../shared/types.js';
import type { ConnectorVersion, VersionReport } from '../shared/versions.js';

export interface VersionServiceOptions {
  demo?: boolean;
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
}

const MAX_METADATA_BYTES = 128 * 1024;
const MAX_METADATA_CHUNKS = 4096;
const REFRESH_INTERVAL_MS = 30_000;
const INVALID_METADATA = '유효한 최신 버전 메타데이터가 아닙니다.';
const FETCH_FAILED = '공식 최신 버전 정보를 가져오지 못했습니다.';
const FETCH_TIMEOUT = '최신 버전 조회 시간이 초과되었습니다.';
const OVERSIZED_METADATA = '최신 버전 메타데이터가 크기 제한(128 KiB)을 초과했습니다.';
const NOTICE = '설치된 CLI와 공식 배포 채널의 버전을 비교합니다. 최신 버전 조회 결과는 캐시되며 자동 업데이트는 실행하지 않습니다.';

type Source = { url: string; channel: string; releaseUrl?: string } & (
  { kind: 'npm'; packageName: string } | { kind: 'kiro' }
);
const sources: Record<Agent, Source> = {
  codex: { kind: 'npm', url: 'https://registry.npmjs.org/@openai/codex/latest', packageName: '@openai/codex', channel: 'npm latest' },
  claude: { kind: 'npm', url: 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest', packageName: '@anthropic-ai/claude-code', channel: 'npm latest' },
  kiro: {
    kind: 'kiro', url: 'https://prod.download.cli.kiro.dev/stable/latest/manifest.json',
    channel: '공식 stable 배포', releaseUrl: 'https://kiro.dev/docs/cli/installation/',
  },
};

const prefixes: Record<Agent, RegExp> = {
  codex: /^(?:codex(?:-cli)?|@openai\/codex)(?:\s+version)?\s+/i,
  claude: /^(?:claude(?: code|-code|-cli)?|@anthropic-ai\/claude-code)(?:\s+version)?\s+/i,
  kiro: /^kiro(?:-cli| cli)?(?:\s+version)?\s+/i,
};

function normalizeVersion(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 256) return null;
  const version = parseSemver(value);
  if (!version) return null;
  return version.version + (version.build.length ? `+${version.build.join('.')}` : '');
}

function installedVersion(agent: Agent, raw: string | null): string | null {
  if (!raw || raw.length > 4096) return null;
  const text = stripVTControlCharacters(raw).trim().replace(prefixes[agent], '');
  const match = /^(v?[0-9][0-9A-Za-z.+-]*)(?:[ \t]+\([^()\r\n]*\))?$/.exec(text);
  return match ? normalizeVersion(match[1]) : null;
}

function duration(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(maximum, Math.max(1, value)) : fallback;
}

interface Latest {
  version: string | null;
  checkedAt: string | null;
  error: string | null;
  failed: boolean;
}
interface CachedLatest { attemptedAt: number; expiresAt: number; value: Latest }
class MetadataError extends Error {}

function demoReport(): VersionReport {
  const samples: [Agent, string, string, string, ConnectorVersion['status']][] = [
    ['codex', '1.0.0', 'codex-cli 1.0.0', '1.1.0', 'update-available'],
    ['claude', '2.1.0', '2.1.0 (Claude Code)', '2.1.0', 'current'],
    ['kiro', '3.0.0-preview.1', 'kiro-cli 3.0.0-preview.1', '2.9.0', 'ahead'],
  ];
  return {
    demo: true,
    notice: '데모용 고정 샘플 데이터입니다. 호스트나 인터넷을 조회하지 않습니다.',
    items: samples.map(([agent, currentVersion, currentRaw, latestVersion, status]) => ({
      agent, installed: true, currentVersion, currentRaw, latestVersion, status,
      checkedAt: '2026-09-25T00:00:00.000Z', sourceUrl: '', releaseUrl: '', channel: 'sample', error: null,
    })),
  };
}

export class VersionService {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly cache = new Map<Agent, CachedLatest>();
  private readonly inFlight = new Map<Agent, Promise<Latest>>();
  private probeInFlight: Promise<ConnectorStatus[]> | null = null;

  constructor(private readonly options: VersionServiceOptions, private readonly probe: () => Promise<ConnectorStatus[]>) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = duration(options.timeoutMs, 5000, 30_000);
    this.ttlMs = duration(options.ttlMs, 3_600_000, 86_400_000);
  }

  private installed(): Promise<ConnectorStatus[]> {
    if (!this.probeInFlight) {
      this.probeInFlight = Promise.resolve().then(() => this.probe()).catch(() => [])
        .finally(() => { this.probeInFlight = null; });
    }
    return this.probeInFlight;
  }

  private async download(source: Source): Promise<string> {
    const controller = new AbortController();
    const expires = performance.now() + this.timeoutMs;
    let body: ReadableStream<Uint8Array> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timedOut = false;
    const cancel = () => {
      try {
        const pending = reader ? reader.cancel() : body?.cancel();
        void pending?.catch(() => {});
      } catch { /* Cleanup must not defeat the total deadline. */ }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new MetadataError(FETCH_TIMEOUT));
        controller.abort();
        cancel();
      }, this.timeoutMs);
    });
    const operation = async (): Promise<string> => {
      // Only server-owned constants are requested. No local version/configuration enters this request.
      const response = await this.fetcher(source.url, {
        method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { accept: 'application/json' }, cache: 'no-store', signal: controller.signal,
      });
      body = response.body;
      if (controller.signal.aborted || performance.now() >= expires) { cancel(); throw new MetadataError(FETCH_TIMEOUT); }
      if (!response.ok || response.redirected) throw new MetadataError(FETCH_FAILED);
      const length = response.headers.get('content-length');
      if (length && /^\d+$/.test(length) && Number(length) > MAX_METADATA_BYTES) throw new MetadataError(OVERSIZED_METADATA);
      if (!body) throw new MetadataError(INVALID_METADATA);
      reader = body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0;
      let chunks = 0;
      let text = '';
      for (;;) {
        const chunk = await reader.read();
        if (controller.signal.aborted || performance.now() >= expires) throw new MetadataError(FETCH_TIMEOUT);
        if (chunk.done) break;
        if (++chunks > MAX_METADATA_CHUNKS) throw new MetadataError(INVALID_METADATA);
        bytes += chunk.value.byteLength;
        if (bytes > MAX_METADATA_BYTES) throw new MetadataError(OVERSIZED_METADATA);
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      const payload: unknown = JSON.parse(text);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new MetadataError(INVALID_METADATA);
      const data = payload as Record<string, unknown>;
      const version = normalizeVersion(data.version);
      if (!version || version !== data.version) throw new MetadataError(INVALID_METADATA);
      if (source.kind === 'npm') {
        if (data.name !== source.packageName) throw new MetadataError(INVALID_METADATA);
      } else if (!Array.isArray(data.packages) || !data.packages.length || !data.packages.every(
        entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
          && Object.hasOwn(entry, 'channel') && entry.channel === 'stable',
      )) {
        throw new MetadataError(INVALID_METADATA);
      }
      if (performance.now() >= expires) throw new MetadataError(FETCH_TIMEOUT);
      return version;
    };
    try {
      return await Promise.race([operation(), deadline]);
    } catch (error) {
      throw timedOut ? new MetadataError(FETCH_TIMEOUT) : error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      cancel();
      try { reader?.releaseLock(); } catch { /* A pending read was already cancelled. */ }
    }
  }

  private latest(agent: Agent, force: boolean): Promise<Latest> {
    const source = sources[agent];
    const pending = this.inFlight.get(agent);
    if (pending) return pending;
    const attemptedAt = this.now();
    const cached = this.cache.get(agent);
    if (cached && (force ? attemptedAt - cached.attemptedAt < REFRESH_INTERVAL_MS : attemptedAt < cached.expiresAt)) {
      return Promise.resolve(cached.value);
    }
    const checkedAt = new Date(attemptedAt).toISOString();
    const lookup = this.download(source).then<Latest, Latest>(
      version => ({ version, checkedAt, error: null, failed: false }),
      error => ({
        version: null, checkedAt, failed: true,
        error: error instanceof MetadataError ? error.message : FETCH_FAILED,
      }),
    ).then(value => {
      this.cache.set(agent, {
        attemptedAt, expiresAt: attemptedAt + (value.failed ? REFRESH_INTERVAL_MS : this.ttlMs), value,
      });
      return value;
    }).finally(() => { this.inFlight.delete(agent); });
    this.inFlight.set(agent, lookup);
    return lookup;
  }

  async report(force = false): Promise<VersionReport> {
    if (this.options.demo) return demoReport();
    const [connectors, latest] = await Promise.all([
      this.installed(), Promise.all(AGENTS.map(agent => this.latest(agent, force))),
    ]);
    return {
      demo: false, notice: NOTICE,
      items: AGENTS.map((agent, index): ConnectorVersion => {
        const connector = connectors.find(item => item.agent === agent);
        const currentRaw = connector?.version ?? null;
        const currentVersion = connector?.installed ? installedVersion(agent, currentRaw) : null;
        const remote = latest[index];
        let status: ConnectorVersion['status'] = 'unknown';
        let error = remote.error;
        if (!connector) error = '설치된 CLI 상태를 확인하지 못했습니다.';
        else if (!connector.installed) status = 'not-installed';
        else if (remote.failed) status = 'check-failed';
        else if (!currentVersion) error = '설치된 CLI 버전을 해석할 수 없습니다.';
        else if (remote.version) {
          const order = compare(currentVersion, remote.version);
          status = order === 0 ? 'current' : order < 0 ? 'update-available' : 'ahead';
        }
        return {
          agent, installed: connector?.installed ?? null, currentVersion, currentRaw,
          latestVersion: remote.version, status, error, checkedAt: remote.checkedAt,
          sourceUrl: sources[agent].url, releaseUrl: sources[agent].releaseUrl ?? sources[agent].url,
          channel: sources[agent].channel,
        };
      }),
    };
  }
}
