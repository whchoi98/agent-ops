import { afterEach, describe, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
import { access, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopAppService, type DesktopAppServiceOptions, type PlistConverter } from '../server/desktop-apps.js';

const temporary: string[] = [];
const metadata = {
  CFBundleShortVersionString: '2026.09.25-beta.1',
  CFBundleVersion: '000042',
  CFBundleIdentifier: 'test.fixture.codex',
};

function plistValue(value: unknown): string {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (Array.isArray(value)) return `<array>${value.map(plistValue).join('')}</array>`;
  if (value && typeof value === 'object') {
    return `<dict>${Object.entries(value).map(([key, child]) => `<key>${escape(key)}</key>${plistValue(child)}`).join('')}</dict>`;
  }
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (typeof value === 'number') return `<integer>${value}</integer>`;
  return `<string>${escape(String(value ?? 'invalid converter output fixture'))}</string>`;
}

async function fixture(options: DesktopAppServiceOptions = {}) {
  const base = await mkdtemp(join(tmpdir(), 'agent-ops-desktop-'));
  temporary.push(base);
  const applicationsDir = join(base, 'System Applications');
  const homeDir = join(base, 'Current User');
  const userApplications = join(homeDir, 'Applications');
  await Promise.all([mkdir(applicationsDir), mkdir(userApplications, { recursive: true })]);
  const conversions: Buffer[] = [];
  const outputs = new Map<string, string>();
  const converter: PlistConverter = async input => {
    conversions.push(Buffer.from(input));
    const output = outputs.get(input.toString('base64'));
    if (output === undefined) throw new Error('Unexpected fixture input');
    return output;
  };
  async function bundle(name = 'Codex.app', location = applicationsDir, properties: unknown = metadata, raw?: Buffer) {
    const path = join(location, name);
    const plistPath = join(path, 'Contents', 'Info.plist');
    await mkdir(join(path, 'Contents'), { recursive: true });
    const input = raw ?? Buffer.from(`<?xml version="1.0"?><!-- fixture ${outputs.size} --><plist version="1.0">${plistValue(properties)}</plist>`);
    outputs.set(input.toString('base64'), JSON.stringify(properties));
    await writeFile(plistPath, input);
    return { path, plistPath, input };
  }
  const service = new DesktopAppService({ platform: 'darwin', applicationsDir, homeDir, converter, ...options });
  return { base, homeDir, applicationsDir, userApplications, bundle, conversions, outputs, service };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('bounded desktop app inventory', () => {
  it('reads exact app version, build and identifier from separate plist keys without running the app', async () => {
    const f = await fixture();
    const codex = await f.bundle();
    const marker = join(f.base, 'app-was-executed');
    await mkdir(join(codex.path, 'Contents', 'MacOS'));
    await writeFile(join(codex.path, 'Contents', 'MacOS', 'Codex'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await f.bundle('Claude.app', f.userApplications, {
      CFBundleShortVersionString: '1.0.1234', CFBundleVersion: '1234.5', CFBundleIdentifier: 'test.fixture.claude',
      CodeEngineVersion: 'must-not-be-imported', Authentication: 'fixture-private-value',
    });
    await f.bundle('Kiro.app', f.applicationsDir, {
      CFBundleShortVersionString: '0.9.7', CFBundleVersion: '20260925', CFBundleIdentifier: 'test.fixture.kiro',
    });
    const report = await f.service.report();
    expect(report).toMatchObject({ status: 'supported', platform: 'darwin', scope: 'server-host', demo: false, cacheTtlMs: 600000 });
    expect(report.items.map(item => [item.id, item.versionScope])).toEqual([
      ['codex-app', 'app'], ['claude-desktop', 'app-container'], ['kiro-ide', 'ide'],
    ]);
    expect(report.items[0]).toMatchObject({ status: 'installed', installed: true });
    expect(report.items[0].installations).toEqual([{
      path: codex.path, location: 'system', version: '2026.09.25-beta.1', build: '000042',
      bundleIdentifier: 'test.fixture.codex', metadataStatus: 'complete', issues: [],
      source: {
        type: 'info-plist', path: codex.plistPath,
        keys: { version: 'CFBundleShortVersionString', build: 'CFBundleVersion', bundleIdentifier: 'CFBundleIdentifier' },
      },
    }]);
    expect(report.items[1].installations[0].version).toBe('1.0.1234');
    expect(report.items[2].installations[0].version).toBe('0.9.7');
    for (const item of report.items) {
      expect(item.unverified).toEqual({
        authentication: 'unverified', cloudChats: 'unverified', privateHistories: 'unverified', codeEngineVersion: 'unverified',
      });
      expect(item.candidates).toHaveLength(item.id === 'codex-app' ? 4 : 2);
    }
    expect(JSON.stringify(report)).not.toMatch(/fixture-private-value|must-not-be-imported|latestVersion/);
    await expect(access(marker, constants.F_OK)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(codex.plistPath)).toEqual(codex.input);
    expect(f.conversions).toHaveLength(3);
  });

  it('passes XML and binary bytes unchanged to the injected plist converter', async () => {
    const f = await fixture();
    const xml = Buffer.from('<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleVersion</key><string>001</string></dict></plist>');
    // A binary plist containing {"CFBundleVersion": "001"}.
    const binary = Buffer.from('YnBsaXN0MDDRAQJfEA9DRkJ1bmRsZVZlcnNpb25TMDAxCAsdAAAAAAAAAQEAAAAAAAAAAwAAAAAAAAAAAAAAAAAAACE=', 'base64');
    await f.bundle('Codex.app', f.applicationsDir, { CFBundleVersion: '001' }, xml);
    await f.bundle('Claude.app', f.applicationsDir, { CFBundleVersion: '001' }, binary);
    const report = await f.service.report();
    expect(f.conversions).toEqual([xml, binary]);
    expect(report.items[0].installations[0]).toMatchObject({ version: null, build: '001', metadataStatus: 'partial' });
    expect(report.items[1].installations[0]).toMatchObject({ version: null, build: '001', metadataStatus: 'partial' });
  });

  it('checks only eight fixed candidates and never searches other homes, nested folders or other renamed apps', async () => {
    const f = await fixture();
    await f.bundle('Codex.app', join(f.base, 'Other User', 'Applications'));
    await f.bundle('Claude.app', join(f.homeDir, 'Downloads'));
    await f.bundle('Kiro.app', join(f.applicationsDir, 'Nested'));
    await f.bundle('Codex Preview.app');
    await f.bundle('Claude Code.app');
    await f.bundle('Kiro CLI.app');
    const report = await f.service.report();
    expect(report.items.every(item => item.status === 'not-installed' && item.installed === false)).toBe(true);
    expect(report.items.flatMap(item => item.candidates.map(candidate => candidate.path))).toEqual([
      join(f.applicationsDir, 'Codex.app'), join(f.applicationsDir, 'ChatGPT.app'),
      join(f.userApplications, 'Codex.app'), join(f.userApplications, 'ChatGPT.app'),
      join(f.applicationsDir, 'Claude.app'), join(f.userApplications, 'Claude.app'),
      join(f.applicationsDir, 'Kiro.app'), join(f.userApplications, 'Kiro.app'),
    ]);
    expect(f.conversions).toEqual([]);
  });

  it('uses system then user precedence without selecting a numerically newer or more complete copy', async () => {
    const f = await fixture();
    const system = await f.bundle('Codex.app', f.applicationsDir, { CFBundleVersion: '10' });
    const user = await f.bundle('Codex.app', f.userApplications, {
      CFBundleShortVersionString: '99.0', CFBundleVersion: '99', CFBundleIdentifier: 'test.fixture.codex',
    });
    const report = await f.service.report();
    expect(report.items[0].installations.map(item => item.path)).toEqual([system.path, user.path]);
    expect(report.items[0].installations[0]).toMatchObject({ version: null, build: '10', metadataStatus: 'partial' });
    expect(report.items[0].candidates.map(item => item.status)).toEqual(['found', 'not-found', 'found', 'not-found']);
    expect(f.conversions).toHaveLength(2);
  });

  it.each(['system', 'user'] as const)('recognizes Codex in %s ChatGPT.app by its exact bundle identifier', async location => {
    const f = await fixture();
    const app = await f.bundle('ChatGPT.app', location === 'system' ? f.applicationsDir : f.userApplications, {
      ...metadata, CFBundleIdentifier: 'com.openai.codex', CFBundleName: 'ChatGPT',
    });
    const item = (await f.service.report()).items[0];
    expect(item).toMatchObject({ id: 'codex-app', name: 'Codex App', installed: true, status: 'installed' });
    expect(item.installations).toEqual([expect.objectContaining({
      path: app.path, location, version: '2026.09.25-beta.1', build: '000042',
      bundleIdentifier: 'com.openai.codex', metadataStatus: 'complete',
      source: expect.objectContaining({ path: app.plistPath }),
    })]);
    expect(await readFile(app.plistPath)).toEqual(app.input);
  });

  it.each(['com.openai.chat', 'com.openai.codex.preview'])('excludes ChatGPT.app with a different identifier: %s', async identifier => {
    const f = await fixture();
    const app = await f.bundle('ChatGPT.app', f.applicationsDir, { ...metadata, CFBundleIdentifier: identifier });
    const item = (await f.service.report()).items[0];
    expect(item).toMatchObject({ installed: false, status: 'not-installed', installations: [] });
    expect(item.candidates.find(candidate => candidate.path === app.path)).toMatchObject({
      status: 'not-found', issues: [{ code: 'bundle-identifier-mismatch', field: 'bundleIdentifier' }],
    });
    expect(JSON.stringify(item)).not.toContain('2026.09.25-beta.1');
  });

  it.each([
    { properties: { CFBundleShortVersionString: '1.2.3', CFBundleVersion: '001' }, issue: 'field-missing' },
    { properties: { ...metadata, CFBundleIdentifier: 'invalid/identifier' }, issue: 'field-invalid' },
  ])('keeps ChatGPT.app identity unverified when its identifier is $issue', async ({ properties, issue }) => {
    const f = await fixture();
    const app = await f.bundle('ChatGPT.app', f.applicationsDir, properties);
    const item = (await f.service.report()).items[0];
    expect(item).toMatchObject({ installed: null, status: 'unverified', installations: [] });
    expect(item.candidates.find(candidate => candidate.path === app.path)).toMatchObject({
      status: 'unverified', issues: [{ code: issue, field: 'bundleIdentifier' }],
    });
  });

  it('does not infer Codex identity from ChatGPT.app when its plist cannot be read', async () => {
    const f = await fixture();
    const app = await f.bundle('ChatGPT.app', f.applicationsDir, { ...metadata, CFBundleIdentifier: 'com.openai.codex' });
    await rm(app.plistPath);
    const item = (await f.service.report()).items[0];
    expect(item).toMatchObject({ installed: null, status: 'unverified', installations: [] });
    expect(item.candidates.find(candidate => candidate.path === app.path)).toMatchObject({
      status: 'unverified', issues: [{ code: 'plist-missing' }],
    });
  });

  it('preserves system and legacy-name precedence while listing matching aliases in both roots', async () => {
    const f = await fixture();
    const systemCodex = await f.bundle('Codex.app');
    const systemAlias = await f.bundle('ChatGPT.app', f.applicationsDir, { ...metadata, CFBundleIdentifier: 'com.openai.codex' });
    const userCodex = await f.bundle('Codex.app', f.userApplications);
    const userAlias = await f.bundle('ChatGPT.app', f.userApplications, { ...metadata, CFBundleIdentifier: 'com.openai.codex' });
    expect((await f.service.report()).items[0].installations.map(item => item.path))
      .toEqual([systemCodex.path, systemAlias.path, userCodex.path, userAlias.path]);
  });

  it('retains unknown version fields after the ChatGPT.app identifier establishes Codex identity', async () => {
    const f = await fixture();
    await f.bundle('ChatGPT.app', f.applicationsDir, { CFBundleIdentifier: 'com.openai.codex', CFBundleVersion: '001' });
    const item = (await f.service.report()).items[0];
    expect(item).toMatchObject({ installed: true, status: 'installed' });
    expect(item.installations[0]).toMatchObject({
      version: null, build: '001', bundleIdentifier: 'com.openai.codex', metadataStatus: 'partial',
      issues: [{ code: 'field-missing', field: 'version' }],
    });
  });

  it('rechecks alias identity only on refresh after a cached different-app result', async () => {
    const f = await fixture();
    await f.bundle('ChatGPT.app', f.applicationsDir, { ...metadata, CFBundleIdentifier: 'com.openai.chat' });
    expect((await f.service.report()).items[0].installed).toBe(false);
    await f.bundle('ChatGPT.app', f.applicationsDir, { ...metadata, CFBundleIdentifier: 'com.openai.codex' });
    expect((await f.service.report()).items[0].installed).toBe(false);
    expect((await f.service.refresh()).items[0]).toMatchObject({ installed: true, status: 'installed' });
  });

  it.each(['linux', 'win32', 'freebsd'] as const)('reports unsupported-host on %s even when bundles exist in injected roots', async platform => {
    const f = await fixture({ platform });
    await f.bundle();
    const report = await f.service.report();
    expect(report).toMatchObject({ status: 'unsupported-host', platform, scope: 'server-host' });
    expect(report.items.every(item => item.status === 'unsupported-host' && item.installed === null)).toBe(true);
    expect(report.items.every(item => item.installations.length === 0 && item.candidates.length === 0)).toBe(true);
    expect(f.conversions).toEqual([]);
  });

  it('keeps demo inventory unverified without inspecting real bundles', async () => {
    const f = await fixture({ demo: true });
    await f.bundle();
    const report = await f.service.refresh();
    expect(report).toMatchObject({ status: 'demo', demo: true });
    expect(report.items.every(item => item.status === 'unverified' && item.installed === null && !item.candidates.length)).toBe(true);
    expect(f.conversions).toEqual([]);
  });

  it('distinguishes absent application roots from unreadable or unsafe roots', async () => {
    const f = await fixture();
    await rm(f.userApplications, { recursive: true });
    await rm(f.applicationsDir, { recursive: true });
    expect((await f.service.report()).items[0]).toMatchObject({ status: 'not-installed', installed: false });
    await writeFile(f.applicationsDir, 'not a directory');
    const report = await f.service.refresh();
    expect(report.items[0]).toMatchObject({ status: 'unverified', installed: null });
    expect(report.items[0].candidates[0]).toMatchObject({ status: 'unverified', issues: [{ code: 'unsafe-path' }] });
    expect(f.conversions).toEqual([]);
  });

  it.each(['root', 'bundle', 'contents', 'plist', 'hardlink'] as const)('rejects a %s escape without converting data outside the owning root', async kind => {
    const f = await fixture();
    const outside = await f.bundle('Codex.app', join(f.base, 'Outside'));
    const target = join(f.applicationsDir, 'Codex.app');
    if (kind === 'root') {
      await rm(f.applicationsDir, { recursive: true });
      await symlink(join(f.base, 'Outside'), f.applicationsDir);
    } else if (kind === 'bundle') {
      await symlink(outside.path, target);
    } else if (kind === 'contents') {
      await mkdir(target);
      await symlink(join(outside.path, 'Contents'), join(target, 'Contents'));
    } else {
      await mkdir(join(target, 'Contents'), { recursive: true });
      if (kind === 'plist') await symlink(outside.plistPath, join(target, 'Contents', 'Info.plist'));
      else await link(outside.plistPath, join(target, 'Contents', 'Info.plist'));
    }
    const report = await f.service.report();
    expect(f.conversions).toEqual([]);
    expect(report.items[0].status).not.toBe('not-installed');
    expect(report.items[0].installations.every(item => item.version === null)).toBe(true);
    expect(JSON.stringify(report.items[0])).toContain('unsafe-path');
    expect(JSON.stringify(report)).not.toContain(outside.plistPath);
  });

  it('rejects links to another allowed root but still discovers that root independently', async () => {
    const f = await fixture();
    const user = await f.bundle('Codex.app', f.userApplications);
    await symlink(user.path, join(f.applicationsDir, 'Codex.app'));
    const report = await f.service.report();
    expect(report.items[0].installations.map(item => item.path)).toEqual([user.path]);
    expect(report.items[0].candidates[0].status).toBe('unverified');
    expect(f.conversions).toHaveLength(1);
  });

  it('keeps installed presence with unknown metadata when Info.plist is missing or malformed', async () => {
    const f = await fixture();
    const missing = await f.bundle();
    await rm(missing.plistPath);
    const malformed = await f.bundle('Claude.app');
    f.outputs.set(malformed.input.toString('base64'), '{"secret":"fixture-private",broken');
    const report = await f.service.report();
    expect(report.items.slice(0, 2).every(item => item.status === 'installed' && item.installed === true)).toBe(true);
    expect(report.items[0].installations[0]).toMatchObject({
      version: null, build: null, bundleIdentifier: null, metadataStatus: 'unavailable', issues: [{ code: 'plist-missing' }],
    });
    expect(report.items[1].installations[0]).toMatchObject({
      version: null, build: null, bundleIdentifier: null, metadataStatus: 'unavailable', issues: [{ code: 'plist-invalid' }],
    });
    expect(JSON.stringify(report)).not.toContain('fixture-private');
  });

  it('does not infer app version from build or coerce malformed fields to strings', async () => {
    const f = await fixture();
    await f.bundle('Codex.app', f.applicationsDir, {
      CFBundleShortVersionString: 123, CFBundleVersion: '00123', CFBundleIdentifier: { value: 'test.fixture.codex' },
    });
    const report = await f.service.report();
    expect(report.items[0].installations[0]).toMatchObject({
      version: null, build: '00123', bundleIdentifier: null, metadataStatus: 'partial',
      issues: [{ code: 'field-invalid', field: 'version' }, { code: 'field-invalid', field: 'bundleIdentifier' }],
    });
  });

  it.each([
    { CFBundleShortVersionString: 'v'.repeat(129) },
    { CFBundleShortVersionString: '1.2\nspoof' },
    { CFBundleShortVersionString: '1.2\u202eevil' },
    { CFBundleShortVersionString: '   ' },
    { CFBundleVersion: false },
    { CFBundleIdentifier: 'invalid/identifier' },
    { CFBundleIdentifier: 'a'.repeat(256) },
  ])('rejects invalid or overlong fields: %j', async bad => {
    const f = await fixture();
    await f.bundle('Codex.app', f.applicationsDir, { ...metadata, ...bad });
    const installation = (await f.service.report()).items[0].installations[0];
    expect(installation.metadataStatus).toBe('partial');
    expect(installation.issues).toEqual([expect.objectContaining({ code: 'field-invalid' })]);
  });

  it('bounds input before conversion and converted output before parsing', async () => {
    const f = await fixture();
    await f.bundle('Codex.app', f.applicationsDir, metadata, Buffer.alloc(256 * 1024 + 1, 32));
    const expanded = await f.bundle('Claude.app');
    f.outputs.set(expanded.input.toString('base64'), ' '.repeat(256 * 1024 + 1));
    const report = await f.service.report();
    expect(f.conversions).toEqual([expanded.input]);
    expect(report.items[0].installations[0].issues).toEqual([{ code: 'plist-too-large' }]);
    expect(report.items[1].installations[0].issues).toEqual([{ code: 'metadata-limit' }]);
  });

  it.each([null, [], 'string', { nested: Array(5000).fill(1) }])('rejects a non-dictionary or excessive converted metadata tree', async properties => {
    const f = await fixture();
    await f.bundle('Codex.app', f.applicationsDir, properties);
    expect((await f.service.report()).items[0].installations[0]).toMatchObject({
      version: null, build: null, bundleIdentifier: null, metadataStatus: 'unavailable',
    });
  });

  it('rejects excessive nesting without recursive traversal', async () => {
    const f = await fixture();
    const app = await f.bundle();
    f.outputs.set(app.input.toString('base64'), '{"nested":'.repeat(40) + 'null' + '}'.repeat(40));
    expect((await f.service.report()).items[0].installations[0].issues).toEqual([{ code: 'metadata-limit' }]);
  });

  it('does not leak converter error output and does not prevent the next app from being discovered', async () => {
    const f = await fixture({ converter: async input => {
      if (input.includes('broken')) throw new Error('fixture-secret stderr /private/fixture');
      return JSON.stringify(metadata);
    } });
    await f.bundle('Codex.app', f.applicationsDir, metadata, Buffer.from('broken'));
    await f.bundle('Claude.app');
    const report = await f.service.report();
    expect(report.items[0].installations[0].issues).toEqual([{ code: 'conversion-failed' }]);
    expect(report.items[1].installations[0].version).toBe('2026.09.25-beta.1');
    expect(JSON.stringify(report)).not.toMatch(/fixture-secret|\/private\/fixture/);
  });

  it('bounds a stalled converter and aborts its helper request', async () => {
    let signal: AbortSignal | undefined;
    const f = await fixture({ converterTimeoutMs: 25, converter: (_input, options) => {
      signal = options.signal;
      return new Promise(() => {});
    } });
    await f.bundle();
    const report = await f.service.report();
    expect(report.items[0].installations[0].issues).toEqual([{ code: 'conversion-timeout' }]);
    expect(signal?.aborted).toBe(true);
  });

  it('caches for ten minutes, coalesces concurrent refreshes and exposes newly installed copies only after refresh or expiry', async () => {
    let now = Date.parse('2026-09-25T12:00:00Z');
    const f = await fixture({ now: () => now });
    await f.bundle();
    const reports = await Promise.all([f.service.report(), f.service.report(), f.service.refresh()]);
    expect(f.conversions).toHaveLength(1);
    expect(reports[0]).toEqual(reports[1]);
    expect(reports[0]).toMatchObject({ checkedAt: '2026-09-25T12:00:00.000Z', expiresAt: '2026-09-25T12:10:00.000Z' });
    await f.bundle('Claude.app');
    now += 599999;
    expect((await f.service.report()).items[1].status).toBe('not-installed');
    expect(f.conversions).toHaveLength(1);
    now++;
    expect((await f.service.report()).items[1].status).toBe('installed');
    expect(f.conversions).toHaveLength(3);
    await f.bundle('Kiro.app');
    expect((await f.service.refresh()).items[2].status).toBe('installed');
    expect(f.conversions).toHaveLength(6);
  });

  it('caches missing-app discovery until manual refresh instead of rechecking every Settings visit', async () => {
    const f = await fixture();
    expect((await f.service.report()).items[0].status).toBe('not-installed');
    await f.bundle();
    expect((await f.service.report()).items[0].status).toBe('not-installed');
    expect((await f.service.refresh()).items[0].status).toBe('installed');
  });

  it('discards metadata when the app directory changes during conversion', async () => {
    let replace: (() => Promise<void>) | undefined;
    const f = await fixture({ converter: async () => {
      await replace?.();
      return JSON.stringify(metadata);
    } });
    const app = await f.bundle();
    replace = async () => {
      await rename(app.path, join(f.base, 'Moved.app'));
      await mkdir(app.path);
    };
    const installation = (await f.service.report()).items[0].installations[0];
    expect(installation).toMatchObject({ version: null, build: null, bundleIdentifier: null, metadataStatus: 'unavailable' });
    expect(installation.issues).toEqual([{ code: 'changed-during-read' }]);
  });
});
