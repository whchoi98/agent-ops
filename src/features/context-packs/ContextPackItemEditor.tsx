import { ArrowDown, ArrowUp, ExternalLink, Save, Trash2 } from 'lucide-react';
import type { ContextPackItem } from '../../../shared/context-packs';
import { CONTEXT_PACK_LIMITS as limits } from '../../../shared/context-packs';
import { AgentBadge, Button, Field, InlineNotice } from '../../components/ui';
import { useFormat } from '../../i18n/useFormat';
import { useContextPackI18n } from './i18n';

export interface ContextPackItemDraft { title: string; text: string }
export function ContextPackItemEditor({
  item, draft, index, total, disabled = false, onChange, onSave, onRemove, onMove, onOpenSource,
}: {
  item: ContextPackItem; draft: ContextPackItemDraft; index: number; total: number; disabled?: boolean;
  onChange: (draft: ContextPackItemDraft) => void; onSave: () => void; onRemove: () => void;
  onMove: (direction: -1 | 1) => void; onOpenSource: (sessionId: string) => void;
}) {
  const { t } = useContextPackI18n();
  const { dateTime } = useFormat();
  const dirty = draft.title !== item.title || (item.kind === 'note' && draft.text !== item.text);
  return <article className="context-pack-item">
    <div className="context-pack-item-heading">
      <h3>{index + 1}. {item.kind === 'message' ? t('수집한 메시지') : t('사용자 메모')}</h3>
      <div className="context-pack-actions">
        <Button size="small" aria-label={t('{name} 위로 이동', { name: item.title })} icon={ArrowUp}
          disabled={disabled || index === 0} onClick={() => onMove(-1)} />
        <Button size="small" aria-label={t('{name} 아래로 이동', { name: item.title })} icon={ArrowDown}
          disabled={disabled || index === total - 1} onClick={() => onMove(1)} />
        <Button size="small" icon={Trash2} disabled={disabled} onClick={onRemove}>{t('항목 제거')}</Button>
      </div>
    </div>
    <form className="form-stack" onSubmit={event => { event.preventDefault(); if (!disabled && dirty) onSave(); }}>
      <Field label={t('항목 이름')} htmlFor={`label-${item.id}`}>
        <input id={`label-${item.id}`} maxLength={limits.nameChars} required disabled={disabled}
          value={draft.title} onChange={event => onChange({ ...draft, title: event.target.value })} />
      </Field>
      {item.kind === 'message' ? <>
        <div className="context-pack-provenance">
          <AgentBadge agent={item.source.agent} compact />
          <dl>
            <dt>{t('원본 제목')}</dt><dd>{item.source.sessionTitle}</dd>
            <dt>{t('원본 세션')}</dt><dd>{item.source.sessionId}</dd>
            <dt>{t('원본 메시지')}</dt><dd>{item.source.messageId}</dd>
            <dt>{t('수집 시각')}</dt><dd><time dateTime={item.source.capturedAt}>{dateTime(item.source.capturedAt)}</time></dd>
          </dl>
          <p className="field-hint">{t('문자 범위: {offset}부터 {length}자', { offset: item.source.offset, length: item.source.length })}</p>
          <InlineNotice tone={item.sourceAvailable ? 'info' : 'warning'}>
            <strong>{item.sourceAvailable ? t('원본 사용 가능') : t('원본 사용 불가')}</strong>{' '}
            {item.sourceAvailable ? t('수집 뒤 원본이 바뀌었을 수 있습니다.') : t('저장한 인용은 그대로 유지됩니다.')}
          </InlineNotice>
          <Button size="small" icon={ExternalLink} disabled={disabled || !item.sourceAvailable}
            onClick={() => onOpenSource(item.source.sessionId)}>{t('원본 세션 열기')}</Button>
        </div>
        <Field label={t('저장한 인용 (읽기 전용)')} htmlFor={`body-${item.id}`}>
          <textarea id={`body-${item.id}`} rows={5} readOnly value={item.text} />
        </Field>
      </> : <Field label={t('메모 내용')} htmlFor={`body-${item.id}`}>
        <textarea id={`body-${item.id}`} rows={5} maxLength={limits.itemChars} required disabled={disabled}
          value={draft.text} onChange={event => onChange({ ...draft, text: event.target.value })} />
      </Field>}
      <div><Button type="submit" size="small" icon={Save} disabled={disabled || !dirty || !draft.title.trim()
        || (item.kind === 'note' && !draft.text)}>
        {item.kind === 'message' ? t('이름 저장') : t('메모 저장')}
      </Button></div>
    </form>
  </article>;
}
