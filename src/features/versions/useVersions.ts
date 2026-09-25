import { useCallback, useEffect, useRef, useState } from 'react';
import type { VersionReport } from '../../../shared/versions';
import { useResource } from '../../hooks/useResource';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/format';
import type { VersionResource } from './types';

export function useVersions(): VersionResource {
  const resource = useResource<VersionReport>(signal => api.versions(signal), 'cli-versions', true);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const attempt = useRef<AbortController | null>(null);
  useEffect(() => () => attempt.current?.abort(), []);

  const check = useCallback(async () => {
    if (resource.loading || attempt.current) return;
    const request = new AbortController();
    attempt.current = request;
    setChecking(true); setCheckError(null);
    try {
      const report = await api.checkVersions();
      if (!request.signal.aborted) resource.replaceData(report);
    } catch (cause) {
      if (!request.signal.aborted) setCheckError(errorMessage(cause));
    } finally {
      if (!request.signal.aborted) { setChecking(false); attempt.current = null; }
    }
  }, [resource.loading, resource.replaceData]);

  return {
    report: resource.data, loading: resource.loading, checking,
    error: checking ? null : checkError ?? resource.error,
    check,
  };
}
