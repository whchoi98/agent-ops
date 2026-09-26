import { useId, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import {
  HARNESS_CLIENTS, type HarnessClient, type HarnessDecision, type HarnessPolicyDetail, type HarnessRuntime,
} from '../../../shared/harness';
import { Button, Field, InlineNotice, Panel } from '../../components/ui';
import { useFormat } from '../../i18n/useFormat';
import { harnessApi } from './api';
import { useHarnessI18n } from './i18n';
import { CLIENT_LABELS, DEMO_NOTICE, HARNESS_TEXT_LIMIT, parseToolInput, RISK_LABELS, runtimeState, TOOL_NAME_LIMIT } from './model';
import { HarnessActionBadge, HarnessError } from './ui';
import { useHarnessAction } from './useHarness';

export function HarnessDecisionView({ decision }: { decision: HarnessDecision }) {
  const { t } = useHarnessI18n();
  const { dateTime, number } = useFormat();
  return <section className="harness-decision harness-stack" aria-label={t('판정 결과')} aria-live="polite">
    <div className="harness-section-heading"><h3>{t('판정 결과')}</h3><HarnessActionBadge action={decision.action} /></div>
    <p className="harness-hint">{t('이 결과는 판정 테스트입니다. 입력한 도구나 명령을 실행하지 않았습니다.')}</p>
    <div className="harness-actions"><span className="tag">{t('도구 실행 없음')}</span>
      <strong>{t('위험도')}: {decision.risk ? t(RISK_LABELS[decision.risk]) : t('위험도 미기록')}</strong></div>
    <div><h4>{t('판정 이유')}</h4><p translate="no">{decision.reason}</p></div>
    <dl className="harness-properties">
      <div><dt>{t('판정 클라이언트')}</dt><dd>{t(CLIENT_LABELS[decision.client])}</dd></div>
      <div><dt>{t('도구 이름')}</dt><dd><code translate="no">{decision.toolName}</code></dd></div>
      <div><dt>{t('정책 개정')}</dt><dd><code translate="no">{decision.policyRevision}</code></dd></div>
      <div><dt>{t('관측한 엔진 버전')}</dt><dd><code>{decision.engineVersion}</code></dd></div>
      <div><dt>{t('판정 시각')}</dt><dd><time dateTime={decision.checkedAt}>{dateTime(decision.checkedAt)}</time></dd></div>
      <div><dt>{t('판정 소요 시간')}</dt><dd>{number(decision.durationMs)} ms</dd></div>
    </dl>
    {!!decision.matchedRules.length && <div><h4>{t('일치한 규칙')}</h4><ul className="harness-literal-list">
      {decision.matchedRules.map((rule, index) => <li key={index}><code translate="no">{rule}</code></li>)}
    </ul></div>}
  </section>;
}

export function HarnessEvaluation({ policy, runtime, projectId, demo, demoNoticeId, blocked, onEvaluated }: {
  policy: HarnessPolicyDetail | null; runtime: HarnessRuntime | null; projectId?: string;
  demo: boolean; demoNoticeId?: string; blocked: boolean; onEvaluated: () => void;
}) {
  const { t } = useHarnessI18n();
  const id = useId();
  const [client, setClient] = useState<HarnessClient>('codex');
  const [toolName, setToolName] = useState('');
  const [input, setInput] = useState('{}');
  const key = JSON.stringify([projectId, policy?.id, policy?.revision, client, toolName, input]);
  const action = useHarnessAction(key);
  const [result, setResult] = useState<{ key: string; decision: HarnessDecision } | null>(null);
  let toolInput: Record<string, unknown> | null = null;
  let inputError: string | null = null;
  try { toolInput = parseToolInput(input); } catch (cause) { inputError = (cause as Error).message; }
  const unavailable = demo ? DEMO_NOTICE : blocked ? '초안 변경 내용을 먼저 저장하고 현재 정책 개정을 확인하세요.'
    : !policy ? '판정할 저장된 정책을 먼저 선택하세요.'
      : !policy.valid ? '선택한 정책의 구조를 먼저 확인하세요.'
        : !runtime || runtimeState(runtime) !== 'ready' ? '엔진을 확인해 준비 상태로 만든 뒤 판정 테스트를 진행하세요.' : null;
  const disabled = !!unavailable || !toolName.trim() || !!inputError || action.busy;
  async function evaluate() {
    if (disabled || !policy || !toolInput) return;
    setResult(null);
    const decision = await action.run(signal => harnessApi.evaluate({
      projectId, policyId: policy.id, revision: policy.revision, client, toolName: toolName.trim(), toolInput,
    }, signal));
    if (decision) { setResult({ key, decision }); onEvaluated(); }
  }
  return <Panel title={t('판정 테스트')}
    description={t('저장된 정책과 실제 AutoHarness 엔진으로 도구 입력을 판정합니다. 입력한 명령은 실행하지 않습니다.')}>
    <div className="harness-panel-body harness-stack">
      {policy && <p className="harness-hint"><span translate="no">{policy.name}</span>{' · '}<code translate="no">{policy.revision}</code></p>}
      <form className="harness-stack" onSubmit={event => { event.preventDefault(); void evaluate(); }}>
        <div className="harness-form-grid">
          <Field label={t('판정 클라이언트')} htmlFor={`${id}-client`}>
            <select id={`${id}-client`} value={client} disabled={action.busy} onChange={event => setClient(event.target.value as HarnessClient)}>
              {HARNESS_CLIENTS.map(client => <option key={client} value={client}>{t(CLIENT_LABELS[client])}</option>)}
            </select>
          </Field>
          <Field label={t('도구 이름')} htmlFor={`${id}-tool`}>
            <input id={`${id}-tool`} value={toolName} required maxLength={TOOL_NAME_LIMIT} autoComplete="off" spellCheck={false}
              placeholder="Bash / shell / execute_bash" disabled={action.busy} onChange={event => setToolName(event.target.value)} />
          </Field>
        </div>
        <Field label={t('도구 입력(JSON)')} htmlFor={`${id}-input`} hint={t('입력은 최대 64 KiB의 JSON 객체여야 합니다.')}>
          <textarea id={`${id}-input`} className="harness-json-input" rows={6} spellCheck={false} translate="no"
            maxLength={HARNESS_TEXT_LIMIT} value={input} disabled={action.busy} aria-invalid={!!inputError}
            aria-describedby={inputError ? `${id}-input-error` : undefined} onChange={event => setInput(event.target.value)} />
        </Field>
        {inputError && <p className="harness-input-error" role="alert" id={`${id}-input-error`}>{t(inputError)}</p>}
        {unavailable && (!demo || !demoNoticeId) && <InlineNotice>{t(unavailable)}</InlineNotice>}
        <div className="harness-actions"><Button type="submit" variant="primary" icon={ShieldCheck} busy={action.busy} disabled={disabled}
          aria-describedby={demo ? demoNoticeId : undefined}>
          {t('판정 테스트')}
        </Button></div>
      </form>
      {action.error && <div className="harness-stack" aria-live="polite">
        <h3>{t('판정 오류 또는 결과 미확인')}</h3>
        <HarnessError problem={action.error} onRetry={() => void evaluate()} busy={disabled} retryLabel={t('판정 테스트')} />
      </div>}
      {result?.key === key && <HarnessDecisionView decision={result.decision} />}
    </div>
  </Panel>;
}
