import { useMemo } from 'react';
import * as format from '../lib/format';
import { useI18n } from './I18nProvider';

export function useFormat() {
  const { language, t } = useI18n();
  return useMemo(() => {
    function dateTime(value: string | null | undefined, options?: Intl.DateTimeFormatOptions) {
      if (!value || !Number.isFinite(Date.parse(value))) return t('미기록');
      return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'ko-KR', options ?? {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      }).format(new Date(value));
    }
    return {
    dateTime,
    relativeTime(value: string | null | undefined) {
      if (!value || !Number.isFinite(Date.parse(value))) return t('시간 미기록');
      const elapsed = Date.now() - Date.parse(value);
      if (elapsed < 0) return dateTime(value);
      if (elapsed < 60_000) return t('방금 전');
      if (elapsed < 3_600_000) return t('{0}분 전', { 0: Math.floor(elapsed / 60_000) });
      if (elapsed < 86_400_000) return t('{0}시간 전', { 0: Math.floor(elapsed / 3_600_000) });
      if (elapsed < 604_800_000) return t('{0}일 전', { 0: Math.floor(elapsed / 86_400_000) });
      return dateTime(value, { month: 'short', day: 'numeric' });
    },
    duration(ms: number | null | undefined) {
      if (ms == null || !Number.isFinite(ms) || ms < 0) return t('미기록');
      const seconds = Math.floor(ms / 1000);
      if (seconds < 60) return t('{0}초', { 0: seconds });
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return t('{0}분 {1}초', { 0: minutes, 1: seconds % 60 });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t('{0}시간 {1}분', { 0: hours, 1: minutes % 60 });
      return t('{0}일 {1}시간', { 0: Math.floor(hours / 24), 1: hours % 24 });
    },
    money(value: number | null | undefined) { return value == null ? t('미기록') : format.money(value); },
    number: format.number,
    compactNumber: format.compactNumber,
    };
  }, [language, t]);
}
