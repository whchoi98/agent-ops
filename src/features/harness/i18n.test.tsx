import { expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createI18n, I18nContext } from '../../i18n/I18nProvider';
import { useHarnessI18n } from './i18n';
import { HarnessDecisionView } from './HarnessEvaluation';
import { decision } from './testFixtures';

function Notices({ messages }: { messages: string[] }) {
  const { notice } = useHarnessI18n();
  return <>{messages.map((message, index) => <p key={index}>{notice(message)}</p>)}</>;
}
test('server notices and interpolated validation errors are bilingual while data parameters remain literal', () => {
  const html = renderToStaticMarkup(<I18nContext.Provider value={{ ...createI18n('ko'), setLanguage: () => {} }}>
    <Notices messages={[
      'Python was not found.',
      'Managed policy revision changed. Refresh before saving.',
      'rules must be a list of mappings.',
      'mode has an unsupported value. permissions must be a mapping.',
      'Hook preview expired or was already used.',
    ]} />
  </I18nContext.Provider>);
  expect(html).toContain('Python을 찾지 못했습니다.');
  expect(html).toContain('앱 관리 정책의 개정이 변경되었습니다.');
  expect(html).toContain('rules');
  expect(html).toContain('mode');
  expect(html).toContain('permissions');
  expect(html).not.toContain('must be a');
  expect(html).not.toContain('has an unsupported value');
  expect(html).not.toContain('Hook preview expired');
});
test('native decision reasons never cross the app notice translator even when they resemble UI copy', () => {
  const html = renderToStaticMarkup(<I18nContext.Provider value={{ ...createI18n('ko'), setLanguage: () => {} }}>
    <HarnessDecisionView decision={decision({ reason: 'Python was not found.', action: 'deny' })} />
  </I18nContext.Provider>);
  expect(html).toContain('Python was not found.');
});
