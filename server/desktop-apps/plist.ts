import { execFile } from 'node:child_process';
import type { DesktopAppInstallation, DesktopAppMetadataField } from '../../shared/desktop-apps.js';
import { DesktopAppProbeError } from './errors.js';

export const MAX_PLIST_BYTES = 256 * 1024;
export const MAX_CONVERTER_MS = 2000;
export const PLIST_KEYS = {
  version: 'CFBundleShortVersionString',
  build: 'CFBundleVersion',
  bundleIdentifier: 'CFBundleIdentifier',
} as const;

export interface PlistConverterOptions {
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}
export type PlistConverter = (input: Buffer, options: PlistConverterOptions) => Promise<string>;
export type DesktopMetadata = Pick<DesktopAppInstallation, 'version' | 'build' | 'bundleIdentifier' | 'metadataStatus' | 'issues'>;

/** Only Apple's absolute-path helper is executed. App paths never become arguments or executable names. */
export const convertPlist: PlistConverter = (input, options) => new Promise((resolve, reject) => {
  const child = execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    encoding: 'utf8', timeout: Math.min(options.timeoutMs, MAX_CONVERTER_MS),
    maxBuffer: Math.min(options.maxOutputBytes, MAX_PLIST_BYTES),
    signal: options.signal, killSignal: 'SIGKILL', shell: false, cwd: '/',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  }, (error, stdout) => {
    if (error) {
      const failure = error as NodeJS.ErrnoException & { killed?: boolean };
      const code = failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'metadata-limit'
        : options.signal.aborted || failure.killed ? 'conversion-timeout' : 'conversion-failed';
      reject(new DesktopAppProbeError(code));
    } else resolve(stdout);
  });
  // plutil consumes already bounded, validated bytes, not a path it could reopen after a symlink swap.
  child.stdin?.on('error', () => reject(new DesktopAppProbeError('conversion-failed')));
  child.stdin?.end(input);
});

function dictionary(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, 'utf8') > MAX_PLIST_BYTES) throw new DesktopAppProbeError('metadata-limit');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new DesktopAppProbeError('plist-invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DesktopAppProbeError('plist-invalid');
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let entries = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++entries > 4096 || current.depth > 24) throw new DesktopAppProbeError('metadata-limit');
    if (current.value && typeof current.value === 'object') {
      const children = Object.values(current.value);
      if (entries + pending.length + children.length > 4096) throw new DesktopAppProbeError('metadata-limit');
      for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return value as Record<string, unknown>;
}

function validField(value: unknown, field: DesktopAppMetadataField): value is string {
  if (typeof value !== 'string' || !value.length || value !== value.trim()) return false;
  if (field === 'bundleIdentifier') {
    return value.length <= 255 && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/.test(value);
  }
  return value.length <= 128 && Buffer.byteLength(value, 'utf8') <= 256
    && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

/** JSON is produced by plutil for both XML and binary input; no regular-expression plist parser is used. */
export async function readPlistMetadata(input: Buffer, converter: PlistConverter, timeoutMs: number): Promise<DesktopMetadata> {
  if (input.length > MAX_PLIST_BYTES) throw new DesktopAppProbeError('plist-too-large');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DesktopAppProbeError('conversion-timeout'));
      controller.abort();
    }, timeoutMs);
  });
  let converted: string;
  try {
    converted = await Promise.race([
      Promise.resolve().then(() => converter(input, { signal: controller.signal, timeoutMs, maxOutputBytes: MAX_PLIST_BYTES })),
      timedOut,
    ]);
  } catch (error) {
    if (error instanceof DesktopAppProbeError) throw error;
    throw new DesktopAppProbeError('conversion-failed');
  } finally { clearTimeout(timer); }
  const properties = dictionary(converted);
  const result: DesktopMetadata = { version: null, build: null, bundleIdentifier: null, metadataStatus: 'complete', issues: [] };
  for (const field of Object.keys(PLIST_KEYS) as DesktopAppMetadataField[]) {
    const key = PLIST_KEYS[field];
    if (!Object.hasOwn(properties, key)) result.issues.push({ code: 'field-missing', field });
    else if (!validField(properties[key], field)) result.issues.push({ code: 'field-invalid', field });
    else result[field] = properties[key] as string;
  }
  if (result.issues.length) result.metadataStatus = Object.values(PLIST_KEYS).length === result.issues.length ? 'unavailable' : 'partial';
  return result;
}
