import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isAlias, isMap, isNode, isScalar, isSeq, parseAllDocuments } from 'yaml';
import type { HarnessMode, HarnessPolicyDetail, HarnessScope, HarnessValidation } from '../../shared/harness.js';
import type { Project } from '../../shared/types.js';
import {
  boundedInteger, contentHash, decodeHarnessText, harnessObject, harnessRedactor, inspectHarnessPath,
  missingHarnessFile, readHarnessBytes, replaceHarnessBytes, withinHarnessRoot, withHarnessWriteLock,
} from './io.js';
import {
  HARNESS_MAX_POLICY_BYTES, harnessError, harnessPaths,
  type HarnessAuditFile, type HarnessPolicySnapshot, type HarnessResolvedPolicy,
} from './types.js';

const MAX_NODES = 4096;
const MAX_DEPTH = 24;
const MAX_RULES = 256;
const yamlOptions = {
  schema: 'core', version: '1.2', merge: false, resolveKnownTags: false, customTags: null,
  stringKeys: true, uniqueKeys: true, prettyErrors: false, logLevel: 'silent',
} as const;
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor', '<<']);
const MODES = ['core', 'standard', 'enhanced'];
const LEVELS = ['low', 'medium', 'high', 'critical'];
const ACTIONS = ['allow', 'ask', 'deny'];
const LOCAL_VALIDATION = 'Local structural validation only; the AutoHarness engine has not validated this policy.';
const SEPARATE_POLICIES = 'Policies are individual sources with provenance, not a merged effective policy. Checks select one source.';

// Explicit permissions and built-in hooks enforce safety; prose rules are also useful as guidance.
const BUILTIN_POLICY = `version: "1.0"
mode: standard
identity:
  name: Agent Ops standard
  description: Local rule-based governance with built-in safety hooks
rules:
  - id: confirm-destructive-ops
    description: Ask before destructive operations
    severity: error
    enforcement: both
  - id: no-secret-exposure
    description: Keep credentials out of tool input and output
    severity: error
    enforcement: hook
  - id: review-changes
    description: Inspect and test changes before delivery
    severity: warning
    enforcement: prompt
permissions:
  defaults: {unknown_tool: ask, unknown_path: deny, on_error: deny}
  tools:
    Bash:
      policy: restricted
      deny_patterns:
        - 'rm\\s+-rf\\s+[/~]'
        - 'mkfs\\.'
        - 'dd\\s+.*of=/dev/'
        - '(curl|wget)\\s+.*\\|\\s*(ba)?sh'
        - 'git\\s+reset\\s+--hard'
      ask_patterns:
        - 'git\\s+push'
        - '\\b(rm|rmdir|drop|truncate)\\b'
    Read:
      policy: allow
      deny_paths: ['.env', '.env.*', '.ssh/*', '.aws/credentials', '*.pem', '*.key']
    Write:
      policy: restricted
      deny_paths: ['.env', '.env.*', '.ssh/*', '.aws/credentials', '*.pem', '*.key']
    Edit:
      policy: restricted
      deny_paths: ['.env', '.env.*', '.ssh/*', '.aws/credentials', '*.pem', '*.key']
risk:
  classifier: rules
  thresholds: {low: allow, medium: ask, high: deny, critical: deny}
hooks: {profile: standard}
audit: {enabled: true, format: jsonl, output: .autoharness/audit.jsonl, retention_days: 30}
`;

interface ParsedPolicy { config: Record<string, unknown> | null; validation: HarnessValidation }
interface PolicySource {
  scope: HarnessScope;
  name: string;
  root: string;
  path: string | null;
  auditRoot: string;
}
interface LoadedPolicy { source: PolicySource; bytes: Buffer; parsed: ParsedPolicy; detail: HarnessPolicyDetail }

async function canonicalSource(path: string): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  // Audit sources can be advertised before creation; resolve their nearest existing ancestor.
  for (let depth = 0; depth < 32; depth++) {
    try { return join(await realpath(current), ...suffix); }
    catch (error) {
      if (!missingHarnessFile(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
  throw harnessError(400, 'Harness source path exceeds the discovery depth limit.');
}

function parsePolicy(content: string, maxBytes: number): ParsedPolicy {
  const validation: HarnessValidation = {
    valid: false, engineValidated: false, mode: null, ruleCount: 0, errors: [], warnings: [LOCAL_VALIDATION],
  };
  const invalid = (message: string) => {
    if (validation.errors.length < 40 && !validation.errors.includes(message)) validation.errors.push(message);
  };
  const warning = (message: string) => {
    if (validation.warnings.length < 40 && !validation.warnings.includes(message)) validation.warnings.push(message);
  };
  let config: Record<string, unknown>;
  try {
    if (typeof content !== 'string' || Buffer.byteLength(content) > maxBytes) {
      invalid(`Policy size must not exceed ${maxBytes} bytes.`);
      return { config: null, validation };
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content) || /^%/m.test(content)) {
      throw new Error('Unsupported YAML characters or directives');
    }
    // parseDocument with logLevel: silent omits its MULTIPLE_DOCS error.
    const documents = parseAllDocuments(content, yamlOptions);
    if (documents.length !== 1) throw new Error('Exactly one document is required');
    const document = documents[0];
    if (document.errors.length || document.warnings.length || !isMap(document.contents)) throw new Error('Invalid YAML');
    const stack: Array<{ node: unknown; depth: number }> = [{ node: document.contents, depth: 0 }];
    let count = 0;
    while (stack.length) {
      const { node, depth } = stack.pop()!;
      if (++count > MAX_NODES || depth > MAX_DEPTH) throw new Error('YAML limits');
      if (isAlias(node) || (isNode(node) && ('tag' in node && node.tag || 'anchor' in node && node.anchor))) {
        throw new Error('Aliases, anchors and tags are unsupported');
      }
      if (isMap(node)) {
        for (const pair of node.items) {
          if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || unsafeKeys.has(pair.key.value)) {
            throw new Error('Unsafe mapping key');
          }
          stack.push({ node: pair.key, depth: depth + 1 }, { node: pair.value, depth: depth + 1 });
        }
      } else if (isSeq(node)) {
        for (const child of node.items) stack.push({ node: child, depth: depth + 1 });
      } else if (isScalar(node) && typeof node.value === 'number' && !Number.isFinite(node.value)) {
        throw new Error('Non-finite YAML number');
      }
    }
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (!harnessObject(value)) throw new Error('Non-object');
    config = value;
  } catch {
    invalid('Invalid or unsupported YAML. Use one mapping document without aliases, anchors, tags, unsafe keys or excessive depth/nodes.');
    return { config: null, validation };
  }

  const unknown = (value: Record<string, unknown>, allowed: string[], label: string, reject = false) => {
    if (Object.keys(value).some(key => !allowed.includes(key))) {
      (reject ? invalid : warning)(`${label} contains unsupported fields${reject ? '.' : ' that the tested engine may ignore.'}`);
    }
  };
  const objectField = (parent: Record<string, unknown>, key: string, label = key): Record<string, unknown> => {
    if (!(key in parent)) return {};
    if (harnessObject(parent[key])) return parent[key];
    invalid(`${label} must be a mapping.`);
    return {};
  };
  const stringField = (parent: Record<string, unknown>, key: string, label: string, required = false) => {
    if (key in parent ? typeof parent[key] !== 'string' : required) invalid(`${label} must be a string.`);
  };
  const enumField = (parent: Record<string, unknown>, key: string, allowed: readonly string[], label: string) => {
    if (key in parent && (typeof parent[key] !== 'string' || !allowed.includes(parent[key]))) {
      invalid(`${label} has an unsupported value.`);
    }
  };
  const stringList = (parent: Record<string, unknown>, key: string, label: string) => {
    if (key in parent && (!Array.isArray(parent[key]) || parent[key].some(item => typeof item !== 'string'))) {
      invalid(`${label} must be a list of strings.`);
    }
  };
  const objectList = (parent: Record<string, unknown>, key: string, label: string): Record<string, unknown>[] => {
    if (!(key in parent)) return [];
    const value = parent[key];
    if (!Array.isArray(value) || value.some(item => !harnessObject(item))) {
      invalid(`${label} must be a list of mappings.`);
      return [];
    }
    if (value.length > MAX_RULES) invalid(`${label} exceeds the ${MAX_RULES}-entry limit.`);
    return value.slice(0, MAX_RULES) as Record<string, unknown>[];
  };

  unknown(config, ['version', 'mode', 'identity', 'rules', 'permissions', 'risk', 'hooks', 'audit'], 'Policy');
  stringField(config, 'version', 'version');
  if (typeof config.version === 'string' && config.version !== '1.0') warning('Only constitution schema 1.0 has been reviewed.');
  enumField(config, 'mode', MODES, 'mode');
  validation.mode = config.mode === undefined ? 'enhanced'
    : typeof config.mode === 'string' && MODES.includes(config.mode) ? config.mode as HarnessMode : null;
  if (validation.mode === 'enhanced') {
    warning('Enhanced mode does not add context compaction or multi-agent execution to native clients through this integration.');
  }
  const identity = objectField(config, 'identity');
  unknown(identity, ['name', 'description', 'boundaries'], 'identity');
  for (const key of ['name', 'description']) stringField(identity, key, `identity.${key}`);
  stringList(identity, 'boundaries', 'identity.boundaries');

  const rules = objectList(config, 'rules', 'rules');
  validation.ruleCount = Array.isArray(config.rules) ? config.rules.length : 0;
  const ruleIds = new Set<string>();
  for (const rule of rules) {
    unknown(rule, ['id', 'description', 'severity', 'enforcement', 'patterns', 'triggers', 'checks'], 'A rule');
    stringField(rule, 'id', 'Rule id', true);
    stringField(rule, 'description', 'Rule description', true);
    if (typeof rule.id === 'string') {
      if (!rule.id.trim()) invalid('Rule ids must not be empty.');
      if (ruleIds.has(rule.id)) warning('Duplicate rule ids are present.');
      ruleIds.add(rule.id);
    }
    enumField(rule, 'severity', ['info', 'warning', 'error'], 'Rule severity');
    enumField(rule, 'enforcement', ['prompt', 'hook', 'both'], 'Rule enforcement');
    for (const key of ['patterns', 'triggers']) objectList(rule, key, `Rule ${key}`);
    stringList(rule, 'checks', 'Rule checks');
    if (Array.isArray(rule.checks) && rule.checks.length) invalid('Custom named rule checks are unsupported; only built-in hooks are available.');
    if (['patterns', 'triggers'].some(key => Array.isArray(rule[key]) && rule[key].length)) {
      warning('Rule patterns/triggers are metadata here; the check path does not register them as custom executable hooks.');
    }
  }
  if (rules.length) warning('Rule descriptions are guidance; programmatic decisions use permissions, risk rules and built-in hook profiles.');

  const permissions = objectField(config, 'permissions');
  unknown(permissions, ['defaults', 'tools'], 'permissions');
  const defaults = objectField(permissions, 'defaults', 'permissions.defaults');
  unknown(defaults, ['unknown_tool', 'unknown_path', 'on_error'], 'permissions.defaults');
  for (const key of ['unknown_tool', 'unknown_path', 'on_error']) enumField(defaults, key, ACTIONS, `permissions.defaults.${key}`);
  const tools = objectField(permissions, 'tools', 'permissions.tools');
  for (const tool of Object.values(tools)) {
    if (!harnessObject(tool)) { invalid('Each tool permission must be a mapping.'); continue; }
    unknown(tool, ['policy', 'deny_patterns', 'ask_patterns', 'allow_patterns', 'deny_paths', 'ask_paths', 'allow_paths', 'scope', 'allow_domains'], 'A tool permission');
    if (!('policy' in tool)) invalid('Each tool permission requires a policy.');
    enumField(tool, 'policy', ['allow', 'restricted', 'deny'], 'Tool policy');
    for (const key of ['deny_patterns', 'ask_patterns', 'allow_patterns', 'deny_paths', 'ask_paths', 'allow_paths', 'allow_domains']) {
      stringList(tool, key, `Tool ${key}`);
    }
    if (tool.scope !== null) stringField(tool, 'scope', 'Tool scope');
    if (Array.isArray(tool.allow_domains) && tool.allow_domains.length) {
      warning('The tested permission check does not enforce allow_domains; do not rely on it as a network boundary.');
    }
  }
  const risk = objectField(config, 'risk');
  unknown(risk, ['classifier', 'thresholds', 'custom_rules'], 'risk', true);
  if ('classifier' in risk && risk.classifier !== 'rules') invalid('Only the rules risk classifier is supported; model inference is disabled.');
  const thresholds = objectField(risk, 'thresholds', 'risk.thresholds');
  unknown(thresholds, LEVELS, 'risk.thresholds', true);
  for (const level of LEVELS) enumField(thresholds, level, ACTIONS, `risk.thresholds.${level}`);
  for (const rule of objectList(risk, 'custom_rules', 'risk.custom_rules')) {
    unknown(rule, ['pattern', 'level', 'reason', 'tool'], 'A custom risk rule', true);
    stringField(rule, 'pattern', 'Risk rule pattern', true);
    if (!('level' in rule)) invalid('A custom risk rule requires a level.');
    enumField(rule, 'level', LEVELS, 'Risk rule level');
    for (const key of ['reason', 'tool']) stringField(rule, key, `Risk rule ${key}`);
  }
  if (rules.length || Object.keys(tools).length || Array.isArray(risk.custom_rules) && risk.custom_rules.length) {
    warning('Pattern syntax and engine behavior require explicit engine validation; no expressions or commands are evaluated by this reader.');
  }

  const hooks = objectField(config, 'hooks');
  unknown(hooks, ['profile', 'pre', 'post'], 'hooks', true);
  enumField(hooks, 'profile', ['minimal', 'standard', 'strict'], 'Built-in hook profile');
  for (const key of ['pre', 'post']) {
    objectList(hooks, key, `hooks.${key}`);
    if (Array.isArray(hooks[key]) && hooks[key].length) invalid('Custom hook declarations are unsupported; select a built-in hook profile.');
  }

  const audit = objectField(config, 'audit');
  unknown(audit, ['enabled', 'format', 'output', 'retention_days', 'include'], 'audit');
  if ('enabled' in audit && typeof audit.enabled !== 'boolean') invalid('audit.enabled must be a boolean.');
  enumField(audit, 'format', ['jsonl'], 'Audit format');
  stringField(audit, 'output', 'audit.output');
  if ('output' in audit && typeof audit.output === 'string' && !audit.output.trim()) invalid('audit.output must not be empty.');
  if ('retention_days' in audit && (typeof audit.retention_days !== 'number' || !Number.isSafeInteger(audit.retention_days) || audit.retention_days < 1)) {
    invalid('audit.retention_days must be a positive integer.');
  }
  stringList(audit, 'include', 'audit.include');
  validation.valid = validation.errors.length === 0;
  return { config, validation };
}

export class HarnessPolicyStore {
  private readonly dataDir: string;
  private readonly homeDir: string;
  private readonly maxPolicyBytes: number;

  constructor(options: { dataDir: string; homeDir?: string; maxPolicyBytes?: number }) {
    this.dataDir = resolve(options.dataDir);
    this.homeDir = resolve(options.homeDir ?? homedir());
    this.maxPolicyBytes = boundedInteger(options.maxPolicyBytes, HARNESS_MAX_POLICY_BYTES, 1, HARNESS_MAX_POLICY_BYTES);
  }

  validate(content: string): HarnessValidation { return parsePolicy(content, this.maxPolicyBytes).validation; }

  parse(content: string): Record<string, unknown> {
    const parsed = parsePolicy(content, this.maxPolicyBytes);
    if (!parsed.validation.valid || !parsed.config) throw harnessError(400, parsed.validation.errors.join(' '));
    return parsed.config;
  }

  private async id(kind: string, root: string, path: string | null, project: Project | null): Promise<string> {
    const [owner, source, projectRoot] = await Promise.all([
      root ? canonicalSource(root) : null, path ? canonicalSource(path) : null,
      project ? canonicalSource(project.path) : null,
    ]);
    return contentHash(JSON.stringify(['agent-ops-harness-source-v1', kind, owner, source, project?.id ?? null, projectRoot]));
  }

  private managed(project: Project | null): PolicySource {
    const paths = harnessPaths(this.dataDir, project?.id ?? null);
    return { scope: 'managed', name: 'App-managed policy', root: this.dataDir, path: paths.policyPath, auditRoot: paths.directory };
  }

  private async describe(source: PolicySource, bytes: Buffer, project: Project | null): Promise<LoadedPolicy> {
    const content = decodeHarnessText(bytes);
    const parsed = parsePolicy(content, source.scope === 'builtin' ? HARNESS_MAX_POLICY_BYTES : this.maxPolicyBytes);
    const clean = harnessRedactor(parsed.config);
    // Unparseable documents can hide secrets through unsupported aliases/tags or malformed blocks.
    const publicContent = parsed.config ? clean(content, HARNESS_MAX_POLICY_BYTES) : '[REDACTED]';
    const identity = parsed.config && harnessObject(parsed.config.identity) ? parsed.config.identity : {};
    const redacted = publicContent !== content;
    const rules = parsed.config && Array.isArray(parsed.config.rules) ? parsed.config.rules.slice(0, MAX_RULES) : [];
    const detail: HarnessPolicyDetail = {
      id: await this.id(`policy:${source.scope}`, source.root, source.path, project),
      name: typeof identity.name === 'string' ? clean(identity.name, 160) || source.name : source.name,
      scope: source.scope, projectId: project?.id ?? null, path: source.path ? clean(source.path, 4096) : null,
      revision: contentHash(bytes), bytes: bytes.length, valid: parsed.validation.valid, mode: parsed.validation.mode,
      ruleCount: parsed.validation.ruleCount, editable: source.scope === 'managed' && !redacted,
      redacted, content: publicContent,
      warnings: [...parsed.validation.errors, ...parsed.validation.warnings,
        ...(redacted ? ['Secret or unsupported source content is masked. Masked copies cannot be saved.'] : [])],
      rules: rules.filter(harnessObject).map(rule => ({
        id: clean(typeof rule.id === 'string' ? rule.id : '', 160),
        description: clean(typeof rule.description === 'string' ? rule.description : '', 1024),
        severity: ['info', 'warning', 'error'].includes(String(rule.severity)) ? String(rule.severity) : 'error',
        enforcement: ['prompt', 'hook', 'both'].includes(String(rule.enforcement)) ? String(rule.enforcement) : 'both',
      })),
    };
    return { source, bytes, parsed, detail };
  }

  private async discover(project: Project | null): Promise<{ loaded: LoadedPolicy[]; warnings: string[] }> {
    const warnings = [SEPARATE_POLICIES];
    const loaded = [await this.describe({ scope: 'builtin', name: 'Agent Ops standard', root: '', path: null, auditRoot: '' }, Buffer.from(BUILTIN_POLICY), project)];
    const load = async (source: PolicySource): Promise<boolean> => {
      try {
        const info = await inspectHarnessPath(source.root, source.path!);
        if (!info?.isFile()) {
          warnings.push(`${source.name} was excluded: a regular policy file is required.`);
          return false;
        }
        try { loaded.push(await this.describe(source, await readHarnessBytes(source.root, source.path!, this.maxPolicyBytes), project)); }
        catch { warnings.push(`${source.name} could not be read safely within the UTF-8 and byte limits.`); }
        return true;
      } catch (error) {
        if (missingHarnessFile(error)) return false;
        warnings.push(`${source.name} was excluded by owner/file safety checks.`);
        return true;
      }
    };
    const userRoot = join(this.homeDir, '.autoharness');
    await load({ scope: 'user', name: 'User AutoHarness policy', root: this.homeDir, path: join(userRoot, 'config.yaml'), auditRoot: userRoot });
    if (project) {
      for (const candidate of ['.autoharness.yaml', 'constitution.yaml', '.autoharness/constitution.yaml', 'autoharness.yaml']) {
        if (await load({
          scope: 'project', name: 'Project AutoHarness policy', root: project.path,
          path: join(project.path, candidate), auditRoot: project.path,
        })) break;
      }
      await load({
        scope: 'local', name: 'Local AutoHarness override', root: project.path,
        path: join(project.path, '.autoharness.local.yaml'), auditRoot: project.path,
      });
    }
    await load(this.managed(project));
    return { loaded, warnings };
  }

  async list(project: Project | null): Promise<HarnessPolicySnapshot> {
    const { loaded, warnings } = await this.discover(project);
    const auditSources: HarnessAuditFile[] = [];
    const managedAudit = harnessPaths(this.dataDir, project?.id ?? null).auditPath;
    const writerPaths = [managedAudit, ...['events.1.jsonl', 'events.2.jsonl'].map(name => join(dirname(managedAudit), name))];
    const addAudit = async (root: string, path: string, options: {
      managed?: boolean; configured?: boolean; existingOnly?: boolean; scope?: Project | null;
    } = {}) => {
      const { managed = false, configured = false, existingOnly = false, scope = project } = options;
      const target = resolve(path);
      const previous = auditSources.findIndex(item => item.path === target);
      // A shared user source must not acquire a project simply because a project
      // default names the same file. Keep the least specific established attribution.
      if (previous >= 0 && (scope !== null || auditSources[previous].projectId === null || auditSources[previous].managed)) return;
      try {
        const info = await inspectHarnessPath(root, target, true);
        if (existingOnly && !info) return;
        if (info && (!info.isFile() || info.nlink !== 1)) throw new Error('Unsafe source');
        const source = {
          id: await this.id('audit', resolve(root), target, scope), root: resolve(root), path: target,
          projectId: scope?.id ?? null, managed,
        };
        if (previous >= 0) auditSources[previous] = source;
        else auditSources.push(source);
      } catch {
        warnings.push(`${configured ? 'Configured' : 'Default'} audit source was excluded by owner/file safety checks.`);
      }
    };
    const nativeRoot = project?.path ?? this.homeDir;
    await addAudit(nativeRoot, join(nativeRoot, '.autoharness/audit.jsonl'));
    for (const { source, parsed } of loaded) {
      if (source.scope === 'builtin' || !parsed.config || !harnessObject(parsed.config.audit)) continue;
      const output = parsed.config.audit.output;
      if (typeof output !== 'string' || !output.trim()) continue;
      const target = isAbsolute(output) ? resolve(output) : resolve(source.auditRoot, output);
      // Only the fixed bridge writer paths receive app provenance, through the owned entries below.
      if (writerPaths.includes(target)) continue;
      if (!withinHarnessRoot(resolve(source.auditRoot), target)) {
        warnings.push('Configured audit output outside its policy owner was excluded.');
        continue;
      }
      await addAudit(source.root, target, { configured: true, scope: source.scope === 'user' ? null : project });
    }
    await addAudit(this.dataDir, managedAudit, { managed: true });
    // bridge.py owns exactly these archives. Never glob or mutate external audit history.
    for (const name of ['events.1.jsonl', 'events.2.jsonl']) {
      await addAudit(this.dataDir, join(dirname(managedAudit), name), { managed: true, existingOnly: true });
    }
    return { policies: loaded.map(item => item.detail), auditSources, warnings };
  }

  private async selected(id: string, project: Project | null): Promise<LoadedPolicy> {
    const { loaded } = await this.discover(project);
    const found = loaded.find(item => item.detail.id === id);
    if (!found) throw harnessError(409, 'Policy source changed or belongs to another scope. Refresh the policy catalog.');
    return found;
  }

  async detail(id: string, project: Project | null): Promise<HarnessPolicyDetail> {
    return (await this.selected(id, project)).detail;
  }

  async resolve(id: string, revision: string, project: Project | null): Promise<HarnessResolvedPolicy> {
    const selected = await this.selected(id, project);
    if (selected.detail.revision !== revision) throw harnessError(409, 'Policy revision changed. Refresh before checking it.');
    if (!selected.parsed.validation.valid || !selected.parsed.config) {
      throw harnessError(400, 'Policy is invalid or unsupported. Validate it before checking it.');
    }
    return { detail: selected.detail, content: decodeHarnessText(selected.bytes), config: selected.parsed.config };
  }

  async save(project: Project | null, content: string, expectedRevision: string | null): Promise<HarnessPolicyDetail> {
    if (typeof content !== 'string' || /\[REDACTED(?:[^\]]*)\]/i.test(content)) {
      throw harnessError(400, 'Masked policy content cannot be saved. Supply an unmasked policy explicitly.');
    }
    const parsed = parsePolicy(content, this.maxPolicyBytes);
    if (!parsed.validation.valid) throw harnessError(400, parsed.validation.errors.join(' '));
    const source = this.managed(project);
    const path = source.path!;
    return withHarnessWriteLock(this.dataDir, path, async () => {
      const current = async () => {
        try { return await readHarnessBytes(this.dataDir, path, this.maxPolicyBytes); }
        catch (error) { if (missingHarnessFile(error)) return null; throw error; }
      };
      const before = await current();
      const revision = before === null ? null : contentHash(before);
      if (revision !== expectedRevision) throw harnessError(409, 'Managed policy revision changed. Refresh before saving.');
      if (before !== null) {
        await replaceHarnessBytes(this.dataDir, `${path}.bak`, before);
        const backup = await readHarnessBytes(this.dataDir, `${path}.bak`, this.maxPolicyBytes);
        if (contentHash(backup) !== revision) throw harnessError(409, 'Managed policy backup verification failed.');
      }
      const latest = await current();
      if ((latest === null ? null : contentHash(latest)) !== revision) {
        throw harnessError(409, 'Managed policy changed while saving.');
      }
      const bytes = Buffer.from(content);
      await replaceHarnessBytes(this.dataDir, path, bytes);
      const saved = await readHarnessBytes(this.dataDir, path, this.maxPolicyBytes);
      if (contentHash(saved) !== contentHash(bytes)) throw harnessError(409, 'Managed policy changed after replacement.');
      return (await this.describe(source, saved, project)).detail;
    });
  }
}
