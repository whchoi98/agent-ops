import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppUpdateReport } from '../../../shared/app-update';
import { useResource } from '../../hooks/useResource';
import { errorMessage } from '../../lib/format';
import { appUpdateApi } from './api';
import { pollAppUpdate } from './polling';

export function useAppUpdate(demo: boolean) {
  const resource = useResource<AppUpdateReport>(signal => appUpdateApi.report(signal), 'app-update', true);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const attempt = useRef<AbortController | null>(null);
  useEffect(() => () => {
    attempt.current?.abort();
    attempt.current = null;
  }, []);

  const serverChecking = resource.data?.checking ?? false;
  const serverDemo = resource.data?.demo || resource.data?.status === 'demo';
  useEffect(() => {
    if (demo || serverDemo || resource.loading || checking || !serverChecking || !resource.data) return;
    return pollAppUpdate(resource.data, {
      read: appUpdateApi.report, onResult: resource.replaceData, onError: setPollError,
    });
    // Only a transition into checking starts observation. Each cached progress result keeps its deadline.
  }, [demo, serverDemo, resource.loading, checking, serverChecking, resource.replaceData]);

  const check = useCallback(async () => {
    const report = resource.data;
    if (demo || report?.demo || report?.status === 'demo' || resource.loading || report?.checking || attempt.current) return;
    if (report?.nextCheckAt && Date.parse(report.nextCheckAt) > Date.now()) return;
    const controller = new AbortController();
    attempt.current = controller;
    setChecking(true);
    setCheckError(null);
    setPollError(null);
    try {
      const checked = await appUpdateApi.check(controller.signal);
      if (!controller.signal.aborted) resource.replaceData(checked);
    } catch (cause) {
      if (!controller.signal.aborted) setCheckError(errorMessage(cause));
    } finally {
      if (attempt.current === controller) {
        attempt.current = null;
        if (!controller.signal.aborted) setChecking(false);
      }
    }
  }, [demo, resource.data, resource.loading, resource.replaceData]);

  const reload = useCallback(() => {
    setCheckError(null);
    setPollError(null);
    resource.reload();
  }, [resource.reload]);

  return {
    report: resource.data, loading: resource.loading, checking,
    error: checking ? null : checkError ?? pollError ?? resource.error, check, reload,
  };
}
