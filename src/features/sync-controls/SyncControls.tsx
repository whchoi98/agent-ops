import { RefreshCw, Square } from 'lucide-react';
import type { SyncStatus } from '../../../shared/sync-control';
import { Button, InlineNotice, Panel } from '../../components/ui';
import { useI18n, AppNotice } from '../../i18n/I18nProvider';
import { useFormat } from '../../i18n/useFormat';
import './sync-controls.css';

const activityLabels = {
  idle: '동기화 대기', running: '동기화 진행 중', stopping: '동기화 중단 중',
};
const automaticLabels = {
  scheduled: '자동 동기화 활성', manual: '수동 동기화만 사용',
  'waiting-for-idle': '앱의 CLI 작업이 끝나기를 기다리는 중', disabled: '자동 동기화 비활성',
};
const outcomeLabels = {
  completed: '수집 완료', cancelled: '수집 취소', 'timed-out': '수집 시간 초과', failed: '수집 실패',
};

export interface SyncControlsProps {
  status: SyncStatus | null;
  syncing: boolean;
  stopping: boolean;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  now?: number;
}

export function SyncControls({ status, syncing, stopping, onStart, onStop, now = Date.now() }: SyncControlsProps) {
  const { t } = useI18n();
  const { dateTime, number } = useFormat();
  const current = status?.currentAttempt;
  const elapsed = current ? Math.max(0, Math.floor((now - Date.parse(current.startedAt)) / 1000)) : 0;
  const unavailable = !status || status.demo;
  const stopPending = stopping || status?.activity === 'stopping';
  return <section className="sync-control-section" aria-label={t('수집 제어')}>
    <Panel title={t('수집 제어')} description={t('자동 수집과 현재 작업의 상태를 확인합니다.')}
      actions={<div className="sync-control-actions">
        <Button icon={RefreshCw} disabled={unavailable || syncing} onClick={() => void onStart()}>{t('지금 동기화')}</Button>
        <Button icon={Square} busy={stopPending} disabled={unavailable || !syncing} onClick={() => void onStop()}>{t('현재 동기화 중단')}</Button>
      </div>}>
      <div className="sync-control-body">
      {!status ? <p>{t('수집 상태를 확인하고 있습니다.')}</p> : <>
        {status.demo && <InlineNotice>{t('데모에서는 원본 동기화를 실행하지 않습니다.')}</InlineNotice>}
        <dl className="sync-control-values">
          <div><dt>{t('현재 수집 상태')}</dt><dd>{t(activityLabels[status.activity])}</dd></div>
          <div><dt>{t('자동 수집 상태')}</dt><dd>{t(automaticLabels[status.automaticState])}</dd></div>
          <div><dt>{t('다음 확인 시각')}</dt><dd>{status.nextCheckAt ? dateTime(status.nextCheckAt) : t('예약 없음')}</dd></div>
          {current && <>
            <div><dt>{t('수집 시작 방식')}</dt><dd>{t(current.trigger === 'manual' ? '수동 시작' : '자동 시작')}</dd></div>
            <div><dt>{t('현재 경과 시간')}</dt><dd>{t('{0}초', { 0: number(elapsed) })}</dd></div>
            <div><dt>{t('현재 작업 시간 제한')}</dt><dd>{t('{0}초', { 0: number(current.maxSeconds) })}</dd></div>
          </>}
        </dl>
        {status.lastAttempt && <div className="sync-last-attempt">
          <strong>{t('마지막 수집 결과')}: {t(outcomeLabels[status.lastAttempt.outcome])}</strong>
          <span>{dateTime(status.lastAttempt.finishedAt)}</span>
          {status.lastAttempt.error && <p><AppNotice message={status.lastAttempt.error} /></p>}
        </div>}
        <p className="page-footnote">{t('중단 전 저장한 세션은 유지되며, 다시 동기화하면 남은 기록을 확인합니다.')}</p>
      </>}
      </div>
    </Panel>
  </section>;
}
