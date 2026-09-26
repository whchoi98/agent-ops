import type { WorkItem } from '../../../shared/work-items';
import { useData } from '../../state/AppProvider';
import { captureWorkItemDraft, type WorkItemSourceSession } from './model';
import { WorkItemEditor } from './WorkItemEditor';

export interface CaptureWorkItemDialogProps {
  session: WorkItemSourceSession;
  onClose: () => void;
  onCreated?: (item: WorkItem) => void;
}

export function CaptureWorkItemDialog({ session, onClose, onCreated }: CaptureWorkItemDialogProps) {
  const { projects } = useData();
  return <WorkItemEditor projects={projects} initialDraft={captureWorkItemDraft(session, projects)} onClose={onClose}
    onSaved={item => { onCreated?.(item); onClose(); }} />;
}
