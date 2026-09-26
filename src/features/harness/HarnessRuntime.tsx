import { useEffect, useId, useState, type FormEvent } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import type { HarnessRuntime as Runtime, HarnessSettings } from '../../../shared/harness';
import { Button, CopyButton, Field, InlineNotice, Panel, Skeleton } from '../../components/ui';
import { useFormat } from '../../i18n/useFormat';
import { harnessApi } from './api';
import { useHarnessI18n } from './i18n';
import {
  DEMO_NOTICE, INSTALL_COMMAND, PYTHON_PATH_LIMIT, RUNTIME_LABELS, TESTED_ENGINE_VERSION,
  runtimeState, settingsDraft, settingsInput, unsupportedPython, type HarnessSettingsDraft,
} from './model';
import { HarnessBadge, HarnessError } from './ui';
import { useHarnessAction } from './useHarness';

export function HarnessRuntime({ runtime, settings, demo, demoNoticeId, onSettingsSaved, onRuntime, onReload }: {
  runtime: Runtime | null; settings: HarnessSettings | null; demo: boolean; demoNoticeId?: string;
  onSettingsSaved: (settings: HarnessSettings) => void; onRuntime: (runtime: Runtime, settingsRevision: number) => void; onReload: () => void;
}) {
  const { t, notice } = useHarnessI18n();
  const { dateTime } = useFormat();
  const id = useId();
  const [editor, setEditor] = useState<{ original: HarnessSettings; fields: HarnessSettingsDraft } | null>(
    () => settings ? { original: settings, fields: settingsDraft(settings) } : null,
  );
  const [saved, setSaved] = useState(false);
  const saveAction = useHarnessAction();
  const probe = useHarnessAction();
  useEffect(() => {
    if (!settings) return;
    setEditor(previous => {
      if (!previous || (previous.original.revision !== settings.revision
        && JSON.stringify(previous.fields) === JSON.stringify(settingsDraft(previous.original)))) {
        return { original: settings, fields: settingsDraft(settings) };
      }
      return previous;
    });
  }, [settings]);
  const dirty = !!editor && JSON.stringify(editor.fields) !== JSON.stringify(settingsDraft(editor.original));
  const pythonDirty = !!editor && editor.fields.pythonPath.trim() !== (editor.original.pythonPath ?? '');
  const conflict = !!settings && !!editor && settings.revision !== editor.original.revision;
  const busy = saveAction.busy || probe.busy;
  let inputError: string | null = null;
  if (editor) { try { settingsInput(editor.original, editor.fields); } catch (cause) { inputError = (cause as Error).message; } }
  const state = runtime ? runtimeState(runtime) : 'unchecked';
  function edit(patch: Partial<HarnessSettingsDraft>) {
    setEditor(previous => previous ? { ...previous, fields: { ...previous.fields, ...patch } } : null);
    setSaved(false);
  }
  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (!editor || !dirty || busy || conflict || inputError) return;
    const result = await saveAction.run(signal => harnessApi.saveSettings(settingsInput(editor.original, editor.fields), signal));
    if (result) {
      setEditor({ original: result, fields: settingsDraft(result) });
      setSaved(true);
      onSettingsSaved(result);
    }
  }
  async function check() {
    if (demo || busy || pythonDirty || !settings) return;
    const result = await probe.run(signal => harnessApi.probe(signal));
    if (result) onRuntime(result, settings.revision);
  }
  return <Panel title={t('엔진 및 설정')} description={t('AutoHarness는 선택 설치하는 Python 엔진입니다. Python이 없어도 정책과 감사 기록을 조회할 수 있습니다.')}
    className="harness-runtime">
    <div className="harness-panel-body harness-stack">
      <div className="harness-section-heading">
        <HarnessBadge tone={state === 'ready' ? 'success' : state === 'error' ? 'danger' : 'warning'}>{t(RUNTIME_LABELS[state])}</HarnessBadge>
        {demo && <span className="tag">{t('데모 데이터')}</span>}
      </div>
      <dl className="harness-properties">
        <div><dt>{t('관측한 엔진 버전')}</dt><dd><code>{runtime?.engineVersion ?? '—'}</code></dd></div>
        <div><dt>{t('테스트 기준 버전')}</dt><dd><code>{TESTED_ENGINE_VERSION}</code></dd></div>
        <div><dt>{t('Python 버전')}</dt><dd><code>{runtime?.pythonVersion ?? '—'}</code></dd></div>
        <div><dt>{t('저장된 Python 경로')}</dt><dd><code translate="no">{settings?.pythonPath ?? '—'}</code></dd></div>
        <div><dt>{t('마지막 엔진 확인')}</dt><dd>{runtime?.checkedAt
          ? <time dateTime={runtime.checkedAt}>{dateTime(runtime.checkedAt)}</time> : t('확인하지 않음')}</dd></div>
      </dl>
      <p className="harness-hint">{t('테스트 기준 버전은 최신 버전 표시가 아닙니다.')}</p>
      {runtime?.engineVersion && runtime.engineVersion !== TESTED_ENGINE_VERSION &&
        <InlineNotice tone="warning">{t('관측 버전이 테스트 기준 0.1.1과 다릅니다. 호환성을 확인하세요.')}</InlineNotice>}
      {runtime && unsupportedPython(runtime.pythonVersion) && <InlineNotice tone="warning">
        <strong>{t('Python 3.10 이상이 필요합니다. Python 3.9는 지원하지 않습니다.')}</strong>
        <p>{t('Python 3.10 이상 경로를 저장한 뒤 엔진을 다시 확인하세요.')}</p>
      </InlineNotice>}
      {runtime?.error && <InlineNotice tone="error">{notice(runtime.error)}</InlineNotice>}
      {editor ? <form className="harness-stack" onSubmit={event => void save(event)}>
        <Field label={t('Python 실행 파일 경로')} htmlFor={`${id}-python`}
          hint={t('빈 값이면 서버의 기본 Python 검색을 사용합니다. 변경은 저장 버튼을 누를 때만 반영됩니다.')}>
          <input id={`${id}-python`} autoComplete="off" spellCheck={false} maxLength={PYTHON_PATH_LIMIT}
            value={editor.fields.pythonPath} disabled={busy} placeholder="/absolute/path/to/python3"
            onChange={event => edit({ pythonPath: event.target.value })} />
        </Field>
        <div className="harness-form-grid">
          <Field label={t('보관 기간(일)')} htmlFor={`${id}-retention`}>
            <input type="number" id={`${id}-retention`} min={1} max={90} step={1} inputMode="numeric"
              value={editor.fields.retentionDays} disabled={busy} onChange={event => edit({ retentionDays: event.target.value.slice(0, 3) })} />
          </Field>
          <Field label={t('최대 캐시 기록 수')} htmlFor={`${id}-limit`}>
            <input type="number" id={`${id}-limit`} min={100} max={10000} step={1} inputMode="numeric"
              value={editor.fields.maxCacheRecords} disabled={busy} onChange={event => edit({ maxCacheRecords: event.target.value.slice(0, 5) })} />
          </Field>
        </div>
        <p className="harness-hint">{t('기본값은 최근 2,000개, 30일입니다. 외부 원본 로그는 삭제하지 않습니다.')}</p>
        {inputError && <InlineNotice tone="error">{t(inputError)}</InlineNotice>}
        <div className="harness-actions">
          <Button type="submit" icon={Save} disabled={!dirty || !!inputError || conflict || busy} busy={saveAction.busy}>{t('설정 저장')}</Button>
          <span className="harness-hint">{t('설정 개정')}: {editor.original.revision}{dirty ? ` · ${t('저장하지 않은 변경 내용')}` : ''}</span>
        </div>
      </form> : <Skeleton rows={3} />}
      {saved && <p className="harness-hint" role="status">{t('설정을 저장했습니다.')}</p>}
      <HarnessError problem={saveAction.error} busy={busy} onRetry={saveAction.error?.status === 409 ? onReload : () => void save()}
        retryLabel={t(saveAction.error?.status === 409 ? '최신 설정 확인' : '설정 저장')} />
      {conflict && settings && <InlineNotice tone="warning">
        <p>{t('서버 설정이 변경되었습니다. 최신 설정을 확인하고 내 입력을 유지할지 결정하세요.')}</p>
        <dl className="harness-properties">
          <div><dt>{t('설정 개정')}</dt><dd>{settings.revision}</dd></div>
          <div><dt>{t('저장된 Python 경로')}</dt><dd><code translate="no">{settings.pythonPath ?? '—'}</code></dd></div>
          <div><dt>{t('보관 기간(일)')}</dt><dd>{settings.retentionDays}</dd></div>
          <div><dt>{t('최대 캐시 기록 수')}</dt><dd>{settings.maxCacheRecords}</dd></div>
        </dl>
        <Button size="small" disabled={busy} onClick={() => {
          setEditor(previous => previous ? { ...previous, original: settings } : null);
          saveAction.clear();
        }}>{t('최신 설정 개정으로 내 입력 유지')}</Button>
      </InlineNotice>}
      <div className="harness-stack">
        {demo && !demoNoticeId && <InlineNotice>{t(DEMO_NOTICE)}</InlineNotice>}
        <div className="harness-actions">
          <Button icon={RefreshCw} busy={probe.busy} disabled={demo || !settings || busy || pythonDirty}
            aria-describedby={`${id}-probe-hint${demo && demoNoticeId ? ` ${demoNoticeId}` : ''}`} onClick={() => void check()}>{t('엔진 확인')}</Button>
          <p className="harness-hint" id={`${id}-probe-hint`}>{t(pythonDirty
            ? 'Python 경로 변경을 저장한 뒤 엔진을 확인하세요.' : '엔진 확인은 저장된 Python 경로만 사용합니다.')}</p>
        </div>
        <p className="harness-hint">{t('엔진 프로세스 제한은 15초이며, 화면은 응답을 최대 30초 기다립니다.')}</p>
        <HarnessError problem={probe.error} onRetry={() => void check()} retryLabel={t('엔진 확인')} busy={busy || demo || pythonDirty} />
      </div>
      <details className="harness-details" open={state === 'missing' || state === 'unsupported' || state === 'error'}>
        <summary>{t('선택 설치 안내')}</summary>
        <div className="harness-stack">
          <p>{t('아래 명령을 복사해 직접 터미널에서 실행하세요. 이 화면은 설치 명령을 실행하지 않습니다.')}</p>
          <p>{t('python3가 Python 3.10 이상인지 먼저 확인하세요. 원하면 별도 가상 환경에 고정된 소스를 설치할 수 있습니다.')}</p>
          <pre className="harness-code" aria-label={t('설치 명령')} tabIndex={0} translate="no"><code>{INSTALL_COMMAND}</code></pre>
          <div className="harness-actions"><CopyButton text={INSTALL_COMMAND} label={t('설치 명령 복사')} /></div>
          <p className="harness-hint">{t('가상 환경은 선택 사항입니다. 설치 후 해당 환경의 Python 실행 파일 절대 경로를 위 설정에 저장하세요.')}</p>
        </div>
      </details>
    </div>
  </Panel>;
}
