import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DesktopApp, DesktopAppReport } from '../shared/desktop-apps.js';
import { DesktopAppsView, type DesktopAppsViewProps } from '../src/features/versions/DesktopApps';
import { createI18n, I18nContext, MESSAGES } from '../src/i18n/I18nProvider';
import { createNoticeTranslator, messageTemplate, translate, type Language } from '../src/i18n/core';
import { DESKTOP_EN_MESSAGES } from '../src/i18n/desktop.en';

function report(): DesktopAppReport {
  return {
    status: 'supported', platform: 'darwin', scope: 'server-host', demo: false,
    checkedAt: '2026-09-25T12:00:00.000Z', expiresAt: '2026-09-25T12:10:00.000Z', cacheTtlMs: 600000,
    items: ([
      { id: 'codex-app', agent: 'codex', name: 'Codex App', versionScope: 'app', bundle: 'Codex' },
      { id: 'claude-desktop', agent: 'claude', name: 'Claude Desktop', versionScope: 'app-container', bundle: 'Claude' },
      { id: 'kiro-ide', agent: 'kiro', name: 'Kiro IDE', versionScope: 'ide', bundle: 'Kiro' },
    ] as const).map(({ bundle, ...definition }): DesktopApp => ({
      ...definition, status: 'installed', installed: true,
      installations: [{
        path: `/Applications/${bundle}.app`, location: 'system',
        version: '1.2.3-beta.4', build: '00042', bundleIdentifier: `test.fixture.${definition.agent}`,
        metadataStatus: 'complete', issues: [],
        source: {
          type: 'info-plist', path: `/Applications/${bundle}.app/Contents/Info.plist`,
          keys: { version: 'CFBundleShortVersionString', build: 'CFBundleVersion', bundleIdentifier: 'CFBundleIdentifier' },
        },
      }],
      candidates: [{ path: `/Applications/${bundle}.app`, location: 'system', status: 'found', issues: [] }],
      unverified: { authentication: 'unverified', cloudChats: 'unverified', privateHistories: 'unverified', codeEngineVersion: 'unverified' },
    })),
  };
}

function render(overrides: Partial<DesktopAppsViewProps> = {}, language: Language = 'ko') {
  const messages = { ...MESSAGES, ...DESKTOP_EN_MESSAGES };
  return renderToStaticMarkup(createElement(I18nContext.Provider, {
    value: {
      ...createI18n(language), setLanguage: () => {},
      t: (source, values) => translate(language, source, messages, values),
      template: source => messageTemplate(language, source, messages),
      notice: createNoticeTranslator(language, messages),
    },
  }, createElement('form', null, createElement(DesktopAppsView, {
    report: report(), loading: false, refreshing: false, error: null, refresh: async () => {}, ...overrides,
  }))));
}

describe('desktop app inventory presentation', () => {
  it('explains why a ChatGPT.app with a different bundle identifier is excluded in both languages', () => {
    const state = report();
    state.items[0] = {
      ...state.items[0], status: 'not-installed', installed: false, installations: [],
      candidates: [{
        path: '/Applications/ChatGPT.app', location: 'system', status: 'not-found',
        issues: [{ code: 'bundle-identifier-mismatch', field: 'bundleIdentifier' }],
      }],
    };
    expect(render({ report: state })).toContain('번들 식별자가 이 앱과 일치하지 않습니다.');
    const english = render({ report: state }, 'en');
    expect(english).toContain('Bundle identifier does not match this app.');
    expect(english).toContain('/Applications/ChatGPT.app');
    expect(english).not.toMatch(/[가-힣]/u);
  });

  it('shows exact app metadata and provenance, labels the Claude container and Kiro IDE, and keeps refresh out of form submission', () => {
    const html = render();
    expect(html).toContain('macOS 데스크톱 앱');
    expect(html).toContain('Codex App');
    expect(html).toContain('Claude Desktop');
    expect(html).toContain('Kiro IDE');
    expect(html).toContain('앱/컨테이너 버전');
    expect(html).toContain('IDE 버전');
    expect(html).toContain('1.2.3-beta.4');
    expect(html).toContain('00042');
    expect(html).toContain('test.fixture.claude');
    expect(html).toContain('/Applications/Claude.app/Contents/Info.plist');
    expect(html).toContain('CFBundleShortVersionString');
    expect(html).toContain('CFBundleVersion');
    expect(html).toContain('CFBundleIdentifier');
    expect(html).toContain('서로 다릅니다');
    expect(html).toContain('내부 Code 엔진');
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).not.toContain('type="submit"');
    expect(html).not.toContain('업데이트 있음');
  });

  it('has equivalent English copy without translating observed metadata or installation paths', () => {
    const state = report();
    state.items[0].installations[0].path = '/Applications/사용자 경로.app';
    const html = render({ report: state }, 'en');
    expect(html).toContain('macOS desktop apps');
    expect(html).toContain('App/container version');
    expect(html).toContain('IDE version');
    expect(html).toContain('separate release streams');
    expect(html).toContain('Authentication');
    expect(html).toContain('unverified');
    expect(html).toContain('/Applications/사용자 경로.app');
    expect(render({}, 'en')).not.toMatch(/[가-힣]/u);
  });

  it('distinguishes unsupported server hosts from app absence and never suggests it inspected the browser user’s Mac', () => {
    const state = report();
    state.platform = 'linux';
    state.status = 'unsupported-host';
    state.items = state.items.map(item => ({ ...item, installed: null, status: 'unsupported-host', installations: [], candidates: [] }));
    const html = render({ report: state }, 'en');
    expect(html).toContain('linux');
    expect(html).toContain('server host');
    expect(html).toContain('does not inspect your Mac');
    expect(html).toContain('Unsupported host');
    expect(html).not.toContain('Not found in candidate locations');
    expect(html).not.toContain('1.2.3-beta.4');
  });

  it('keeps missing candidates and unknown metadata distinct from installed versions', () => {
    const state = report();
    state.items[0] = { ...state.items[0], installed: false, status: 'not-installed', installations: [] };
    state.items[1].installations[0] = {
      ...state.items[1].installations[0], version: null, metadataStatus: 'partial',
      issues: [{ code: 'field-missing', field: 'version' }],
    };
    const html = render({ report: state }, 'en');
    expect(html).toContain('Not found in candidate locations');
    expect(html).toContain('Unverified');
    expect(html).toContain('Some app metadata could not be verified');
    expect(html).toContain('00042');
    expect(html).not.toContain('Up to date');
  });

  it('retains previous metadata visibly after a failed refresh and disables the button while refreshing', () => {
    const html = render({ error: 'Desktop refresh fixture error' }, 'en');
    expect(html).toContain('1.2.3-beta.4');
    expect(html).toContain('previously checked');
    expect(html).toContain('Desktop refresh fixture error');
    const pending = render({ refreshing: true }, 'en');
    expect(pending).toMatch(/<button[^>]*disabled=""/);
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toContain('1.2.3-beta.4');
  });

  it('does not show absence during initial loading or expose host metadata in demo mode', () => {
    const pending = render({ report: null, loading: true }, 'en');
    expect(pending).toContain('Checking desktop apps');
    expect(pending).not.toContain('Not found in candidate locations');
    const demo = render({ demo: true }, 'en');
    expect(demo).toContain('Demo mode does not inspect desktop app installations');
    expect(demo).not.toContain('/Applications/Codex.app');
    expect(demo).not.toContain('1.2.3-beta.4');
  });

  it('shows all observed installations while preserving the first candidate as the displayed version', () => {
    const state = report();
    state.items[0].installations.push({
      ...state.items[0].installations[0], location: 'user', path: '/Users/Fixture User/Applications/Codex.app', version: '99.0.0',
    });
    const html = render({ report: state }, 'en');
    expect(html).toContain('1 other installation');
    expect(html).toContain('/Users/Fixture User/Applications/Codex.app');
    expect(html).toContain('99.0.0');
    expect(html).toContain('System Applications takes precedence');
  });
});
