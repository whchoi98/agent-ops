import type { CreateSavedView, SavedView, UpdateSavedView } from '../../../shared/saved-views';
import { createSavedViewsResource, type SavedViewsSnapshot } from './resource';

export interface UseSavedViewsResult extends SavedViewsSnapshot {
  pinnedViews: SavedView[];
  reload: () => Promise<void>;
  clearWriteError: () => void;
  create: (input: CreateSavedView) => Promise<SavedView | null>;
  update: (id: string, input: UpdateSavedView) => Promise<SavedView | null>;
  remove: (id: string, version: number) => Promise<boolean>;
}

/** Pass a saved-view revision from AppProvider's productivity-change subscription. */
export function useSavedViews(revision = 0): UseSavedViewsResult {
  const [resource] = useState(createSavedViewsResource);
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  useEffect(() => {
    resource.start();
    return resource.stop;
  }, [resource]);
  useEffect(() => { void resource.reload(); }, [resource, revision]);
  return useMemo(() => ({
    ...state, pinnedViews: state.views.filter(view => view.pinned),
    reload: resource.reload, clearWriteError: resource.clearWriteError,
    create: resource.create, update: resource.update, remove: resource.remove,
  }), [state, resource]);
}
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
