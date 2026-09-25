import type { DesktopAppReport } from '../../../shared/desktop-apps';
import { request } from '../../lib/api';

export const desktopApi = {
  report: (signal?: AbortSignal) => request<DesktopAppReport>('/desktop-apps', { signal }),
  refresh: (signal?: AbortSignal) => request<DesktopAppReport>('/desktop-apps/refresh', {
    method: 'POST', body: JSON.stringify({}), signal,
  }),
};
