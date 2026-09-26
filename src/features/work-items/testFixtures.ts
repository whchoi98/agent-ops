import type { Project, Session } from '../../../shared/types';
import { emptyUsage } from '../../../shared/types';
import type { WorkItemDetail, WorkItemPage, WorkItemSummary } from '../../../shared/work-items';

export const workProject: Project = {
  id: 'project-synthetic', name: 'Synthetic project', path: '/tmp/work-ui-project',
  color: '#3564e8', executionEnabled: false, createdAt: '2026-09-26T09:00:00.000Z',
};

export function workDetail(patch: Partial<WorkItemDetail> = {}): WorkItemDetail {
  return {
    id: 'work-01234567-89ab-4cde-8fab-0123456789ab',
    title: '설정 [x]?* & review', description: 'Original description', nextAction: 'Review the result',
    projectId: workProject.id, dueDate: '2026-09-26', status: 'todo', priority: 'normal',
    sessionIds: ['codex:synthetic'], contextPackIds: ['pack-synthetic'], lastRunId: null,
    version: 1, createdAt: '2026-09-26T10:00:00.000Z', updatedAt: '2026-09-26T10:00:00.000Z', archivedAt: null,
    sessions: [{ id: 'codex:synthetic', title: 'Original session title', agent: 'codex', available: true }],
    packs: [{ id: 'pack-synthetic', name: 'Original context', available: true }],
    ...patch,
  };
}

export function workSummary(patch: Partial<WorkItemSummary> = {}): WorkItemSummary {
  const { description, nextAction, sessions: _sessions, packs: _packs, ...item } = workDetail();
  return { ...item, descriptionPreview: description, nextActionPreview: nextAction, lastRunStatus: null, ...patch };
}

export function workPage(patch: Partial<WorkItemPage> = {}): WorkItemPage {
  return {
    items: [workSummary()], total: 1, counts: { todo: 1, in_progress: 0, blocked: 0, done: 0 },
    limit: 25, offset: 0, ...patch,
  };
}

export function sourceSession(patch: Partial<Session> = {}): Session {
  return {
    id: 'codex:synthetic', nativeId: 'synthetic', agent: 'codex', title: 'Original session title',
    projectPath: workProject.path, projectName: workProject.name, model: 'fixture-model',
    startedAt: '2026-09-26T09:00:00.000Z', updatedAt: '2026-09-26T09:01:00.000Z',
    status: 'recorded', messageCount: 100000, toolCallCount: 0, sourcePath: '/tmp/synthetic-history.jsonl',
    usage: emptyUsage(), bookmarked: false, tags: ['retain'], note: 'Private operator note',
    ...patch,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
