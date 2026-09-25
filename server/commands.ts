import { accessSync, constants, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { AGENTS, type CommandPreview, type ConnectorStatus, type Project, type RunRequest } from '../shared/types.js';
import { connectorFeatures } from './connectors.js';
import { redact } from './privacy.js';

const requestFields = new Set([
  'agent', 'projectId', 'prompt', 'title', 'model', 'policy', 'allowShell', 'resumeSessionId', 'sourceSessionId', 'templateId',
]);

/** Bound the shared pattern matcher on hostile CLI text, without altering the actual prompt. */
export function redactCliText(text: string): string {
  if (!/(?:key|secret|token|passwd|password|authorization|https?:\/\/|sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)/i.test(text)) return text;
  if (text.length > 16 * 1024) return '[REDACTED oversized text; display truncated]';
  return redact(text);
}

const commandError = (message: string, statusCode = 400) =>
  Object.assign(new Error(redactCliText(message)), { statusCode });

/** Validate at the runner boundary too, before spreading untrusted JSON into durable runs. */
export function validateRunRequest(request: RunRequest): void {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw commandError('A run request is required.');
  for (const key of Object.keys(request)) {
    if (!requestFields.has(key)) throw commandError(`Unsupported run request field: ${key.slice(0, 80)}`);
  }
  if (!AGENTS.includes(request.agent)) throw commandError('Unknown agent.');
  if (request.policy !== 'read-only' && request.policy !== 'workspace-write') throw commandError('Unsupported execution policy.');
  if (request.allowShell !== undefined && typeof request.allowShell !== 'boolean') throw commandError('allowShell must be a boolean.');
  if (request.allowShell && request.policy === 'read-only') throw commandError('Shell opt-in requires workspace-write; it cannot be enabled with read-only policy.');
  if (typeof request.projectId !== 'string' || !request.projectId || request.projectId.length > 1000) {
    throw commandError('A known project is required.');
  }
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.includes('\0') || Buffer.byteLength(request.prompt) > 1024 * 1024) {
    throw commandError('Prompt must be nonempty text, without NUL characters, at most 1 MiB.');
  }
  if (request.model !== undefined && (typeof request.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(request.model))) {
    throw commandError('Invalid model name.');
  }
  for (const field of ['resumeSessionId', 'sourceSessionId', 'templateId', 'title'] as const) {
    const value = request[field];
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 1000)) {
      throw commandError(`Invalid ${field}.`);
    }
  }
  if (request.resumeSessionId && request.sourceSessionId) throw commandError('Choose a native resume or a cross-agent source session, not both.');
}

function validateExecutable(connector: ConnectorStatus) {
  const path = connector.executable;
  if (!connector.installed || !path || !isAbsolute(path) || /[\0\r\n]/.test(path)) {
    throw commandError('The agent executable is not installed or is not an absolute executable path.', 409);
  }
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    if (!statSync(path).isFile()) throw new Error('Not a file');
  } catch {
    throw commandError('The agent executable is missing or cannot be executed.', 409);
  }
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(path)) {
    throw commandError('The agent executable requires a shell; install a native executable.', 409);
  }
  return path;
}

function inGitWorkspace(path: string): boolean {
  let directory = path;
  for (;;) {
    try {
      const marker = join(directory, '.git');
      const metadata = statSync(marker);
      if (metadata.isFile() || (metadata.isDirectory() && statSync(join(marker, 'HEAD')).isFile())) return true;
    } catch { /* Look in the parent. */ }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

function quote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildCommand(
  request: RunRequest, project: Project, connector: ConnectorStatus, resumeNativeId?: string,
  options: { previewOnly?: boolean } = {},
): CommandPreview {
  validateRunRequest(request);
  if (connector.agent !== request.agent) throw commandError('Connector does not match the requested agent.');
  if (request.projectId !== project.id || !isAbsolute(project.path) || project.path.includes('\0')) throw commandError('Invalid project workspace.');
  // Trusted formatter option for non-executing demo samples, never a request field.
  const sampleOnly = options.previewOnly === true && !connector.installed;
  if (sampleOnly) {
    connector = { ...connector, executable: null, version: null, supportsResume: false, supportsStreaming: false };
  }
  const executable = sampleOnly
    ? { codex: 'codex', claude: 'claude', kiro: 'kiro-cli' }[request.agent]
    : validateExecutable(connector);
  if (request.resumeSessionId && !resumeNativeId) throw commandError('The resume session must resolve to a known native session ID.');
  if (resumeNativeId !== undefined) {
    if (!connector.supportsResume) throw commandError(sampleOnly
      ? 'Resume support is unverified. Install the CLI before previewing a resume.'
      : 'This installed CLI does not support explicit session resume.', 409);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/.test(resumeNativeId)) throw commandError('Invalid native resume session ID.');
  }
  const features = connectorFeatures(connector);
  const warnings: string[] = sampleOnly
    ? [`Sample demo preview only; CLI capabilities are unverified. Install ${executable} before live execution. Demo execution is disabled.`]
    : [];
  const writing = request.policy === 'workspace-write';
  let args: string[];
  let stdin = true;
  let policyDescription: string;
  if (request.agent === 'codex') {
    args = resumeNativeId
      ? ['exec', 'resume', '--json', '-c', `sandbox_mode="${request.policy}"`, '-c', 'approval_policy="never"']
      : ['exec', '--json', '--color', 'never', '--sandbox', request.policy, '-c', 'approval_policy="never"'];
    if (request.model) args.push('--model', request.model);
    if (!inGitWorkspace(project.path)) {
      args.push('--skip-git-repo-check');
      warnings.push('This project is outside a Git repository; the Git repository check will be skipped.');
    }
    if (resumeNativeId) args.push(resumeNativeId);
    args.push('-');
    policyDescription = `Requests the Codex ${request.policy} sandbox with approval_policy="never". Enforcement belongs to the installed CLI.`;
  } else if (request.agent === 'claude') {
    const tools = writing ? `Read,Glob,Grep,Edit,Write${request.allowShell ? ',Bash' : ''}` : 'Read,Glob,Grep';
    args = [
      '--print', '--verbose', '--output-format', 'stream-json', '--permission-mode', writing ? 'acceptEdits' : 'plan',
      '--tools', tools, '--allowedTools', tools, '--disallowedTools', 'AskUserQuestion,ExitPlanMode,mcp__*',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    ];
    if (request.model) args.push('--model', request.model);
    if (resumeNativeId) args.push('--resume', resumeNativeId);
    if (features.permissionPrompts) args.push('--permission-prompts', 'none');
    policyDescription = `Claude provider tool policy allows ${writing ? `file reads and edits${request.allowShell ? ', plus Bash shell commands' : ''}` : 'Read, Glob and Grep only'} in noninteractive print mode with external MCP configuration disabled. Installed CLI hooks still apply; this is not an OS sandbox.`;
  } else {
    const fileTools = features.kiroV3 ? (writing ? 'read,grep,write' : 'read,grep') : (writing ? 'fs_read,fs_write' : 'fs_read');
    const tools = fileTools + (request.allowShell ? (features.kiroV3 ? ',shell' : ',execute_bash') : '');
    args = ['chat', ...(features.resumeEngine ? ['--agent-engine', features.resumeEngine] : []),
      '--no-interactive', '--wrap', 'never', `--trust-tools=${tools}`];
    if (request.model) args.push('--model', request.model);
    if (connector.supportsStreaming) args.push('--output-format', 'stream-json');
    else warnings.push('This Kiro CLI does not advertise structured streaming; output will be captured as text.');
    if (resumeNativeId) args.push('--resume-id', resumeNativeId);
    stdin = features.stdinPrompt;
    if (!stdin) {
      args.push('--', request.prompt);
      warnings.push('This Kiro version has no verified stdin prompt support. The prompt is passed as one argument and may be visible to local process inspection.');
    }
    policyDescription = `Kiro provider tool policy trusts ${tools} in noninteractive mode. Installed CLI hooks and configuration still apply; this is not an OS sandbox.`;
  }
  if (request.allowShell && request.agent !== 'codex') {
    warnings.push('Shell execution was explicitly enabled. Agent commands can start processes, access the network, and affect files outside the workspace with your account permissions; this policy provides no OS isolation.');
  }
  return {
    executable, args, cwd: project.path, stdin, policyDescription, warnings,
    displayCommand: [executable, ...args].map((arg) => quote(redactCliText(arg))).join(' '),
  };
}
