import type { Store } from '../store.js';
import type { WorkItemService } from './work-items.js';
import type { ContextPackService } from './context-packs.js';
import type { SavedViewService } from './saved-views.js';
import type { TemplateService } from './templates.js';

interface Services {
  workItems: WorkItemService;
  contextPacks: ContextPackService;
  savedViews: SavedViewService;
  templates: TemplateService;
}

/** Add small examples once, only to an explicitly isolated demo store. */
export function seedProductivityDemo(store: Store, services: Services): void {
  if (store.getMeta('mode') !== 'demo' || store.getMeta('demo-productivity-seeded')) return;
  store.db.transaction(() => {
    const source = store.listSessions({ agent: 'codex', limit: 1 }).items[0];
    const project = source ? store.listProjects().find(item => item.path === source.projectPath) : store.listProjects()[0];
    let pack = services.contextPacks.create({
      name: 'Authentication investigation',
      description: 'Selected evidence and acceptance criteria for the next assistant.',
      projectId: project?.id ?? null,
      instructions: 'Verify the current code before continuing. Explain the smallest useful next step.',
    });
    if (source) {
      const message = store.listMessages(source.id, { role: 'user', limit: 1 }).items[0];
      if (message?.content) pack = services.contextPacks.addItem(pack.id, {
        version: pack.version, kind: 'message', sessionId: source.id, messageId: message.id,
        offset: 0, length: Math.min(2000, message.content.length),
      });
    }
    pack = services.contextPacks.addItem(pack.id, {
      version: pack.version, kind: 'note', title: 'Acceptance criteria',
      text: 'Preserve the existing behavior, add a regression check, and record unresolved questions.',
    });
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const shared = { projectId: project?.id ?? null, sessionIds: source ? [source.id] : [] };
    services.workItems.create({
      ...shared, title: 'Review the authentication investigation', priority: 'high', dueDate: today,
      description: 'Continue from selected evidence instead of rereading every conversation.',
      nextAction: 'Inspect the current code and list the remaining checks.', contextPackIds: [pack.id],
    });
    services.workItems.create({
      ...shared, title: 'Continue the interface cleanup', status: 'in_progress',
      nextAction: 'Compare the current screens with the acceptance criteria.',
    });
    services.workItems.create({
      ...shared, title: 'Resolve the missing test fixture', status: 'blocked', priority: 'high',
      dueDate: yesterday.toISOString().slice(0, 10), nextAction: 'Confirm which fixture the failing check needs.',
    });
    services.workItems.create({
      ...shared, title: 'Record the completed investigation', status: 'done', priority: 'low',
      description: 'This example is marked complete by the operator, independently of CLI exit codes.',
    });
    const template = services.templates.create({
      name: 'Focused review with inputs',
      description: 'Choose the target, goal and result format before starting a review.',
      category: 'review', agent: 'any', policy: 'read-only',
      prompt: 'Review {{target}}.\nGoal: {{goal}}\nReturn the result as {{format}}.\nVerify assumptions and cite the relevant files.',
      variables: [
        { name: 'target', label: 'Review target', type: 'text', required: true, defaultValue: 'the current changes' },
        { name: 'goal', label: 'Review goal', type: 'multiline', required: true, defaultValue: 'Find correctness issues and missing regression checks.' },
        { name: 'format', label: 'Result format', type: 'select', required: true,
          options: ['a checklist', 'a detailed report'], defaultValue: 'a checklist' },
      ],
    });
    services.templates.update(template.id, {
      expectedRevision: template.revision,
      description: 'Reusable review inputs with explicit scope, acceptance criteria and a retained revision history.',
    });
    services.savedViews.create({
      name: 'Recent Codex sessions', query: { agent: 'codex', sort: 'recent', limit: 20 }, period: 'last7', pinned: true,
    });
    services.savedViews.create({
      name: 'Failed sessions', query: { status: 'failed', sort: 'recent', limit: 20 }, period: 'all-time',
    });
    store.setMeta('demo-productivity-seeded', true);
  })();
}
