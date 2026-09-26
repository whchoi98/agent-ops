import { useMemo } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { createNoticeTranslator, translate, type MessageValues } from '../../i18n/core';
import { HARNESS_EN_MESSAGES } from '../../i18n/harness.en';

const koreanNotices = Object.fromEntries(Object.entries(HARNESS_EN_MESSAGES).map(([ko, en]) => [en, ko]));
export function useHarnessI18n() {
  const app = useI18n();
  return useMemo(() => {
    const notice = createNoticeTranslator(app.language, HARNESS_EN_MESSAGES, koreanNotices);
    const exact = app.language === 'en' ? HARNESS_EN_MESSAGES : koreanNotices;
    const localize = (source: string) => {
      const translated = notice(source);
      return translated === source ? app.notice(source) : translated;
    };
    return {
      language: app.language,
      t: (source: string, values?: MessageValues) => Object.hasOwn(HARNESS_EN_MESSAGES, source)
        ? translate(app.language, source, HARNESS_EN_MESSAGES, values) : app.t(source, values),
      // Only app-owned errors and notices cross this boundary. Source text and decisions stay literal.
      notice: (source: string) => {
        if (Object.hasOwn(exact, source)) return exact[source];
        // A failed save can join several structural errors. Translate the sentences independently,
        // retaining field names and any other interpolated values verbatim.
        const parts = source.split(/(?<=\.)\s+(?=[A-Za-z])/);
        return parts.length > 1 ? parts.map(localize).join(' ') : localize(source);
      },
    };
  }, [app.language, app.t, app.notice]);
}
