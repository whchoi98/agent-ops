import { useMemo } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { createNoticeTranslator, translate, type MessageValues } from '../../i18n/core';
import { CONTEXT_PACKS_EN_MESSAGES } from '../../i18n/context-packs.en';

const koreanNotices = Object.fromEntries(Object.entries(CONTEXT_PACKS_EN_MESSAGES).map(([ko, en]) => [en, ko]));

/** Feature translations work before the coordinator merges global dictionaries. */
export function useContextPackI18n() {
  const app = useI18n();
  return useMemo(() => {
    const notice = createNoticeTranslator(app.language, CONTEXT_PACKS_EN_MESSAGES, koreanNotices);
    return {
      language: app.language,
      t: (source: string, values?: MessageValues) => Object.hasOwn(CONTEXT_PACKS_EN_MESSAGES, source)
        ? translate(app.language, source, CONTEXT_PACKS_EN_MESSAGES, values) : app.t(source, values),
      notice: (source: string) => {
        const local = notice(source);
        return local !== source ? local : app.notice(source);
      },
    };
  }, [app.language, app.t, app.notice]);
}
