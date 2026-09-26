import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HarnessWorkspace } from '../HarnessWorkspace';
import { I18nProvider, LanguageToggle } from '../../../i18n/I18nProvider';
import { harnessProject } from '../testFixtures';
import '../../../styles/index.css';
import '../harness.css';

createRoot(document.getElementById('root')!).render(<StrictMode><I18nProvider>
  <main style={{ padding: '16px', maxWidth: '1200px', margin: 'auto' }}>
    <LanguageToggle />
    <HarnessWorkspace projects={[harnessProject, { ...harnessProject, id: 'project-other', name: 'Other project' }]}
      demo={new URL(location.href).searchParams.has('demo')} />
  </main>
</I18nProvider></StrictMode>);
