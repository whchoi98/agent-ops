import type { ContextPackPage, ContextPackQuery } from '../../../shared/context-packs';
import { useResource } from '../../hooks/useResource';
import { useApp } from '../../state/AppProvider';
import { contextPacksApi } from './api';

/** Bounded local reloads; no bootstrap or archive refresh is needed. */
export function useContextPacks(query: ContextPackQuery = {}, refreshKey = 0) {
  const { productivityRevision } = useApp();
  // Root revisions include SSE, reconnection and visibility recovery. Only this
  // metadata page reloads; editors/capture targets retain their loaded versions.
  const key = JSON.stringify([query.q, query.projectId, query.offset, query.limit, refreshKey, productivityRevision]);
  const resource = useResource<ContextPackPage>(signal => contextPacksApi.list(query, signal), key, true);
  return { ...resource, page: resource.data };
}
