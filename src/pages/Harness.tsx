import { HarnessWorkspace } from '../features/harness/HarnessWorkspace';
import { useData } from '../state/AppProvider';
import '../features/harness/harness.css';

export function Harness() {
  const { projects, demo } = useData();
  return <HarnessWorkspace projects={projects} demo={demo} />;
}
