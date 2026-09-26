import { useMemo } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { createNoticeTranslator, translate, type MessageValues } from '../../i18n/core';
import { TEMPLATE_FIELDS_EN_MESSAGES } from '../../i18n/template-fields.en';

/** Feature copy stays in the feature chunk; never pass template content here. */
export function useTemplateFieldsI18n() {
  const app = useI18n();
  return useMemo(() => {
    const notice = createNoticeTranslator(app.language, TEMPLATE_FIELDS_EN_MESSAGES);
    return {
      language: app.language,
      t: (source: string, values?: MessageValues) => Object.hasOwn(TEMPLATE_FIELDS_EN_MESSAGES, source)
        ? translate(app.language, source, TEMPLATE_FIELDS_EN_MESSAGES, values) : app.t(source, values),
      notice: (source: string) => {
        const translated = notice(source);
        return translated === source ? app.notice(source) : translated;
      },
    };
  }, [app]);
}
