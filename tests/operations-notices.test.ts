import { expect, it } from 'vitest';
import { createI18n } from '../src/i18n/I18nProvider';

it.each([
  'Synchronization cancelled.',
  'Synchronization time limit exceeded.',
  'Synchronization failed.',
  'Some Kiro credit values were invalid; recorded credits may be partial.',
  '/fixture/history.json: Some Kiro credit values were invalid; recorded credits may be partial.',
  '/fixture/history.json: Kiro credit turn identities were ambiguous; recorded credits are unknown.',
])('localizes generated operational notices without changing provenance: %s', message => {
  const translated = createI18n('ko').notice(message);
  expect(translated).toMatch(/[가-힣]/);
  if (message.startsWith('/fixture/')) expect(translated).toContain('/fixture/history.json:');
  expect(createI18n('en').notice(message)).toBe(message);
});
