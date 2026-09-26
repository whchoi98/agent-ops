import { Eye, Trash2 } from 'lucide-react';
import {
  HARNESS_CLIENTS, type HarnessBinding, type HarnessClient, type HarnessPolicyDetail, type HarnessRuntime,
} from '../../../shared/harness';
import { Button, InlineNotice, Panel } from '../../components/ui';
import { useFormat } from '../../i18n/useFormat';
import { useHarnessI18n } from './i18n';
import { BINDING_LABELS, CLIENT_LABELS, CODEX_TRUST_NOTICE, DEMO_NOTICE, KIRO_SHARED_NOTICE, runtimeState } from './model';
import { HarnessBadge, HarnessNotices } from './ui';

export function HarnessHooks({ bindings, projectId, policy, runtime, demo, demoNoticeId, blocked, busy, onPreview }: {
  bindings: HarnessBinding[]; projectId?: string; policy: HarnessPolicyDetail | null; runtime: HarnessRuntime | null;
  demo: boolean; demoNoticeId?: string; blocked: boolean; busy: boolean;
  onPreview: (client: HarnessClient, action: 'install' | 'remove', managed: boolean, trigger: HTMLButtonElement) => void;
}) {
  const { t } = useHarnessI18n();
  const { dateTime } = useFormat();
  const noInstall = !projectId || !policy || !policy.valid || !runtime || runtimeState(runtime) !== 'ready' || blocked || demo || busy;
  return <Panel title={t('네이티브 훅')} description={t('설정 근거와 실제 이벤트 관측을 구분합니다. 훅 변경은 미리보기를 검토한 뒤 적용합니다.')}>
    <div className="harness-panel-body harness-stack">
      {!projectId && <InlineNotice>{t('훅을 변경할 프로젝트를 선택하세요.')}</InlineNotice>}
      {demo && !demoNoticeId && <InlineNotice>{t(DEMO_NOTICE)}</InlineNotice>}
      {!demo && projectId && noInstall && !busy && <p className="harness-hint">{t(!policy
        ? '판정할 저장된 정책을 먼저 선택하세요.' : blocked ? '초안 변경 내용을 먼저 저장하고 현재 정책 개정을 확인하세요.'
          : '엔진을 확인해 준비 상태로 만든 뒤 판정 테스트를 진행하세요.')}</p>}
      <InlineNotice>{t(KIRO_SHARED_NOTICE)}</InlineNotice>
      <div className="harness-bindings">
        {HARNESS_CLIENTS.map(client => {
          const kiro = client === 'kiro-ide' || client === 'kiro-cli';
          const binding = bindings.find(item => item.client === client)
            ?? (kiro ? bindings.find(item => item.client === 'kiro-ide' || item.client === 'kiro-cli') : undefined);
          const state = binding?.state ?? 'unknown';
          const update = !!binding?.managed && state !== 'unconfigured';
          const name = t(CLIENT_LABELS[client]);
          return <article key={client} className="harness-binding" aria-label={name}>
            <div className="harness-section-heading">
              <h3>{name}</h3>{kiro && <span className="tag">{t('공유 연결')}</span>}
            </div>
            <dl className="harness-properties">
              <div><dt>{t('설정 근거')}</dt><dd><HarnessBadge tone={state === 'configured' ? 'info' : state === 'unconfigured' ? 'neutral' : 'warning'}>
                {t(BINDING_LABELS[state])}
              </HarnessBadge></dd></div>
              <div><dt>{t('실제 이벤트 관측')}</dt><dd>{binding?.lastObservedAt ? <>
                <span>{t('관측됨')}</span>{' '}<time dateTime={binding.lastObservedAt}>{dateTime(binding.lastObservedAt)}</time>
              </> : t('관측되지 않음')}</dd></div>
              <div><dt>{t('관리 주체')}</dt><dd>{binding && (binding.path || binding.managed)
                ? t(binding.managed ? '앱 관리' : '외부 설정') : '—'}</dd></div>
              <div><dt>{t('관측한 클라이언트 버전')}</dt><dd>{binding?.detectedVersion
                ? <code>{binding.detectedVersion}</code> : t('버전 확인 필요')}</dd></div>
              {binding?.requiredVersion && <div><dt>{t('필요한 클라이언트 버전')}</dt><dd><code>{binding.requiredVersion}</code></dd></div>}
              {binding?.policyRevision && <div><dt>{t('정책 개정')}</dt><dd><code translate="no">{binding.policyRevision}</code></dd></div>}
            </dl>
            {binding?.path && <code className="harness-source-path" translate="no">{binding.path}</code>}
            {!binding?.detectedVersion && <p className="harness-hint">{t('설치 버전을 확인하지 못했습니다. 지원 여부를 직접 확인하세요.')}</p>}
            {client === 'codex' && <p className="harness-hint">{t(CODEX_TRUST_NOTICE)}</p>}
            <HarnessNotices messages={binding?.notices ?? []} />
            {binding?.path && !binding.managed && <p className="harness-hint">{t('앱이 관리하지 않는 외부 훅은 제거할 수 없습니다.')}</p>}
            <div className="harness-actions">
              <Button size="small" icon={Eye} disabled={noInstall}
                aria-describedby={demo ? demoNoticeId : undefined}
                aria-label={t(update ? '{client} 업데이트 미리보기' : '{client} 설치 미리보기', { client: name })}
                onClick={event => onPreview(client, 'install', !!binding?.managed, event.currentTarget)}>{t(update ? '업데이트 미리보기' : '설치 미리보기')}</Button>
              <Button size="small" variant="danger" icon={Trash2} disabled={demo || busy || !projectId || !binding?.managed}
                aria-describedby={demo ? demoNoticeId : undefined}
                aria-label={t('{client} 제거 미리보기', { client: name })}
                onClick={event => onPreview(client, 'remove', !!binding?.managed, event.currentTarget)}>{t('제거 미리보기')}</Button>
            </div>
          </article>;
        })}
      </div>
    </div>
  </Panel>;
}
