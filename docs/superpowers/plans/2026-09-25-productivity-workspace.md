# Productivity Workspace Implementation Plan

> **For agentic workers:** Use task-specific TDD and bounded parallel workers.
> The coordinator owns shared integration; do not edit another worker's files.

**Goal:** Deliver the user-requested productivity direction with work items,
parameterized templates, reusable context packs and saved session views.

**Architecture:** Extend the local SQLite workbench with small feature tables and
versioned mutations. Compose existing explicit run previews with local context;
use bounded feature APIs and independent SSE notifications.

**Tech Stack:** Existing Node.js, TypeScript, Fastify, SQLite, React, Vitest and
Playwright; no new dependency.

**Spec:** [Productivity workspace](../specs/2026-09-25-productivity-workspace-design.md)

## Global constraints

- Baseline `e32f704`, 1,226 passing tests; isolated `agent-ops-resources` worktree.
- Preserve native schema 4, fingerprints, original content, annotations,
  loopback/proxy guards, owned-process cleanup and Korean/English UI.
- Tasks: 10,000, title 200, description/next action 8,000 each, 20 sessions,
  5 packs, list at most 100/default 25.
- Template variables: 20, ASCII identifier 40, value 8,000, rendered prompt
  64,000; history 20 per template and 1,000 globally.
- Packs: 200, items 20, item text 8,000, total item text 48,000, source 8 MiB,
  name/description/instructions 200/500/8,000, compiled prompt 64,000.
- Saved views: 50, name 120, no persisted pagination offset, relative dates
  resolved using the browser's local calendar.
- New mutations use positive integer versions and atomic `retryWrite`; stale
  requests return 409 with no partial write.
- No actual model/MCP calls, automatic agent workflows, new backup subsystem,
  external telemetry or native-history mutation.
- All tests use `flock /tmp/my-agent-ops-1.4-test.lock`; workers use
  `--maxWorkers=1`, coordinator uses at most 2.

## Shared contracts and integration ownership

The coordinator owns `shared/types.ts`, `server/app.ts`, `server/runner.ts`,
`server/commands.ts`, `server/store.ts`, app state/navigation/Shell/palette,
NewRunDialog, SessionReader, Overview, global dictionaries, demo seed, versions,
package scripts and public documentation.

Workers own their feature contracts, services, UI components and focused tests.
Use this shared server hook interface from `server/productivity/common.ts`:

```typescript
export interface ProductivityRouteHooks {
  write: <T>(action: () => T) => Promise<T>;
  onChange: () => void;
}
```

`problem(statusCode, message)` creates an ordinary Error with `statusCode`.
Feature services receive the existing `Store`; they own only their extension
tables and never open a second live database connection or touch native files.
Route registrars inherit the root application's access/error handlers.

## Task 1: Work items and explicit run linkage

**Owner:** coordinator for backend/run linkage; work-item UI worker for views and editors.

**Files:** `shared/work-items.ts`, `server/productivity/work-items.ts`,
`server/productivity/work-item-routes.ts`, `src/pages/WorkItems.tsx`,
`src/features/work-items/`, integration files named above, focused work-item
store/API/run/browser tests.

**Interfaces:**

```typescript
type WorkItemStatus = 'todo' | 'in_progress' | 'blocked' | 'done';
type WorkItemPriority = 'low' | 'normal' | 'high';
interface WorkItem {
  id: string; title: string; description: string; nextAction: string;
  projectId: string | null; dueDate: string | null;
  status: WorkItemStatus; priority: WorkItemPriority;
  sessionIds: string[]; contextPackIds: string[]; lastRunId: string | null;
  version: number; createdAt: string; updatedAt: string; archivedAt: string | null;
}
```

Add optional `workItemId`, `workItemVersion` and `contextPackIds` to RunRequest;
validate the pair and bounded IDs. `WorkItemService.linkRun(run)` checks version,
status/project and links the already reserved run inside its insertion
transaction. Runner's optional `onCreated(run)` callback is synchronous and
executes inside the same transaction as `insertRun`.

- [x] Prove the missing route and run-link behavior fail on the baseline:

```typescript
expect((await app.inject('/api/productivity/work-items')).statusCode).toBe(200);
const first = await service.create({ title: 'Fix login', projectId: project.id });
service.update(first.id, { version: first.version, nextAction: 'Review the fix' });
expect(() => service.update(first.id, { version: first.version, title: 'stale' }))
  .toThrow(/changed|version/i);
```

- [x] Implement indexed CRUD, filters, pagination, archive/delete, references,
  version conflicts and record limits; test persistence with reopened stores.
- [x] Connect session capture and work-item run drafts. Test two launches with
  the same version queue only one controlled CLI, rollback on failed linkage,
  project/status validation and explicit completion.
- [x] Build list/board/editor views, due-date feedback and linked result actions.
  Add Overview/command-palette access and both languages.

## Task 2: Parameterized template inputs and history

**Owner:** template worker.

**Write set:** new `shared/template-fields.ts`, `server/productivity/templates.ts`,
`src/features/template-fields/`, `src/features/templates/TemplateEditor.tsx`,
`src/pages/Templates.tsx`, `src/i18n/template-fields.en.ts`,
focused `tests/template-fields*.test.ts` and component tests in the feature folder.
Do not edit shared/types, app.ts, NewRunDialog, global dictionaries or seed.

**Interfaces:** export `TemplateVariable`, `renderTemplate(template, values)`,
`templateVariables(prompt)`, `TemplateService`, `registerTemplateFieldRoutes`,
`TemplateVariableInputs` and `TEMPLATE_FIELDS_EN_MESSAGES`.
Coordinator adds optional `variables?: TemplateVariable[]`, `revision?: number`
to PromptTemplate.

`TemplateService` provides `create`, `update(id, patch)`, `remove`,
`history(id)`, `restore(id, revision, expectedRevision)` and `render(id, values)`.
Existing template CRUD routes call its synchronous methods under `hooks.write`.
Registrar adds GET `/api/templates/:id/history`, POST
`/api/templates/:id/restore` and POST `/api/templates/:id/render`.
New UI sends optional `expectedRevision` for compatible PATCH updates.

- [x] Add failing literal-substitution/required/select/limit tests. A value
  containing `{{other}}`, `$&`, backticks or `$(...)` must remain literal.
- [x] Implement definitions, rendering and guarded history persistence with
  ordinary legacy templates unchanged. Test stale revisions, restart/history
  caps, delete behavior and restore as a new revision.
- [x] Add input/apply UI, definition editing, history preview/restore and library
  use flow. Export a reusable input component for coordinator's run dialog.
- [x] Verify both languages, preserved user text and no execution side effects;
  report exact component props and service method signatures.

## Task 3: Reusable context packs

**Owner:** context worker.

**Write set:** new `shared/context-packs.ts`, `server/productivity/context-packs.ts`,
`server/productivity/context-pack-routes.ts`, `src/pages/ContextPacks.tsx`,
`src/features/context-packs/`, `src/i18n/context-packs.en.ts`,
focused `tests/context-packs*.test.ts` and component tests in that feature folder.
Do not edit shared/types, app.ts, navigation/Shell, SessionReader, NewRunDialog,
global dictionaries, store.ts or seed.

**Interfaces:** export `ContextPackService`, `registerContextPackRoutes`,
`ContextPackPicker`, `CaptureContextDialog`, `CONTEXT_PACKS_EN_MESSAGES`.
Service receives Store and provides create/get/list/update/remove, addItem,
updateItem/removeItem/reorder, compile/export. Expose the exact DTOs in
`shared/context-packs.ts`; summaries must omit item bodies.

Use `/api/productivity/context-packs`, `/:id`, `/:id/items`, `/:id/items/:itemId`,
`/:id/reorder`, `/:id/compile`, `/:id/export`. Mutations carry `version`.
Capture input uses `{kind:'message', sessionId, messageId, offset, length}` or
`{kind:'note', title, text}`. Captured source text is immutable; retained items
do not reread their source on unrelated updates.

- [x] Add failing tests capturing a real synthetic message, preserving source
  provenance, rejecting client-forged text and staying unchanged on conflict.
- [x] Implement bounded metadata lists, source excerpts, notes/reorder/versioned
  edits and local compile/export. Prove large-message bounds, omitted-source
  behavior, all selected items preserved and sensitive patterns redacted.
- [x] Build the page/editor and reusable session-capture and selection dialogs.
  Offer copy/export and a prepared run via existing `useApp().openNewRun`.
  No model call or native file operation.
- [x] Verify source changes/deletion, Unicode boundaries, prompt-size failures,
  English/Korean and keyboard/error states; report integration props.

## Task 4: Saved views and filter reuse

**Owner:** saved-view worker.

**Write set:** new `shared/saved-views.ts`, `server/productivity/saved-views.ts`,
`src/features/saved-views/`, `src/i18n/saved-views.en.ts`,
focused `tests/saved-views*.test.ts` and component tests in that feature folder.
Do not edit Sessions, palette, app.ts, global dictionaries, shared/types or seed.

**Interfaces:** export `SavedViewService`, `registerSavedViewRoutes`,
`resolveSavedView(view, now)`, `SavedViewsBar`, `useSavedViews`,
`SAVED_VIEWS_EN_MESSAGES`. API base `/api/productivity/saved-views`.
Bar receives current `SessionQuery` and `onApply(query)`; applying resets offset.
Expose DTOs, relative-period enum and hook return shape.

- [x] Add failing tests for relative periods recalculated on a later day, DST
  calendar boundaries, filter round-trip and offset removal.
- [x] Implement versioned CRUD/pinning/name and query validation/caps under the
  shared write hook. Persist only metadata; do not execute saved searches.
- [x] Build a compact save/open/update/delete/pin toolbar and hook with abort
  handling. Provide query resolution for Sessions and palette integration.
- [x] Test literal metacharacters, invalid dates/filters, stale mutations,
  both languages and surfaced load/write errors.

## Task 5: Combined flow, performance, documentation and release

**Owner:** coordinator; independent reviewer after integration.

- [x] Integrate registrars and compatible template CRUD, task run linking,
  lazy pages, navigation, small SSE events and demo examples.
- [x] Verify session capture, template input and attached context lead into
  the same explicit preview/run flow without losing drafts or user edits.
- [x] Add browser tests covering CRUD/reload/conflicts, combined flow, source
  capture, relative saved views, template history, palette, phone and proxy.
- [x] Measure bounded lists/quick search and prove no native-corpus rewrite or
  full-bootstrap refresh on new metadata edits.
- [x] Run required checks:

```bash
npm run typecheck
npm test -- --maxWorkers=2
npm run build
npm run test:e2e
```

- [x] Review independently, resolve real findings and update bilingual README,
  changelog, API/operating docs, a productivity reference and verification log.
- [x] Prepare the compatible minor release, production installation archive and
  smoke test; align package/lock/runtime/changelog/tag/release versions.
- [x] Publish through standing authorization, deploy with backup at an idle
  point and verify runtime/assets/public downloads. Audit every spec requirement
  before marking the active goal complete.
