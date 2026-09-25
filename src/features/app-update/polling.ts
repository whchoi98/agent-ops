import type { AppUpdateReport } from '../../../shared/app-update';
import { errorMessage } from '../../lib/format';

interface PollOptions {
  read: (signal: AbortSignal) => Promise<AppUpdateReport>;
  onResult: (report: AppUpdateReport) => void;
  onError: (message: string) => void;
}

/** Observe a check already in progress using GET only, with one read at a time and a total limit. */
export function pollAppUpdate(initial: AppUpdateReport, options: PollOptions): () => void {
  if (!initial.checking || initial.demo || initial.status === 'demo') return () => {};
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearTimeout(deadline);
    controller?.abort();
  };
  const deadline = setTimeout(() => {
    stop();
    options.onError('확인 중 상태가 계속됩니다. 캐시 상태를 다시 불러오세요.');
  }, 15000);
  const read = async () => {
    controller = new AbortController();
    try {
      const report = await options.read(controller.signal);
      if (stopped) return;
      options.onResult(report);
      if (!report.checking || report.demo || report.status === 'demo') stop();
      else timer = setTimeout(() => void read(), 1000);
    } catch (cause) {
      if (stopped) return;
      stop();
      options.onError(errorMessage(cause));
    }
  };
  timer = setTimeout(() => void read(), 1000);
  return stop;
}
