import {
  createContext, Fragment, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode,
} from 'react';
import { EN_MESSAGES } from './en';
import { UI_EN_MESSAGES } from './ui.en';
import { NOTICE_EN_MESSAGES } from './notices.en';
import { NOTICE_KO_MESSAGES } from './notices.ko';
import { RESOURCE_EN_MESSAGES } from './resources.en';
import { DESKTOP_EN_MESSAGES } from './desktop.en';
import { SYNC_EN_MESSAGES } from './sync.en';
import { CREDIT_EN_MESSAGES } from './credits.en';
import { APP_UPDATE_EN_MESSAGES } from './app-update.en';
import { createNoticeTranslator, LANGUAGE_STORAGE_KEY, messageTemplate, readLanguage, translate, type Language, type MessageValues } from './core';

export const MESSAGES = {
  ...EN_MESSAGES, ...UI_EN_MESSAGES, ...NOTICE_EN_MESSAGES,
  ...RESOURCE_EN_MESSAGES, ...DESKTOP_EN_MESSAGES,
  ...SYNC_EN_MESSAGES, ...CREDIT_EN_MESSAGES, ...APP_UPDATE_EN_MESSAGES,
};

export function createI18n(language: Language) {
  return {
    language,
    t: (source: string, values?: MessageValues) => translate(language, source, MESSAGES, values),
    notice: createNoticeTranslator(language, MESSAGES, NOTICE_KO_MESSAGES),
    template: (source: string) => messageTemplate(language, source, MESSAGES),
  };
}

export const I18nContext = createContext({
  ...createI18n('ko'),
  setLanguage: (_language: Language) => {},
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, updateLanguage] = useState<Language>(() => {
    try { return readLanguage(typeof window === 'undefined' ? undefined : window.localStorage); }
    catch { return 'ko'; }
  });
  const setLanguage = useCallback((next: Language) => updateLanguage(next), []);
  useLayoutEffect(() => {
    document.documentElement.lang = language;
    try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language); } catch { /* Keep the in-memory preference. */ }
  }, [language]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === LANGUAGE_STORAGE_KEY) updateLanguage(event.newValue === 'en' ? 'en' : 'ko');
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  const value = useMemo(() => ({ ...createI18n(language), setLanguage }), [language, setLanguage]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);

export function AppNotice({ message }: { message: string }) {
  const { notice } = useI18n();
  return <>{notice(message)}</>;
}

/** Explicit app copy with opaque React values; values are never translated. */
export function Trans({ message, values = {} }: { message: string; values?: Record<string, ReactNode> }) {
  const { template } = useI18n();
  const parts = template(message).split(/(\{\w+\})/g);
  const occurrences: Record<string, number> = Object.create(null);
  return <>{parts.map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    const occurrence = name ? (occurrences[name] = (occurrences[name] ?? 0) + 1) : 0;
    return <Fragment key={name ? `value-${name}-${occurrence}` : `text-${index}`}>
      {name && Object.hasOwn(values, name) ? values[name] : part}
    </Fragment>;
  })}</>;
}

export function LanguageToggle() {
  const { language, setLanguage, t } = useI18n();
  return <button type="button" className="topbar-language-button"
    aria-label={language === 'ko' ? t('영어로 전환') : t('한국어로 전환')}
    title={language === 'ko' ? t('영어로 전환') : t('한국어로 전환')}
    onClick={() => setLanguage(language === 'ko' ? 'en' : 'ko')}>
    <span aria-hidden className={language === 'ko' ? 'language-active' : ''}>한</span>
    <span aria-hidden className="language-separator">/</span>
    <span aria-hidden className={language === 'en' ? 'language-active' : ''}>EN</span>
  </button>;
}
