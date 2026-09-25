import type { AppUpdateReport } from '../../../shared/app-update';
import { ApiError, request } from '../../lib/api';

/** Bound the browser-to-workbench request while retaining the shared proxy and mutation guards. */
async function boundedRequest(path: string, init: RequestInit = {}): Promise<AppUpdateReport> {
  const parent = init.signal;
  if (parent?.aborted) throw new DOMException('Aborted', 'AbortError');
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  let onAbort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(timedOut
      ? new ApiError('앱 업데이트 요청 시간이 초과되었습니다. 캐시 상태를 다시 불러오세요.', 408)
      : new DOMException('Aborted', 'AbortError'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  try {
    return await Promise.race([
      request<AppUpdateReport>(path, { ...init, signal: controller.signal }), interrupted,
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

export const appUpdateApi = {
  report: (signal?: AbortSignal) => boundedRequest('/app-update', { signal }),
  check: (signal?: AbortSignal) => boundedRequest('/app-update/check', {
    method: 'POST', body: '{}', signal,
  }),
};
