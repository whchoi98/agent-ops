export const RESOURCE_SCOPES = ['server', 'sync', 'agents', 'mcp', 'harness'] as const;
export type ResourceScope = (typeof RESOURCE_SCOPES)[number];
export type OwnedResourceScope = Exclude<ResourceScope, 'server'>;
export type ResourceWarning =
  | 'owned_processes_unavailable' | 'owned_process_identity_changed' | 'owned_process_limit'
  | 'owned_platform_unsupported' | 'disk_unavailable' | 'disk_entry_limit' | 'disk_depth_limit'
  | 'disk_time_limit' | 'disk_scan_incomplete' | 'disk_volume_unavailable' | 'sampling_failed';

export interface ProcessResourceUsage {
  /** One logical CPU is 100%; null means there is no comparable measured interval. */
  cpuPercent: number | null;
  /** Sum of per-process RSS, including shared pages in each process's RSS. */
  rssBytes: number | null;
  processCount: number | null;
}

export interface ResourceSample {
  at: string;
  scopes: Record<ResourceScope, ProcessResourceUsage>;
  heapUsedBytes: number | null;
  heapTotalBytes: number | null;
  cpuWindowMs: number | null;
  durationMs: number;
  warnings: ResourceWarning[];
}

export const DISK_CATEGORIES = ['database', 'wal', 'backups', 'other'] as const;
export type DiskCategory = (typeof DISK_CATEGORIES)[number];
export interface DiskCategoryUsage {
  logicalBytes: number;
  allocatedBytes: number | null;
  fileCount: number;
}
export interface DiskSnapshot {
  at: string;
  dataDirectory: string;
  logicalBytes: number | null;
  allocatedBytes: number | null;
  fileCount: number;
  entriesScanned: number;
  skippedLinks: number;
  complete: boolean;
  durationMs: number;
  categories: Record<DiskCategory, DiskCategoryUsage>;
  volume: { totalBytes: number; availableBytes: number } | null;
  warnings: ResourceWarning[];
}
export interface ResourceReport {
  server: { pid: number; platform: string; logicalCpuCount: number; totalMemoryBytes: number; startedAt: string };
  sampleIntervalSeconds: number;
  diskIntervalSeconds: number;
  retentionSeconds: number;
  current: ResourceSample | null;
  history: ResourceSample[];
  disk: DiskSnapshot | null;
  collector: { sampling: boolean; scanningDisk: boolean; skippedSamples: number; maxDurationMs: number };
}
