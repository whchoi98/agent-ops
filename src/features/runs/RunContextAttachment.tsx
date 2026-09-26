import { useEffect, useId, useRef, useState } from 'react';
import { Button, InlineNotice } from '../../components/ui';
import { errorMessage } from '../../lib/format';
import { ContextPackPicker } from '../context-packs';
import { compileRunContext, runContextInputSignature, type RunContextApplication, type RunContextInput } from './RunContextCompile';
import { RunContextRequestGate, type RunContextRequest } from './RunContextRequests';
import { useRunContextI18n } from './RunContextI18n';
import './RunContext.css';

export interface RunContextAttachmentProps {
  value: RunContextInput;
  onSelect: (ids: string[]) => void;
  onApply: (application: RunContextApplication, input: RunContextInput) => void;
  projectId?: string;
  disabled?: boolean;
  refreshKey?: number;
  gate?: RunContextRequestGate;
  onBusyChange?: (busy: boolean) => void;
}

export function RunContextActions({
  selectedCount, pendingCount, busy, disabled, error, cancelled, onCompile, onCancel,
}: {
  selectedCount: number; pendingCount: number; busy: boolean; disabled?: boolean;
  error?: string; cancelled?: boolean; onCompile: () => void; onCancel: () => void;
}) {
  const { t, notice } = useRunContextI18n();
  return <div className="form-stack">
    <p className="field-hint" role="status">{t('{count}개 연결 · {pending}개 추가 대기', { count: selectedCount, pending: pendingCount })}</p>
    <div className="run-context-actions">
      <Button busy={busy} disabled={disabled || pendingCount === 0} onClick={onCompile}>{t('선택한 컨텍스트 추가')}</Button>
      {busy && <Button onClick={onCancel}>{t('조합 취소')}</Button>}
    </div>
    {busy && <p role="status" className="field-hint">{t('컨텍스트 조합 중…')}</p>}
    {cancelled && <InlineNotice>{t('취소했습니다. 프롬프트와 선택한 연결은 그대로 유지됩니다.')}</InlineNotice>}
    {error && <InlineNotice tone="error">{notice(error)}</InlineNotice>}
    {!!pendingCount && !busy && <p className="field-hint">{t('선택한 컨텍스트를 추가한 뒤 명령을 미리 보세요.')}</p>}
    <p className="field-hint">{t('연결을 제거해도 프롬프트 본문은 지우지 않습니다. 필요한 내용은 직접 편집하세요.')}</p>
    <p className="field-hint">{t('이미 추가한 묶음은 다시 선택해도 본문을 중복해서 추가하지 않습니다.')}</p>
  </div>;
}

export function RunContextAttachment({
  value, onSelect, onApply, projectId, disabled, refreshKey, gate: sharedGate, onBusyChange,
}: RunContextAttachmentProps) {
  const { t } = useRunContextI18n();
  const id = useId();
  const [ownGate] = useState(() => new RunContextRequestGate());
  const gate = sharedGate ?? ownGate;
  const [open, setOpen] = useState(value.selectedIds.length > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const mounted = useRef(true);
  const active = useRef<{ operation: RunContextRequest; signature: string } | null>(null);
  const latest = useRef({ value, disabled, onSelect, onApply, onBusyChange });
  latest.current = { value, disabled, onSelect, onApply, onBusyChange };
  const signature = runContextInputSignature(value);
  const pendingCount = value.selectedIds.filter(packId => !value.appliedIds.includes(packId)).length;

  useEffect(() => {
    mounted.current = true;
    if (!sharedGate) gate.activate();
    return () => {
      mounted.current = false;
      if (active.current?.operation.cancel()) latest.current.onBusyChange?.(false);
      active.current = null;
      if (!sharedGate) gate.dispose();
    };
  }, [gate, sharedGate]);
  useEffect(() => {
    const current = active.current;
    if (current && current.signature !== signature && current.operation.cancel()) {
      active.current = null;
      setBusy(false);
      setError('초안이 변경되었습니다. 현재 내용을 유지한 채 컨텍스트를 다시 조합하세요.');
      latest.current.onBusyChange?.(false);
    }
  }, [signature]);

  async function compile() {
    const current = latest.current;
    if (current.disabled || active.current || !current.value.selectedIds.some(packId => !current.value.appliedIds.includes(packId))) return;
    const operation = gate.start();
    if (!operation) return;
    const input: RunContextInput = {
      prompt: current.value.prompt, selectedIds: [...current.value.selectedIds], appliedIds: [...current.value.appliedIds],
    };
    const startedSignature = runContextInputSignature(input);
    active.current = { operation, signature: startedSignature };
    setBusy(true); setError(''); setCancelled(false);
    current.onBusyChange?.(true);
    try {
      const application = await compileRunContext(input, operation.signal);
      if (!mounted.current || !operation.current()) return;
      if (runContextInputSignature(latest.current.value) !== startedSignature) {
        throw new Error('초안이 변경되었습니다. 현재 내용을 유지한 채 컨텍스트를 다시 조합하세요.');
      }
      latest.current.onApply(application, input);
    } catch (cause) {
      if (mounted.current && operation.current()) setError(errorMessage(cause));
    } finally {
      if (operation.finish()) {
        active.current = null;
        if (mounted.current) { setBusy(false); latest.current.onBusyChange?.(false); }
      }
    }
  }
  function cancel() {
    if (!active.current?.operation.cancel()) return;
    active.current = null;
    setBusy(false); setCancelled(true);
    latest.current.onBusyChange?.(false);
  }

  return <section className="run-context-attachment form-stack">
    <div><Button size="small" aria-expanded={open} aria-controls={id} disabled={busy}
      onClick={() => setOpen(previous => !previous)}>{t('컨텍스트 연결')}</Button></div>
    {open && <div id={id} className="form-stack">
      <ContextPackPicker selectedIds={[...value.selectedIds]} projectId={projectId} maxSelected={5}
        disabled={disabled || busy} refreshKey={refreshKey} onChange={ids => {
          if (latest.current.disabled || active.current) return;
          try { latest.current.onSelect(ids); setError(''); setCancelled(false); }
          catch (cause) { setError(errorMessage(cause)); }
        }} />
      <RunContextActions selectedCount={value.selectedIds.length} pendingCount={pendingCount} busy={busy}
        disabled={disabled} error={error} cancelled={cancelled} onCompile={() => { void compile(); }} onCancel={cancel} />
    </div>}
    {!open && !!pendingCount && <p className="field-hint">{t('선택한 컨텍스트를 추가한 뒤 명령을 미리 보세요.')}</p>}
  </section>;
}
