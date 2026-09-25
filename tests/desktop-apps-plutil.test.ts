import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import type { ExecFileException, ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { convertPlist } from '../server/desktop-apps/plist.js';

const execute = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execute }));

let output: string;
let failure: ExecFileException | null;
let received: Buffer[];
beforeEach(() => {
  execute.mockReset();
  output = '{"CFBundleVersion":"001"}';
  failure = null;
  received = [];
  execute.mockImplementation((_file: string, _args: string[], _options: ExecFileOptionsWithStringEncoding,
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => {
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, done) { received.push(Buffer.from(chunk)); done(); },
    });
    stdin.on('finish', () => callback(failure, output, 'fixture-private-stderr'));
    return { stdin };
  });
});

describe('trusted plist conversion boundary', () => {
  it('uses only fixed plutil arguments and bounded stdin/stdout without a shell or app invocation', async () => {
    const signal = new AbortController().signal;
    const input = Buffer.from('bplist00 fixture with spaces; $(never-run)');
    expect(await convertPlist(input, { signal, timeoutMs: 2000, maxOutputBytes: 256 * 1024 })).toBe('{"CFBundleVersion":"001"}');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0].slice(0, 3)).toEqual([
      '/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'],
      {
        encoding: 'utf8', timeout: 2000, maxBuffer: 256 * 1024, signal, killSignal: 'SIGKILL', shell: false, cwd: '/',
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      },
    ]);
    expect(Buffer.concat(received)).toEqual(input);
  });

  it('clamps oversized helper limits instead of allowing a caller to lift the bounds', async () => {
    await convertPlist(Buffer.from('fixture'), {
      signal: new AbortController().signal, timeoutMs: 60000, maxOutputBytes: 1024 * 1024,
    });
    expect(execute.mock.calls[0][2]).toMatchObject({ timeout: 2000, maxBuffer: 256 * 1024 });
  });

  it('reports output overflow distinctly even when execFile killed the helper', async () => {
    failure = Object.assign(new Error('fixture-secret output'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true });
    await expect(convertPlist(Buffer.from('fixture'), {
      signal: new AbortController().signal, timeoutMs: 2000, maxOutputBytes: 256 * 1024,
    })).rejects.toMatchObject({ message: 'metadata-limit', code: 'metadata-limit' });
  });

  it.each([
    { failure: { killed: true }, code: 'conversion-timeout' },
    { failure: { code: 'ENOENT' }, code: 'conversion-failed' },
  ])('returns a fixed diagnostic for $code without helper output', async example => {
    failure = Object.assign(new Error('fixture-secret output'), example.failure) as ExecFileException;
    await expect(convertPlist(Buffer.from('fixture'), {
      signal: new AbortController().signal, timeoutMs: 2000, maxOutputBytes: 256 * 1024,
    })).rejects.toMatchObject({ message: example.code, code: example.code });
  });
});
