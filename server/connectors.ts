import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { AGENTS, type Agent, type ConnectorStatus, type Settings } from '../shared/types.js';
import { redact } from './privacy.js';

const names: Record<Agent, string> = { codex: 'codex', claude: 'claude', kiro: 'kiro-cli' };
const PROBE_TIMEOUT_MS = 2000;
const CACHE_MS = 30_000;
type Features = {
  permissionPrompts: boolean; stdinPrompt: boolean; kiroV3: boolean;
  agentEngine: boolean; resumeEngine?: 'v2';
};
type ProbeResult = { text: string; error: string | null };
type Detection = Pick<ConnectorStatus, 'version' | 'error' | 'supportsResume' | 'supportsStreaming'> & { features: Features };
const cache = new Map<string, { expires: number; value: Promise<Detection> }>();
let extraFeatures = new WeakMap<ConnectorStatus, Features>();

function diagnostic(text: string): string {
  return text.length > 4096 ? 'Oversized probe diagnostic omitted.' : redact(text).trim().slice(0, 800);
}

function versionParts(version: string | null): number[] | null {
  const match = version?.match(/(?:^|[\s/v])v?(\d+)\.(\d+)\.(\d+)(?=$|[\s+(-])/i);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Supplemental help details stay server-side; the shared status never reports authentication. */
export function connectorFeatures(connector: ConnectorStatus): Features {
  const cached = extraFeatures.get(connector);
  if (cached) return cached;
  const version = versionParts(connector.version);
  const [major, minor, patch] = version || [0, 0, 0];
  return {
    permissionPrompts: connector.agent === 'claude'
      && (major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 259)))),
    stdinPrompt: connector.agent !== 'kiro' || major >= 2,
    kiroV3: connector.agent === 'kiro' && major >= 3,
    agentEngine: false,
  };
}

export function connectorForResume(connector: ConnectorStatus, sourcePath: string): ConnectorStatus {
  const features = connectorFeatures(connector);
  if (connector.agent !== 'kiro' || !features.kiroV3 || !/\.(?:sqlite3?|db)(?:$|[#?])/i.test(sourcePath)) return connector;
  if (!features.agentEngine) {
    throw Object.assign(new Error('This historical Kiro SQLite session requires a verified V2 engine selector. The installed CLI does not advertise --agent-engine; use a context handoff instead.'), { statusCode: 409 });
  }
  const selected = { ...connector };
  extraFeatures.set(selected, { ...features, kiroV3: false, resumeEngine: 'v2', stdinPrompt: true });
  return selected;
}

export function invalidateConnectorCache(): void {
  cache.clear();
  extraFeatures = new WeakMap();
}

async function findExecutable(name: string): Promise<string | null> {
  // Relative/empty PATH entries could select a script from the workspace being opened.
  const directories = (process.env.PATH || '').split(delimiter).filter((path) => isAbsolute(path));
  const extensions = process.platform === 'win32' ? ['.exe', '.com', ''] : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const path = join(directory, `${name}${extension}`);
      try {
        await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        if ((await stat(path)).isFile()) return path;
      } catch {
        // A missing or inaccessible PATH entry is not an installed connector.
      }
    }
  }
  return null;
}

function probe(executable: string, args: string[]): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = execFile(executable, args, {
      encoding: 'utf8', shell: false, windowsHide: true,
      timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
    }, (error, stdout, stderr) => {
      const detail = diagnostic(String(stderr || error?.message || ''));
      const timedOut = error?.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      resolve({
        text: `${stdout}\n${stderr}`,
        error: error
          ? `${args.join(' ')} probe ${timedOut ? 'timed out' : 'failed'}${detail ? `: ${detail}` : ''}`
          : null,
      });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
}

const hasFlag = (help: string, flag: string): boolean =>
  new RegExp(`(?:^|\\s|[,|])${flag}(?=$|[\\s=<,|\\[])`, 'm').test(help);

async function inspect(agent: Agent, executable: string): Promise<Detection> {
  const helpArgs = agent === 'codex' ? ['exec', '--help'] : agent === 'kiro' ? ['chat', '--help'] : ['--help'];
  const [versionResult, helpResult, rootHelp] = await Promise.all([
    probe(executable, ['--version']), probe(executable, helpArgs),
    agent === 'kiro' ? probe(executable, ['--help']) : Promise.resolve({ text: '', error: null }),
  ]);
  const versionLine = versionResult.text.trim().split(/\r?\n/)[0] || '';
  const versionError = versionLine.length > 1000 ? '--version probe returned oversized output.' : null;
  const version = versionResult.error || versionError ? null : redact(versionLine).slice(0, 300) || null;
  const features = connectorFeatures({ agent, version } as ConnectorStatus);
  const help = helpResult.error ? '' : helpResult.text;
  if (agent === 'claude' && hasFlag(help, '--permission-prompts')) features.permissionPrompts = true;
  if (agent === 'kiro' && /\b(?:stdin|standard input)\b/i.test(help)) features.stdinPrompt = true;
  if (agent === 'kiro') {
    features.agentEngine = hasFlag(`${help}\n${rootHelp.error ? '' : rootHelp.text}`, '--agent-engine');
    // Structured headless output is a V2/V3 capability; both engines accept piped prompts.
    if (features.agentEngine && hasFlag(help, '--output-format')) features.stdinPrompt = true;
  }
  return {
    version, features,
    error: [versionResult.error, versionError, helpResult.error].filter(Boolean).join('; ') || null,
    supportsResume: agent === 'codex' || hasFlag(help, agent === 'kiro' ? '--resume-id' : '--resume'),
    supportsStreaming: hasFlag(help, agent === 'codex' ? '--json' : '--output-format'),
  };
}

export async function detectConnectors(
  settings: Settings, sessionCounts: Partial<Record<Agent, number>> = {},
): Promise<ConnectorStatus[]> {
  return Promise.all(AGENTS.map(async (agent) => {
    const roots = [...settings.sourceRoots[agent]];
    const [executable, existing] = await Promise.all([
      findExecutable(names[agent]),
      Promise.all(roots.map(async (path) => {
        try { await access(path, constants.F_OK); return path; } catch { return null; }
      })),
    ]);
    const status: ConnectorStatus = {
      agent, installed: executable !== null, executable, version: null, roots,
      existingRoots: existing.filter((path): path is string => path !== null),
      sessionCount: Math.max(0, sessionCounts[agent] || 0), error: null,
      supportsResume: false, supportsStreaming: false,
    };
    if (!executable) {
      status.error = `${names[agent]} executable was not found on PATH.`;
      return status;
    }
    try {
      const identity = await stat(executable);
      const key = `${agent}\0${executable}\0${identity.ino}:${identity.size}:${identity.mtimeMs}`;
      let entry = cache.get(key);
      if (!entry || entry.expires <= Date.now()) {
        for (const [oldKey, old] of cache) if (old.expires <= Date.now()) cache.delete(oldKey);
        entry = { expires: Date.now() + CACHE_MS, value: inspect(agent, executable) };
        cache.set(key, entry);
      }
      const { features, ...detection } = await entry.value;
      Object.assign(status, detection);
      extraFeatures.set(status, features);
    } catch (error) {
      status.error = `Connector probe failed: ${diagnostic(error instanceof Error ? error.message : String(error))}`;
    }
    return status;
  }));
}
