export type Language = 'ko' | 'en';
export type Messages = Readonly<Record<string, string>>;
export type MessageValues = Readonly<Record<string, unknown>>;
export const LANGUAGE_STORAGE_KEY = 'agent-ops-language';

export function readLanguage(storage?: Pick<Storage, 'getItem'>): Language {
  try { return storage?.getItem(LANGUAGE_STORAGE_KEY) === 'en' ? 'en' : 'ko'; }
  catch { return 'ko'; }
}

export function messageTemplate(language: Language, source: string, messages: Messages): string {
  return language === 'en' && Object.hasOwn(messages, source) ? messages[source] : source;
}

export function interpolate(template: string, values: MessageValues = {}): string {
  return template.replace(/\{(\w+)\}/g, (token, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : token);
}

export function translate(language: Language, source: string, messages: Messages, values: MessageValues = {}): string {
  return interpolate(messageTemplate(language, source, messages), values);
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Only app-owned notices should enter this boundary; user content never does. */
export function createNoticeTranslator(language: Language, english: Messages, korean: Messages = {}) {
  const messages = language === 'en' ? english : korean;
  const patterns = Object.entries(messages).filter(([source]) =>
    /\{\w+\}/.test(source) && source.replace(/\{\w+\}/g, '').trim().length >= 8)
    .sort(([left], [right]) => right.replace(/\{\w+\}/g, '').length - left.replace(/\{\w+\}/g, '').length)
    .map(([source, target]) => {
      const names: string[] = [];
      let cursor = 0;
      let pattern = '^';
      for (const match of source.matchAll(/\{(\w+)\}/g)) {
        pattern += escapePattern(source.slice(cursor, match.index)) + '([\\s\\S]*?)';
        names.push(match[1]);
        cursor = match.index! + match[0].length;
      }
      return { expression: new RegExp(pattern + escapePattern(source.slice(cursor)) + '$'), names, target };
    });
  return (source: string): string => {
    if (!source) return source;
    if (Object.hasOwn(messages, source)) return messages[source];
    for (const { expression, names, target } of patterns) {
      const match = expression.exec(source);
      if (!match) continue;
      const values: Record<string, string> = Object.create(null);
      names.forEach((name, index) => { values[name] = match[index + 1]; });
      return interpolate(target, values);
    }
    return source;
  };
}
