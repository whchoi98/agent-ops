import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { harnessPaths, type HarnessHookBindingFile } from '../../server/harness/types.js';

export const bridgePath = fileURLToPath(new URL('../../server/harness/bridge.py', import.meta.url));
export const enginePython = process.env.HARNESS_TEST_PYTHON ?? process.env.AGENT_OPS_HARNESS_TEST_PYTHON;
export const python = await (async () => {
  for (const path of ['/bin/python3.12', '/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3', ...(enginePython ? [enginePython] : [])]) {
    if (await access(path, constants.X_OK).then(() => true, () => false)) return path;
  }
  // The optional Python feature must not prevent ordinary Node-only test runs.
  return '';
})();

export async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-harness-bridge-'));
  const projectDir = join(root, 'project with spaces');
  const dataDir = join(root, 'data');
  await Promise.all([mkdir(projectDir, { mode: 0o700 }), mkdir(dataDir, { mode: 0o700 })]);
  return { root, projectDir, dataDir };
}

export async function controlled(root: string, config: Record<string, unknown> = {}) {
  const path = join(root, 'controlled bridge.py');
  await Promise.all([
    copyFile(fileURLToPath(new URL('./harness-bridge-runtime.py', import.meta.url)), path),
    writeFile(join(root, 'fixture.json'), JSON.stringify(config)),
  ]);
  return path;
}

/** An empty venv, optionally with deliberately incomplete package metadata/API. No pip/network. */
export async function probeEnvironment(root: string, engineVersion?: string) {
  const directory = join(root, 'probe-venv');
  await promisify(execFile)(python, ['-I', '-m', 'venv', '--without-pip', directory], { env: { PATH: '/usr/bin:/bin' } });
  const executable = join(directory, 'bin', 'python');
  if (engineVersion !== undefined) {
    const { stdout } = await promisify(execFile)(executable, ['-I', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'], { env: { PATH: '/usr/bin:/bin' } });
    const site = stdout.trim();
    const metadata = join(site, 'autoharness-0.1.1.dist-info');
    const core = join(site, 'autoharness', 'core');
    await Promise.all([mkdir(metadata, { recursive: true }), mkdir(core, { recursive: true })]);
    await Promise.all([
      writeFile(join(metadata, 'METADATA'), `Metadata-Version: 2.1\nName: autoharness\nVersion: ${engineVersion}\n`),
      writeFile(join(site, 'autoharness', '__init__.py'), ''),
      writeFile(join(core, '__init__.py'), ''),
      writeFile(join(core, 'constitution.py'), 'class Constitution:\n  pass\n'),
      writeFile(join(core, 'pipeline.py'), 'class ToolGovernancePipeline:\n  pass\n'),
      writeFile(join(core, 'hooks.py'), 'class HookRegistry:\n  pass\n'),
      writeFile(join(core, 'types.py'), 'class ToolCall:\n  pass\n'),
    ]);
  }
  return executable;
}

export async function waitJson(path: string): Promise<Record<string, any>> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch { await delay(10); }
  }
  throw new Error('Controlled harness child did not become ready.');
}

export function running(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function gone(pid: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!running(pid)) return;
    // Linux containers can retain an adopted zombie until their init reaps it.
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
      if (!stat || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return;
    }
    await delay(10);
  }
  throw new Error('An owned harness process survived cleanup.');
}

export function invokeBridge(
  executable: string, input: unknown, args: string[] = [], env: NodeJS.ProcessEnv = {},
  timeoutMs = 18000, entryPath = bridgePath,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-I', entryPath, ...args], {
      env: { PATH: '/usr/bin:/bin', ...env }, stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const out: Buffer[] = [], err: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
      reject(new Error('Bridge test process exceeded its deadline.'));
    }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    for (const [stream, target] of [[child.stdout, out], [child.stderr, err]] as const) {
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 512 * 1024) {
          if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
          reject(new Error('Bridge test output exceeded its bound.'));
        } else target.push(chunk);
      });
    }
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

export function invokeHookFault(executable: string, input: unknown, fault: 'exception' | 'timeout' | 'success' | 'nproc', evidencePath: string) {
  const entry = fileURLToPath(new URL('./harness-bridge-hook-fault.py', import.meta.url));
  return invokeBridge(executable, input, [bridgePath, fault, evidencePath], {}, 18000, entry);
}

export const policy = {
  mode: 'core',
  hooks: { profile: 'minimal' },
  permissions: {
    defaults: { unknown_tool: 'ask', unknown_path: 'allow', on_error: 'deny' },
    tools: {
      bash: { policy: 'restricted', allow_patterns: ['^echo safe$'], ask_patterns: ['^echo review$'], deny_patterns: ['^echo forbidden$'] },
      file_read: { policy: 'allow' },
    },
  },
  risk: { classifier: 'rules', thresholds: { low: 'allow', medium: 'allow', high: 'ask', critical: 'deny' } },
};

export async function binding(
  dataDir: string, projectDir: string, client: HarnessHookBindingFile['client'],
  overrides: Partial<HarnessHookBindingFile> = {},
) {
  const paths = harnessPaths(dataDir, 'project-1');
  await mkdir(paths.bindingsDir, { recursive: true, mode: 0o700 });
  const path = join(paths.bindingsDir, `${client}.json`);
  const value: HarnessHookBindingFile = {
    protocol: 1, client, projectId: 'project-1', projectDir, policyId: 'policy-1',
    policyRevision: 'revision-1', policy, pythonPath: enginePython ?? python,
    engineVersion: '0.1.1', createdAt: '2026-09-26T00:00:00.000Z', ...overrides,
  };
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return { path, value, auditPath: paths.auditPath, scope: dirname(paths.bindingsDir) };
}
