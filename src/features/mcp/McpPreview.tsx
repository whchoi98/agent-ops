import { useId } from 'react';
import { Eye, Play } from 'lucide-react';
import type { McpCheckPreview, McpCheckSummary, McpDetail } from '../../../shared/mcp';
import { Button, InlineNotice } from '../../components/ui';
import { useFormat } from '../../i18n/useFormat';
import { McpConfigurationView, McpFindings } from './McpConfigurationView';
import { useMcpI18n } from './i18n';
import { checkBlockReason, previewBlockReason, type McpAction } from './model';

export function McpPreviewView({ preview }: { preview: McpCheckPreview }) {
  const { t, notice } = useMcpI18n();
  const { dateTime, duration } = useFormat();
  return <section className="mcp-preview" aria-label={t('점검 미리보기')}>
    <h3>{t('점검 미리보기')}</h3>
    <p className="mcp-hint">{t('미리보기만 준비했습니다. 아래 내용을 검토하고 직접 점검을 시작하세요.')}</p>
    <InlineNotice tone={preview.startsProcess ? 'warning' : 'info'}>
      {t(preview.startsProcess
        ? '이 점검은 설정된 프로세스를 시작합니다. 시작 과정에서 부수 효과가 생길 수 있습니다.'
        : '이 점검은 설정된 엔드포인트에 접속하고 설정된 헤더를 전송합니다.')}
    </InlineNotice>
    <p>{t('초기화와 메타데이터 목록만 요청합니다. 도구 호출, 리소스 본문 읽기, 프롬프트 실행, 모델 추론은 요청하지 않습니다.')}</p>
    <p className="mcp-hint">{t('어시스턴트의 OAuth 세션, 실행 옵션, 활성 프로필과 관리 정책을 재현하지 않습니다.')}</p>
    <dl className="mcp-properties">
      <div><dt>{t('요청할 메서드')}</dt><dd><ul className="mcp-name-list">{preview.methods.map(method =>
        <li key={method}><code>{method}</code></li>)}</ul></dd></div>
      <div><dt>{t('최대 점검 시간')}</dt><dd>{duration(preview.timeoutMs)}</dd></div>
      <div><dt>{t('미리보기 만료')}</dt><dd><time dateTime={preview.expiresAt}>{dateTime(preview.expiresAt, {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      })}</time></dd></div>
    </dl>
    {preview.blockedReasons.length > 0 && <section><h4>{t('차단 사유')}</h4><McpFindings findings={preview.blockedReasons} /></section>}
    {preview.notices.length > 0 && <ul className="mcp-notices">{preview.notices.map((message, index) => <li key={index}>{notice(message)}</li>)}</ul>}
    <McpConfigurationView configuration={preview.configuration} />
  </section>;
}

export interface McpPreviewActionsProps {
  detail: McpDetail | null; preview: McpCheckPreview | null; projectId: string | undefined;
  demo: boolean; activeCheck: McpCheckSummary | null; busy: McpAction | null; visible: boolean;
  now: number; onPreview: () => void; onCheck: () => void;
}

export function McpPreviewActions({ detail, preview, projectId, demo, activeCheck, busy, visible, now, onPreview, onCheck }: McpPreviewActionsProps) {
  const { t } = useMcpI18n();
  const hintId = useId();
  const blocked = checkBlockReason(detail, demo, activeCheck);
  const previewBlocked = preview ? previewBlockReason(preview, detail?.id ?? '', projectId, now) : null;
  const disabled = Boolean(blocked || busy || !visible);
  return <div className="mcp-preview-actions">
    <p id={hintId} className="mcp-hint" role={previewBlocked ? 'status' : undefined}>
      {t(blocked ?? previewBlocked ?? (busy === 'check' ? '워크벤치 점검 시작을 요청하고 있습니다…' : preview
        ? '미리보기만 준비했습니다. 아래 내용을 검토하고 직접 점검을 시작하세요.' : '점검은 미리보기를 검토한 뒤 직접 시작합니다.'))}
    </p>
    <div>
      <Button icon={Eye} disabled={disabled} busy={busy === 'preview'} onClick={onPreview} aria-describedby={hintId}>
        {t(preview ? '새 미리보기' : '점검 미리보기')}
      </Button>
      {(preview || busy === 'check') && <Button variant="primary" icon={Play} busy={busy === 'check'}
        disabled={disabled || !preview || Boolean(previewBlocked)} onClick={onCheck} aria-describedby={hintId}>{t('워크벤치 점검 시작')}</Button>}
    </div>
  </div>;
}
