import { expect, type Page, type Route } from '@playwright/test';
import type { HarnessCatalog, HarnessClient, HarnessPolicyDetail } from '../../../../shared/harness';
import { auditPage, auditRecord, binding, catalog, decision, deferred, hookPreview, policy, runtime, settings } from '../testFixtures';

export async function harnessBrowserApi(page: Page, demo = false) {
  let currentSettings = settings();
  let currentRuntime = runtime({ state: 'unsupported', pythonVersion: '3.9.25', engineVersion: null });
  const managed = new Map<string | null, HarnessPolicyDetail>();
  let revision = 1;
  let previewCount = 0;
  let applyCount = 0;
  let kiroManaged = false;
  const heldCatalogs: Array<{
    method: 'GET' | 'POST'; started: ReturnType<typeof deferred<HarnessCatalog>>;
    release: ReturnType<typeof deferred<void>>; finished: ReturnType<typeof deferred<void>>;
  }> = [];
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> | null; query: Record<string, string> }> = [];
  const sourceFor = (projectId: string | null) => policy({
    id: 'source-standard', scope: 'builtin', editable: false, projectId, name: '원문 정책 이름',
    content: 'version: "1.0"\nmode: standard\nrules: []\n',
    path: `/tmp/synthetic/${'long-source-'.repeat(24)}.yaml`,
  });
  const bindingsFor = (projectId: string | null) => (['codex', 'claude-code', 'kiro-ide', 'kiro-cli'] as HarnessClient[])
    .map(client => binding({
      client, projectId, managed: client.startsWith('kiro') && kiroManaged,
      state: client.startsWith('kiro') && kiroManaged ? 'configured' : 'unconfigured',
      path: client.startsWith('kiro') ? '/tmp/synthetic/.kiro/hooks.json' : '/tmp/synthetic/.codex/hooks.json',
    }));
  const respond = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const projectId = url.searchParams.get('projectId');
    const body = request.postDataJSON() as Record<string, unknown> | null;
    const path = url.pathname;
    requests.push({ path, method: request.method(), body, query: Object.fromEntries(url.searchParams) });
    if (demo && ['/api/harness/runtime/check', '/api/harness/evaluate', '/api/harness/hooks/apply'].includes(path)) {
      return respond(route, { error: '데모에서는 실제 엔진 실행과 훅 설정 변경을 할 수 없습니다.' }, 403);
    }
    if (path === '/api/harness' || path === '/api/harness/refresh') {
      const scope = path.endsWith('/refresh') ? body?.projectId as string ?? null : projectId;
      const snapshot = catalog({
        projectId: scope, demo, runtime: demo ? runtime() : currentRuntime, settings: currentSettings,
        policies: [sourceFor(scope), ...(managed.has(scope) ? [managed.get(scope)!] : [])],
        bindings: bindingsFor(scope),
      });
      const index = heldCatalogs.findIndex(held => held.method === request.method());
      if (index >= 0) {
        const held = heldCatalogs.splice(index, 1)[0];
        held.started.resolve(structuredClone(snapshot));
        await held.release.promise;
        try { await respond(route, snapshot); }
        finally { held.finished.resolve(); }
        return;
      }
      return respond(route, snapshot);
    }
    if (path === '/api/harness/settings' && body) {
      if (body.revision !== currentSettings.revision) return respond(route, { error: '하니스 설정이 변경되었습니다. 다시 불러온 뒤 저장하세요.' }, 409);
      currentSettings = { revision: currentSettings.revision + 1, pythonPath: body.pythonPath as string | null,
        retentionDays: Number(body.retentionDays), maxCacheRecords: Number(body.maxCacheRecords) };
      currentRuntime = runtime({ state: 'unchecked', engineVersion: null, pythonVersion: null, checkedAt: null });
      return respond(route, currentSettings);
    }
    if (path === '/api/harness/runtime/check') {
      expect(body).toEqual({});
      currentRuntime = runtime();
      return respond(route, currentRuntime);
    }
    if (path === '/api/harness/policies/managed' && body) {
      const scope = body.projectId as string ?? null;
      const original = managed.get(scope);
      if (body.expectedRevision !== (original?.revision ?? null)) {
        return respond(route, { error: 'Managed policy revision changed. Refresh before saving.' }, 409);
      }
      const saved = policy({ id: `managed-${scope ?? 'global'}`, projectId: scope, name: 'Managed literal policy',
        content: String(body.content), revision: `revision-${++revision}` });
      managed.set(scope, saved);
      return respond(route, saved);
    }
    if (path === '/api/harness/policies/validate') return respond(route, {
      valid: true, engineValidated: false, mode: 'standard', ruleCount: 0, errors: [],
      warnings: ['Local structural validation only; the AutoHarness engine has not validated this policy.'],
    });
    if (path.startsWith('/api/harness/policies/')) {
      return respond(route, path.endsWith('/source-standard') ? sourceFor(projectId) : managed.get(projectId));
    }
    if (path === '/api/harness/evaluate' && body) return respond(route, decision({
      policyId: String(body.policyId), policyRevision: String(body.revision), projectId: body.projectId as string ?? null,
      client: body.client as HarnessClient, toolName: String(body.toolName),
    }));
    if (path === '/api/harness/hooks/preview' && body) return respond(route, hookPreview({
      id: `preview-${++previewCount}`, projectId: String(body.projectId), client: body.client as HarnessClient,
      action: body.action as 'install' | 'remove', canApply: !demo,
      files: demo ? [] : [{ path: `/tmp/synthetic/.kiro/${'long-path-'.repeat(30)}.json`, existed: true,
        before: '{"token":"[REDACTED]"}', after: '{"hooks":"shared synthetic hook"}' }],
    }));
    if (path === '/api/harness/hooks/apply' && body) {
      applyCount++;
      if (applyCount === 1) return respond(route, { error: 'Hook preview expired or was already used.' }, 409);
      kiroManaged = true;
      return respond(route, binding({ client: 'kiro-ide', projectId: String(body.projectId), state: 'configured', managed: true }));
    }
    if (path === '/api/harness/audit') {
      const items = Array.from({ length: 45 }, (_, index) => auditRecord({
        id: `audit-${index}`, projectId, client: index % 2 ? 'codex' : 'kiro', sessionId: `session-${index}`,
        origin: index % 3 === 0 ? 'autoharness' : index % 3 === 1 ? 'agent-ops-test' : 'agent-ops-hook',
      }));
      const filtered = items.filter(item => (!url.searchParams.get('client') || item.client === url.searchParams.get('client'))
        && (!url.searchParams.get('sessionId') || item.sessionId === url.searchParams.get('sessionId')));
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 20);
      return respond(route, auditPage({ total: filtered.length, offset, limit, items: filtered.slice(offset, offset + limit) }));
    }
    return respond(route, { error: `Unexpected request ${path}` }, 500);
  });
  return {
    requests, managed,
    changeSettings: () => {
      currentSettings = { ...currentSettings, revision: currentSettings.revision + 1, pythonPath: '/opt/other/python3' };
      currentRuntime = runtime({ state: 'unchecked', checkedAt: null, engineVersion: null, pythonVersion: null });
    },
    ready: () => { currentRuntime = runtime(); },
    resetRuntime: () => { currentRuntime = runtime({ state: 'unchecked', checkedAt: null, engineVersion: null, pythonVersion: null }); },
    holdCatalog: (method: 'GET' | 'POST' = 'POST') => {
      const held = { method, started: deferred<HarnessCatalog>(), release: deferred<void>(), finished: deferred<void>() };
      heldCatalogs.push(held);
      return { started: held.started.promise, release: held.release.resolve, finished: held.finished.promise };
    },
  };
}
