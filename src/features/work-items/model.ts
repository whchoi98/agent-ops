import type { Agent, Project, Session, SessionQuery } from '../../../shared/types';
import type {
  WorkItemDetail, WorkItemFields, WorkItemPage, WorkItemPatch, WorkItemPrepared,
  WorkItemQuery, WorkItemStatus, WorkItemSummary,
} from '../../../shared/work-items';
import { WORK_ITEM_PRIORITIES, WORK_ITEM_STATUSES } from '../../../shared/work-items';
import { toQueryString } from '../../lib/query';

export const WORK_ITEM_UI_LIMITS = { title: 200, text: 8000, sessions: 20, packs: 5, page: 100 } as const;

export type WorkItemSourceSession = Pick<Session, 'id' | 'title' | 'agent' | 'projectPath' | 'projectName'>;
export type WorkSessionReference = WorkItemDetail['sessions'][number];
export interface WorkItemDraft {
  readonly original: Readonly<Pick<WorkItemDetail, 'id' | 'version' | 'archivedAt' | 'lastRunId'>> | null;
  fields: WorkItemFields;
  sessions: WorkItemDetail['sessions'];
  packs: WorkItemDetail['packs'];
}
export interface WorkItemColumn {
  status: WorkItemStatus; items: WorkItemSummary[]; visible: number; total: number;
}
export interface WorkItemsPageState {
  search: string;
  query: WorkItemQuery;
  editor: { itemId?: string } | null;
}
export function applyWorkItemLocation(previous: WorkItemsPageState | null, search: string): WorkItemsPageState {
  if (previous?.search === search) return previous;
  const q = new URLSearchParams(search).get('q')?.slice(0, 200) || undefined;
  const id = readWorkItemId(search);
  return {
    search,
    query: {
      ...(previous?.query ?? { status: 'open', archived: false, sort: 'priority', limit: 25 }),
      q, offset: 0,
    },
    editor: id ? { itemId: id } : null,
  };
}

export function localWorkDate(now = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new Error('올바른 날짜를 입력하세요.');
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function nextWorkDayDelay(now = new Date()): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return Math.max(1, next.getTime() - now.getTime());
}
const boundedNumber = (value: number | undefined, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;

export function requestWorkItemQuery(query: WorkItemQuery = {}, now = new Date()): WorkItemQuery {
  return {
    ...(query.q ? { q: query.q.slice(0, 200) } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.priority ? { priority: query.priority } : {}),
    archived: query.archived ?? false,
    ...(query.due ? { due: query.due, ...(query.due !== 'none' ? { today: localWorkDate(now) } : {}) } : {}),
    sort: query.sort ?? 'priority',
    limit: boundedNumber(query.limit, 25, 1, WORK_ITEM_UI_LIMITS.page),
    offset: boundedNumber(query.offset, 0, 0, 1_000_000),
  };
}
export function changeWorkItemFilters(query: WorkItemQuery, patch: Partial<WorkItemQuery>): WorkItemQuery {
  return { ...query, ...patch, offset: 0 };
}
export function workItemRange(page: WorkItemPage) {
  const visible = page.items.length;
  return { from: visible ? page.offset + 1 : 0, to: visible ? Math.min(page.offset + visible, page.total) : 0, visible, total: page.total };
}
export function workItemPageOffset(page: WorkItemPage): number {
  return page.offset >= page.total ? Math.max(0, Math.floor((page.total - 1) / page.limit) * page.limit) : page.offset;
}
export function workItemColumns(page: WorkItemPage, status?: WorkItemQuery['status']): WorkItemColumn[] {
  return WORK_ITEM_STATUSES.filter(value => !status || (status === 'open' ? value !== 'done' : value === status)).map(value => {
    const items = page.items.filter(item => item.status === value);
    return { status: value, items, visible: items.length, total: page.counts[value] };
  });
}
export function workItemDueState(item: Pick<WorkItemDetail, 'dueDate' | 'status' | 'archivedAt'>, today: string) {
  if (!item.dueDate) return 'none';
  if (item.archivedAt || item.status === 'done') return 'inactive';
  return item.dueDate < today ? 'overdue' : item.dueDate === today ? 'today' : 'upcoming';
}
export function readWorkItemId(search: string): string | null {
  const ids = new URLSearchParams(search).getAll('id');
  return ids.length === 1 && ids[0].trim() && ids[0].length <= 200 && !/[\u0000-\u001f]/.test(ids[0]) ? ids[0] : null;
}
export function workItemLink(id?: string): string {
  return `#/work-items${id ? `?${toQueryString({ id })}` : ''}`;
}

export function workSessionQuery(
  search: { q: string; agent?: Agent; projectPath?: string }, page: { projectPath?: string; offset: number },
): SessionQuery {
  return { q: search.q, agent: search.agent, project: search.projectPath, limit: 10, offset: page.projectPath === search.projectPath ? page.offset : 0 };
}

function copyFields(fields: WorkItemFields): WorkItemFields {
  return {
    title: fields.title, description: fields.description, nextAction: fields.nextAction, projectId: fields.projectId,
    dueDate: fields.dueDate, status: fields.status, priority: fields.priority,
    sessionIds: [...fields.sessionIds], contextPackIds: [...fields.contextPackIds],
  };
}

export function createWorkItemDraft(item?: WorkItemDetail): WorkItemDraft {
  return {
    original: item ? Object.freeze({ id: item.id, version: item.version, archivedAt: item.archivedAt, lastRunId: item.lastRunId }) : null,
    fields: item ? copyFields(item) : {
      title: '', description: '', nextAction: '', projectId: null, dueDate: null,
      status: 'todo', priority: 'normal', sessionIds: [], contextPackIds: [],
    },
    sessions: item?.sessions.map(source => ({ ...source })) ?? [],
    packs: item?.packs.map(source => ({ ...source })) ?? [],
  };
}
export function captureWorkItemDraft(session: WorkItemSourceSession, projects: Project[]): WorkItemDraft {
  const draft = createWorkItemDraft();
  draft.fields.title = session.title.slice(0, WORK_ITEM_UI_LIMITS.title).replace(/[\ud800-\udbff]$/, '');
  draft.fields.projectId = projects.find(project => project.path === session.projectPath)?.id ?? null;
  draft.fields.sessionIds = [session.id];
  draft.sessions = [{ id: session.id, title: session.title, agent: session.agent, available: true }];
  return draft;
}
export function isWorkCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validReferences(ids: string[], max: number) {
  return ids.length <= max && new Set(ids).size === ids.length
    && ids.every(id => typeof id === 'string' && id.trim() && id.length <= 200 && !/[\u0000-\u001f]/.test(id));
}
export function workItemInput(draft: WorkItemDraft): WorkItemFields {
  const fields = copyFields(draft.fields);
  if (!fields.title.trim() || fields.title.length > WORK_ITEM_UI_LIMITS.title) throw new Error('작업 제목을 200자 이내로 입력하세요.');
  if (fields.description.length > WORK_ITEM_UI_LIMITS.text || fields.nextAction.length > WORK_ITEM_UI_LIMITS.text) {
    throw new Error('설명과 다음 할 일은 각각 8,000자까지 입력할 수 있습니다.');
  }
  if (fields.dueDate !== null && !isWorkCalendarDate(fields.dueDate)) throw new Error('올바른 날짜를 입력하세요.');
  if (!WORK_ITEM_STATUSES.includes(fields.status) || !WORK_ITEM_PRIORITIES.includes(fields.priority)) throw new Error('작업 상태와 우선순위를 확인하세요.');
  if (!validReferences(fields.sessionIds, WORK_ITEM_UI_LIMITS.sessions)) throw new Error('중복 없이 세션을 20개까지 선택하세요.');
  if (!validReferences(fields.contextPackIds, WORK_ITEM_UI_LIMITS.packs)) throw new Error('중복 없이 컨텍스트 묶음을 5개까지 선택하세요.');
  return { ...fields, title: fields.title.trim() };
}
export function workItemPatch(draft: WorkItemDraft): WorkItemPatch {
  if (!draft.original) throw new Error('먼저 작업을 저장하세요.');
  return { ...workItemInput(draft), version: draft.original.version };
}
export function toggleWorkSession(draft: WorkItemDraft, source: WorkSessionReference): WorkItemDraft {
  if (draft.fields.sessionIds.includes(source.id)) {
    return {
      ...draft, fields: { ...draft.fields, sessionIds: draft.fields.sessionIds.filter(id => id !== source.id) },
      sessions: draft.sessions.filter(item => item.id !== source.id),
    };
  }
  if (draft.fields.sessionIds.length >= WORK_ITEM_UI_LIMITS.sessions) throw new Error('중복 없이 세션을 20개까지 선택하세요.');
  return {
    ...draft, fields: { ...draft.fields, sessionIds: [...draft.fields.sessionIds, source.id] },
    sessions: [...draft.sessions, { ...source }],
  };
}
export function preparedWorkItemDraft(draft: WorkItemDraft, prepared: WorkItemPrepared): WorkItemPrepared['draft'] {
  const original = draft.original;
  if (!original || prepared.workItem.id !== original.id || prepared.workItem.version !== original.version
    || prepared.draft.workItemId !== original.id || prepared.draft.workItemVersion !== original.version) {
    throw new Error('준비한 실행의 작업 정보가 다릅니다. 최신 작업을 다시 불러오세요.');
  }
  return { ...prepared.draft, ...(prepared.draft.contextPackIds ? { contextPackIds: [...prepared.draft.contextPackIds] } : {}) };
}
