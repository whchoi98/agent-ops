import { useEffect, useState, useSyncExternalStore } from 'react';
import type { WorkItemQuery } from '../../../shared/work-items';
import { useResource } from '../../hooks/useResource';
import { workItemsApi } from './api';
import { createWorkItemEditorResource, type WorkItemEditorSource } from './editor-resource';
import { localWorkDate, nextWorkDayDelay, requestWorkItemQuery } from './model';

export function useLocalWorkDate() {
  const [today, setToday] = useState(() => localWorkDate());
  useEffect(() => {
    let timeout: number | undefined;
    const refresh = () => {
      window.clearTimeout(timeout);
      const now = new Date();
      setToday(localWorkDate(now));
      timeout = window.setTimeout(refresh, nextWorkDayDelay(now) + 25);
    };
    const visible = () => { if (!document.hidden) refresh(); };
    refresh();
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearTimeout(timeout); document.removeEventListener('visibilitychange', visible); };
  }, []);
  return today;
}

export function useWorkItems(query: WorkItemQuery, revision = 0) {
  const today = useLocalWorkDate();
  const request = requestWorkItemQuery(query);
  const key = JSON.stringify(request);
  const resource = useResource(async signal => ({ key, page: await workItemsApi.list(request, signal) }), `${key}:${revision}`, true);
  const current = resource.data?.key === key;
  return { page: current ? resource.data!.page : null, loading: resource.loading || (!current && !resource.error), error: resource.error, reload: resource.reload, today };
}

export function useOpenWorkItems(projectId: string | undefined, revision = 0) {
  const resource = useResource(signal => workItemsApi.open(projectId, signal), `open-work:${projectId ?? ''}:${revision}`, false);
  return { page: resource.data, loading: resource.loading, error: resource.error, reload: resource.reload };
}

/** This resource is intentionally independent of productivityRevision while a draft is open. */
export function useWorkItemEditor(source: WorkItemEditorSource) {
  const [resource] = useState(() => createWorkItemEditorResource(source));
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  useEffect(() => {
    resource.start();
    if ('id' in source) void resource.reload();
    return resource.stop;
    // The dialog remounts for another item. Refetches never reinitialize an existing draft.
  }, [resource]);
  return { ...state, reload: resource.reload, edit: resource.edit, toggleSession: resource.toggleSession,
    save: resource.save, archive: resource.archive, reopen: resource.reopen, remove: resource.remove, prepare: resource.prepare };
}
