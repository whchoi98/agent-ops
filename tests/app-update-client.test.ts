import { afterEach, describe, expect, it, vi } from 'vitest';
import { appUpdateApi } from '../src/features/app-update/api';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('workbench update client', () => {
  it('uses proxy-relative cache GETs and guarded empty explicit POSTs', async () => {
    vi.stubGlobal('document', { baseURI: 'https://workbench.example.com/proxy/4327/' });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const report = { currentVersion: '1.2.1', status: 'not-checked', latest: null };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Response.json(report);
    });
    expect(requests).toHaveLength(0);
    expect(await appUpdateApi.report()).toEqual(report);
    expect(requests.map(request => request.init?.method ?? 'GET')).toEqual(['GET']);
    expect(await appUpdateApi.check()).toEqual(report);
    expect(requests.map(request => request.url)).toEqual([
      'https://workbench.example.com/proxy/4327/api/app-update',
      'https://workbench.example.com/proxy/4327/api/app-update/check',
    ]);
    expect(requests[0].init?.body).toBeUndefined();
    expect(requests[1].init).toMatchObject({
      method: 'POST', body: '{}', credentials: 'same-origin',
      headers: { 'X-Agent-Ops': '1', 'Content-Type': 'application/json' },
    });
    expect(requests[1].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['report', 'check'] as const)('propagates cancellation for %s without retrying', async operation => {
    vi.stubGlobal('document', { baseURI: 'https://workbench.example.com/' });
    let requests = 0;
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      requests++;
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    const controller = new AbortController();
    const pending = appUpdateApi[operation](controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(requests).toBe(1);
  });

  it('does not send a POST when its caller is already disposed', async () => {
    vi.stubGlobal('document', { baseURI: 'https://workbench.example.com/' });
    let requests = 0;
    vi.stubGlobal('fetch', async () => { requests++; return Response.json({}); });
    const controller = new AbortController();
    controller.abort();
    await expect(appUpdateApi.check(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toBe(0);
  });

  it('bounds a stalled local request even when its fetcher ignores cancellation', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { baseURI: 'https://workbench.example.com/' });
    let signal: AbortSignal | null | undefined;
    let requests = 0;
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      requests++;
      signal = init?.signal;
      return new Promise<Response>(() => {});
    });
    const pending = appUpdateApi.check().catch(cause => cause);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toMatchObject({ name: 'ApiError', status: 408 });
    expect(signal?.aborted).toBe(true);
    expect(requests).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('includes reading the local response body in the request deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { baseURI: 'https://workbench.example.com/' });
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream<Uint8Array>({})));
    const pending = appUpdateApi.report().catch(cause => cause);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toMatchObject({ name: 'ApiError', status: 408 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a rejected check for the UI without automatically retrying it', async () => {
    vi.stubGlobal('document', { baseURI: 'https://workbench.example.com/' });
    let requests = 0;
    vi.stubGlobal('fetch', async () => {
      requests++;
      return Response.json({ error: 'X-Agent-Ops: 1 header required.' }, { status: 403 });
    });
    await expect(appUpdateApi.check()).rejects.toMatchObject({
      name: 'ApiError', status: 403, message: 'X-Agent-Ops: 1 header required.',
    });
    expect(requests).toBe(1);
  });
});
