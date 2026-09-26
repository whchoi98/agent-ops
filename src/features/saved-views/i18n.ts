import { useMemo } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { createNoticeTranslator, translate, type MessageValues } from '../../i18n/core';
import { SAVED_VIEWS_EN_MESSAGES } from '../../i18n/saved-views.en';

export function useSavedViewsI18n() {
  const app = useI18n();
  return useMemo(() => {
    const notice = createNoticeTranslator(app.language, SAVED_VIEWS_EN_MESSAGES);
    return {
      language: app.language,
      t: (source: string, values?: MessageValues) => Object.hasOwn(SAVED_VIEWS_EN_MESSAGES, source)
        ? translate(app.language, source, SAVED_VIEWS_EN_MESSAGES, values) : app.t(source, values),
      notice: (source: string) => {
        const translated = notice(source);
        return translated === source ? app.notice(source) : translated;
      },
    };
  }, [app.language, app.t, app.notice]);
}
