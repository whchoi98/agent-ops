import { useMemo } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { translate, type MessageValues } from '../../i18n/core';
import { APP_UPDATE_EN_MESSAGES } from '../../i18n/app-update.en';

/** Usable before the coordinator merges the feature's explicit dictionary into global messages. */
export function useAppUpdateI18n() {
  const app = useI18n();
  return useMemo(() => ({
    t: (source: string, values?: MessageValues) => Object.hasOwn(APP_UPDATE_EN_MESSAGES, source)
      ? translate(app.language, source, APP_UPDATE_EN_MESSAGES, values) : app.t(source, values),
    notice: (source: string) => Object.hasOwn(APP_UPDATE_EN_MESSAGES, source)
      ? translate(app.language, source, APP_UPDATE_EN_MESSAGES) : app.notice(source),
  }), [app.language, app.t, app.notice]);
}
