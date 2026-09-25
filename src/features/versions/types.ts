import type { VersionReport } from '../../../shared/versions';

export interface VersionSnapshot {
  report: VersionReport | null;
  loading: boolean;
  checking: boolean;
  error: string | null;
}

export interface VersionResource extends VersionSnapshot {
  check: () => Promise<void>;
}
