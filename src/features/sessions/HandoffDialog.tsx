import { useI18n, Trans, AppNotice } from '../../i18n/I18nProvider';
import { useState, type FormEvent } from 'react';
import { ArrowRight, ArrowRightLeft } from 'lucide-react';
import { AGENTS, type Agent, type SessionDetail } from '../../../shared/types';
import { Dialog } from '../../components/Dialog';
import { AgentBadge, Button, Field, InlineNotice, ProviderMark } from '../../components/ui';
import { api } from '../../lib/api';
import { AGENT_META, errorMessage } from '../../lib/format';
import { useApp, useData } from '../../state/AppProvider';

export function HandoffDialog({ session, onClose }: { session: SessionDetail; onClose: () => void }) {
  const { t } = useI18n();
  const data = useData();
  const { openNewRun } = useApp();
  const [target, setTarget] = useState<Agent>(AGENTS.find(agent => agent !== session.agent)!);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function prepare(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const handoff = await api.handoff({ sessionId: session.id, targetAgent: target, instruction: instruction.trim() || undefined });
      openNewRun({
        agent: handoff.targetAgent, prompt: handoff.prompt, sourceSessionId: handoff.sourceSessionId,
        projectId: data.projects.find(project => project.path === session.projectPath)?.id,
        title: `${handoff.sessionTitle.slice(0, 180)} · ${AGENT_META[target].short} 전달`, policy: 'read-only',
      });
    } catch (cause) { setError(errorMessage(cause)); setBusy(false); }
  }
  return <Dialog title={t("다른 에이전트에 전달")} description={t("대화의 맥락을 새 프롬프트로 준비합니다.")} size="medium" onClose={onClose}
    footer={<><Button onClick={onClose} disabled={busy}><Trans message={"닫기"} /></Button><Button type="submit" form="handoff-form" icon={ArrowRightLeft} variant="primary" busy={busy}><Trans message={"전달 프롬프트 준비"} /></Button></>}>
    <form id="handoff-form" onSubmit={prepare} className="form-stack">
      <div className="handoff-source"><AgentBadge agent={session.agent} /><ArrowRight size={16} aria-hidden /><AgentBadge agent={target} /><p>{session.title}</p></div>
      <fieldset className="field"><legend><Trans message={"전달받을 에이전트"} /></legend><div className="agent-picker">
        {AGENTS.filter(agent => agent !== session.agent).map(agent => <button type="button" key={agent} aria-pressed={target === agent}
          className={`agent-option ${target === agent ? 'selected' : ''}`} onClick={() => setTarget(agent)}>
          <ProviderMark agent={agent} /><span>{AGENT_META[agent].name}</span></button>)}
      </div></fieldset>
      <Field label={t("추가 지시사항 (선택)")} htmlFor="handoff-instruction"><textarea id="handoff-instruction" rows={4} maxLength={8000} value={instruction}
        onChange={event => setInstruction(event.target.value)} placeholder={t("전달받은 에이전트가 집중할 내용이나 다음 작업을 적어주세요.")} /></Field>
      <InlineNotice><Trans message={"준비된 프롬프트를 다음 화면에서 수정할 수 있습니다. 명령을 미리 보고 실행을 눌러야 작업이 시작됩니다."} /></InlineNotice>
      {error && <InlineNotice tone="error"><AppNotice message={error} /></InlineNotice>}
    </form>
  </Dialog>;
}
