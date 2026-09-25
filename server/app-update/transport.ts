import { APP_UPDATE_SOURCE_URL, type AppUpdateRelease } from '../../shared/app-update.js';
import { AppUpdateFailure, validateAppRelease } from './release.js';

const MAX_RESPONSE_BYTES = 256 * 1024;
const TOTAL_DEADLINE_MS = 8000;

/** The same deadline covers headers, streaming, decoding and validation. */
export async function downloadAppRelease(fetcher: typeof fetch, controller: AbortController): Promise<AppUpdateRelease> {
  const expires = performance.now() + TOTAL_DEADLINE_MS;
  let body: ReadableStream<Uint8Array> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => {
    try {
      const pending = reader ? reader.cancel() : body?.cancel();
      void pending?.catch(() => {});
    } catch { /* Do not wait for cleanup from a failing or late response. */ }
  };
  const guard = () => {
    if (!controller.signal.aborted && performance.now() >= expires) controller.abort(new AppUpdateFailure('timeout'));
    if (controller.signal.aborted) {
      cancel();
      throw controller.signal.reason;
    }
  };
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { cancel(); reject(controller.signal.reason); };
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new AppUpdateFailure('timeout')), TOTAL_DEADLINE_MS);
  const operation = async () => {
    guard();
    const response = await fetcher(APP_UPDATE_SOURCE_URL, {
      method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-ops-local' },
      signal: controller.signal,
    });
    body = response.body;
    guard();
    if (response.redirected || response.status >= 300 && response.status < 400
      || response.url && response.url !== APP_UPDATE_SOURCE_URL) throw new AppUpdateFailure('redirect-rejected');
    if (response.status !== 200) throw new AppUpdateFailure('request-failed');
    const length = response.headers.get('content-length');
    if (length !== null && !/^\d+$/.test(length)) throw new AppUpdateFailure('invalid-release');
    if (length !== null && Number(length) > MAX_RESPONSE_BYTES) throw new AppUpdateFailure('response-too-large');
    if (!body) throw new AppUpdateFailure('invalid-release');
    reader = body.getReader();
    // A single fixed buffer also bounds memory for responses fragmented into tiny chunks.
    const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      guard();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > MAX_RESPONSE_BYTES) throw new AppUpdateFailure('response-too-large');
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))); }
    catch { throw new AppUpdateFailure('invalid-release'); }
    const release = validateAppRelease(payload);
    guard();
    return release;
  };
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    controller.abort();
    cancel();
    try { reader?.releaseLock(); } catch { /* A pending read was already cancelled. */ }
  }
}
