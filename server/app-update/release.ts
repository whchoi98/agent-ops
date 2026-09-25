import { parse, type SemVer } from 'semver';
import {
  APP_UPDATE_REPOSITORY_URL, type AppUpdateErrorCode, type AppUpdateRelease,
} from '../../shared/app-update.js';

export class AppUpdateFailure extends Error {
  constructor(readonly code: AppUpdateErrorCode) { super(code); }
}

/** SemVer's convenience v/=/whitespace prefixes are not part of a package version. */
export function parseAppVersion(value: unknown): SemVer | null {
  if (typeof value !== 'string' || value.length > 256) return null;
  const parsed = parse(value);
  if (!parsed) return null;
  const canonical = parsed.version + (parsed.build.length ? `+${parsed.build.join('.')}` : '');
  return value === canonical ? parsed : null;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function publishedAt(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const expected = value.includes('.')
    ? value.replace(/\.(\d{1,3})Z$/, (_, fraction: string) => `.${fraction.padEnd(3, '0')}Z`)
    : value.replace(/Z$/, '.000Z');
  const canonical = new Date(time).toISOString();
  return canonical === expected ? canonical : null;
}

/** Keep only version, provenance and a validated installation archive, never release prose. */
export function validateAppRelease(value: unknown): AppUpdateRelease {
  const invalid = () => new AppUpdateFailure('invalid-release');
  if (!object(value) || value.draft !== false || value.prerelease !== false
    || typeof value.tag_name !== 'string') throw invalid();
  const tag = value.tag_name;
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  const parsed = parseAppVersion(version);
  if (!parsed || parsed.prerelease.length) throw invalid();
  const released = publishedAt(value.published_at);
  const releaseUrl = `${APP_UPDATE_REPOSITORY_URL}/releases/tag/${encodeURIComponent(tag)}`;
  // Raw equality intentionally rejects credentials, ports, queries and URL-normalization tricks.
  if (value.html_url !== releaseUrl || !released || !Array.isArray(value.assets) || !value.assets.every(object)) {
    throw invalid();
  }
  const name = `agent-ops-local-${version}.tgz`;
  const url = `${APP_UPDATE_REPOSITORY_URL}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  const matches = value.assets.filter(asset => asset.name === name);
  const candidate = matches.length === 1 ? matches[0] : null;
  const archive = candidate && candidate.browser_download_url === url
    && (candidate.state === undefined || candidate.state === 'uploaded') ? { name, url } : null;
  return { version, tag, releaseUrl, publishedAt: released, archive };
}
