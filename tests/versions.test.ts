import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, ConnectorStatus } from '../shared/types.js';
import { VersionService } from '../server/versions.js';

const codexUrl = 'https://registry.npmjs.org/@openai/codex/latest';
const claudeUrl = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';
const kiroUrl = 'https://prod.download.cli.kiro.dev/stable/latest/manifest.json';
const kiroDocsUrl = 'https://kiro.dev/docs/cli/installation/';
const checkedAt = '2026-09-25T00:00:00.000Z';
const start = Date.parse(checkedAt);

function connector(agent: Agent, version: string | null, installed = true): ConnectorStatus {
  return {
    agent, installed, version, executable: installed ? `/fixture/private-account/${agent}` : null,
    roots: ['/fixture/private-history'], existingRoots: [], sessionCount: 17, error: null,
    supportsResume: false, supportsStreaming: false,
  };
}

function registry(codex = '0.157.0', claude = '2.1.282', kiro = '2.24.0'): typeof fetch {
  return async input => {
    if (String(input) === codexUrl) return Response.json({ name: '@openai/codex', version: codex });
    if (String(input) === claudeUrl) return Response.json({ name: '@anthropic-ai/claude-code', version: claude });
    if (String(input) === kiroUrl) return Response.json({
      version: kiro, packages: [{ channel: 'stable' }, { channel: 'stable' }],
    });
    throw new Error('Unexpected metadata URL');
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('VersionService comparison', () => {
  it('parses actual CLI prefixes and suffixes while preserving the raw strings', async () => {
    const service = new VersionService({ fetcher: registry(), now: () => start }, async () => [
      connector('codex', 'codex-cli 0.156.9'),
      connector('claude', '2.1.282 (Claude Code)'),
      connector('kiro', 'kiro-cli 3.0.1'),
    ]);
    const report = await service.report();
    expect(report.demo).toBe(false);
    expect(report.items.map(item => item.agent)).toEqual(['codex', 'claude', 'kiro']);
    expect(report.items[0]).toMatchObject({
      installed: true, currentVersion: '0.156.9', currentRaw: 'codex-cli 0.156.9',
      latestVersion: '0.157.0', status: 'update-available', checkedAt, sourceUrl: codexUrl, error: null,
    });
    expect(report.items[1]).toMatchObject({
      installed: true, currentVersion: '2.1.282', currentRaw: '2.1.282 (Claude Code)',
      latestVersion: '2.1.282', status: 'current', checkedAt, sourceUrl: claudeUrl, error: null,
    });
    expect(report.items[2]).toMatchObject({
      installed: true, currentVersion: '3.0.1', currentRaw: 'kiro-cli 3.0.1',
      latestVersion: '2.24.0', status: 'ahead', checkedAt, sourceUrl: kiroUrl,
      releaseUrl: kiroDocsUrl, channel: '공식 stable 배포', error: null,
    });
  });

  it.each([
    ['codex-cli 0.9.0', '0.10.0', '0.9.0', 'update-available'],
    ['codex v0.157.0', '0.157.0', '0.157.0', 'current'],
    ['  codex-cli 0.158.0  ', '0.157.0', '0.158.0', 'ahead'],
    ['codex-cli 0.157.0-alpha.2', '0.157.0', '0.157.0-alpha.2', 'update-available'],
    ['codex-cli 0.158.0-beta.1', '0.157.0', '0.158.0-beta.1', 'ahead'],
    ['codex-cli 0.157.0-rc.2', '0.157.0-rc.10', '0.157.0-rc.2', 'update-available'],
    ['codex-cli 0.157.0+local.1', '0.157.0+published.2', '0.157.0+local.1', 'current'],
  ])('compares %s against %s with real semver precedence', async (raw, latest, current, status) => {
    const service = new VersionService({ fetcher: registry(latest), now: () => start }, async () => [connector('codex', raw)]);
    expect((await service.report()).items[0]).toMatchObject({
      currentRaw: raw, currentVersion: current, latestVersion: latest, status,
    });
  });

  it.each([
    'custom build', 'codex-cli 01.157.0', 'codex-cli 0.157', 'codex-cli 0.157.0garbage',
    'codex-cli >=0.157.0', 'Error: Node.js v20.20.1', 'claude 0.157.0',
  ])('does not coerce unrelated or invalid installed output: %s', async raw => {
    const service = new VersionService({ fetcher: registry(), now: () => start }, async () => [connector('codex', raw)]);
    expect((await service.report()).items[0]).toMatchObject({
      installed: true, currentRaw: raw, currentVersion: null, latestVersion: '0.157.0', status: 'unknown',
    });
  });

  it('distinguishes explicitly absent installations from missing probe information', async () => {
    const service = new VersionService({ fetcher: registry(), now: () => start }, async () => [
      connector('codex', null, false),
    ]);
    const report = await service.report();
    expect(report.items[0]).toMatchObject({
      installed: false, currentRaw: null, currentVersion: null, latestVersion: '0.157.0', status: 'not-installed',
    });
    expect(report.items[1]).toMatchObject({ installed: null, currentVersion: null, status: 'unknown' });
  });

  it('isolates failed metadata providers while retaining their installed version', async () => {
    const fetcher: typeof fetch = async input => String(input) === codexUrl
      ? new Response('fixture-private-provider-error', { status: 503 })
      : registry()(input);
    const service = new VersionService({ fetcher, now: () => start }, async () => [
      connector('codex', 'codex-cli 0.157.0'), connector('claude', '2.1.282 (Claude Code)'),
    ]);
    const report = await service.report();
    expect(report.items[0]).toMatchObject({
      currentVersion: '0.157.0', currentRaw: 'codex-cli 0.157.0',
      latestVersion: null, status: 'check-failed', checkedAt,
    });
    expect(report.items[0].error).toBeTruthy();
    expect(report.items[1]).toMatchObject({ latestVersion: '2.1.282', status: 'current', error: null });
    expect(JSON.stringify(report)).not.toContain('fixture-private-provider-error');
  });

  it.each([
    { name: '@different/package', version: '0.157.0' },
    { name: '@openai/codex', version: 'latest' },
    { name: '@openai/codex', version: '0.157.0junk' },
    { name: '@openai/codex', version: '01.157.0' },
    { name: '@openai/codex', version: 157 },
    { version: '0.157.0' },
    ['0.157.0'],
  ])('requires a matching package identity and a valid version', async payload => {
    const fetcher: typeof fetch = async input => String(input) === codexUrl ? Response.json(payload) : registry()(input);
    const service = new VersionService({ fetcher, now: () => start }, async () => [connector('codex', 'codex-cli 0.157.0')]);
    expect((await service.report()).items[0]).toMatchObject({
      installed: true, currentVersion: '0.157.0', latestVersion: null, status: 'check-failed',
    });
  });
});

describe('VersionService Kiro stable metadata', () => {
  it.each([
    ['kiro-cli 2.23.0', '2.23.0', 'update-available'],
    ['kiro-cli 2.24.0', '2.24.0', 'current'],
    ['kiro-cli 3.0.0-preview.1', '3.0.0-preview.1', 'ahead'],
  ])('compares %s with the version at the root of the verified stable manifest', async (raw, current, status) => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async input => {
      requests.push(String(input));
      if (String(input) !== kiroUrl) return registry()(input);
      return Response.json({
        version: '2.24.0',
        packages: [
          { channel: 'stable', version: '999.0.0', url: 'https://untrusted.example.test/do-not-download' },
          { channel: 'stable' },
        ],
      });
    };
    const result = (await new VersionService({ fetcher, now: () => start }, async () => [
      connector('kiro', raw),
    ]).report()).items[2];
    expect(result).toMatchObject({
      agent: 'kiro', installed: true, currentRaw: raw, currentVersion: current, latestVersion: '2.24.0',
      status, checkedAt, sourceUrl: kiroUrl, releaseUrl: kiroDocsUrl, channel: '공식 stable 배포', error: null,
    });
    expect(requests.sort()).toEqual([kiroUrl, claudeUrl, codexUrl]);
    expect(JSON.stringify(result)).not.toContain('untrusted.example.test');
  });

  it.each([
    { version: '2.24.0' },
    { version: '2.24.0', packages: {} },
    { version: '2.24.0', packages: [] },
    { version: '2.24.0', packages: [null] },
    { version: '2.24.0', packages: ['stable'] },
    { version: '2.24.0', packages: [{}] },
    { version: '2.24.0', packages: [{ channel: 'preview' }] },
    { version: '2.24.0', packages: [{ channel: 'stable' }, { channel: 'fixture-private-channel' }] },
    { version: '2.24.0', packages: [{ channel: 'Stable' }] },
    { version: '2.24', packages: [{ channel: 'stable' }] },
    { version: 224, packages: [{ channel: 'stable' }] },
  ])('rejects missing or inconsistent Kiro manifest fields without losing the installed version', async payload => {
    const fetcher: typeof fetch = async input => String(input) === kiroUrl ? Response.json(payload) : registry()(input);
    const report = await new VersionService({ fetcher, now: () => start }, async () => [
      connector('codex', 'codex-cli 0.157.0'), connector('claude', '2.1.282 (Claude Code)'),
      connector('kiro', 'kiro-cli 2.24.0'),
    ]).report();
    expect(report.items[2]).toMatchObject({
      installed: true, currentRaw: 'kiro-cli 2.24.0', currentVersion: '2.24.0',
      latestVersion: null, status: 'check-failed', checkedAt,
      sourceUrl: kiroUrl, releaseUrl: kiroDocsUrl, channel: '공식 stable 배포',
    });
    expect(report.items[2].error).toBeTruthy();
    expect(report.items.slice(0, 2).map(item => item.status)).toEqual(['current', 'current']);
    expect(JSON.stringify(report)).not.toContain('fixture-private-channel');
  });

  it('isolates a Kiro transport failure while retaining all installed comparisons', async () => {
    const fetcher: typeof fetch = async input => {
      if (String(input) === kiroUrl) throw new Error('fixture-private-kiro-error');
      return registry()(input);
    };
    const report = await new VersionService({ fetcher, now: () => start }, async () => [
      connector('codex', 'codex-cli 0.157.0'), connector('claude', '2.1.282 (Claude Code)'),
      connector('kiro', 'kiro-cli 2.24.0'),
    ]).report();
    expect(report.items.map(item => item.status)).toEqual(['current', 'current', 'check-failed']);
    expect(report.items[2]).toMatchObject({ currentVersion: '2.24.0', latestVersion: null, checkedAt });
    expect(JSON.stringify(report)).not.toContain('fixture-private-kiro-error');
  });
});

describe('VersionService bounded transport', () => {
  it('only issues fixed official metadata GETs without credentials, redirects or local state', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return registry()(input, init);
    };
    const service = new VersionService({ fetcher, now: () => start }, async () => [
      connector('codex', 'codex-cli 0.156.9'), connector('claude', '2.1.282 (Claude Code)'),
    ]);
    await service.report();
    expect(requests.map(request => request.url).sort()).toEqual([kiroUrl, claudeUrl, codexUrl]);
    for (const { init } of requests) {
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      expect(new Headers(init?.headers).get('cookie')).toBeNull();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.stringify(requests)).not.toContain('private-account');
    expect(JSON.stringify(requests)).not.toContain('private-history');
    expect(JSON.stringify(requests)).not.toContain('0.156.9');
  });

  it.each([
    () => new Response(null, { status: 302, headers: { location: 'https://untrusted.example.test/' } }),
    () => new Response('{"name":"@openai/codex","version":"fixture-private-error"'),
    () => new Response(null, { status: 204 }),
  ])('rejects redirects, malformed metadata and empty bodies without exposing their text', async response => {
    const fetcher: typeof fetch = async input => String(input) === codexUrl ? response() : registry()(input);
    const result = (await new VersionService({ fetcher, now: () => start }, async () => [
      connector('codex', 'codex-cli 0.157.0'),
    ]).report()).items[0];
    expect(result).toMatchObject({ currentVersion: '0.157.0', latestVersion: null, status: 'check-failed' });
    expect(result.error).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain('fixture-private-error');
    expect(JSON.stringify(result)).not.toContain('untrusted.example.test');
  });

  it.each(['header', 'bytes', 'utf8'] as const)('enforces the 128 KiB limit using %s', async kind => {
    let cancelled = false;
    const fetcher: typeof fetch = async input => {
      if (String(input) !== codexUrl) return registry()(input);
      const bytes = kind === 'utf8'
        ? new TextEncoder().encode('가'.repeat(45_000))
        : new Uint8Array(kind === 'header' ? 1 : 131_073);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes); },
        cancel() { cancelled = true; },
      }), { headers: kind === 'header' ? { 'content-length': '131073' } : {} });
    };
    const report = await new VersionService({ fetcher, now: () => start }, async () => [
      connector('codex', 'codex-cli 0.157.0'), connector('claude', '2.1.282 (Claude Code)'),
    ]).report();
    expect(report.items[0]).toMatchObject({ latestVersion: null, status: 'check-failed' });
    expect(report.items[0].error).toContain('128');
    expect(report.items[1].status).toBe('current');
    expect(cancelled).toBe(true);
  });

  it('accepts valid metadata at the exact byte limit', async () => {
    const skeleton = '{"name":"@openai/codex","version":"0.157.0","padding":""}';
    const payload = skeleton.replace('""', `"${'x'.repeat(131_072 - skeleton.length)}"`);
    const fetcher: typeof fetch = async input => String(input) === codexUrl
      ? new Response(payload, { headers: { 'content-length': '131072' } }) : registry()(input);
    expect((await new VersionService({ fetcher, now: () => start }, async () => [
      connector('codex', 'codex-cli 0.157.0'),
    ]).report()).items[0]).toMatchObject({ latestVersion: '0.157.0', status: 'current', error: null });
  });

  it('bounds a fetcher that never returns headers even if it ignores abort', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input) !== codexUrl) return registry()(input, init);
      signal = init?.signal;
      return new Promise<Response>(() => {});
    };
    const pending = new VersionService({ fetcher, timeoutMs: 20, now: () => start }, async () => [
      connector('codex', 'codex-cli 0.157.0'), connector('claude', '2.1.282 (Claude Code)'),
    ]).report();
    await vi.advanceTimersByTimeAsync(21);
    const report = await pending;
    expect(report.items[0]).toMatchObject({ currentVersion: '0.157.0', latestVersion: null, status: 'check-failed' });
    expect(report.items[0].error).toMatch(/시간|timeout/i);
    expect(report.items[1].status).toBe('current');
    expect(signal?.aborted).toBe(true);
  });

  it('uses one total deadline for headers and body and does not await a stalled cancellation', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const fetcher: typeof fetch = async input => {
      if (String(input) !== codexUrl) return registry()(input);
      await new Promise(resolve => setTimeout(resolve, 12));
      return new Response(new ReadableStream<Uint8Array>({
        cancel() { cancelled = true; return new Promise<void>(() => {}); },
      }));
    };
    const pending = new VersionService({ fetcher, timeoutMs: 20, now: () => start }, async () => [
      connector('codex', 'codex-cli 0.157.0'),
    ]).report();
    await vi.advanceTimersByTimeAsync(21);
    const result = (await pending).items[0];
    expect(result).toMatchObject({ currentVersion: '0.157.0', latestVersion: null, status: 'check-failed' });
    expect(result.error).toMatch(/시간|timeout/i);
    expect(cancelled).toBe(true);
  });

  it('rejects pathological empty-chunk streams without starving the deadline', async () => {
    let chunks = 0;
    let cancelled = false;
    const fetcher: typeof fetch = async input => {
      if (String(input) !== codexUrl) return registry()(input);
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (++chunks <= 10_000) controller.enqueue(new Uint8Array());
          else {
            controller.enqueue(new TextEncoder().encode('{"name":"@openai/codex","version":"0.157.0"}'));
            controller.close();
          }
        },
        cancel() { cancelled = true; },
      }));
    };
    const result = (await new VersionService({ fetcher, now: () => start }, async () => [
      connector('codex', 'codex-cli 0.157.0'),
    ]).report()).items[0];
    expect(result).toMatchObject({ currentVersion: '0.157.0', latestVersion: null, status: 'check-failed' });
    expect(cancelled).toBe(true);
  });

  it('cancels a late response body after the metadata deadline has already returned a failure', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const fetcher: typeof fetch = async input => {
      if (String(input) !== codexUrl) return registry()(input);
      await new Promise(resolve => setTimeout(resolve, 30));
      return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
    };
    const pending = new VersionService({ fetcher, timeoutMs: 20, now: () => start }, async () => [
      connector('codex', 'codex-cli 0.157.0'),
    ]).report();
    await vi.advanceTimersByTimeAsync(21);
    expect((await pending).items[0].status).toBe('check-failed');
    await vi.advanceTimersByTimeAsync(10);
    expect(cancelled).toBe(true);
  });
});

describe('VersionService caching and demo isolation', () => {
  it('honors a shorter configured TTL without bypassing the separate forced-refresh cooldown', async () => {
    let clock = start;
    let remote = '0.157.0';
    const fetcher: typeof fetch = input => registry(remote)(input);
    const service = new VersionService({ fetcher, now: () => clock, ttlMs: 1000 }, async () => [
      connector('codex', 'codex-cli 0.157.0'),
    ]);
    expect((await service.report()).items[0].latestVersion).toBe('0.157.0');
    remote = '0.158.0';
    clock += 999;
    expect((await service.report()).items[0].latestVersion).toBe('0.157.0');
    clock++;
    expect((await service.report()).items[0].latestVersion).toBe('0.158.0');
    remote = '0.159.0';
    expect((await service.report(true)).items[0].latestVersion).toBe('0.158.0');
  });

  it('caches latest metadata for an hour while refreshing installed versions', async () => {
    let clock = start;
    let remote = '0.157.0';
    let installed = 'codex-cli 0.156.9';
    const fetcher: typeof fetch = input => registry(remote)(input);
    const service = new VersionService({ fetcher, now: () => clock }, async () => [connector('codex', installed)]);
    const first = await service.report();
    expect(first.items[0]).toMatchObject({ latestVersion: '0.157.0', status: 'update-available', checkedAt });
    first.items[0].latestVersion = '99.0.0';
    remote = '0.158.0';
    installed = 'codex-cli 0.157.0';
    clock += 3_599_999;
    expect((await service.report()).items[0]).toMatchObject({
      currentVersion: '0.157.0', latestVersion: '0.157.0', status: 'current', checkedAt,
    });
    clock++;
    expect((await service.report()).items[0]).toMatchObject({
      latestVersion: '0.158.0', status: 'update-available', checkedAt: '2026-09-25T01:00:00.000Z',
    });
  });

  it('coalesces concurrent lookups and bounds forced refresh storms', async () => {
    let clock = start;
    let remote = '0.157.0';
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const requests: string[] = [];
    const fetcher: typeof fetch = async input => {
      requests.push(String(input));
      await gate;
      return registry(remote)(input);
    };
    const service = new VersionService({ fetcher, now: () => clock }, async () => [connector('codex', 'codex-cli 0.157.0')]);
    const pending = Array.from({ length: 12 }, (_, index) => service.report(index % 2 === 0));
    release();
    const reports = await Promise.all(pending);
    expect(reports.every(report => report.items[0].latestVersion === '0.157.0')).toBe(true);
    expect(requests.filter(url => url === codexUrl)).toHaveLength(1);
    expect(requests.filter(url => url === claudeUrl)).toHaveLength(1);
    expect(requests.filter(url => url === kiroUrl)).toHaveLength(1);
    remote = '0.158.0';
    clock += 29_999;
    expect((await service.report(true)).items[0].latestVersion).toBe('0.157.0');
    clock++;
    expect((await service.report(true)).items[0].latestVersion).toBe('0.158.0');
    expect(requests.filter(url => url === codexUrl)).toHaveLength(2);
    expect(requests.filter(url => url === kiroUrl)).toHaveLength(2);
  });

  it('retains installed versions but never reports stale successful metadata as current after a failed refresh', async () => {
    let clock = start;
    let fail = false;
    const fetcher: typeof fetch = async input => {
      if (fail && String(input) === codexUrl) throw new Error('fixture-private-network-error');
      return registry()(input);
    };
    const service = new VersionService({ fetcher, now: () => clock }, async () => [connector('codex', 'codex-cli 0.157.0')]);
    expect((await service.report()).items[0].status).toBe('current');
    fail = true;
    clock += 30_000;
    const failed = await service.report(true);
    expect(failed.items[0]).toMatchObject({
      currentVersion: '0.157.0', currentRaw: 'codex-cli 0.157.0', latestVersion: null, status: 'check-failed',
    });
    fail = false;
    expect((await service.report(true)).items[0].status).toBe('check-failed');
    clock += 30_000;
    expect((await service.report(true)).items[0].status).toBe('current');
    expect(JSON.stringify(failed)).not.toContain('fixture-private-network-error');
  });

  it('handles a failed local probe as unknown installation information without exposing its diagnostic', async () => {
    const service = new VersionService({ fetcher: registry(), now: () => start }, async () => {
      throw new Error('fixture-private-probe-error');
    });
    const report = await service.report();
    expect(report.items[0]).toMatchObject({ currentVersion: null, currentRaw: null, latestVersion: '0.157.0', status: 'unknown' });
    expect(JSON.stringify(report)).not.toContain('fixture-private-probe-error');
  });

  it('returns the fixed sample comparisons without probing the host or fetching metadata', async () => {
    const service = new VersionService({
      demo: true,
      fetcher: async () => { throw new Error('Demo must not fetch'); },
      now: () => { throw new Error('Demo timestamps must be fixed'); },
    }, async () => { throw new Error('Demo must not probe'); });
    const report = await service.report(true);
    expect(report.demo).toBe(true);
    expect(report.notice).toMatch(/샘플|sample/i);
    expect(report.items.map(({ agent, currentVersion, latestVersion, status }) => ({
      agent, currentVersion, latestVersion, status,
    }))).toEqual([
      { agent: 'codex', currentVersion: '1.0.0', latestVersion: '1.1.0', status: 'update-available' },
      { agent: 'claude', currentVersion: '2.1.0', latestVersion: '2.1.0', status: 'current' },
      { agent: 'kiro', currentVersion: '3.0.0-preview.1', latestVersion: '2.9.0', status: 'ahead' },
    ]);
    expect(await service.report()).toEqual(report);
  });
});
