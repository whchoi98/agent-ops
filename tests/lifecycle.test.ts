import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';

it('closes active SSE streams before waiting for server shutdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-sse-'));
  const { app } = await createApp({ dataDir: dir, demo: true, autoSync: false });
  const abort = new AbortController();
  let deadline: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/api/events`, { signal: abort.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    deadline = setTimeout(() => { timedOut = true; abort.abort(); }, 2000);
    await app.close();
    expect(timedOut).toBe(false);
    await reader.cancel().catch(() => {});
  } finally {
    if (deadline) clearTimeout(deadline);
    abort.abort();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
