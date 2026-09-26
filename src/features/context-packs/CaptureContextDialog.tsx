import { useEffect, useId, useRef, useState } from 'react';
import { Plus, Save } from 'lucide-react';
import { CONTEXT_PACK_LIMITS as limits, type ContextPack } from '../../../shared/context-packs';
import { Dialog } from '../../components/Dialog';
import { Button, Field, InlineNotice } from '../../components/ui';
import { useResource } from '../../hooks/useResource';
import { errorMessage } from '../../lib/format';
import { contextPacksApi } from './api';
import { captureInput } from './model';
import { useContextPackI18n } from './i18n';
import { ContextPackPicker } from './ContextPackPicker';

export interface CaptureContextDialogProps {
  sessionId: string;
  messageId: string;
  onClose: () => void;
  onCaptured?: (pack: ContextPack) => void;
  /** Range from the reader, in UTF-16 units. Missing length requires user input. */
  offset?: number;
  length?: number;
  /** Display only, from the reader's existing selection. Never sent to the API. */
  previewText?: string;
  initialPackId?: string;
  /** Default project for a newly created pack, not a restriction on capture targets. */
  projectId?: string;
}

export function CaptureContextFields({
  sessionId, messageId, offset, length, onOffset, onLength, previewText, disabled = false,
}: {
  sessionId: string; messageId: string; offset: string; length: string;
  onOffset: (value: string) => void; onLength: (value: string) => void;
  previewText?: string; disabled?: boolean;
}) {
  const { t } = useContextPackI18n();
  const id = useId();
  let preview = previewText?.slice(0, limits.itemChars);
  if (preview && /[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
  return <div className="form-stack">
    <p>{t('로컬 메시지에서 지정한 범위를 가져옵니다. 미리보기 본문은 서버로 보내지 않습니다.')}</p>
    <dl className="context-pack-source-ids">
      <dt>{t('원본 세션')}</dt><dd>{sessionId}</dd>
      <dt>{t('원본 메시지')}</dt><dd>{messageId}</dd>
    </dl>
    <div className="form-grid">
      <Field label={t('시작 위치 (0부터)')} htmlFor={`${id}-offset`}>
        <input id={`${id}-offset`} type="number" min={0} step={1} required disabled={disabled}
          value={offset} onChange={event => onOffset(event.target.value)} />
      </Field>
      <Field label={t('가져올 문자 수')} htmlFor={`${id}-length`}>
        <input id={`${id}-length`} type="number" min={1} max={limits.itemChars} step={1} required disabled={disabled}
          value={length} onChange={event => onLength(event.target.value)} />
      </Field>
    </div>
    <p className="field-hint">{t('문자 위치는 브라우저의 UTF-16 기준입니다. 이모지를 나누는 범위는 저장할 수 없습니다.')}</p>
    {preview !== undefined ? <Field label={t('선택한 인용 미리보기')} htmlFor={`${id}-preview`}>
      <textarea id={`${id}-preview`} rows={5} readOnly value={preview} />
      {previewText !== preview && <p className="field-hint">{t('미리보기는 최대 8,000자입니다. 저장할 문자 범위를 확인하세요.')}</p>}
    </Field> : <p className="field-hint">{t('범위를 변경했습니다. 저장할 때 서버에서 해당 범위를 가져옵니다.')}</p>}
  </div>;
}

export function CaptureContextDialog({
  sessionId, messageId, onClose, onCaptured, offset: initialOffset = 0, length: initialLength,
  previewText, initialPackId, projectId,
}: CaptureContextDialogProps) {
  const { t, notice } = useContextPackI18n();
  const formId = useId();
  const [offset, setOffset] = useState(String(initialOffset));
  const [length, setLength] = useState(initialLength === undefined ? '' : String(initialLength));
  const [selectedIds, setSelectedIds] = useState(initialPackId ? [initialPackId] : []);
  const [name, setName] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState<'capture' | 'create' | null>(null);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const selectedId = selectedIds[0];
  // Freeze the target version for this selection. Unlike the picker summaries,
  // this key must not include productivityRevision or silently retry a 409.
  const target = useResource<ContextPack | null>(
    signal => selectedId ? contextPacksApi.get(selectedId, signal) : Promise.resolve(null), selectedId ?? '',
  );
  const pack = target.data?.id === selectedId ? target.data : null;
  useEffect(() => () => { pending.current?.abort(); }, []);
  const initialRange = Number(offset) === initialOffset && Number(length) === initialLength;
  const validRange = offset !== '' && length !== '' && Number.isSafeInteger(Number(offset)) && Number(offset) >= 0
    && Number.isSafeInteger(Number(length)) && Number(length) > 0 && Number(length) <= limits.itemChars
    && Number.isSafeInteger(Number(offset) + Number(length));
  const canCapture = !busy && !target.loading && !target.error && pack && validRange
    && pack.itemCount < limits.items && pack.totalChars + Number(length) <= limits.totalChars;

  async function create() {
    if (pending.current || !name.trim()) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy('create'); setError('');
    try {
      const created = await contextPacksApi.create({ name, projectId: projectId ?? null }, controller.signal);
      if (controller.signal.aborted) return;
      setSelectedIds([created.id]); setName(''); setRefreshKey(value => value + 1);
      target.replaceData(created);
    } catch (cause) { if (!controller.signal.aborted) setError(errorMessage(cause)); }
    finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  async function capture() {
    if (pending.current || !canCapture || !pack) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy('capture'); setError('');
    try {
      const result = await contextPacksApi.addItem(pack.id,
        captureInput(pack.version, { sessionId, messageId }, Number(offset), Number(length)), controller.signal);
      if (controller.signal.aborted) return;
      onCaptured?.(result);
      onClose();
    } catch (cause) { if (!controller.signal.aborted) setError(errorMessage(cause)); }
    finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  function reload() { setError(''); target.reload(); setRefreshKey(value => value + 1); }
  return <Dialog title={t('컨텍스트 묶음에 추가')} description={t('서버에서 메시지를 가져온 뒤 원본이 바뀌어도 인용은 유지됩니다.')}
    size="large" onClose={onClose} footer={<>
      <Button onClick={onClose} disabled={Boolean(busy)}>{t('취소')}</Button>
      <Button form={formId} type="submit" variant="primary" icon={Save} busy={busy === 'capture'}
        disabled={!canCapture}>{t('인용 저장')}</Button>
    </>}>
    <div className="form-stack">
      <ContextPackPicker selectedIds={selectedIds} onChange={ids => { setSelectedIds(ids); setError(''); }}
        maxSelected={1} disabled={Boolean(busy)} refreshKey={refreshKey} />
      <div className="context-pack-create-target">
        <Field label={t('새 묶음 이름')} htmlFor={`${formId}-name`}>
          <input id={`${formId}-name`} maxLength={limits.nameChars} value={name} disabled={Boolean(busy)}
            onChange={event => setName(event.target.value)} />
        </Field>
        <Button icon={Plus} onClick={() => void create()} busy={busy === 'create'} disabled={Boolean(busy) || !name.trim()}>
          {t('새 묶음을 만들고 선택')}
        </Button>
      </div>
      {selectedId && target.loading && <p role="status">{t('선택한 묶음 불러오는 중')}</p>}
      {pack && <p>{t('{count}개 항목 / 20개, {chars}자 / 48,000자', {
        count: pack.itemCount, chars: pack.totalChars.toLocaleString(),
      })}</p>}
      <form id={formId} className="form-stack" onSubmit={event => { event.preventDefault(); void capture(); }}>
        <CaptureContextFields sessionId={sessionId} messageId={messageId} offset={offset} length={length}
          onOffset={setOffset} onLength={setLength} disabled={Boolean(busy)} previewText={initialRange ? previewText : undefined} />
      </form>
      <p className="field-hint">{t('최대 20개 항목, 항목당 8,000자, 본문 합계 48,000자입니다.')}</p>
      {(error || target.error) && <InlineNotice tone="error">
        {notice(error || target.error!)}
        <Button size="small" disabled={Boolean(busy)} onClick={reload}>{t('최신 내용 다시 불러오기')}</Button>
      </InlineNotice>}
    </div>
  </Dialog>;
}
