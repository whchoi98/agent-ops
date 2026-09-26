import { lazy, Suspense, useEffect, useState } from 'react';
import type { WorkItemQuery } from '../../shared/work-items';
import { Skeleton } from '../components/ui';
import { useDebounced } from '../hooks/useResource';
import { useApp, useData } from '../state/AppProvider';
import { WorkItemsView } from '../features/work-items/WorkItemsView';
import { applyWorkItemLocation, changeWorkItemFilters, readWorkItemId, workItemPageOffset } from '../features/work-items/model';
import { useWorkItems } from '../features/work-items/useWorkItems';
import '../features/work-items/work-items.css';

const WorkItemEditor = lazy(() => import('../features/work-items/WorkItemEditor').then(module => ({ default: module.WorkItemEditor })));

export function WorkItems() {
  const { search, productivityRevision, openRun } = useApp();
  const { projects } = useData();
  const [pageState, setPageState] = useState(() => applyWorkItemLocation(null, search));
  const { query, editor } = pageState;
  const [mode, setMode] = useState<'list' | 'board'>('list');
  const requestedId = readWorkItemId(search);
  const setQuery = (update: (query: WorkItemQuery) => WorkItemQuery) =>
    setPageState(current => ({ ...current, query: update(current.query) }));
  const setEditor = (editor: { itemId?: string } | null) => setPageState(current => ({ ...current, editor }));
  const q = useDebounced(query.q ?? '');
  const resource = useWorkItems({ ...query, q: q || undefined }, productivityRevision);
  // Apply external q/id links only when the hash changes; typing and SSE leave local filters alone.
  useEffect(() => { setPageState(current => applyWorkItemLocation(current, search)); }, [search]);
  useEffect(() => {
    if (resource.loading || resource.error || !resource.page) return;
    const offset = workItemPageOffset(resource.page);
    if (offset !== (query.offset ?? 0)) setQuery(current => ({ ...current, offset }));
  }, [resource.loading, resource.error, resource.page, query.offset]);
  function closeEditor() {
    setEditor(null);
    if (!requestedId) return;
    const params = new URLSearchParams(search);
    params.delete('id');
    const next = params.toString();
    window.history.replaceState(null, '', `#/work-items${next ? `?${next}` : ''}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  return <>
    <WorkItemsView page={resource.page} query={query} projects={projects} mode={mode} today={resource.today}
      loading={resource.loading || q !== (query.q ?? '')} error={resource.error}
      onFilters={patch => setQuery(current => changeWorkItemFilters(current, patch))}
      onPage={offset => setQuery(current => ({ ...current, offset }))}
      onMode={setMode} onNew={() => setEditor({})} onOpen={itemId => setEditor({ itemId })}
      onOpenRun={openRun} onReload={resource.reload} />
    {editor && <Suspense fallback={<Skeleton rows={3} />}>
      <WorkItemEditor {...editor} projects={projects} onClose={closeEditor} onSaved={resource.reload} onDeleted={resource.reload} />
    </Suspense>}
  </>;
}
