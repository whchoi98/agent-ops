import { beforeEach, expect, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { SessionTable } from '../../components/SessionTable';
import { SessionInfo } from '../sessions/SessionMetadata';
import { Overview } from '../../pages/Overview';
import { Analytics } from '../../pages/Analytics';
import { Projects } from '../../pages/Projects';
import { Runs } from '../../pages/Runs';
import { Sessions } from '../../pages/Sessions';
import { createI18n, I18nContext } from '../../i18n/I18nProvider';
import { creditBootstrap, creditSession } from './testFixtures';

const state = vi.hoisted(() => ({ data: null as ReturnType<typeof creditBootstrap> | null, search: '' }));

// Replace app state and its effects, while rendering the actual usage consumers.
vi.mock('../../state/AppProvider', () => ({
  useData: () => state.data,
  useApp: () => ({
    data: state.data, page: 'sessions', search: state.search, navigate: () => {},
    error: null, loading: false, refreshing: false, refresh: async () => {}, archiveRevision: 0,
    connection: 'connected', syncing: false, sync: async () => {}, themeSaving: false, setTheme: async () => {},
    modal: null, closeModal: () => {}, openSession: () => {}, openRun: () => {}, openNewRun: () => {},
    openCompare: () => {}, paletteOpen: false, setPaletteOpen: () => {}, subscribe: () => () => {},
    notify: () => {}, toasts: [], dismissToast: () => {},
  }),
}));

function render(children: ReactNode, language: 'ko' | 'en' = 'en') {
  return renderToStaticMarkup(<I18nContext.Provider value={{ ...createI18n(language), setLanguage: () => {} }}>
    {children}
  </I18nContext.Provider>);
}

function text(html: string) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');
}

beforeEach(() => {
  state.data = creditBootstrap();
  state.search = '';
});

test('session rows use fractional Kiro credits as their primary measurement', () => {
  const html = render(<SessionTable sessions={[creditSession()]} />);
  expect(text(html)).toContain('0.125');
  expect(text(html)).toContain('credits');
  expect(html).toContain('Partial record');
  expect(html).not.toContain('Input 100');
});

test.each(['codex', 'claude'] as const)('session rows retain tokens for %s even with an unexpected credit field', agent => {
  const html = render(<SessionTable sessions={[creditSession({ credits: 999 }, { agent })]} />);
  expect(text(html)).toContain('120');
  expect(text(html)).toContain('Tokens');
  expect(html).not.toContain('999');
});

test.each([
  { credits: 0.125, expected: '0.125* credits' },
  { credits: 0, expected: '0* credits' },
  { credits: undefined, expected: 'Not recorded credits' },
] as const)('session metadata preserves raw tokens beside credit detail: $credits', ({ credits, expected }) => {
  const html = render(<SessionInfo session={creditSession({ credits })} />);
  const creditDetail = html.match(/<dt>Recorded Kiro credits<\/dt><dd>([\s\S]*?)<\/dd>/)?.[1];
  expect(text(creditDetail ?? '')).toBe(expected);
  expect(text(html)).toContain('Total tokens120');
  expect(text(html)).toContain('Input tokens100');
  expect(text(html)).toContain('Output tokens20');
});

test.each([['Overview', Overview], ['Analytics', Analytics]] as const)('%s adds separate credit totals and Kiro coverage without hiding tokens or USD', (_name, Page) => {
  const html = render(<Page />);
  const summary = html.match(/<section class="panel credit-summary"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? '';
  expect(text(summary)).toContain('Recorded Kiro credits');
  expect(text(summary)).toContain('0.125');
  expect(text(summary)).toContain('2/3 Kiro sessions recorded');
  expect(text(summary)).toContain('1 partial');
  expect(text(html)).toContain('Recorded tokens');
  expect(text(html)).toContain('$1.50');
  const titles = [...html.matchAll(/<title(?:\s[^>]*)?>(.*?)<\/title>/g)].map(match => match[1]);
  expect(titles.length).toBeGreaterThan(0);
  expect(titles.every(title => title.length > 0 && !title.includes('[object Object]'))).toBe(true);
});

test('analytics keeps overflow distinct from zero and retains the observed coverage', () => {
  state.data!.analytics.recordedCredits = null;
  const html = render(<Analytics />);
  expect(text(html)).toContain('Total overflow');
  expect(text(html)).toContain('2/3 Kiro sessions recorded');
  expect(text(html)).not.toContain('NaN');
  expect(text(html)).not.toContain('Infinity');
});

test('analytics shows independently labelled credits for agent, project, model and session-start-date groups', () => {
  const html = render(<Analytics />);
  expect(text(html)).toContain('Session start date (UTC)');
  expect(text(html)).toContain('Daily Kiro credits');
  expect(html.match(/2\/3 Kiro sessions recorded/g)?.length).toBeGreaterThanOrEqual(5);
  expect(html).not.toMatch(/[가-힣]/u);
});

test('project cards show separate Kiro credits and coverage alongside token totals', () => {
  const html = render(<Projects />);
  expect(text(html)).toContain('Recorded Kiro credits');
  expect(text(html)).toContain('0.125');
  expect(text(html)).toContain('2/3 Kiro sessions recorded');
  expect(text(html)).toContain('360');
  expect(text(html)).toContain('Tokens');
});

test('a resumed Kiro run displays only its own missing credits', () => {
  state.data!.sessions[0].usage.credits = 987.625;
  const html = render(<Runs />);
  expect(text(html)).toContain('Not recorded');
  expect(text(html)).toContain('credits');
  expect(html).not.toContain('987.625');
});

test('session credit sorting survives URL parsing and has an English option', () => {
  state.search = '?sort=credits';
  const html = render(<Sessions />);
  expect(html).toMatch(/<option value="credits" selected="">[^<]*Credits/);
  expect(html).not.toMatch(/[가-힣]/u);
});
