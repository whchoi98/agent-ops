import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { SyncService } from '../server/sync.js';

it('stops an import without checkpointing unread sessions, so the next sync can resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-sync-'));
  const store = new Store(':memory:');
  let pending: Promise<unknown> | null = null;
  try {
    const source = join(dir, 'session.jsonl');
    writeFileSync(source, [
      { type: 'session_meta', payload: { id: 'cancel-fixture', cwd: dir, timestamp: '2026-09-24T10:00:00Z' } },
      { type: 'response_item', timestamp: '2026-09-24T10:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review cancellation behavior' }] } },
    ].map((value) => JSON.stringify(value)).join('\n'));
    store.saveSettings({ sourceRoots: { codex: [source], claude: [], kiro: [] } });
    const sync = new SyncService(store);
    const first = sync.run();
    pending = first;
    sync.cancel();
    expect((await first).imported).toBe(0);
    expect(store.listSessions().total).toBe(0);
    expect((await new SyncService(store).run()).imported).toBe(1);
    expect(store.listSessions().items[0].nativeId).toBe('cancel-fixture');
  } finally {
    await pending?.catch(() => {});
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
