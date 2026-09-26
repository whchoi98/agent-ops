import { useMemo } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { createNoticeTranslator, translate, type MessageValues } from '../../i18n/core';
import { WORK_ITEMS_EN_MESSAGES } from '../../i18n/work-items.en';

const koreanNotices = Object.fromEntries(Object.entries(WORK_ITEMS_EN_MESSAGES).map(([ko, en]) => [en, ko]));
export function useWorkItemI18n() {
  const app = useI18n();
  return useMemo(() => {
    const notice = createNoticeTranslator(app.language, WORK_ITEMS_EN_MESSAGES, koreanNotices);
    return {
      language: app.language,
      t: (source: string, values?: MessageValues) => Object.hasOwn(WORK_ITEMS_EN_MESSAGES, source)
        ? translate(app.language, source, WORK_ITEMS_EN_MESSAGES, values) : app.t(source, values),
      notice: (source: string) => {
        const translated = notice(source);
        return translated === source ? app.notice(source) : translated;
      },
    };
  }, [app.language, app.t, app.notice]);
}
