import { FileDown, Play, RefreshCw } from 'lucide-react';
import type { ContextPackCompilation, ContextPackExportFormat } from '../../../shared/context-packs';
import { Button, CopyButton, Field, InlineNotice } from '../../components/ui';
import { useContextPackI18n } from './i18n';

export function ContextPackOutput({ compilation, busy, dirty, onCompile, onPrepareRun, onExport }: {
  compilation: ContextPackCompilation | null; busy: boolean; dirty: boolean;
  onCompile: () => void; onPrepareRun: () => void; onExport: (format: ContextPackExportFormat) => void;
}) {
  const { t } = useContextPackI18n();
  const current = !dirty && !busy ? compilation : null;
  return <section className="context-pack-output form-stack">
    <h3>{t('조합한 컨텍스트')}</h3>
    <p>{t('저장한 인용과 메모를 로컬에서 조합합니다. 내보낼 때 공통 자격증명 패턴을 마스킹합니다.')}</p>
    {dirty && <InlineNotice tone="warning">{t('수정한 내용을 먼저 저장하세요.')}</InlineNotice>}
    <div className="context-pack-actions">
      <Button icon={RefreshCw} disabled={busy || dirty} onClick={onCompile}>{t('컨텍스트 조합')}</Button>
      <Button icon={FileDown} disabled={busy || dirty} onClick={() => onExport('md')}>Markdown</Button>
      <Button icon={FileDown} disabled={busy || dirty} onClick={() => onExport('json')}>JSON</Button>
      <Button variant="primary" icon={Play} disabled={!current} onClick={onPrepareRun}>{t('실행 준비')}</Button>
    </div>
    {current && <>
      <div className="context-pack-actions">
        <CopyButton text={current.prompt} label={t('조합한 컨텍스트 복사')} />
        <span>{t('{count}자 (토큰 수가 아님)', { count: current.characters.toLocaleString() })}</span>
      </div>
      {current.redacted && <InlineNotice>{t('공통 자격증명 패턴을 마스킹했습니다.')}</InlineNotice>}
      <Field label={t('조합한 컨텍스트')} htmlFor={`compiled-${current.packId}`}>
        <textarea id={`compiled-${current.packId}`} readOnly rows={12} value={current.prompt} className="prompt-textarea" />
      </Field>
    </>}
    <p className="field-hint">{t('실행은 다음 화면에서 프롬프트와 명령을 확인한 뒤 시작합니다.')}</p>
  </section>;
}
