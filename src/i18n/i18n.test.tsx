import { expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import type { ExtensionDetail } from '../../shared/extensions';
import { Markdown } from '../components/Markdown';
import { ExtensionAnalysisView } from '../features/extensions/ExtensionAnalysisView';
import { createI18n, I18nContext, Trans } from './I18nProvider';
import { LANGUAGE_STORAGE_KEY, readLanguage } from './core';
import { useFormat } from './useFormat';

function localized(children: ReactNode, language: 'ko' | 'en' = 'en') {
  return renderToStaticMarkup(<I18nContext.Provider value={{ ...createI18n(language), setLanguage: () => {} }}>
    {children}
  </I18nContext.Provider>);
}

test('browser language defaults to Korean and accepts only the persisted supported choice', () => {
  expect(readLanguage()).toBe('ko');
  expect(readLanguage({ getItem: key => key === LANGUAGE_STORAGE_KEY ? 'en' : null })).toBe('en');
  expect(readLanguage({ getItem: () => 'fr' })).toBe('ko');
  expect(readLanguage({ getItem: () => { throw new Error('Storage blocked'); } })).toBe('ko');
});

test('all main page headings and required controls have English dictionary entries', () => {
  const { t } = createI18n('en');
  for (const source of ['워크스페이스 개요', '세션 탐색', '실행 보드', '프로젝트', '사용량 분석', '프롬프트 템플릿', '스킬·플러그인', '설정']) {
    expect(t(source)).not.toMatch(/[가-힣]/);
    expect(createI18n('ko').t(source)).toBe(source);
  }
  expect(t('원문')).toBe('Source');
  expect(t('메뉴 열기')).toBe('Open menu');
  expect(t('설정 저장')).toBe('Save settings');
  expect(t('최대 동시 실행')).toBe('Maximum concurrent runs');
  expect(t('한국어로 전환')).toBe('Switch to Korean');
});

test('translated templates keep user values opaque, including dictionary words and braces', () => {
  const name = '설정 / 원문 / {1}';
  expect(createI18n('en').t('{0} 내용 보기', { 0: name })).toBe('View 설정 / 원문 / {1} content');
  const html = localized(<Trans message={"{0} 내용 보기"} values={{ 0: <strong>{name}</strong> }} />);
  expect(html).toContain('<strong>설정 / 원문 / {1}</strong>');
  expect(html).not.toContain('<strong>Settings');
});

test('known notices translate at their boundary without rewriting paths or unknown diagnostics', () => {
  const { notice } = createI18n('en');
  expect(notice('동기화를 시작했습니다. 진행 상태는 자동으로 갱신됩니다.'))
    .toBe('Synchronization started. Progress updates automatically.');
  expect(notice('파일을 읽지 못했습니다: /tmp/설정/원문.md'))
    .toBe('Could not read the file: /tmp/설정/원문.md');
  expect(notice('내 스킬의 소개')).toBe('내 스킬의 소개');
  expect(notice('vendor diagnostic: 원문')).toBe('vendor diagnostic: 원문');
  expect(createI18n('ko').notice('The agent executable is missing or cannot be executed.'))
    .toBe('에이전트 실행 파일이 없거나 실행할 수 없습니다.');
});

test('Markdown content and code remain original when the interface is English', () => {
  const html = localized(<Markdown content={'# 설정\n\n회귀 테스트를 확인하세요.\n\n```ts\nconst path = "/프로젝트/원문";\n```'} />);
  expect(html).toContain('<h3>설정</h3>');
  expect(html).toContain('회귀 테스트를 확인하세요.');
  expect(html).toContain('/프로젝트/원문');
  expect(html).toContain('Copy code');
});

test('extension content and metadata names remain original while surrounding labels translate', () => {
  const detail: ExtensionDetail = {
    id: 'fixture-skill', agent: 'codex', kind: 'skill', name: '설정', description: '사용자가 쓴 설명',
    version: null, scope: 'user', path: '/프로젝트/원문/SKILL.md', status: 'available',
    statusReason: 'Codex 스킬 경로에서 발견한 정의입니다.', evidence: [], pluginId: null, pluginName: null,
    childCount: 0, warnings: [], entry: null, files: [], children: [],
    metadata: { 이름: '설정', model: 'custom/model-ID' },
    analysis: { purpose: '원문', triggers: ['세션'], tools: ['Read'], mcpServers: [], hooks: [], resources: [],
      sections: ['프로젝트'], links: [], usedBy: [], findings: [], lineCount: 3 },
  };
  const html = localized(<ExtensionAnalysisView detail={detail} onSelect={() => {}} />);
  expect(html).toContain('Role and purpose');
  expect(html).toContain('<p>원문</p>');
  expect(html).toContain('<dt>이름</dt>');
  expect(html).toContain('<dd>설정</dd>');
  expect(html).toContain('<li>세션</li>');
  expect(html).toContain('/프로젝트/원문/SKILL.md');
  expect(html).toContain('custom/model-ID');
  expect(html).toContain('Definition discovered in a Codex skill directory.');
});

function FormattingProbe() {
  const { dateTime, duration, money } = useFormat();
  return <p>{dateTime('2026-09-25T12:00:00Z', { month: 'long', day: 'numeric', timeZone: 'UTC' })}
    {' | '}{duration(90_000)}{' | '}{money(null)}</p>;
}

test('date, duration, and missing-value labels follow the active language', () => {
  const english = localized(<FormattingProbe />);
  expect(english).toContain('September');
  expect(english).toContain('1m 30s');
  expect(english).toContain('Not recorded');
  const korean = localized(<FormattingProbe />, 'ko');
  expect(korean).toContain('9월');
  expect(korean).toContain('1분 30초');
  expect(korean).toContain('미기록');
});
