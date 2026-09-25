import { useMemo } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { translate, type MessageValues } from '../../i18n/core';
import { CREDIT_EN_MESSAGES } from '../../i18n/credits.en';

/** Feature copy works before its dictionary is merged into the global provider. */
export function useCreditI18n() {
  const app = useI18n();
  return useMemo(() => ({
    t: (source: string, values?: MessageValues) => Object.hasOwn(CREDIT_EN_MESSAGES, source)
      ? translate(app.language, source, CREDIT_EN_MESSAGES, values) : app.t(source, values),
  }), [app.language, app.t]);
}
