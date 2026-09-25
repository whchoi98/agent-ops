import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nContext, createI18n } from '../src/i18n/I18nProvider';
import type { SyncStatus } from '../shared/sync-control';
import { SyncControls } from '../src/features/sync-controls/SyncControls';

const status: SyncStatus = {
  policy: { mode: 'idle', intervalSeconds: 60, maxSeconds: 120 }, demo: false, autoEnabled: true,
  activity: 'running', automaticState: 'scheduled', nextCheckAt: null,
  currentAttempt: { id: 'current', trigger: 'manual', startedAt: '2026-09-25T00:00:00Z', maxSeconds: 30 },
  lastAttempt: null,
};
function render(value: SyncStatus | null, language: 'ko' | 'en' = 'ko') {
  return renderToStaticMarkup(createElement(I18nContext.Provider, {
    value: { ...createI18n(language), setLanguage: () => {} },
  }, createElement(SyncControls, {
    status: value, syncing: value?.activity !== 'idle', stopping: value?.activity === 'stopping',
    onStart: async () => {}, onStop: async () => {}, now: Date.parse('2026-09-25T00:00:10Z'),
  })));
}

describe('sync controls presentation', () => {
  it('shows active elapsed time and the attempt budget separately from the next policy', () => {
    const html = render(status);
    expect(html).toContain('10초');
    expect(html).toContain('30초');
    expect(html).toContain('현재 동기화 중단');
    expect(html).toMatch(/disabled=""[^>]*>.*?지금 동기화/s);
  });

  it('keeps demo controls informational and disabled', () => {
    const html = render({ ...status, demo: true, activity: 'idle', currentAttempt: null, automaticState: 'disabled' });
    expect(html).toContain('데모에서는 원본 동기화를 실행하지 않습니다.');
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
  });

  it('distinguishes a stopped attempt without displaying invented import counts', () => {
    const html = render({
      ...status, activity: 'idle', currentAttempt: null,
      lastAttempt: { ...status.currentAttempt!, finishedAt: '2026-09-25T00:00:10Z', outcome: 'cancelled', error: 'Synchronization cancelled.' },
    }, 'en');
    expect(html).toContain('Sync cancelled');
    expect(html).not.toMatch(/[가-힣]/);
    expect(html).not.toContain('0 imported');
  });
});
