import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import type { McpConfiguration, McpServerSummary, McpTransport } from '../../shared/mcp.js';
import { within } from '../extensions/io.js';
import { redactor, secretValues } from './redaction.js';
import { finding, object, strings, type Declaration, type DiscoveryOptions, type McpRecord } from './types.js';

const envName = /^[A-Za-z_][A-Za-z0-9_]{0,199}$/;
// Claude's documented remote interpolation excludes its native/cloud credentials.
const nativeRemoteCredential = /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|CUSTOM_HEADERS)|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN|BEARER_TOKEN_BEDROCK)|GOOGLE_APPLICATION_CREDENTIALS|AZURE_CLIENT_SECRET|(?:HTTPS?|ALL)_PROXY|NPM_TOKEN)$/i;
const safeBaseEnvironment = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'];
const reservedHeaders = /^(?:host|connection|content-length|transfer-encoding|upgrade|te|trailer|accept|content-type|mcp-session-id|mcp-protocol-version|proxy-.*)$/i;

async function identity(path: string): Promise<string | null> {
  try {
    const canonical = await realpath(path);
    const info = await stat(canonical);
    return `${canonical}\0${info.dev}:${info.ino}${info.isDirectory() ? '' : `:${info.mtimeMs}:${info.size}`}`;
  } catch { return null; }
}

async function executable(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  const paths = command.includes('/') || command.includes('\\') ? [resolve(cwd, command)]
    : (env.PATH || '').split(delimiter).slice(0, 64).filter(Boolean).map(path => resolve(cwd, path, command));
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return await realpath(path);
    } catch { /* Missing/inaccessible binaries are static findings, never shell lookups. */ }
  }
  return null;
}

export async function configure(declaration: Declaration, context: DiscoveryOptions): Promise<McpRecord> {
  const raw = declaration.raw;
  const desktopChat = declaration.source.clients?.includes('claude-desktop-chat');
  const issues = [...declaration.findings];
  const missing = new Set<string>();
  const usedEnv = new Set<string>();
  const assigned = object(raw.env);
  const headers: Record<string, string> = Object.create(null);
  const env: NodeJS.ProcessEnv = Object.create(null);
  for (const key of safeBaseEnvironment) if (context.env[key] !== undefined) env[key] = context.env[key];
  // A supplied temporary home remains the process home; no accidental access to the developer's real home in tests.
  env.HOME = context.homeDir;
  const secrets = secretValues(raw);
  const invalid = (code: string, message: string) => issues.push(finding(code, message, 'error'));
  function environmentAllowed(name: string, remote: boolean) {
    usedEnv.add(name);
    if (remote && declaration.agent === 'claude' && nativeRemoteCredential.test(name)) {
      invalid('credential-variable-blocked', 'Native/cloud credential variables cannot be expanded into Claude remote URLs or headers. Use a dedicated MCP variable.');
      return false;
    }
    return true;
  }
  function remember(value: string) {
    if (value) secrets.push(...secretValues({ env: { resolved: value } }));
  }
  function expand(value: string, remote = false) {
    if (declaration.agent === 'codex' && !declaration.pluginRoot || desktopChat) return value;
    const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name: string, fallback?: string) => {
      if (declaration.pluginRoot && name === 'CLAUDE_PLUGIN_ROOT') return declaration.pluginRoot;
      if (declaration.pluginRoot && name === 'CODEX_PLUGIN_ROOT') return declaration.pluginRoot;
      if (declaration.pluginRoot && name === 'CLAUDE_PROJECT_DIR' && context.project) return context.project.path;
      if (!environmentAllowed(name, remote)) return '';
      const result = context.env[name] ?? fallback;
      if (result === undefined) { missing.add(name); return match; }
      remember(result);
      return result;
    });
    if (expanded.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/g, '').includes('${')) {
      issues.push(finding('interpolation-unsupported', 'A client-specific placeholder cannot be resolved safely by this workbench.', 'error'));
    }
    return expanded;
  }
  function text(value: unknown, label: string, max = 8192): string | null {
    if (value === undefined) return null;
    if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
      invalid('invalid-field', `The ${label} field must be a bounded, non-empty string.`);
      return null;
    }
    return expand(value, label === 'url');
  }
  const commandValue = text(raw.command, 'command', 4096);
  const urlValue = text(raw.url, 'url');
  const transport: McpTransport = raw.type === undefined ? declaration.agent === 'claude' || commandValue ? 'stdio' : urlValue ? 'http' : 'unsupported'
    : raw.type === 'streamable-http' ? 'http'
      : ['stdio', 'http', 'sse'].includes(String(raw.type)) ? raw.type as McpTransport : 'unsupported';
  if (transport === 'unsupported') issues.push(finding('unsupported-transport', 'This declaration does not use a supported local stdio, HTTP or SSE transport.', 'error'));
  if (desktopChat && transport !== 'stdio') {
    issues.push(finding('desktop-remote-unsupported', 'This Desktop Chat file is documented for local stdio servers. Remote/account connectors use a different configuration surface and are not inferred here.', 'error'));
  }
  if (raw.command !== undefined && raw.url !== undefined) invalid('ambiguous-target', 'Both command and URL are declared; no target was selected.');
  if (transport === 'stdio' && !commandValue) invalid('missing-command', 'A stdio declaration requires a command.');
  if ((transport === 'http' || transport === 'sse') && !urlValue) invalid('missing-url', 'An HTTP declaration requires a URL.');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean' || raw.disabled !== undefined && typeof raw.disabled !== 'boolean') {
    invalid('invalid-enabled', 'An enable/disable flag is not a boolean.');
  }
  if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.length > 128 || raw.args.some(item => typeof item !== 'string' || item.length > 8192 || item.includes('\0')))) {
    invalid('invalid-arguments', 'Arguments must be an array of at most 128 bounded strings.');
  }
  const args = strings(raw.args).slice(0, 128).map(value => expand(value));
  let cwd = context.project?.path ?? context.homeDir;
  // The selected registered workspace is the invocation context, including for user-scope declarations.
  const explicitCwd = text(raw.cwd, 'cwd', 4096);
  if (explicitCwd) cwd = explicitCwd.startsWith('~/') ? join(context.homeDir, explicitCwd.slice(2))
    : isAbsolute(explicitCwd) ? explicitCwd : resolve(cwd, explicitCwd);
  if (raw.env !== undefined && (raw.env === null || typeof raw.env !== 'object' || Array.isArray(raw.env))) invalid('invalid-environment', 'Environment declarations must be string maps.');
  if (Object.keys(assigned).length > 128) invalid('environment-limit', 'Too many configured environment names.');
  for (const [key, value] of Object.entries(assigned).slice(0, 128)) {
    if (!envName.test(key) || typeof value !== 'string' || value.length > 8192 || value.includes('\0')) {
      invalid('invalid-environment', 'An environment name or value has an unsupported format.');
    } else env[key] = expand(value);
  }
  const inherited: string[] = [];
  if (raw.env_vars !== undefined && (!Array.isArray(raw.env_vars) || raw.env_vars.length > 128)) invalid('invalid-environment', 'env_vars must be a bounded array.');
  for (const value of Array.isArray(raw.env_vars) ? raw.env_vars.slice(0, 128) : []) {
    const name = typeof value === 'string' ? value : object(value).name;
    const source = typeof value === 'string' ? 'local' : object(value).source ?? 'local';
    if (typeof name !== 'string' || !envName.test(name)) { invalid('invalid-environment', 'An inherited environment name is invalid.'); continue; }
    inherited.push(name);
    if (source !== 'local') { issues.push(finding('remote-environment-unsupported', 'Remote executor environment sources are not supported.', 'error')); continue; }
    usedEnv.add(name);
    if (context.env[name] === undefined) missing.add(name);
    else if (!Object.hasOwn(assigned, name)) env[name] = context.env[name];
    if (context.env[name]) remember(context.env[name]!);
  }
  const headerNames = new Set<string>();
  function header(name: string, value: unknown) {
    headerNames.add(name);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,200}$/.test(name) || reservedHeaders.test(name)
      || typeof value !== 'string' || /[\r\n\0]/.test(value) || value.length > 8192) {
      invalid('unsafe-header', 'A configured HTTP header is invalid or would override a protocol header.');
      return;
    }
    headers[name] = value;
    // Register the effective value, including Bearer/Basic/cookie components
    // introduced by interpolation or an environment-header reference.
    remember(value);
  }
  const literalHeaders = { ...object(raw.headers), ...object(raw.http_headers) };
  for (const field of ['headers', 'http_headers', 'env_http_headers']) {
    if (raw[field] !== undefined && (raw[field] === null || typeof raw[field] !== 'object' || Array.isArray(raw[field]))) invalid('invalid-headers', 'HTTP headers must be string maps.');
    if (Object.keys(object(raw[field])).length > 64) invalid('header-limit', 'Too many configured HTTP headers.');
  }
  for (const [name, value] of Object.entries(literalHeaders).slice(0, 64)) header(name, typeof value === 'string' ? expand(value, true) : value);
  for (const [name, value] of Object.entries(object(raw.env_http_headers)).slice(0, 64)) {
    if (typeof value !== 'string' || !envName.test(value)) { invalid('invalid-environment', 'An HTTP environment reference is invalid.'); continue; }
    headerNames.add(name);
    if (!environmentAllowed(value, true)) continue;
    if (context.env[value] === undefined) missing.add(value);
    else header(name, context.env[value]);
  }
  if (raw.bearer_token_env_var !== undefined) {
    const name = raw.bearer_token_env_var;
    if (typeof name !== 'string' || !envName.test(name)) invalid('invalid-environment', 'The bearer token environment name is invalid.');
    else {
      headerNames.add('Authorization');
      if (!environmentAllowed(name, true)) { /* Never read or attach a blocked credential. */ }
      else if (!context.env[name]) missing.add(name);
      else {
        for (const key of Object.keys(headers)) if (key.toLowerCase() === 'authorization') delete headers[key];
        header('Authorization', `Bearer ${context.env[name]}`);
        remember(context.env[name]!);
      }
    }
  }
  if (missing.size) invalid('missing-environment', 'Required environment variables are missing; only their names are shown.');
  const hasHelper = raw.headersHelper !== undefined || raw.http_headers_helper !== undefined;
  if (hasHelper) issues.push(finding('headers-helper-unsupported', 'Dynamic header helper commands are not executed by this workbench.', 'error'));
  if (raw.oauth !== undefined || raw.auth !== undefined || raw.oauthScopes !== undefined) {
    issues.push(finding('oauth-not-imported', 'Native client OAuth sessions are not read or reused. Configured static/environment headers are used if present.', 'info'));
  }
  if (raw.auth === 'chatgpt' || raw.execution !== undefined && raw.execution !== 'local'
    || raw.executor !== undefined || raw.executor_name !== undefined) {
    issues.push(finding('remote-executor-unsupported', 'Native-account authentication and remote executor placement are not supported.', 'error'));
  }
  let safeUrl: string | null = null;
  if (urlValue) {
    try {
      const url = new URL(urlValue);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) invalid('unsafe-url', 'Use an HTTP(S) URL without embedded credentials or a fragment.');
      if (url.protocol === 'http:' && !local) invalid('insecure-http', 'Plain HTTP probes are supported only on loopback.');
      // Never disclose expanded hostname values or paths/query credentials.
      if (String(raw.url).includes('${')) safeUrl = '[environment-defined endpoint]';
      else {
        const original = new URL(String(raw.url));
        safeUrl = `${original.protocol}//${original.host}/[redacted]`;
      }
    } catch { invalid('invalid-url', 'The URL cannot be parsed safely.'); }
  }
  let resolvedCommand: string | null = null;
  let executionIdentity = '';
  if (transport === 'stdio') {
    if (process.platform === 'win32') issues.push(finding('windows-stdio-unsupported', 'Owned process-group cleanup for stdio probes is currently supported on POSIX only.', 'error'));
    try {
      if (!(await stat(cwd)).isDirectory()) throw new Error('Not directory');
      cwd = await realpath(cwd);
      if (context.project) {
        const projectRoot = await realpath(context.project.path);
        if (!within(projectRoot, cwd) && !(declaration.pluginRoot && within(await realpath(declaration.pluginRoot), cwd))) invalid('unsafe-cwd', 'Project stdio working directories must remain within the selected project or owned plugin.');
      }
      if (commandValue) resolvedCommand = await executable(commandValue, cwd, env);
      if (!resolvedCommand) invalid('missing-executable', 'The configured executable was not found on the declared path or the workbench PATH.');
      executionIdentity = `${await identity(cwd)}\0${resolvedCommand ? await identity(resolvedCommand) : ''}`;
    } catch { invalid('missing-cwd', 'The configured working directory is not accessible.'); }
    issues.push(finding('process-start', 'An explicit check starts the configured process with argument arrays; the process can have side effects.', 'info'));
    if (context.project && !context.project.executionEnabled) issues.push(finding('project-execution-disabled', 'Enable execution for the registered project before starting a stdio probe.', 'error'));
  }
  const sanitize = redactor(secrets);
  const configuration: McpConfiguration = {
    command: commandValue ? /^[\p{L}\p{N}._+-]{1,240}$/u.test(basename(commandValue))
      ? sanitize(basename(commandValue), 240) : '[redacted executable]' : null,
    args: args.map(() => '[redacted]'), cwd: transport === 'stdio' ? sanitize(cwd, 4096) : null,
    url: safeUrl ? sanitize(safeUrl, 2048) : null,
    environmentNames: Object.keys(assigned).slice(0, 128).map(name => sanitize(name, 200)).sort(),
    inheritedEnvironmentNames: [...new Set([...inherited, ...usedEnv])].map(name => sanitize(name, 200)).sort(),
    headerNames: [...headerNames].slice(0, 64).map(name => sanitize(name, 200)).sort(),
    missingEnvironmentNames: [...missing].map(name => sanitize(name, 200)).sort(),
    hasOAuth: raw.oauth !== undefined || raw.auth !== undefined || raw.oauthScopes !== undefined,
    hasHeadersHelper: hasHelper, redacted: true,
    enabledTools: raw.enabled_tools === undefined ? null : strings(raw.enabled_tools).slice(0, 128).map(name => sanitize(name)),
    disabledTools: strings(raw.disabled_tools ?? raw.disabledTools).slice(0, 128).map(name => sanitize(name)),
  };
  if (declaration.status === 'disabled') issues.push(finding('configuration-disabled', 'This MCP declaration is disabled in its configuration.', 'error'));
  if (declaration.status === 'shadowed') issues.push(finding('configuration-shadowed', 'A higher-precedence declaration replaces this target in the selected scope.', 'error'));
  const unsupported = issues.some(issue => /unsupported$/.test(issue.code));
  const item: McpServerSummary = {
    id: context.id(declaration.key), agent: declaration.agent, name: sanitize(declaration.name, 240),
    scope: declaration.scope, projectId: context.project?.id ?? null, transport,
    status: declaration.status, statusReason: declaration.statusReason,
    source: { ...declaration.source, path: sanitize(declaration.source.path, 4096),
      pluginName: declaration.source.pluginName ? sanitize(declaration.source.pluginName, 240) : null,
      agentName: declaration.source.agentName ? sanitize(declaration.source.agentName, 240) : null },
    configuration, findings: issues.slice(0, 32),
    clientStates: declaration.clientStates ? structuredClone(declaration.clientStates) : undefined,
    checkSupport: unsupported ? 'unsupported' : issues.some(issue => issue.level === 'error') ? 'blocked' : 'supported',
    lastCheck: null,
  };
  return {
    declaration, item, target: { transport, command: resolvedCommand, args, cwd, env, url: urlValue, headers, executionIdentity },
    fingerprint: '', secrets,
  };
}
