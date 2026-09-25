import { afterEach, expect, it, vi } from 'vitest';
import { desktopApi } from '../src/features/versions/desktopApi';

afterEach(() => { vi.unstubAllGlobals(); });

it('uses the shared client with proxy-relative API URLs, cancellation and the mutation guard', async () => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.example.com/proxy/4327/' });
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    requests.push({ path, init });
    return new Response('{"scope":"server-host"}', { headers: { 'content-type': 'application/json' } });
  });
  const controller = new AbortController();
  expect(await desktopApi.report(controller.signal)).toEqual({ scope: 'server-host' });
  expect(await desktopApi.refresh(controller.signal)).toEqual({ scope: 'server-host' });
  expect(requests.map(request => request.path)).toEqual([
    'https://workbench.example.com/proxy/4327/api/desktop-apps',
    'https://workbench.example.com/proxy/4327/api/desktop-apps/refresh',
  ]);
  expect(requests[0].init?.signal).toBe(controller.signal);
  expect(requests[1].init).toMatchObject({
    method: 'POST', body: '{}', signal: controller.signal,
    credentials: 'same-origin', headers: { 'X-Agent-Ops': '1', 'Content-Type': 'application/json' },
  });
});
