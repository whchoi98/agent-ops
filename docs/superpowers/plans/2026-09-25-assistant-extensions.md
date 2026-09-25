# Assistant Extensions Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent
> provider and interface work; keep filesystem boundaries and integration local.

**Goal:** Inspect and analyze Codex, Claude Code and Kiro skills/plugins in Agent Ops.
**Architecture:** On-demand bounded discovery, native provider adapters, static
analysis and redacted previews; an existing CLI-run draft provides optional deep
analysis. The UI is a new workspace using the existing API and proxy conventions.
**Tech Stack:** Node.js 20.19+, TypeScript, Fastify, React, Vitest, Playwright,
YAML and TOML parsers.
**Spec:** [Assistant extensions](../specs/2026-09-25-assistant-extensions.md).

## Global constraints

- Preserve loopback, Host/Origin and mutation-header checks.
- Original metadata is read-only; no plugin, hook, skill script or model executes
  during discovery, static analysis or testing.
- Do not publish local configuration, native histories or credentials.
- Distinguish cached/installed/configured availability from actual invocation.
- Maintain macOS path support without claiming unperformed Mac runtime tests.

## Task 1: File boundaries and static analysis

Files: `server/extensions/io.ts`, `server/extensions/analysis.ts`,
`tests/extensions-io.test.ts`, `tests/extensions-analysis.test.ts`.
Consumes `DiscoveryIO`, `ExtensionSummary`, `ExtensionContent`; produces
`ExtensionReader`, `parseSkillDocument`, `sanitizeText`, `sanitizeMetadata`,
`analyzeExtension`.

- [x] Write temporary-tree tests proving an ordinary SKILL.md reads, an outside
  symlink and credential filename do not, oversized reads report truncation and
  discovery is bounded. Run the focused suite before implementation.
- [x] Write analysis tests for YAML metadata, declared tools, JSON MCP/hook names,
  missing descriptions and redaction of environment values/private-key material.
- [x] Implement the reader and analyzer; rerun both suites.

```ts
const analysis = analyzeExtension(item, [entry], metadata, ['review-agent']);
expect(analysis.tools).toContain('Read');
expect(sanitizeText('password=fixture-secret')).not.toContain('fixture-secret');
```

## Task 2: Native assistant discovery

Files: `server/extensions/codex.ts`, `server/extensions/claude.ts`,
`server/extensions/kiro.ts`, `tests/extensions-{codex,claude,kiro}.test.ts`.
Consumes `DiscoveryContext`; each exports an async `discoverCodex`,
`discoverClaude` or `discoverKiro` returning `DiscoveryResult`.

- [x] For each provider, write real config/manifest fixture tests and observe
  missing-adapter failure before implementing it.
- [x] Cover explicit enable/disable, user/project scope, bundled skills and
  missing or malformed source diagnostics. Codex tests include config trust;
  Claude tests include installed registry plus local override; Kiro tests include
  agent `skill://` resources and IDE power activation uncertainty.
- [x] Implement adapters and run their focused suites.

```ts
const result = await discoverCodex(context);
expect(result.candidates.find(x => x.name === 'review-guide')?.status).toBe('disabled');
```

## Task 3: Catalog, previews, API and demo

Files: `server/extensions/service.ts`, `server/extensions/demo.ts`,
`server/extensions/routes.ts`, `server/app.ts`, `src/lib/api.ts`,
`tests/extensions-api.test.ts`.
Consumes provider results and public contracts; produces `ExtensionService`
and the five documented routes.

- [x] Test native fixtures through Fastify injection: lists/filter/page counts,
  project ID validation, opaque file lookup, redacted preview and analysis draft.
- [x] Confirm demo cannot inspect the host; refresh and analysis require the
  existing mutation header; deep-analysis preparation launches no process.
- [x] Implement bounded per-project caching, detail enrichment, child links,
  refresh, static analysis and prompt preparation; rerun API tests.

```ts
const response = await app.inject('/api/extensions?agent=claude&limit=1');
expect(response.json().items).toHaveLength(1);
expect((await app.inject('/api/extensions/unknown/files/outside')).statusCode).toBe(404);
```

## Task 4: Workspace and end-to-end integration

Files: `src/pages/Extensions.tsx`, `src/features/extensions/*`,
`src/styles/extensions.css`, `src/App.tsx`, `src/lib/navigation.ts`,
`src/components/Shell.tsx`, `tests/e2e/extensions.spec.ts`.
Consumes the public contracts and `api.extensions`, `extension`,
`extensionFile`, `refreshExtensions`, `analyzeExtension` client methods.

- [x] Write a browser test that fails on the missing new navigation/workspace.
- [x] Add filters, assistant counts, project scope, paged results, detail tabs,
  file previews, plugin children and editable analysis-run draft integration.
- [x] Verify Korean search, keyboard/dialog behavior, mobile overflow and
  proxy-prefixed API requests using deterministic demo data.

```ts
await page.getByRole('link', { name: '스킬·플러그인', exact: true }).click();
await expect(page.getByRole('heading', { name: '스킬·플러그인', exact: true })).toBeVisible();
```

## Task 5: Review and delivery

- [x] Run `npm run check`, then `npm run test:e2e`; inspect a demo screenshot.
- [x] Inspect local inventory aggregates without printing instruction content or
  secrets. Review boundary tests and resolve material findings.
- [x] Update README, API/operating docs, changelog and verification evidence.
- [ ] Build and verify distribution, integrate the feature, update the existing
  service, and confirm live health/catalog responses without credential login.

## Task 6: Installed/latest CLI version comparison (user addition)

Files: `shared/versions.ts`, `server/versions.ts`, `tests/versions.test.ts`,
`tests/versions-api.test.ts`, `src/features/versions/*`, `src/pages/Settings.tsx`,
`src/lib/api.ts`, `server/app.ts`.
Consumes existing `ConnectorStatus` probes; produces `VersionReport` through
`GET /api/connector-versions` and explicit refresh through
`POST /api/connector-versions/check`.

- [x] Verify fixed public vendor metadata endpoints and their current schemas.
- [x] Write red tests for semver comparison, unknown/current/prerelease states,
  independent source failures, timeout/body limits, caching and demo isolation.
- [x] Implement version service and local API routes. Do not send local metadata
  to vendor endpoints, permit arbitrary URLs, or execute upgrade commands.
- [x] Show installed/latest values, source and check time in Settings; preserve
  current version when latest checks fail, and mark sample data in demo.
- [x] Verify the UI and proxy route, then include the feature in final checks.
