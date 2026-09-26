import { afterEach, expect, it, vi } from 'vitest';
import { RunContextRequestGate, runPreparationApi } from './RunContextRequests';

afterEach(() => vi.unstubAllGlobals());

it('allows only one owned preparation request until it finishes', () => {
  const gate = new RunContextRequestGate();
  const first = gate.start()!;
  expect(first.current()).toBe(true);
  expect(gate.start()).toBeNull();
  expect(first.finish()).toBe(true);
  expect(first.current()).toBe(false);
  expect(gate.start()?.current()).toBe(true);
});

it('cancels only the owned request and cannot clear a newer operation through late cleanup', () => {
  const gate = new RunContextRequestGate();
  const first = gate.start()!;
  expect(first.cancel()).toBe(true);
  expect(first.signal.aborted).toBe(true);
  const second = gate.start()!;
  expect(first.cancel()).toBe(false);
  expect(first.finish()).toBe(false);
  expect(second.signal.aborted).toBe(false);
  expect(second.current()).toBe(true);
});

it('disposal aborts in-flight work and refuses operations after unmount', () => {
  const gate = new RunContextRequestGate();
  const request = gate.start()!;
  gate.dispose();
  expect(request.signal.aborted).toBe(true);
  expect(request.current()).toBe(false);
  expect(gate.start()).toBeNull();
});

it('can activate a new effect lifetime without reviving requests cancelled by an earlier cleanup', () => {
  const gate = new RunContextRequestGate();
  const earlier = gate.start()!;
  gate.dispose();
  gate.activate();
  const current = gate.start()!;
  expect(current.current()).toBe(true);
  expect(earlier.current()).toBe(false);
  expect(earlier.finish()).toBe(false);
  expect(current.signal.aborted).toBe(false);
});

it('forwards abort signals and metadata only through the existing explicit preview and run routes', async () => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/mounted/' });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({}));
  });
  const body = {
    agent: 'codex' as const, projectId: 'project-work', prompt: 'Explicit draft', policy: 'read-only' as const,
    workItemId: 'work-one', workItemVersion: 7, contextPackIds: ['pack-one'],
  };
  const controller = new AbortController();
  expect(calls).toEqual([]);
  await runPreparationApi.preview(body, controller.signal);
  await runPreparationApi.start(body, controller.signal);
  expect(calls.map(call => new URL(call.url).pathname)).toEqual(['/mounted/api/runs/preview', '/mounted/api/runs']);
  for (const { init } of calls) {
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(body);
    expect(init.signal).toBe(controller.signal);
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers).get('X-Agent-Ops')).toBe('1');
  }
});

it('does not retry an explicit start rejected for a stale work-item version', async () => {
  vi.stubGlobal('document', { baseURI: 'https://workbench.invalid/' });
  let requests = 0;
  vi.stubGlobal('fetch', async () => {
    requests++;
    return new Response(JSON.stringify({ error: 'Work item changed' }), { status: 409 });
  });
  await expect(runPreparationApi.start({
    agent: 'codex', projectId: 'project-work', prompt: 'Explicit', policy: 'read-only', workItemId: 'work-one', workItemVersion: 2,
  }, new AbortController().signal)).rejects.toMatchObject({ status: 409 });
  expect(requests).toBe(1);
});
