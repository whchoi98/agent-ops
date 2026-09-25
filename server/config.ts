import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Settings } from '../shared/types.js';

export const VERSION = '1.2.1';
export const defaultSettings = (): Settings => {
  const home = homedir();
  const codex = process.env.CODEX_HOME || join(home, '.codex');
  const claude = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  return {
    concurrency: 2,
    timeoutMinutes: 30,
    scanIntervalSeconds: 60,
    theme: 'light',
    sourceRoots: {
      codex: [join(codex, 'sessions'), join(codex, 'archived_sessions')],
      claude: [join(claude, 'projects')],
      kiro: [
        join(home, '.kiro', 'sessions', 'cli'),
        join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'kiro-cli', 'data.sqlite3'),
        ...(process.platform === 'darwin' ? [join(home, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3')] : []),
      ],
    },
  };
};

export function dataDirectory(demo = false): string {
  const base = process.env.AGENT_OPS_DATA_DIR
    ? resolve(process.env.AGENT_OPS_DATA_DIR)
    : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'agent-ops');
  return demo ? join(base, 'demo') : base;
}
