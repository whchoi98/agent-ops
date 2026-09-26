import type { CommandPreview, Run, RunRequest } from '../../../shared/types';
import { request } from '../../lib/api';

export interface RunContextRequest {
  signal: AbortSignal;
  current: () => boolean;
  finish: () => boolean;
  cancel: () => boolean;
}

/** Share one gate between preview, explicit start and local context compilation. */
export class RunContextRequestGate {
  private active: RunContextRequest | null = null;
  private disposed = false;

  /** A new mounted effect lifetime may reuse the gate after StrictMode cleanup. */
  activate(): void { this.disposed = false; }

  start(): RunContextRequest | null {
    if (this.disposed || this.active) return null;
    const controller = new AbortController();
    const operation: RunContextRequest = {
      signal: controller.signal,
      current: () => !this.disposed && this.active === operation && !controller.signal.aborted,
      finish: () => {
        if (this.active !== operation) return false;
        this.active = null;
        return true;
      },
      cancel: () => {
        if (this.active !== operation) return false;
        this.active = null;
        controller.abort();
        return true;
      },
    };
    this.active = operation;
    return operation;
  }

  dispose(): void {
    this.disposed = true;
    this.active?.cancel();
  }
}

const post = (body: RunRequest, signal: AbortSignal): RequestInit => ({
  method: 'POST', body: JSON.stringify(body), signal,
});

export const runPreparationApi = {
  preview: (body: RunRequest, signal: AbortSignal) => request<CommandPreview>('/runs/preview', post(body, signal)),
  start: (body: RunRequest, signal: AbortSignal) => request<Run>('/runs', post(body, signal)),
};
