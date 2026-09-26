import { expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { createI18n, I18nContext } from '../../i18n/I18nProvider';
import { HarnessRuntime } from './HarnessRuntime';
import { HarnessPolicyEditor, HarnessValidationResult } from './HarnessPolicies';
import { HarnessDecisionView, HarnessEvaluation } from './HarnessEvaluation';
import { HarnessHooks } from './HarnessHooks';
import { HarnessHookPreviewView } from './HarnessHookPreview';
import { HarnessAuditView } from './HarnessAudit';
import { auditPage, auditRecord, binding, decision, harnessProject, hookPreview, policy, runtime, settings, storage } from './testFixtures';
import type { HarnessPolicySnapshot } from './policy-resource';

function render(children: ReactNode, language: 'en' | 'ko' = 'en') {
  return renderToStaticMarkup(<I18nContext.Provider value={{ ...createI18n(language), setLanguage: () => {} }}>
    {children}
  </I18nContext.Provider>);
}
function control(html: string, label: string) {
  const found = (html.match(/<button\b[\s\S]*?<\/button>/g) ?? []).find(value => value.includes(label));
  expect(found, label).toBeDefined();
  return found!;
}
const noAction = () => {};

test('an unsupported Python keeps settings and copyable pinned installation help usable', () => {
  const html = render(<HarnessRuntime runtime={runtime({ state: 'missing', pythonVersion: '3.9.25', engineVersion: null })}
    settings={settings()} demo={false} onSettingsSaved={noAction} onRuntime={noAction} onReload={noAction} />);
  expect(html).toContain('Unsupported Python or engine');
  expect(html).toContain('3.9.25');
  expect(html).toContain('Python 3.10 or newer is required');
  expect(html).toContain('Tested version');
  expect(html).toContain('0.1.1');
  expect(html).toContain('3561e468f9ca9f9bf282512e695bd32e4e90fef4.tar.gz');
  expect(control(html, 'Copy installation commands')).not.toContain('disabled=""');
  expect(control(html, 'Probe engine')).not.toContain('disabled=""');
});

test('demo readiness is a fixture and never enables engine probes or evaluations', () => {
  const html = render(<>
    <HarnessRuntime runtime={runtime()} settings={settings()} demo onSettingsSaved={noAction} onRuntime={noAction} onReload={noAction} />
    <HarnessEvaluation policy={policy()} runtime={runtime()} demo blocked={false} onEvaluated={noAction} />
  </>);
  expect(control(html, 'Probe engine')).toContain('disabled=""');
  expect(control(html, 'Decision test')).toContain('disabled=""');
  expect(html).toContain('Demo mode disables engine probes');
});

test('an unsupported engine version does not incorrectly ask to replace a supported Python interpreter', () => {
  const html = render(<HarnessRuntime runtime={runtime({ state: 'unsupported', pythonVersion: '3.12.1', engineVersion: '0.1.2' })}
    settings={settings()} demo={false} onSettingsSaved={noAction} onRuntime={noAction} onReload={noAction} />);
  expect(html).toContain('The observed version differs from the tested version 0.1.1');
  expect(html).not.toContain('Python 3.9 is unsupported');
});

test('policy conflicts expose the literal draft and reviewed revision without translating policy text', () => {
  const state: HarnessPolicySnapshot = {
    selectedId: 'policy:managed', detail: policy({ content: '# 최신 원문 <script>', revision: 'revision-2' }),
    draft: { content: '# 새로고침 <script>', expectedRevision: 'revision-1', baseContent: '# original' },
    loading: false, busy: null, error: { message: 'Harness policy changed. Reload before saving.', status: 409, unknown: false },
    validation: null, saved: false,
  };
  const content = <HarnessPolicyEditor state={state} projectId={harnessProject.id} onEdit={noAction}
    onSave={noAction} onValidate={noAction} onReload={noAction} onAdopt={noAction} />;
  const english = render(content);
  const korean = render(content, 'ko');
  for (const html of [english, korean]) {
    expect(html).toContain('# 새로고침 &lt;script&gt;');
    expect(html).toContain('# 최신 원문 &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('revision-1');
    expect(html).toContain('revision-2');
  }
  expect(control(english, 'Use this revision for my next save')).not.toContain('disabled=""');
  expect(control(english, 'Save policy')).toContain('disabled=""');
  expect(korean).toContain('하니스 정책이 변경되었습니다.');
});

test('passing structural validation never claims the actual engine validated it', () => {
  const html = render(<HarnessValidationResult validation={{
    valid: true, engineValidated: false, mode: 'standard', ruleCount: 2, errors: [], warnings: [],
  }} />);
  expect(html).toContain('Structure passed');
  expect(html).toContain('Actual engine validation was not performed');
  expect(html).not.toContain('Actual engine validation completed');
});

test.each(['allow', 'ask', 'deny', 'error'] as const)('a %s decision labels the result and never claims the tool was run', action => {
  const html = render(<HarnessDecisionView decision={decision({ action })} />);
  expect(html).toContain({ allow: 'Allow', ask: 'Ask', deny: 'Deny', error: 'Engine error' }[action]);
  expect(html).toContain('No tool execution');
  expect(html).toContain('정책 원문 이유 &lt;script&gt;');
  expect(html).toContain('High');
});

test('hooks show four clients, shared Kiro scope, observed events separately, and prevent external removal', () => {
  const html = render(<HarnessHooks bindings={[
    binding({ state: 'configured', managed: false }),
    binding({ client: 'kiro-ide', state: 'configured', managed: true }),
    binding({ client: 'kiro-cli', state: 'configured', managed: true }),
  ]} projectId={harnessProject.id} policy={policy()} runtime={runtime()} demo={false} blocked={false}
    busy={false} onPreview={noAction} />);
  for (const client of ['Codex', 'Claude Code', 'Kiro IDE', 'Kiro CLI']) expect(html).toContain(client);
  expect(html).toContain('Observed native event');
  expect(html).toContain('Not observed');
  expect(html).toContain('share one .kiro hook configuration');
  expect(html).toContain('Complete Codex native hook trust review in Codex itself');
  expect(control(html, 'Preview Codex removal')).toContain('disabled=""');
  expect(control(html, 'Preview Kiro IDE removal')).not.toContain('disabled=""');
});

test('global and demo scopes disable native hook mutations with an explanation', () => {
  for (const demo of [true, false]) {
    const html = render(<HarnessHooks bindings={[binding({ managed: true })]} policy={policy()}
      runtime={runtime()} demo={demo} blocked={false} busy={false} onPreview={noAction} />);
    expect(control(html, 'Preview Codex install')).toContain('disabled=""');
    expect(control(html, 'Preview Codex removal')).toContain('disabled=""');
    expect(html).toContain('Select a project before changing native hooks');
  }
});

test('an expired Kiro preview retains redacted files and offers a new preview rather than a replay', () => {
  const html = render(<HarnessHookPreviewView state={{
    request: { projectId: harnessProject.id, client: 'kiro-ide', action: 'install', policyId: 'policy', revision: 'rev-1' },
    preview: hookPreview({ client: 'kiro-ide', expiresAt: '2020-01-01T00:00:00Z' }),
    busy: null, error: null, needsPreview: false, applied: null,
  }} now={Date.parse('2026-09-26')} changed={false} demo={false} onNewPreview={noAction} onApply={noAction} />);
  expect(html).toContain('[REDACTED]');
  expect(html).toContain('Before');
  expect(html).toContain('After');
  expect(html).toContain('affect both clients');
  expect(control(html, 'Apply')).toContain('disabled=""');
  expect(control(html, 'New preview')).not.toContain('disabled=""');
});

test('audit totals are retained-window totals with shared Kiro provenance, diagnostics and no raw payload fields', () => {
  const record = Object.assign(auditRecord(), { toolInput: 'DO_NOT_RENDER_INPUT', toolOutput: 'DO_NOT_RENDER_OUTPUT' });
  const html = render(<HarnessAuditView page={auditPage({ items: [record], storage: storage({ truncated: true, invalidLines: 3 }) })}
    query={{ offset: 0, limit: 20 }} loading={false} error={null} onFilters={noAction} onPage={noAction} onReload={noAction} />);
  expect(html).toContain('32 matching records in the retained cache');
  expect(html).toContain('Kiro shared');
  expect(html).toContain('원문 사유 &lt;script&gt;');
  expect(html).toContain('Invalid lines');
  expect(html).toContain('was truncated');
  expect(html).toContain('Bytes read');
  expect(html).toContain('session-synthetic');
  expect(html).not.toContain('DO_NOT_RENDER');
  expect(control(html, 'Previous page')).toContain('disabled=""');
  expect(control(html, 'Next page')).not.toContain('disabled=""');
});

test('an audit request failure retains existing records and a local retry while stale pagination is disabled', () => {
  const html = render(<HarnessAuditView page={auditPage()} query={{ offset: 0, limit: 20 }} loading
    error={{ message: 'Failed to read harness catalog.', status: 500, unknown: false }}
    onFilters={noAction} onPage={noAction} onReload={noAction} />);
  expect(html).toContain('role="alert"');
  expect(html).toContain('원문 사유');
  expect(control(html, 'Next page')).toContain('disabled=""');
});
