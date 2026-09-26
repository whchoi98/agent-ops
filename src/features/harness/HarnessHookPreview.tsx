import { Check, Eye } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { Button, InlineNotice, Skeleton } from '../../components/ui';
import { useNow } from '../../hooks/useResource';
import { useFormat } from '../../i18n/useFormat';
import { useHarnessI18n } from './i18n';
import { CLIENT_LABELS, CODEX_TRUST_NOTICE, DEMO_NOTICE, KIRO_SHARED_NOTICE, previewBlockReason } from './model';
import type { HarnessHookSnapshot } from './hooks-resource';
import { HarnessError, HarnessNotices } from './ui';

export interface HarnessHookPreviewProps {
  state: HarnessHookSnapshot; changed: boolean; demo: boolean; newPreviewDisabled?: boolean;
  onNewPreview: () => void; onApply: () => void;
}
export function HarnessHookPreviewView({ state, now, changed, demo, newPreviewDisabled, onNewPreview, onApply }: HarnessHookPreviewProps & { now: number }) {
  const { t } = useHarnessI18n();
  const { dateTime } = useFormat();
  const { preview, request, busy, applied } = state;
  const blocked = changed ? '선택한 정책 개정이 변경되었습니다. 새 미리보기를 검토하세요.'
    : preview && request ? previewBlockReason(preview, request, now) : null;
  const canApply = !!preview && !blocked && !state.needsPreview && !demo && !busy && !applied;
  return <div className="harness-stack">
    {request && <dl className="harness-properties">
      <div><dt>{t('클라이언트')}</dt><dd>{t(CLIENT_LABELS[request.client])}</dd></div>
      <div><dt>{t('프로젝트 ID')}</dt><dd><code translate="no">{request.projectId}</code></dd></div>
      <div><dt>{t('변경 작업')}</dt><dd>{t(request.action === 'remove' ? '제거' : '설치 · 업데이트')}</dd></div>
      {request.revision && <div><dt>{t('정책 개정')}</dt><dd><code translate="no">{request.revision}</code></dd></div>}
    </dl>}
    {demo && <InlineNotice>{t(DEMO_NOTICE)}</InlineNotice>}
    {(request?.client === 'kiro-ide' || request?.client === 'kiro-cli') && <InlineNotice tone="warning">{t(KIRO_SHARED_NOTICE)}</InlineNotice>}
    {request?.client === 'codex' && <InlineNotice>{t(CODEX_TRUST_NOTICE)}</InlineNotice>}
    {busy === 'preview' && <Skeleton rows={3} />}
    {preview && <>
      <p className="harness-hint">{t('미리보기 만료 시각')}: <time dateTime={preview.expiresAt}>{dateTime(preview.expiresAt, {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      })}</time></p>
      <HarnessNotices messages={preview.notices} />
      {preview.files.map((file, index) => <section key={`${index}:${file.path}`} className="harness-preview-file">
        <div className="harness-section-heading"><h3><code translate="no">{file.path}</code></h3>
          <span className="tag">{t(file.existed ? '기존 파일' : '새 파일')}</span></div>
        <div className="harness-file-diff">
          <div><h4>{t('변경 전')}</h4><pre className="harness-code" tabIndex={0} translate="no"><code>{file.before}</code></pre></div>
          <div><h4>{t('변경 후')}</h4><pre className="harness-code" tabIndex={0} translate="no"><code>{file.after}</code></pre></div>
        </div>
      </section>)}
      {!preview.files.length && <p className="harness-hint">{t('표시할 파일 변경이 없습니다.')}</p>}
    </>}
    <HarnessError problem={state.error} />
    {blocked && <InlineNotice tone="warning">{t(blocked)}</InlineNotice>}
    {state.needsPreview && !applied && <p className="harness-hint">
      {t('새 미리보기를 검토한 뒤 다시 적용할 수 있습니다. 이전 적용 요청은 자동으로 반복하지 않습니다.')}
    </p>}
    {applied ? <InlineNotice tone="success">{t('변경을 적용했습니다. 활성화 여부는 네이티브 클라이언트에서 확인하세요.')}</InlineNotice>
      : <div className="harness-actions">
        <Button icon={Eye} busy={busy === 'preview'} disabled={!!busy || demo || newPreviewDisabled} onClick={onNewPreview}>{t('새 미리보기')}</Button>
        <Button icon={Check} variant="primary" busy={busy === 'apply'} disabled={!canApply} onClick={onApply}>{t('적용')}</Button>
      </div>}
  </div>;
}

export function HarnessHookPreviewDialog(props: HarnessHookPreviewProps & { onClose: () => void }) {
  const { t } = useHarnessI18n();
  const now = useNow(!!props.state.preview && !props.state.applied);
  return <Dialog title={t('훅 변경 미리보기')} size="large" className="harness-dialog"
    description={t('비밀 값이 가려진 변경 전후 파일과 안내를 확인하세요. 적용 버튼을 눌러야 파일이 변경됩니다.')}
    onClose={() => { if (props.state.busy !== 'apply') props.onClose(); }}
    footer={<Button disabled={props.state.busy === 'apply'} onClick={props.onClose}>{t('닫기')}</Button>}>
    <HarnessHookPreviewView {...props} now={now} />
  </Dialog>;
}
