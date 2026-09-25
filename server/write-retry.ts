import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from './store.js';

const WAIT_LIMIT_MS = 5000;

function busy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'));
}

/**
 * Retry only a synchronous database operation. Each attempt is atomic; callers
 * publish events or launch processes after this resolves, never inside action.
 */
export async function retryWrite<T>(
  store: Store, action: () => T, cancelled: () => boolean = () => false,
): Promise<T> {
  const deadline = performance.now() + WAIT_LIMIT_MS;
  for (;;) {
    if (cancelled() || !store.db.open) throw Object.assign(new Error('The application is stopping.'), { statusCode: 503 });
    if (store.db.inTransaction) throw new Error('Cannot asynchronously retry inside an existing database transaction.');
    const timeout = Number(store.db.pragma('busy_timeout', { simple: true }));
    try {
      // Never hold the HTTP event loop inside SQLite's synchronous busy wait.
      store.db.pragma('busy_timeout = 0');
      return store.db.transaction(action).immediate();
    } catch (error) {
      if (!busy(error)) throw error;
      if (performance.now() >= deadline) {
        throw Object.assign(new Error('The database is busy. Retry the request shortly.'), { statusCode: 503 });
      }
    } finally {
      if (store.db.open) store.db.pragma(`busy_timeout = ${timeout}`);
    }
    await delay(25);
  }
}
