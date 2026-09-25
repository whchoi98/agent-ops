import { useMemo } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { createNoticeTranslator, translate, type MessageValues } from '../../i18n/core';
import { MCP_EN_MESSAGES } from '../../i18n/mcp.en';
import { MCP_KO_MESSAGES } from '../../i18n/mcp.ko';

/** Keep feature dictionaries in the lazy MCP chunk instead of the initial app bundle. */
export function useMcpI18n() {
  const app = useI18n();
  return useMemo(() => {
    const notice = createNoticeTranslator(app.language, MCP_EN_MESSAGES, MCP_KO_MESSAGES);
    return {
      language: app.language,
      t: (source: string, values?: MessageValues) => Object.hasOwn(MCP_EN_MESSAGES, source)
        ? translate(app.language, source, MCP_EN_MESSAGES, values) : app.t(source, values),
      notice: (source: string) => {
        const translated = notice(source);
        return translated === source ? app.notice(source) : translated;
      },
    };
  }, [app.language, app.t, app.notice]);
}
