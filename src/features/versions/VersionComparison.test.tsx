import { expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConnectorVersion } from '../../../shared/versions';
import { VersionComparison } from './VersionComparison';
import { VersionSection } from './VersionSection';
import type { VersionSnapshot } from './types';
import { VersionService } from '../../../server/versions';

function snapshot(version: Partial<ConnectorVersion> = {}, state: Partial<VersionSnapshot> = {}): VersionSnapshot {
  return {
    report: {
      items: [{
        agent: 'codex', installed: true, currentVersion: '1.2.3', currentRaw: 'codex-cli 1.2.3',
        latestVersion: '1.3.0', status: 'update-available', checkedAt: '2026-09-25T08:00:00Z',
        sourceUrl: 'https://registry.npmjs.org/@openai/codex/latest',
        releaseUrl: 'https://github.com/openai/codex/releases', channel: 'npm latest', error: null,
        ...version,
      }],
      demo: false, notice: '',
    },
    loading: false, checking: false, error: null, ...state,
  };
}

test('compares actual current and latest numbers with source, channel and check time', () => {
  const html = renderToStaticMarkup(<VersionComparison agent="codex" state={snapshot()} />);
  expect(html).toContain('현재 버전');
  expect(html).toContain('최신 버전');
  expect(html).toContain('1.2.3');
  expect(html).toContain('1.3.0');
  expect(html).toContain('업데이트 있음');
  expect(html).toContain('npm latest');
  expect(html).toContain('href="https://registry.npmjs.org/@openai/codex/latest"');
  expect(html).toMatch(/datetime="2026-09-25T08:00:00Z"/i);
});

test('a failed latest lookup keeps the installed number and does not claim currency', () => {
  const html = renderToStaticMarkup(<VersionComparison agent="codex" state={snapshot({
    latestVersion: null, status: 'check-failed', error: '공개 메타데이터 조회 시간 초과',
  })} />);
  expect(html).toContain('1.2.3');
  expect(html).toContain('조회 실패');
  expect(html).toContain('확인 불가');
  expect(html).toContain('공개 메타데이터 조회 시간 초과');
  expect(html).not.toContain('최신 상태');
});

test('a failed refresh retains the last comparison and marks it as previously checked', () => {
  const html = renderToStaticMarkup(<VersionComparison agent="codex"
    state={snapshot({ currentVersion: '1.3.0', status: 'current' }, { error: '서버 연결 실패' })} />);
  expect(html).toContain('1.3.0');
  expect(html).toContain('조회 실패');
  expect(html).toContain('이전 확인 값');
  expect(html).not.toContain('최신 상태');
});

test('an installed version ahead of the public channel is not offered as an update', () => {
  const html = renderToStaticMarkup(<VersionComparison agent="codex" state={snapshot({
    currentVersion: '2.0.0-beta.2', status: 'ahead',
  })} />);
  expect(html).toContain('2.0.0-beta.2');
  expect(html).toContain('1.3.0');
  expect(html).toContain('공개 최신보다 새 버전');
  expect(html).toContain('다른 배포 채널');
  expect(html).not.toContain('업데이트 있음');
});

test('missing and unparseable installations are distinguished from current', () => {
  const missing = renderToStaticMarkup(<VersionComparison agent="codex" state={snapshot({
    installed: false, currentVersion: null, currentRaw: null, status: 'not-installed',
  })} />);
  expect(missing).toContain('미설치');
  expect(missing).toContain('1.3.0');
  expect(missing).not.toContain('최신 상태');
  const unknown = renderToStaticMarkup(<VersionComparison agent="codex" state={snapshot({
    currentVersion: null, currentRaw: 'codex-cli development build', status: 'unknown',
  })} />);
  expect(unknown).toContain('비교 불가');
  expect(unknown).toContain('codex-cli development build');
  expect(unknown).not.toContain('최신 상태');
});

test('a current status without both version numbers cannot become a positive comparison', () => {
  const html = renderToStaticMarkup(<VersionComparison agent="codex" state={snapshot({
    currentVersion: null, currentRaw: null, latestVersion: null, status: 'current',
  })} />);
  expect(html).toContain('비교 불가');
  expect(html).not.toContain('최신 상태');
});

test('page loading or a missing report keeps the bootstrap CLI number visible', () => {
  const html = renderToStaticMarkup(<VersionComparison agent="codex"
    connector={{ installed: true, version: 'codex-cli 0.125.2' }}
    state={{ report: null, loading: true, checking: false, error: null }} />);
  expect(html).toContain('0.125.2');
  expect(html).toContain('확인 중');
  expect(html).not.toContain('미설치');
});

test('demo comparison numbers are explicitly marked as samples', () => {
  const state = snapshot();
  state.report!.demo = true;
  const html = renderToStaticMarkup(<VersionComparison agent="codex" state={state} />);
  expect(html).toContain('1.2.3');
  expect(html).toContain('1.3.0');
  expect(html).toContain('데모 샘플');
});

test('source and release URLs cannot create active or credential-bearing links', () => {
  for (const url of ['javascript:alert(1)', 'file:///private/metadata', 'https://fixture-user:fixture-value@example.com/latest']) {
    const html = renderToStaticMarkup(<VersionComparison agent="codex" state={snapshot({
      sourceUrl: url, releaseUrl: url,
    })} />);
    expect(html).toContain('1.2.3');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('fixture-value');
  }
});

test('the version refresh action remains a button inside the existing settings form', () => {
  const html = renderToStaticMarkup(<form>
    <VersionSection state={{ ...snapshot(), check: async () => {} }}><p>설정 입력 영역</p></VersionSection>
  </form>);
  expect(html).toContain('aria-label="CLI 버전 비교"');
  expect(html).toMatch(/<button[^>]*type="button"[^>]*>[\s\S]*?최신 버전 확인/);
  expect(html).not.toContain('type="submit"');
  expect(html).toContain('설정 입력 영역');
});

test.each(['rejected', 'missing'] as const)('keeps unknown %s probe information distinct from confirmed absence', async kind => {
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    const data = url.includes('@openai/codex')
      ? { name: '@openai/codex', version: '0.157.0' }
      : url.includes('@anthropic-ai/claude-code')
        ? { name: '@anthropic-ai/claude-code', version: '2.1.282' }
        : { version: '2.24.0', packages: [{ channel: 'stable' }] };
    return new Response(JSON.stringify(data));
  };
  const report = await new VersionService({ fetcher }, async () => {
    if (kind === 'rejected') throw new Error('fixture probe failure');
    return [];
  }).report();
  expect(report.items[0].status).toBe('unknown');
  expect(report.items[0].installed).toBeNull();
  const html = renderToStaticMarkup(<VersionComparison agent="codex"
    connector={{ installed: true, version: 'codex-cli 0.136.0' }}
    state={{ report, loading: false, checking: false, error: null }} />);
  expect(html).not.toContain('미설치');
  expect(html).toContain('0.136.0');
  expect(html).toContain('비교 불가');
  expect(html).toContain('이전 확인 값');
  const withoutPrevious = renderToStaticMarkup(<VersionComparison agent="codex"
    state={{ report, loading: false, checking: false, error: null }} />);
  expect(withoutPrevious).not.toContain('미설치');
  expect(withoutPrevious).toContain('확인 불가');
});
