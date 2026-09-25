import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AppUpdateErrorCode, AppUpdateReport, AppUpdateStatus } from '../shared/app-update.js';
import { AppUpdate, AppUpdateView, type AppUpdateViewProps } from '../src/features/app-update/AppUpdate';
import { createI18n, I18nContext } from '../src/i18n/I18nProvider';
import type { Language } from '../src/i18n/core';
import { APP_UPDATE_EN_MESSAGES } from '../src/i18n/app-update.en';

const now = Date.parse('2026-09-25T12:00:00.000Z');

function report(overrides: Partial<AppUpdateReport> = {}): AppUpdateReport {
  return {
    currentVersion: '1.2.1', demo: false, status: 'update-available', checking: false,
    sourceUrl: 'https://api.github.com/repos/whchoi98/agent-ops/releases/latest',
    checkedAt: '2026-09-25T11:58:00.000Z', nextCheckAt: '2026-09-25T11:59:00.000Z', error: null,
    latest: {
      version: '1.3.0', tag: 'v1.3.0', publishedAt: '2026-09-24T00:00:00.000Z',
      releaseUrl: 'https://github.com/whchoi98/agent-ops/releases/tag/v1.3.0',
      archive: {
        name: 'agent-ops-local-1.3.0.tgz',
        url: 'https://github.com/whchoi98/agent-ops/releases/download/v1.3.0/agent-ops-local-1.3.0.tgz',
      },
    },
    commands: {
      npm: "npm install -g 'https://github.com/whchoi98/agent-ops/releases/download/v1.3.0/agent-ops-local-1.3.0.tgz'",
      git: "git fetch --no-tags 'https://github.com/whchoi98/agent-ops.git' 'refs/tags/v1.3.0' &&\ngit merge --ff-only FETCH_HEAD &&\nnpm ci &&\nnpm run build",
    },
    ...overrides,
  };
}

function render(overrides: Partial<AppUpdateViewProps> = {}, language: Language = 'en') {
  // No global dictionary registration is needed for this independently delivered feature.
  return renderToStaticMarkup(createElement(I18nContext.Provider, {
    value: { ...createI18n(language), setLanguage: () => {} },
  }, createElement('form', null, createElement(AppUpdateView, {
    report: report(), loading: false, checking: false, error: null,
    check: async () => {}, reload: () => {}, now, ...overrides,
  }))));
}

describe('workbench update presentation', () => {
  it('exports a demo-aware card that renders independently of Settings registration', () => {
    const html = renderToStaticMarkup(createElement(I18nContext.Provider, {
      value: { ...createI18n('en'), setLanguage: () => {} },
    }, createElement(AppUpdate, { demo: true })));
    expect(html).toContain('my-agent-ops updates');
    expect(html).toContain('Demo mode does not contact GitHub');
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).not.toContain('npm install -g');
  });

  it('identifies the running workbench version separately and shows source, release and timestamps', () => {
    const html = render();
    expect(html).toContain('my-agent-ops updates');
    expect(html).toContain('Running app version');
    expect(html).toContain('coding CLI and desktop app versions');
    expect(html).toContain('1.2.1');
    expect(html).toContain('1.3.0');
    expect(html).toContain('Update available');
    expect(html).toMatch(/datetime="2026-09-25T11:58:00.000Z"/i);
    expect(html).toMatch(/datetime="2026-09-24T00:00:00.000Z"/i);
    expect(html).toContain('https://api.github.com/repos/whchoi98/agent-ops/releases/latest');
    expect(html).toContain('href="https://github.com/whchoi98/agent-ops/releases/tag/v1.3.0"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).not.toContain('type="submit"');
    expect(html).not.toMatch(/[가-힣]/u);
  });

  it('offers copy buttons and exact commands with stop, server-terminal and startup-setting instructions', () => {
    const html = render();
    expect(html).toContain('Copy npm update command');
    expect(html).toContain('Copy Git update commands');
    expect(html).toContain('npm install -g &#x27;https://github.com/whchoi98/agent-ops/releases/download/v1.3.0/agent-ops-local-1.3.0.tgz&#x27;');
    expect(html).toContain('git merge --ff-only FETCH_HEAD');
    expect(html).toContain('npm ci');
    expect(html).toContain('npm run build');
    expect(html).toContain('Ctrl+C');
    expect(html).toContain('server terminal');
    expect(html).toContain('data directory');
    expect(html).toContain('environment variables');
    expect(html).toContain('--data-dir');
    expect(html).toContain('--port');
    expect(html).toContain('--public-url');
    expect(html).toContain('previous startup command');
    expect(html).toContain('does not install or restart');
  });

  it('keeps valid release and Git instructions without offering an unvalidated npm archive', () => {
    const value = report();
    value.latest!.archive = null;
    value.commands.npm = null;
    const html = render({ report: value });
    expect(html).toContain('Update available');
    expect(html).toContain('View release');
    expect(html).toContain('No validated npm archive is available');
    expect(html).toContain('Copy Git update commands');
    expect(html).not.toContain('Copy npm update command');
    expect(html).not.toContain('npm install -g');
  });

  it.each([
    ['not-checked', 'Not checked'],
    ['current', 'Up to date'],
    ['ahead', 'Ahead of the public release'],
    ['unavailable', 'Release unavailable'],
  ] as Array<[AppUpdateStatus, string]>)('does not offer updates in %s state', (status, label) => {
    const html = render({ report: report({ status }) });
    expect(html).toContain(label);
    expect(html).not.toContain('npm install -g');
    expect(html).not.toContain('git fetch');
    expect(html).not.toMatch(/[가-힣]/u);
  });

  it('distinguishes initial loading from a successful current-version check', () => {
    const html = render({ report: null, loading: true });
    expect(html).toContain('Loading app update information');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).not.toContain('Up to date');
    expect(html).not.toContain('npm install -g');
  });

  it.each(['local', 'server'])('disables repeated checks and command copying during a %s check', source => {
    const html = render({
      checking: source === 'local', report: report({ checking: source === 'server' }),
    });
    expect(html).toContain('Checking app release');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).not.toContain('Copy npm update command');
    expect(html).not.toContain('Copy Git update commands');
  });

  it('shows the earliest next check and re-enables the action once cooldown expires', () => {
    const value = report({ nextCheckAt: '2026-09-25T12:00:45.000Z' });
    const waiting = render({ report: value });
    expect(waiting).toContain('Next check allowed');
    expect(waiting).toMatch(/datetime="2026-09-25T12:00:45.000Z"/i);
    expect(waiting).toContain('45 seconds');
    expect(waiting).toMatch(/<button[^>]*disabled=""/);
    expect(render({ report: value, now: now + 45_000 })).not.toContain('disabled=""');
  });

  it('shows a local API error and a cache-only retry while withholding stale install commands', () => {
    const html = render({ error: '서버 응답을 읽지 못했습니다. 새로고침 후 다시 시도하세요.' });
    expect(html).toContain('Could not load app update information');
    expect(html).toContain('Reload cached status');
    expect(html).toContain('previously checked release');
    expect(html).toContain('Release unavailable');
    expect(html).toContain('1.2.1');
    expect(html).not.toContain('npm install -g');
    expect(html).not.toMatch(/[가-힣]/u);
  });

  it('shows a cache retry when observation times out instead of keeping the progress error hidden', () => {
    const html = render({
      report: report({ checking: true }),
      error: '확인 중 상태가 계속됩니다. 캐시 상태를 다시 불러오세요.',
    });
    expect(html).toContain('The check is still in progress');
    expect(html).toContain('Reload cached status');
    expect(html).toContain('Release unavailable');
    expect(html).not.toContain('Checking app release');
    expect(html).not.toContain('npm install -g');
  });

  it.each([
    ['invalid-current-version', 'SemVer'],
    ['invalid-release', 'Release metadata'],
    ['request-failed', 'Could not fetch'],
    ['redirect-rejected', 'redirect'],
    ['response-too-large', '256 KiB'],
    ['timeout', '8-second'],
    ['closed', 'closed'],
  ] as Array<[AppUpdateErrorCode, string]>)('explains %s errors in both languages', (error, expected) => {
    const value = report({ status: 'unavailable', latest: null, error });
    const english = render({ report: value });
    expect(english).toContain(expected);
    expect(english).toContain('role="alert"');
    expect(english).not.toMatch(/[가-힣]/u);
    const korean = render({ report: value }, 'ko');
    expect(korean).toContain('릴리스 확인 불가');
    expect(korean).toMatch(/[가-힣]/u);
    expect(korean).not.toContain(error);
  });

  it.each(['prop', 'report'])('makes demo mode from the %s non-actionable and suppresses release metadata', source => {
    const html = render({ demo: source === 'prop', report: report({ demo: source === 'report' }) });
    expect(html).toContain('Demo mode');
    expect(html).toContain('does not contact GitHub');
    expect(html).toContain('1.2.1');
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).not.toContain('1.3.0');
    expect(html).not.toContain('npm install -g');
    expect(html).not.toContain('git fetch');
    expect(html).not.toContain('View release');
    expect(html).not.toMatch(/[가-힣]/u);
  });

  it('keeps Korean and English instructions equivalent without middle dots or em dashes', () => {
    const korean = render({}, 'ko');
    expect(korean).toContain('my-agent-ops 업데이트');
    expect(korean).toContain('서버 터미널');
    expect(korean).toContain('데이터 디렉터리');
    expect(korean).toContain('환경 변수');
    expect(korean).toContain('Ctrl+C');
    expect(korean).toContain('--public-url');
    expect(korean).not.toMatch(/[·—]/u);
    expect(render()).not.toMatch(/[·—]/u);
    for (const [source, target] of Object.entries(APP_UPDATE_EN_MESSAGES)) {
      expect(source.match(/\{\w+\}/g)?.sort() ?? []).toEqual(target.match(/\{\w+\}/g)?.sort() ?? []);
      expect(target).not.toMatch(/[가-힣·—]/u);
      expect(source).not.toMatch(/[·—]/u);
    }
  });
});
