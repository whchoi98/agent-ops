import type { RunRequest, RunStatus } from './types.js';

export const WORK_ITEM_STATUSES = ['todo', 'in_progress', 'blocked', 'done'] as const;
export const WORK_ITEM_PRIORITIES = ['low', 'normal', 'high'] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number];

export interface WorkItemFields {
  title: string;
  description: string;
  nextAction: string;
  projectId: string | null;
  dueDate: string | null;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  sessionIds: string[];
  contextPackIds: string[];
}

export interface WorkItem extends WorkItemFields {
  id: string;
  lastRunId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface WorkItemSummary extends Omit<WorkItem, 'description' | 'nextAction'> {
  descriptionPreview: string;
  nextActionPreview: string;
  lastRunStatus: RunStatus | null;
}

export interface WorkItemQuery {
  q?: string;
  projectId?: string;
  status?: WorkItemStatus | 'open';
  priority?: WorkItemPriority;
  archived?: boolean;
  due?: 'today' | 'overdue' | 'week' | 'none';
  /** Calendar date in the browser's timezone, not a UTC conversion of midnight. */
  today?: string;
  sort?: 'priority' | 'recent' | 'due';
  limit?: number;
  offset?: number;
}

export interface WorkItemPage {
  items: WorkItemSummary[];
  total: number;
  counts: Record<WorkItemStatus, number>;
  limit: number;
  offset: number;
}

export interface WorkItemPatch extends Partial<WorkItemFields> {
  version: number;
  archived?: boolean;
}

export interface WorkItemPrepared {
  workItem: WorkItem;
  draft: Partial<RunRequest> & Pick<RunRequest, 'agent' | 'prompt' | 'policy'>;
}

export interface WorkItemDetail extends WorkItem {
  sessions: Array<{ id: string; title: string; agent: string | null; available: boolean }>;
  packs: Array<{ id: string; name: string; available: boolean }>;
}

export type ProductivityEntity = 'work-items' | 'context-packs' | 'saved-views' | 'templates';
export interface ProductivityChange { type: 'productivity-change'; entity: ProductivityEntity }
