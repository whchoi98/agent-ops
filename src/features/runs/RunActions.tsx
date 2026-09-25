import { useI18n, Trans } from '../../i18n/I18nProvider';
import { useState } from 'react';
import { RotateCcw, Square } from 'lucide-react';
import type { Run } from '../../../shared/types';
import { Button } from '../../components/ui';
import { api } from '../../lib/api';
import { canRetryRun, errorMessage, isActiveRun } from '../../lib/format';
import { useApp, useData } from '../../state/AppProvider';

export function RunActions({ run, onChanged, small = false }: { run: Run; onChanged?: () => void; small?: boolean }) {
  const { t } = useI18n();
  const data = useData();
  const { refresh, notify, openRun } = useApp();
  const [busy, setBusy] = useState(false);
  async function cancel() {
    if (!isActiveRun(run.status) || busy) return;
    setBusy(true);
    try {
      await api.cancelRun(run.id);
      await refresh(true); onChanged?.();
      notify('실행을 취소했습니다.');
    } catch (error) { notify(errorMessage(error), 'error'); }
    finally { setBusy(false); }
  }
  async function retry() {
    if (data.demo || !canRetryRun(run.status) || busy) return;
    setBusy(true);
    try {
      const next = await api.retryRun(run.id);
      await refresh(true);
      notify('같은 설정으로 새 실행을 등록했습니다.');
      openRun(next.id);
    } catch (error) { notify(errorMessage(error), 'error'); }
    finally { setBusy(false); }
  }
  if (isActiveRun(run.status)) return <Button variant="danger" size={small ? 'small' : 'normal'} icon={Square} busy={busy}
    onClick={() => void cancel()}>{run.status === 'queued' ? t("대기 취소") : t("실행 취소")}</Button>;
  if (canRetryRun(run.status)) return <Button size={small ? 'small' : 'normal'} icon={RotateCcw} busy={busy} disabled={data.demo}
    title={data.demo ? t("데모에서는 실행을 다시 시도할 수 없습니다.") : t("같은 설정으로 새 실행을 시작합니다.")} onClick={() => void retry()}><Trans message={"다시 시도"} /></Button>;
  return null;
}
