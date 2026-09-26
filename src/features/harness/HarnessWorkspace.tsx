import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { RefreshCw } from 'lucide-react';
import type {
  HarnessAuditQuery, HarnessClient, HarnessHookRequest, HarnessSettings,
} from '../../../shared/harness';
import type { Project } from '../../../shared/types';
import { Button, Field, InlineNotice, PageHeading } from '../../components/ui';
import { useFormat } from '../../i18n/useFormat';
import { HarnessAudit } from './HarnessAudit';
import { HarnessEvaluation } from './HarnessEvaluation';
import { HarnessHookPreviewDialog } from './HarnessHookPreview';
import { HarnessHooks } from './HarnessHooks';
import { HarnessPolicies } from './HarnessPolicies';
import { HarnessRuntime } from './HarnessRuntime';
import { HarnessTabPanel, HarnessTabs, type HarnessTab } from './HarnessTabs';
import { createHarnessHookResource } from './hooks-resource';
import { useHarnessI18n } from './i18n';
import { DEMO_NOTICE, runtimeState } from './model';
import { createHarnessPolicyResource, policyDirty } from './policy-resource';
import { HarnessError, HarnessNotices } from './ui';
import { useHarnessCatalog } from './useHarness';

export function HarnessWorkspace({ projects, demo }: { projects: Project[]; demo: boolean }) {
  const { t } = useHarnessI18n();
  const { dateTime } = useFormat();
  const tabsId = useId();
  const [activeTab, setActiveTab] = useState<HarnessTab>('engine');
  const [query, setQuery] = useState<HarnessAuditQuery>({ offset: 0, limit: 20 });
  const projectId = query.projectId;
  const scopeKey = JSON.stringify(projectId ?? null);
  const [auditRevision, setAuditRevision] = useState(0);
  const catalogResource = useHarnessCatalog(projectId);
  const catalog = catalogResource.data;
  const policiesByScope = useRef(new Map<string, ReturnType<typeof createHarnessPolicyResource>>());
  const policyResource = useMemo(() => {
    let resource = policiesByScope.current.get(scopeKey);
    if (!resource) { resource = createHarnessPolicyResource(projectId); policiesByScope.current.set(scopeKey, resource); }
    return resource;
  }, [scopeKey, projectId]);
  const policyState = useSyncExternalStore(policyResource.subscribe, policyResource.getSnapshot, policyResource.getSnapshot);
  const hookResource = useMemo(() => createHarnessHookResource(projectId), [projectId]);
  const hookState = useSyncExternalStore(hookResource.subscribe, hookResource.getSnapshot, hookResource.getSnapshot);
  const hookReturnFocus = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    policyResource.start();
    if (policyResource.getSnapshot().selectedId && policyResource.getSnapshot().selectedId !== 'new') void policyResource.reload();
    return policyResource.stop;
  }, [policyResource]);
  useEffect(() => { hookResource.start(); return hookResource.stop; }, [hookResource]);
  useEffect(() => {
    if (hookState.request || catalogResource.loading || !hookReturnFocus.current) return;
    const trigger = hookReturnFocus.current;
    hookReturnFocus.current = null;
    // Starting a preview disables its trigger before Dialog can remember the focused element.
    // Restore it after the dialog cleanup and any catalog read have completed.
    const timer = window.setTimeout(() => {
      if (trigger.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [hookState.request, catalogResource.loading]);
  useEffect(() => {
    if (!catalog) return;
    policyResource.setPolicies(catalog.policies);
    if (!policyResource.getSnapshot().selectedId) {
      const initial = catalog.policies.find(item => item.scope === 'managed' && item.projectId === (projectId ?? null)) ?? catalog.policies[0];
      if (initial) void policyResource.select(initial.id);
    }
  }, [catalog, policyResource, projectId]);
  useEffect(() => {
    if (projectId && !projects.some(project => project.id === projectId)) {
      setQuery(previous => ({ ...previous, projectId: undefined, sessionId: undefined, offset: 0 }));
    }
  }, [projects, projectId]);

  const currentSettings = catalog?.settings ?? catalogResource.global?.settings ?? null;
  const runtime = catalog?.runtime ?? catalogResource.global?.runtime ?? null;
  const isDemo = demo || !!catalog?.demo || !!catalogResource.global?.demo;
  const demoNoticeId = isDemo ? `${tabsId}-demo` : undefined;
  const selected = policyState.detail;
  const selectedSummary = catalog?.policies.find(item => item.id === selected?.id);
  const policyBlocked = catalogResource.loading || !catalog || policyState.loading || !!policyState.busy || !!policyState.error || policyDirty(policyState.draft)
    || !!(selected && (!selectedSummary || selectedSummary.revision !== selected.revision))
    || !!(selected && policyState.draft && policyState.draft.expectedRevision !== selected.revision);
  const previewPolicy = catalog?.policies.find(item => item.id === hookState.request?.policyId);
  const previewChanged = hookState.request?.action === 'install'
    && (!previewPolicy || previewPolicy.revision !== hookState.request.revision);
  const newPreviewDisabled = catalogResource.loading || !catalog || (hookState.request?.action === 'install'
    && (!previewPolicy?.valid || !runtime || runtimeState(runtime) !== 'ready'));
  const filters = useCallback((patch: HarnessAuditQuery) => setQuery(previous => ({ ...previous, ...patch, offset: 0 })), []);
  const auditReload = useCallback(() => setAuditRevision(value => value + 1), []);

  async function refreshCatalog() {
    if (await catalogResource.refresh()) auditReload();
  }
  function acceptSettings(settings: HarnessSettings) {
    if (catalogResource.acceptSettings(settings)) auditReload();
  }

  async function savePolicy() {
    const result = await policyResource.save();
    if (result) catalogResource.acceptPolicy(result);
  }
  async function reloadPolicy() {
    const result = await catalogResource.reload();
    if (!result) return;
    policyResource.setPolicies(result.policies);
    await policyResource.reload();
  }
  function previewHook(client: HarnessClient, action: 'install' | 'remove', managed: boolean, trigger: HTMLButtonElement) {
    if (isDemo || !projectId || (action === 'install' && (policyBlocked || !selected || !runtime || runtimeState(runtime) !== 'ready'))) return;
    hookReturnFocus.current = trigger;
    const request: HarnessHookRequest = {
      projectId, client, action, ...(action === 'install' && selected ? { policyId: selected.id, revision: selected.revision } : {}),
    };
    void hookResource.preview(request, managed);
  }
  function newPreview() {
    const request = hookState.request;
    if (!request || isDemo || newPreviewDisabled) return;
    const binding = catalog?.bindings.find(item => item.client === request.client);
    void hookResource.preview({
      ...request, ...(request.action === 'install' && previewPolicy ? { revision: previewPolicy.revision } : {}),
    }, !!binding?.managed);
  }
  async function applyHook() {
    if (isDemo || previewChanged || catalogResource.loading) return;
    const result = await hookResource.apply();
    if (result && catalogResource.acceptBinding(result)) auditReload();
    // Refresh evidence after either outcome; a mutation itself is never replayed.
    void catalogResource.reload();
  }

  return <div className="harness-workspace">
    <PageHeading title={t('하니스 관리')} eyebrow="AUTOHARNESS"
      description={t('엔진과 정책, 네이티브 훅 설정 및 최근 감사 기록을 관리하세요.')}
      actions={<Button icon={RefreshCw} busy={catalogResource.loading}
        onClick={() => void refreshCatalog()}>{t('하니스 목록 새로고침')}</Button>} />
    <div className="harness-scope">
      <Field label={t('프로젝트')} htmlFor="harness-project" hint={t('등록된 프로젝트를 선택하면 사용자 정책과 프로젝트 정책을 함께 확인합니다.')}>
        <select id="harness-project" aria-label={t('하니스 프로젝트 선택')} value={projectId ?? ''}
          onChange={event => filters({ projectId: event.target.value || undefined, sessionId: undefined })}>
          <option value="">{t('전역 · 사용자 설정')}</option>
          {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </Field>
      <p className="harness-hint">{t('목록 갱신은 엔진을 실행하거나 훅을 변경하지 않습니다.')}</p>
    </div>
    {isDemo && <div id={demoNoticeId}><InlineNotice>{t(DEMO_NOTICE)}</InlineNotice></div>}
    <HarnessError problem={catalogResource.error} onRetry={catalogResource.reload} busy={catalogResource.loading} />
    <HarnessTabs id={tabsId} active={activeTab} onChange={setActiveTab} />
    <HarnessTabPanel id={tabsId} tab="engine" active={activeTab === 'engine'}>
      <HarnessRuntime runtime={runtime} settings={currentSettings} demo={isDemo} demoNoticeId={demoNoticeId}
        onSettingsSaved={acceptSettings} onRuntime={catalogResource.acceptRuntime} onReload={catalogResource.reload} />
    </HarnessTabPanel>
    <HarnessTabPanel id={tabsId} tab="policies" active={activeTab === 'policies'}>
      <div className="harness-stack">
        <HarnessPolicies policies={catalog?.policies ?? []} loading={catalogResource.loading} state={policyState} projectId={projectId}
          onSelect={id => void policyResource.select(id)} onNew={policyResource.newPolicy} onEdit={policyResource.edit}
          onSave={() => void savePolicy()} onValidate={() => void policyResource.validate()} onReload={() => void reloadPolicy()} onAdopt={policyResource.adoptRevision} />
        {catalog && <details className="panel harness-discovery">
          <summary>{t('검색 진단')}</summary>
          <div className="harness-stack">
            <p className="harness-hint">{t('검색 시각')}: <time dateTime={catalog.scannedAt}>{dateTime(catalog.scannedAt)}</time></p>
            <HarnessNotices messages={catalog.warnings} />
          </div>
        </details>}
      </div>
    </HarnessTabPanel>
    <HarnessTabPanel id={tabsId} tab="decision" active={activeTab === 'decision'}>
      <HarnessEvaluation key={`evaluation:${scopeKey}`} policy={selected} projectId={projectId} runtime={runtime} demo={isDemo}
        demoNoticeId={demoNoticeId} blocked={policyBlocked} onEvaluated={auditReload} />
    </HarnessTabPanel>
    <HarnessTabPanel id={tabsId} tab="hooks" active={activeTab === 'hooks'}>
      <HarnessHooks bindings={catalog?.bindings ?? []} projectId={projectId} policy={selected} runtime={runtime} demo={isDemo}
        demoNoticeId={demoNoticeId} blocked={policyBlocked} busy={!!hookState.busy || catalogResource.loading} onPreview={previewHook} />
    </HarnessTabPanel>
    <HarnessTabPanel id={tabsId} tab="audit" active={activeTab === 'audit'}>
      <HarnessAudit key={`audit:${scopeKey}`} query={query} revision={auditRevision} onFilters={filters} onPage={offset => setQuery(previous => ({ ...previous, offset }))} />
    </HarnessTabPanel>
    {hookState.request && <HarnessHookPreviewDialog state={hookState} changed={previewChanged} demo={isDemo}
      newPreviewDisabled={newPreviewDisabled} onNewPreview={newPreview} onApply={() => void applyHook()} onClose={hookResource.close} />}
  </div>;
}
