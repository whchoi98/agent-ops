import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppUpdateService, type AppUpdateServiceOptions } from '../server/app-update.js';

const sourceUrl = 'https://api.github.com/repos/whchoi98/agent-ops/releases/latest';
const repositoryUrl = 'https://github.com/whchoi98/agent-ops';
const start = Date.parse('2026-09-25T12:00:00.000Z');
const services: AppUpdateService[] = [];

function release(version = '1.3.0', tag = `v${version}`) {
  return {
    id: 42, tag_name: tag, name: `Release ${version}`, draft: false, prerelease: false,
    html_url: `${repositoryUrl}/releases/tag/${encodeURIComponent(tag)}`,
    published_at: '2026-09-24T10:20:30Z',
    body: 'Unneeded release prose must not enter the cache.',
    author: { login: 'fixture-author' },
    assets: [{
      id: 43, name: `agent-ops-local-${version}.tgz`, state: 'uploaded', size: 123456,
      browser_download_url: `${repositoryUrl}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(`agent-ops-local-${version}.tgz`)}`,
    }],
  };
}

function service(options: Partial<AppUpdateServiceOptions> = {}) {
  const result = new AppUpdateService({
    currentVersion: '1.2.1', now: () => start,
    fetcher: async () => Response.json(release()),
    ...options,
  });
  services.push(result);
  return result;
}

afterEach(() => {
  services.splice(0).forEach(item => item.close());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('workbench update cache and comparison', () => {
  it('constructs and reads a bounded unverified snapshot without a network request', () => {
    let requests = 0;
    const update = service({ fetcher: async () => { requests++; return Response.json(release()); } });
    expect(update.snapshot()).toEqual({
      currentVersion: '1.2.1', demo: false, status: 'not-checked', checking: false,
      latest: null, checkedAt: null, nextCheckAt: null, error: null, sourceUrl,
      commands: { npm: null, git: null },
    });
    expect(update.snapshot()).toEqual(update.snapshot());
    expect(requests).toBe(0);
  });

  it('checks only the fixed public source and caches validated release metadata and safe commands', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const update = service({
      fetcher: async (url, init) => {
        requests.push({ url: String(url), init });
        return Response.json(release());
      },
    });
    const result = await update.check();
    expect(result).toMatchObject({
      currentVersion: '1.2.1', demo: false, status: 'update-available', checking: false,
      checkedAt: '2026-09-25T12:00:00.000Z', nextCheckAt: '2026-09-25T12:01:00.000Z', error: null, sourceUrl,
      latest: {
        version: '1.3.0', tag: 'v1.3.0', publishedAt: '2026-09-24T10:20:30.000Z',
        releaseUrl: 'https://github.com/whchoi98/agent-ops/releases/tag/v1.3.0',
        archive: {
          name: 'agent-ops-local-1.3.0.tgz',
          url: 'https://github.com/whchoi98/agent-ops/releases/download/v1.3.0/agent-ops-local-1.3.0.tgz',
        },
      },
      commands: {
        npm: "npm install -g 'https://github.com/whchoi98/agent-ops/releases/download/v1.3.0/agent-ops-local-1.3.0.tgz'",
        git: "git fetch --no-tags 'https://github.com/whchoi98/agent-ops.git' 'refs/tags/v1.3.0' &&\ngit merge --ff-only FETCH_HEAD &&\nnpm ci &&\nnpm run build",
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(sourceUrl);
    expect(requests[0].init).toMatchObject({
      method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      signal: expect.any(AbortSignal),
    });
    const headers = new Headers(requests[0].init?.headers);
    expect([...headers.keys()].sort()).toEqual(['accept', 'user-agent']);
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(headers.get('user-agent')).not.toContain('1.2.1');
    expect(requests[0].init?.body).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/Unneeded release prose|fixture-author|"id":/);
    expect(update.snapshot()).toEqual(result);
    expect(requests).toHaveLength(1);
  });

  it.each([
    ['1.9.9', '1.10.0', 'update-available'],
    ['1.3.0', '1.3.0', 'current'],
    ['2.0.0', '1.3.0', 'ahead'],
    ['1.3.0-rc.10', '1.3.0', 'update-available'],
    ['1.4.0-beta.1', '1.3.0', 'ahead'],
    ['1.3.0+local.3', '1.3.0+published.4', 'current'],
    ['0.0.0', '0.0.1', 'update-available'],
  ])('compares %s with %s using SemVer precedence', async (currentVersion, latest, status) => {
    const result = await service({ currentVersion, fetcher: async () => Response.json(release(latest)) }).check();
    expect(result).toMatchObject({ currentVersion, status, latest: { version: latest }, error: null });
    if (status !== 'update-available') expect(result.commands).toEqual({ npm: null, git: null });
  });

  it('accepts an exact stable SemVer tag without a v prefix', async () => {
    const result = await service({ fetcher: async () => Response.json(release('1.3.0', '1.3.0')) }).check();
    expect(result).toMatchObject({ status: 'update-available', latest: { tag: '1.3.0', version: '1.3.0' } });
    expect(result.commands.git).toContain("'refs/tags/1.3.0'");
  });

  it.each(['', '1.2', '01.2.1', '=1.2.1', 'v1.2.1', ' 1.2.1', '1.2.1\n', '1.2.1;touch /tmp/fixture'])(
    'does not invent a comparison for an invalid current version: %j',
    async currentVersion => {
      let requests = 0;
      const update = service({
        currentVersion, fetcher: async () => { requests++; return Response.json(release()); },
      });
      expect(await update.check()).toMatchObject({
        status: 'unavailable', error: 'invalid-current-version', latest: null,
        checkedAt: null, nextCheckAt: null, commands: { npm: null, git: null },
      });
      expect(requests).toBe(0);
    },
  );

  it('does not let consumers alter cached metadata, commands or the current version', async () => {
    const update = service();
    const checked = await update.check();
    checked.latest!.archive!.url = 'https://attacker.invalid/archive.tgz';
    checked.commands.npm = 'untrusted';
    const snapshot = update.snapshot();
    snapshot.latest!.version = '999.0.0';
    snapshot.currentVersion = '999.0.0';
    expect(update.snapshot()).toMatchObject({
      currentVersion: '1.2.1', latest: { version: '1.3.0', archive: { url: expect.stringContaining('/whchoi98/agent-ops/') } },
      commands: { npm: expect.stringContaining("npm install -g 'https://github.com/whchoi98/agent-ops/") },
    });
  });

  it('never contacts a release source or offers install commands in demo mode', async () => {
    let requests = 0;
    const update = service({ demo: true, fetcher: async () => { requests++; return Response.json(release()); } });
    const snapshot = update.snapshot();
    expect(snapshot).toMatchObject({
      currentVersion: '1.2.1', demo: true, status: 'demo', checking: false, latest: null,
      checkedAt: null, nextCheckAt: null, error: null, commands: { npm: null, git: null },
    });
    expect(await update.check()).toEqual(snapshot);
    expect(requests).toBe(0);
  });
});

describe('release validation', () => {
  it.each([
    null, [], '1.3.0',
    { ...release(), draft: true },
    { ...release(), draft: undefined },
    { ...release(), draft: 'false' },
    { ...release(), prerelease: true },
    { ...release(), prerelease: undefined },
    { ...release(), prerelease: 0 },
    ...['v01.3.0', 'v1.3', 'vv1.3.0', 'latest', 'v1.3.0-rc.1', 'v1.3.0;id', 'v1.3.0\n', 'v1.3.0/other', `v1.3.0+${'a'.repeat(256)}`]
      .map(tag_name => ({ ...release(), tag_name })),
    { ...release(), published_at: undefined },
    { ...release(), published_at: 'yesterday' },
    { ...release(), published_at: '2026-02-30T12:00:00Z' },
    { ...release(), published_at: '2026-09-24' },
    { ...release(), assets: null },
    { ...release(), assets: {} },
    { ...release(), assets: [null] },
  ])('rejects malformed, draft and prerelease payloads', async payload => {
    const result = await service({ fetcher: async () => Response.json(payload) }).check();
    expect(result).toMatchObject({
      status: 'unavailable', latest: null, error: 'invalid-release', checking: false,
      checkedAt: '2026-09-25T12:00:00.000Z', commands: { npm: null, git: null },
    });
  });

  it.each([
    'http://github.com/whchoi98/agent-ops/releases/tag/v1.3.0',
    'https://github.com.attacker.invalid/whchoi98/agent-ops/releases/tag/v1.3.0',
    'https://github.com@attacker.invalid/whchoi98/agent-ops/releases/tag/v1.3.0',
    'https://fixture:secret@github.com/whchoi98/agent-ops/releases/tag/v1.3.0',
    'https://github.com:443/whchoi98/agent-ops/releases/tag/v1.3.0',
    'https://github.com/other/agent-ops/releases/tag/v1.3.0',
    'https://github.com/whchoi98/other/releases/tag/v1.3.0',
    'https://github.com/whchoi98/agent-ops/releases/tag/v1.2.1',
    'https://github.com/whchoi98/agent-ops/releases/tag/v1.3.0?download=1',
    'https://github.com/whchoi98/agent-ops/releases/tag/v1.3.0#fragment',
    'https://github.com/whchoi98/agent-ops/releases/tag/%761.3.0',
    'https://github.com/whchoi98/agent-ops/releases/tag/../tag/v1.3.0',
    'https://github.com\\whchoi98\\agent-ops\\releases\\tag\\v1.3.0',
    'https://github.com/whchoi98/agent-ops/releases/tag/v1.3.0/',
  ])('rejects a noncanonical or foreign release page: %s', async html_url => {
    const result = await service({ fetcher: async () => Response.json({ ...release(), html_url }) }).check();
    expect(result).toMatchObject({ status: 'unavailable', latest: null, error: 'invalid-release' });
  });

  it.each([
    [],
    [{ name: 'other-1.3.0.tgz', browser_download_url: release().assets[0].browser_download_url }],
    [{ ...release().assets[0], name: 'agent-ops-local-1.2.1.tgz' }],
    [{ ...release().assets[0], name: 'agent-ops-local-1.3.0.tgz;id' }],
    [{ ...release().assets[0], browser_download_url: 'https://attacker.invalid/agent-ops-local-1.3.0.tgz' }],
    [{ ...release().assets[0], browser_download_url: release().assets[0].browser_download_url.replace('whchoi98', 'other') }],
    [{ ...release().assets[0], browser_download_url: release().assets[0].browser_download_url.replace('/v1.3.0/', '/v1.2.1/') }],
    [{ ...release().assets[0], browser_download_url: `${release().assets[0].browser_download_url}?download=1` }],
    [{ ...release().assets[0], browser_download_url: `${release().assets[0].browser_download_url}#fragment` }],
    [{ ...release().assets[0], browser_download_url: release().assets[0].browser_download_url.replace('github.com/', 'github.com:443/') }],
    [{ ...release().assets[0], browser_download_url: release().assets[0].browser_download_url.replace('https://', 'https://user:secret@') }],
    [{ ...release().assets[0], browser_download_url: release().assets[0].browser_download_url.replace('/v1.3.0/', '/%761.3.0/') }],
    [{ ...release().assets[0], browser_download_url: `${repositoryUrl}/archive/refs/tags/v1.3.0.tar.gz` }],
    [{ ...release().assets[0], state: 'new' }],
    [release().assets[0], release().assets[0]],
  ].map(assets => ({ assets })))('retains valid release info but withholds npm for missing, unsafe or ambiguous archives', async ({ assets }) => {
    const result = await service({ fetcher: async () => Response.json({ ...release(), assets }) }).check();
    expect(result).toMatchObject({
      status: 'update-available', error: null,
      latest: { version: '1.3.0', releaseUrl: `${repositoryUrl}/releases/tag/v1.3.0`, archive: null },
      commands: { npm: null },
    });
    expect(result.commands.git).toContain("'refs/tags/v1.3.0'");
    expect(JSON.stringify(result)).not.toMatch(/attacker|user:secret|other-1.3.0/);
  });
});

describe('bounded explicit update requests', () => {
  it('coalesces an in-flight check and enforces 60 seconds between attempt starts', async () => {
    let now = start;
    let finish!: (response: Response) => void;
    let requests = 0;
    const update = service({
      now: () => now,
      fetcher: async () => {
        requests++;
        return requests === 1 ? new Promise<Response>(resolve => { finish = resolve; }) : Response.json(release());
      },
    });
    const first = update.check();
    const second = update.check();
    expect(second).toBe(first);
    expect(requests).toBe(1);
    expect(update.snapshot()).toMatchObject({
      status: 'not-checked', checking: true, checkedAt: null, nextCheckAt: '2026-09-25T12:01:00.000Z',
    });
    now += 2000;
    finish(Response.json(release()));
    const checked = await first;
    expect(checked.checkedAt).toBe('2026-09-25T12:00:02.000Z');
    expect(checked.checking).toBe(false);
    now = start + 59_999;
    expect(await update.check()).toEqual(checked);
    expect(requests).toBe(1);
    now = start + 60_000;
    expect(await update.check()).toMatchObject({
      checkedAt: '2026-09-25T12:01:00.000Z', nextCheckAt: '2026-09-25T12:02:00.000Z',
    });
    expect(requests).toBe(2);
  });

  it('rate-limits failed attempts, clears stale success and never returns remote or exception text', async () => {
    let now = start;
    let requests = 0;
    const update = service({
      now: () => now,
      fetcher: async () => {
        if (++requests === 1) return Response.json(release());
        throw new Error('/private/account/secrets: fixture-token');
      },
    });
    await update.check();
    now += 60_000;
    const failed = await update.check();
    expect(failed).toMatchObject({
      status: 'unavailable', error: 'request-failed', latest: null, checking: false,
      commands: { npm: null, git: null }, nextCheckAt: '2026-09-25T12:02:00.000Z',
    });
    expect(JSON.stringify(failed)).not.toMatch(/private|secrets|fixture-token/);
    now += 59_999;
    expect(await update.check()).toEqual(failed);
    expect(requests).toBe(2);
  });

  it('keeps the default cooldown when the system wall clock jumps forward', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(start);
    let requests = 0;
    const update = service({
      now: undefined, fetcher: async () => { requests++; return Response.json(release()); },
    });
    await update.check();
    vi.setSystemTime(start + 3_600_000);
    await update.check();
    expect(requests).toBe(1);
    await vi.advanceTimersByTimeAsync(59_999);
    await update.check();
    expect(requests).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await update.check();
    expect(requests).toBe(2);
  });

  it.each([301, 302, 307, 308])('rejects a redirect status %s without reading its body', async status => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
    const result = await service({
      fetcher: async () => new Response(body, { status, headers: { location: 'https://attacker.invalid/' } }),
    }).check();
    expect(result).toMatchObject({ status: 'unavailable', error: 'redirect-rejected', latest: null });
    expect(cancelled).toBe(true);
  });

  it('rejects an already redirected response from an injected fetcher', async () => {
    const response = Response.json(release());
    Object.defineProperty(response, 'redirected', { value: true });
    const result = await service({ fetcher: async () => response }).check();
    expect(result).toMatchObject({ status: 'unavailable', error: 'redirect-rejected' });
  });

  it('rejects a mismatched final response URL', async () => {
    const response = Response.json(release());
    Object.defineProperty(response, 'url', { value: 'https://attacker.invalid/release' });
    const result = await service({ fetcher: async () => response }).check();
    expect(result).toMatchObject({ status: 'unavailable', error: 'redirect-rejected' });
  });

  it.each([204, 206, 403, 404, 429, 500])('treats HTTP %s as unavailable without echoing the server body', async status => {
    const result = await service({
      fetcher: async () => new Response(status === 204 ? null : 'fixture-private-error', { status }),
    }).check();
    expect(result).toMatchObject({ status: 'unavailable', error: 'request-failed', latest: null });
    expect(JSON.stringify(result)).not.toContain('fixture-private-error');
  });

  it.each(['{broken', '"1.3.0"', '[]'])('rejects malformed or non-object JSON: %s', async body => {
    const result = await service({
      fetcher: async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
    }).check();
    expect(result).toMatchObject({ status: 'unavailable', error: 'invalid-release' });
  });

  it('rejects invalid UTF-8 instead of silently changing release metadata', async () => {
    const body = new Uint8Array([...new TextEncoder().encode('{"unused":"'), 0xff, ...new TextEncoder().encode('"}')]);
    const result = await service({
      fetcher: async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
    }).check();
    expect(result).toMatchObject({ status: 'unavailable', error: 'invalid-release' });
  });

  it('accepts exactly 256 KiB but rejects a larger advertised or streamed body and cancels it', async () => {
    const json = JSON.stringify(release());
    const exact = json + ' '.repeat(256 * 1024 - Buffer.byteLength(json));
    expect((await service({ fetcher: async () => new Response(exact) }).check()).status).toBe('update-available');
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(128 * 1024));
        controller.enqueue(new Uint8Array(128 * 1024 + 1));
      },
      cancel() { cancelled = true; },
    });
    expect(await service({ fetcher: async () => new Response(body) }).check()).toMatchObject({
      status: 'unavailable', error: 'response-too-large',
    });
    expect(cancelled).toBe(true);
    expect(await service({
      fetcher: async () => new Response(json, { headers: { 'content-length': '262145' } }),
    }).check()).toMatchObject({ status: 'unavailable', error: 'response-too-large' });
  });

  it('applies one eight-second deadline to both headers and a stalled body', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    let cancelled = false;
    const update = service({
      fetcher: async (_input, init) => {
        signal = init?.signal;
        await new Promise(resolve => setTimeout(resolve, 6000));
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode('{"tag_name":')); },
          cancel() { cancelled = true; },
        }));
      },
    });
    const pending = update.check();
    await vi.advanceTimersByTimeAsync(7999);
    expect(update.snapshot().checking).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: 'unavailable', error: 'timeout', checking: false });
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes at the deadline even if the fetcher ignores aborts and cancels a late body', async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const update = service({ fetcher: async () => new Promise<Response>(resolve => { finish = resolve; }) });
    const pending = update.check();
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toMatchObject({ status: 'unavailable', error: 'timeout' });
    let cancelled = false;
    finish(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toBe(true);
    expect(update.snapshot()).toMatchObject({ status: 'unavailable', latest: null, error: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['headers', 'body'])('close aborts owned %s work and cannot be undone by late results', async phase => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    let cancelled = false;
    let finish!: (response: Response) => void;
    let requests = 0;
    const update = service({
      fetcher: async (_input, init) => {
        requests++;
        signal = init?.signal;
        if (phase === 'headers') return new Promise<Response>(resolve => { finish = resolve; });
        return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
      },
    });
    const pending = update.check();
    await vi.advanceTimersByTimeAsync(0);
    update.close();
    update.close();
    expect(signal?.aborted).toBe(true);
    expect(await pending).toMatchObject({
      status: 'unavailable', error: 'closed', checking: false, latest: null, nextCheckAt: null,
    });
    if (phase === 'headers') {
      finish(Response.json(release()));
      await vi.advanceTimersByTimeAsync(0);
    } else expect(cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await update.check()).toMatchObject({ status: 'unavailable', error: 'closed', latest: null });
    expect(requests).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start any later request or timer after an idle close', async () => {
    vi.useFakeTimers();
    let requests = 0;
    const update = service({ fetcher: async () => { requests++; return Response.json(release()); } });
    update.close();
    expect(await update.check()).toMatchObject({ status: 'unavailable', error: 'closed', checking: false });
    expect(requests).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
