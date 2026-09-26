import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { HARNESS_CLIENTS, type HarnessBinding, type HarnessClient, type HarnessHookPreview,
  type HarnessHookRequest, type HarnessRuntime } from '../../shared/harness.js';
import type { Project } from '../../shared/types.js';
import { HARNESS_MAX_POLICY_BYTES, harnessError, harnessPaths, type HarnessHookBindingFile,
  type HarnessResolvedPolicy } from './types.js';
import { HookFiles, hookAbsolute, hookHash, type HookFileChange } from './hooks-files.js';

type ObjectValue = Record<string, unknown>;
type ManagedClient = 'codex' | 'claude-code' | 'kiro';
type Versions = Partial<Record<HarnessClient, string | null>>;
type Event = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure';
interface Source { path: string; scope: 'user' | 'project'; value: ObjectValue; kiro: boolean }
interface InstalledState {
  protocol: 1;
  owner: 'agent-ops-harness-hooks';
  client: ManagedClient;
  projectId: string;
  projectDir: string;
  targetPath: string;
  bindingPath: string;
  pythonPath: string;
  bridgePath: string;
  configHash: string;
  bindingHash: string;
  createdTarget: boolean;
  hadHooks: boolean;
}
interface Inventory {
  files: HookFiles;
  sources: Source[];
  targetPath: string | null;
  bindingPath: string | null;
  statePath: string | null;
  binding: HarnessHookBindingFile | null;
  installed: InstalledState | null;
  document: ObjectValue | null;
  projectDir: string | null;
}
interface StoredPreview {
  request: HarnessHookRequest;
  projectFingerprint: string;
  runtimeFingerprint: string | null;
  policyFingerprint: string | null;
  policySource: HarnessResolvedPolicy | null;
  policySnapshot: HarnessResolvedPolicy | null;
  versionsFingerprint: string;
  expires: number;
  bytes: number;
  canApply: boolean;
  files: HookFiles;
  changes: HookFileChange[];
}
interface HarnessHookManagerOptions {
  dataDir: string;
  homeDir?: string;
  codexHome?: string;
  claudeHome?: string;
  kiroHome?: string;
  bridgePath: string;
  previewTtlMs?: number;
  getProject?: (id: string) => Project | null;
}

const MAX_PREVIEWS = 32;
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_NODES = 20000;
const PRE_TOOL_FAILURE = ' || exit 2';
const managedClient = (client: HarnessClient): ManagedClient => client.startsWith('kiro-') ? 'kiro' : client as ManagedClient;
const events = (client: ManagedClient): Event[] => client === 'claude-code'
  ? ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'] : ['PreToolUse', 'PostToolUse'];
const requiredVersion = (client: HarnessClient) => client === 'kiro-ide' ? '1.0' : client === 'kiro-cli' ? '3.0' : null;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const within = (root: string, path: string) => {
  const tail = relative(root, path);
  return tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
};
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const fingerprint = (value: unknown) => hookHash(JSON.stringify(value));
const sharedKiroNotice = 'Shared Kiro IDE/CLI configuration: installing, updating or removing it affects both clients. Events may not identify which client ran.';
const trustNotice = 'Codex requires native /hooks review and trust of this exact hook definition. Installed does not mean active.';

function bounded(value: unknown) {
  const stack = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let count = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++count > MAX_NODES || current.depth > 32) throw harnessError(413, 'Hook input depth or node limit exceeded.');
    if (current.value && typeof current.value === 'object') {
      if (seen.has(current.value)) throw harnessError(400, 'Invalid cyclic hook input.');
      seen.add(current.value);
      for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 });
    } else if (!['string', 'number', 'boolean', 'undefined'].includes(typeof current.value) && current.value !== null) {
      throw harnessError(400, 'Invalid hook input value.');
    }
  }
}

function parseDocument(text: string, toml = false): ObjectValue {
  let value: unknown;
  try { value = toml ? parseToml(text.replace(/^\uFEFF/, '')) : JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw harnessError(400, `Invalid native hook ${toml ? 'TOML' : 'JSON'}; the source was not changed.`); }
  bounded(value);
  if (!object(value)) throw harnessError(400, 'Invalid hook configuration: expected an object.');
  return value;
}

function validateNative(value: ObjectValue, kiro: boolean, toml = false) {
  if (kiro) {
    if (value.version !== 'v1' || !Array.isArray(value.hooks)) throw harnessError(400, 'Invalid Kiro v1 hook schema.');
    for (const hook of value.hooks) {
      if (!object(hook) || typeof hook.name !== 'string' || typeof hook.trigger !== 'string' ||
        !object(hook.action) || !['command', 'agent'].includes(String(hook.action.type)) ||
        (hook.action.type === 'command' && typeof hook.action.command !== 'string') ||
        (hook.action.type === 'agent' && typeof hook.action.prompt !== 'string') ||
        (hook.matcher !== undefined && typeof hook.matcher !== 'string') ||
        (hook.timeout !== undefined && (typeof hook.timeout !== 'number' || !Number.isFinite(hook.timeout) || hook.timeout < 0))) {
        throw harnessError(400, 'Invalid Kiro hook definition.');
      }
    }
  } else {
    if (value.hooks === undefined) return;
    if (!object(value.hooks)) throw harnessError(400, 'Invalid native hooks object.');
    for (const [event, groups] of Object.entries(value.hooks)) {
      if (toml && ['managed_dir', 'windows_managed_dir'].includes(event) && typeof groups === 'string') continue;
      if (!Array.isArray(groups)) throw harnessError(400, 'Invalid native hook matcher groups.');
      for (const group of groups) {
        if (!object(group) || !Array.isArray(group.hooks) || (group.matcher !== undefined && typeof group.matcher !== 'string')) {
          throw harnessError(400, 'Invalid native hook matcher group; flat command entries are not supported.');
        }
        for (const hook of group.hooks) {
          if (!object(hook) || typeof hook.type !== 'string' || (hook.type === 'command' && typeof hook.command !== 'string')) {
            throw harnessError(400, 'Invalid native hook handler.');
          }
        }
      }
    }
  }
}

function commands(client: ManagedClient, pythonPath: string, bridgePath: string, bindingPath: string) {
  hookAbsolute(pythonPath);
  hookAbsolute(bridgePath);
  hookAbsolute(bindingPath);
  return Object.fromEntries(events(client).map(event => [
    event, `${quote(pythonPath)} -I ${quote(bridgePath)} --binding ${quote(bindingPath)} --event ${event}${event === 'PreToolUse' ? PRE_TOOL_FAILURE : ''}`,
  ])) as Partial<Record<Event, string>>;
}

function isOwnedCommand(own: Partial<Record<Event, string>>, event: string, command: unknown) {
  const expected = own[event as Event];
  if (!expected || typeof command !== 'string') return false;
  // Recognize the exact previously generated PreToolUse command as well, so an
  // explicit update upgrades it instead of installing a second policy hook.
  return command === expected || event === 'PreToolUse' && expected.endsWith(PRE_TOOL_FAILURE) &&
    command === expected.slice(0, -PRE_TOOL_FAILURE.length);
}

function sourceCommands(source: Source): Array<{ event: string; command: string; disabled: boolean }> {
  if (source.kiro) return (source.value.hooks as ObjectValue[]).flatMap(hook => {
    const action = hook.action as ObjectValue;
    return action.type === 'command' ? [{ event: String(hook.trigger), command: String(action.command), disabled: hook.enabled === false }] : [];
  });
  const result: Array<{ event: string; command: string; disabled: boolean }> = [];
  for (const [event, groups] of Object.entries((source.value.hooks ?? {}) as ObjectValue)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups as ObjectValue[]) {
      for (const handler of group.hooks as ObjectValue[]) {
        if (handler.type === 'command') result.push({ event, command: String(handler.command), disabled: handler.enabled === false });
      }
    }
  }
  return result;
}

function stripOwned(document: ObjectValue, client: ManagedClient, own: Partial<Record<Event, string>>) {
  const result = structuredClone(document);
  let removed = 0;
  if (client === 'kiro') {
    result.hooks = (result.hooks as ObjectValue[]).filter(hook => {
      const action = hook.action as ObjectValue;
      const owned = action.type === 'command' && isOwnedCommand(own, String(hook.trigger), action.command);
      if (owned) removed++;
      return !owned;
    });
  } else if (object(result.hooks)) {
    for (const event of events(client)) {
      const groups = result.hooks[event];
      if (!Array.isArray(groups)) continue;
      const kept: ObjectValue[] = [];
      for (const group of groups as ObjectValue[]) {
        let removedHere = 0;
        const remaining = (group.hooks as ObjectValue[]).filter(hook => {
          const owned = hook.type === 'command' && isOwnedCommand(own, event, hook.command);
          if (owned) { removed++; removedHere++; }
          return !owned;
        });
        if (!removedHere || remaining.length || Object.keys(group).some(key => !['matcher', 'hooks'].includes(key))) {
          kept.push(removedHere ? { ...group, hooks: remaining } : group);
        }
      }
      if (kept.length || groups.length === 0) result.hooks[event] = kept;
      else delete result.hooks[event];
    }
  }
  return { document: result, removed };
}

function installCommands(document: ObjectValue, client: ManagedClient, generated: Partial<Record<Event, string>>) {
  if (client === 'kiro') {
    const hooks = document.hooks as ObjectValue[];
    for (const event of events(client)) hooks.push({
      name: `agent-ops AutoHarness ${event}`, trigger: event, matcher: '.*',
      action: { type: 'command', command: generated[event] }, timeout: 15,
    });
  } else {
    const hooks = (document.hooks ??= {}) as ObjectValue;
    for (const event of events(client)) {
      const groups = (hooks[event] ??= []) as ObjectValue[];
      groups.push({ matcher: '.*', hooks: [{ type: 'command', command: generated[event], timeout: 15 }] });
    }
  }
}

function checkedVersion(version: string | null | undefined) {
  if (typeof version !== 'string' || version.length > 128 || /[\u0000-\u001f]/.test(version)) return null;
  return /(?:^|\s)v?\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?(?:$|\s)/.test(version) ? version : null;
}

function unsupported(client: HarnessClient, version: string | null) {
  const required = requiredVersion(client);
  if (!required || !version) return false;
  const found = version.match(/(\d+)\.(\d+)/)!;
  return Number(found[1]) < Number(required.split('.')[0]);
}

export class HarnessHookManager {
  private readonly dataDir: string;
  private readonly homeDir: string;
  private readonly homes: Record<ManagedClient, string>;
  private readonly bridgePath: string;
  private readonly ttl: number;
  private readonly getProject?: (id: string) => Project | null;
  private readonly previews = new Map<string, StoredPreview>();
  private readonly versions = new Map<string, Versions>();
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private closed = false;

  constructor(options: HarnessHookManagerOptions) {
    this.dataDir = hookAbsolute(options.dataDir);
    this.homeDir = hookAbsolute(options.homeDir ?? homedir());
    this.homes = {
      codex: hookAbsolute(options.codexHome ?? join(this.homeDir, '.codex')),
      'claude-code': hookAbsolute(options.claudeHome ?? join(this.homeDir, '.claude')),
      kiro: hookAbsolute(options.kiroHome ?? join(this.homeDir, '.kiro')),
    };
    this.bridgePath = hookAbsolute(options.bridgePath);
    this.getProject = options.getProject;
    const ttl = options.previewTtlMs ?? 60000;
    if (!Number.isFinite(ttl) || ttl <= 0) throw harnessError(400, 'Invalid hook preview TTL.');
    this.ttl = Math.min(60000, ttl);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(harnessError(503, 'Hook manager is closed.'));
    if (this.queued >= 64) return Promise.reject(harnessError(429, 'Too many pending hook operations.'));
    this.queued++;
    const result = this.tail.then(() => {
      if (this.closed) throw harnessError(503, 'Hook manager is closed.');
      return operation();
    });
    this.tail = result.catch(() => undefined).finally(() => { this.queued--; });
    return result;
  }

  private versionKey(project: Project | null) { return project ? `${project.id}\0${project.path}` : 'global'; }
  private clientVersions(project: Project | null) { return this.versions.get(this.versionKey(project)) ?? {}; }
  private rememberVersions(project: Project | null, versions?: Versions) {
    if (!versions) return;
    const key = this.versionKey(project);
    const found = { ...this.clientVersions(project) };
    for (const client of HARNESS_CLIENTS) if (Object.hasOwn(versions, client)) found[client] = checkedVersion(versions[client]);
    this.versions.delete(key);
    this.versions.set(key, found);
    while (this.versions.size > 64) this.versions.delete(this.versions.keys().next().value!);
  }

  private validateProject(project: Project) {
    if (!project || typeof project.id !== 'string' || !project.id || project.id.length > 512 ||
      typeof project.path !== 'string' || typeof project.executionEnabled !== 'boolean') {
      throw harnessError(400, 'Invalid registered project.');
    }
    hookAbsolute(project.path);
  }

  private revalidateRegistration(expected: Project) {
    if (!this.getProject) return;
    const registered = this.getProject(expected.id);
    if (!registered || registered.id !== expected.id || registered.path !== expected.path ||
      registered.executionEnabled !== expected.executionEnabled) {
      throw harnessError(409, 'Registered project path or execution permission changed; create a new preview.');
    }
  }

  private async inventory(client: HarnessClient, project: Project | null): Promise<Inventory> {
    const files = new HookFiles();
    const family = managedClient(client);
    const sources: Source[] = [];
    let projectDir: string | null = null;
    if (project) {
      this.validateProject(project);
      projectDir = await files.project(project.path);
    }
    const targetPath = !projectDir ? null : family === 'claude-code'
      ? join(projectDir, '.claude', 'settings.local.json')
      : family === 'codex' ? join(projectDir, '.codex', 'hooks.json')
        : join(projectDir, '.kiro', 'hooks', 'agent-ops-autoharness.json');
    const add = async (path: string, scope: 'user' | 'project', toml = false) => {
      if (sources.some(source => source.path === path)) return;
      const file = await files.read(path);
      if (file.text === null) return;
      const value = parseDocument(file.text, toml);
      validateNative(value, family === 'kiro', toml);
      sources.push({ path, scope, value, kiro: family === 'kiro' });
    };
    if (family === 'kiro') {
      for (const [directory, scope] of [
        [join(this.homes.kiro, 'hooks'), 'user'],
        ...(projectDir ? [[join(projectDir, '.kiro', 'hooks'), 'project']] : []),
      ] as Array<[string, 'user' | 'project']>) {
        for (const path of await files.jsonFiles(directory)) await add(path, scope);
      }
      if (targetPath) await add(targetPath, 'project');
    } else {
      const directories: Array<[string, 'user' | 'project']> = [[this.homes[family], 'user']];
      if (projectDir) directories.push([join(projectDir, family === 'codex' ? '.codex' : '.claude'), 'project']);
      for (const [directory, scope] of directories) {
        if (family === 'claude-code') {
          await add(join(directory, 'settings.json'), scope);
          await add(join(directory, 'settings.local.json'), scope);
        } else {
          await add(join(directory, 'hooks.json'), scope);
          await add(join(directory, 'config.toml'), scope, true);
        }
      }
    }
    let bindingPath: string | null = null;
    let statePath: string | null = null;
    let binding: HarnessHookBindingFile | null = null;
    let installed: InstalledState | null = null;
    if (project) {
      const directory = harnessPaths(this.dataDir, project.id).bindingsDir;
      bindingPath = join(directory, `${family}.json`);
      statePath = join(directory, `${family}.hooks-state.json`);
      const bindingFile = await files.read(bindingPath);
      const stateFile = await files.read(statePath);
      if (bindingFile.text !== null) {
        const value = parseDocument(bindingFile.text);
        if (value.protocol !== 1 || value.client !== family || value.projectId !== project.id || value.projectDir !== projectDir ||
          typeof value.policyId !== 'string' || typeof value.policyRevision !== 'string' || !object(value.policy) ||
          typeof value.pythonPath !== 'string' || typeof value.engineVersion !== 'string' || typeof value.createdAt !== 'string') {
          throw harnessError(400, 'Invalid hook binding ownership or schema.');
        }
        hookAbsolute(value.pythonPath);
        binding = value as unknown as HarnessHookBindingFile;
      }
      if (stateFile.text !== null) {
        const value = parseDocument(stateFile.text);
        if (value.protocol !== 1 || value.owner !== 'agent-ops-harness-hooks' || value.client !== family ||
          value.projectId !== project.id || value.projectDir !== projectDir || value.targetPath !== targetPath ||
          value.bindingPath !== bindingPath || typeof value.pythonPath !== 'string' || typeof value.bridgePath !== 'string' ||
          typeof value.configHash !== 'string' || typeof value.bindingHash !== 'string' ||
          typeof value.createdTarget !== 'boolean' || typeof value.hadHooks !== 'boolean') {
          throw harnessError(400, 'Invalid app-owned hook fingerprint record.');
        }
        hookAbsolute(value.pythonPath);
        hookAbsolute(value.bridgePath);
        installed = value as unknown as InstalledState;
      }
      // Old per-client Kiro bindings cannot silently coexist with the common
      // bridge. Retain them and require explicit repair of their ownership.
      if (family === 'kiro') {
        for (const legacy of ['kiro-ide', 'kiro-cli']) {
          const file = await files.read(join(directory, `${legacy}.json`));
          if (file.text !== null) throw harnessError(409, 'Conflicting legacy Kiro client binding; preserve it and resolve the shared Kiro configuration first.');
        }
      }
    }
    return {
      files, sources, targetPath, bindingPath, statePath, binding, installed, projectDir,
      document: sources.find(source => source.path === targetPath)?.value ?? null,
    };
  }

  private ownCommands(client: HarnessClient, inventory: Inventory) {
    const state = inventory.installed;
    if (state) return commands(managedClient(client), state.pythonPath, state.bridgePath, inventory.bindingPath!);
    const binding = inventory.binding;
    return binding ? commands(managedClient(client), binding.pythonPath, this.bridgePath, inventory.bindingPath!) : {};
  }

  private unresolvedBindingReferences(client: HarnessClient, inventory: Inventory) {
    if (!inventory.bindingPath) return false;
    const path = inventory.bindingPath;
    const quoted = quote(path);
    const own = this.ownCommands(client, inventory);
    return inventory.sources.some(source => sourceCommands(source).some(hook =>
      (hook.command.includes(path) || hook.command.includes(quoted)) &&
      (source.path !== inventory.targetPath || !isOwnedCommand(own, hook.event, hook.command))));
  }

  private row(client: HarnessClient, project: Project | null, inventory: Inventory): HarnessBinding {
    const version = checkedVersion(this.clientVersions(project)[client]);
    const family = managedClient(client);
    const own = this.ownCommands(client, inventory);
    const hasOwner = Boolean(inventory.binding || inventory.installed);
    const owned = inventory.sources.filter(source => source.path === inventory.targetPath)
      .flatMap(sourceCommands).filter(command => isOwnedCommand(own, command.event, command.command));
    const external = inventory.sources.filter(source => sourceCommands(source).some(command =>
      /auto[-_]?harness/i.test(command.command) || command.command.includes('--binding') && command.command.includes(this.bridgePath)));
    const primary = external.find(source => source.scope === 'project') ?? external[0];
    const notices: string[] = [];
    let state: HarnessBinding['state'] = hasOwner ? 'configured' : primary ? 'needs-review' : 'unconfigured';
    if (family === 'kiro') notices.push(sharedKiroNotice);
    if (client === 'codex') notices.push(trustNotice);
    if (primary && (!hasOwner || external.some(source => source.path !== inventory.targetPath))) {
      notices.push('Outside AutoHarness declarations are read-only and are not managed or removable by this integration.');
    }
    if (hasOwner) {
      const record = inventory.installed;
      const changed = !inventory.binding || owned.length !== events(family).length ||
        record && (inventory.files.files.get(inventory.targetPath!)?.hash !== record.configHash ||
          inventory.files.files.get(inventory.bindingPath!)?.hash !== record.bindingHash);
      if (changed) {
        state = 'changed';
        notices.push('Installed hook or binding fingerprints changed; create a new preview to review the drift.');
      } else if (!record) {
        state = 'needs-review';
        notices.push('The installed fingerprint record is missing; review the binding before updating it.');
      } else if (client === 'codex' || owned.some(command => command.disabled)) state = 'needs-review';
    }
    if (owned.some(command => command.event === 'PreToolUse' && command.command !== own.PreToolUse)) {
      if (state === 'configured') state = 'needs-review';
      notices.push('The installed PreToolUse command predates the fail-closed fallback; preview an update to protect interpreter or bridge failures.');
    }
    if (inventory.sources.some(source => source.value.disableAllHooks === true ||
      source.value.allow_managed_hooks_only === true ||
      object(source.value.features) && (source.value.features.hooks === false || source.value.features.codex_hooks === false))) {
      if (state === 'configured') state = 'needs-review';
      notices.push('Native settings disable hooks or restrict them to administrator-managed hooks; review those settings in the native client.');
    }
    if (!version) {
      if (state !== 'changed') state = hasOwner || primary ? 'needs-review' : 'unknown';
      notices.push('Client version is unknown; verify version and native hook support before relying on this configuration.');
    } else if (unsupported(client, version)) {
      state = 'unsupported';
      notices.push(`This hook format requires ${client === 'kiro-cli' ? 'Kiro CLI 3.0' : 'Kiro IDE 1.0'} or later.`);
    }
    if (this.unresolvedBindingReferences(client, inventory)) {
      if (hasOwner) state = 'changed';
      notices.push('Unresolved handlers still reference this binding. Reconcile them in the native configuration before updating or removing it; the handlers and binding are preserved.');
    }
    return {
      client, projectId: project?.id ?? null, state,
      path: hasOwner ? inventory.targetPath : primary?.path ?? inventory.targetPath,
      scope: hasOwner ? 'project' : primary?.scope ?? null, managed: hasOwner,
      policyRevision: inventory.binding?.policyRevision ?? null, detectedVersion: version,
      requiredVersion: requiredVersion(client), lastObservedAt: null, notices,
    };
  }

  list(project: Project | null, versions?: Versions): Promise<HarnessBinding[]> {
    return this.serialize(async () => {
      this.rememberVersions(project, versions);
      const result: HarnessBinding[] = [];
      for (const client of HARNESS_CLIENTS) {
        try { result.push(this.row(client, project, await this.inventory(client, project))); }
        catch (error) {
          result.push({
            client, projectId: project?.id ?? null, state: 'unknown', path: null, scope: null, managed: false,
            policyRevision: null, detectedVersion: checkedVersion(this.clientVersions(project)[client]),
            requiredVersion: requiredVersion(client), lastObservedAt: null,
            notices: [(error as Error).message, ...(managedClient(client) === 'kiro' ? [sharedKiroNotice] : [])],
          });
        }
      }
      return result;
    });
  }

  private checkPolicy(request: HarnessHookRequest, project: Project, resolved: HarnessResolvedPolicy | null) {
    if (!resolved || !resolved.detail.valid || resolved.detail.id !== request.policyId || resolved.detail.revision !== request.revision ||
      resolved.detail.projectId !== null && resolved.detail.projectId !== project.id) {
      throw harnessError(409, 'Selected policy or revision does not match this project.');
    }
    bounded(resolved);
    if (!object(resolved.config) || Buffer.byteLength(resolved.content) > HARNESS_MAX_POLICY_BYTES ||
      Buffer.byteLength(JSON.stringify(resolved.config)) > HARNESS_MAX_POLICY_BYTES) {
      throw harnessError(413, 'Selected policy exceeds the hook policy size limit.');
    }
    return structuredClone(resolved);
  }

  private expire() {
    const now = Date.now();
    for (const [id, preview] of this.previews) if (preview.expires <= now) this.previews.delete(id);
  }

  /** Parent must resolve this immutable policy selection and revalidate its revision before apply. */
  getSelection(previewId: string): HarnessHookRequest {
    this.expire();
    const preview = !this.closed && this.previews.get(previewId);
    if (!preview) throw harnessError(409, 'Hook preview expired or was already used.');
    return { ...preview.request };
  }

  preview(request: HarnessHookRequest, project: Project, resolved: HarnessResolvedPolicy | null, runtime: HarnessRuntime): Promise<HarnessHookPreview> {
    // Copy browser-owned selection immediately, before any await or queued work.
    const selection = { projectId: request.projectId, client: request.client, action: request.action,
      ...(request.policyId !== undefined ? { policyId: request.policyId } : {}),
      ...(request.revision !== undefined ? { revision: request.revision } : {}) };
    const projectSnapshot = structuredClone(project);
    const runtimeSnapshot = structuredClone(runtime);
    return this.serialize(async () => {
      this.expire();
      this.validateProject(projectSnapshot);
      if (selection.projectId !== projectSnapshot.id || !HARNESS_CLIENTS.includes(selection.client) || !['install', 'remove'].includes(selection.action)) {
        throw harnessError(400, 'Invalid hook client, action or registered project selection.');
      }
      const inventory = await this.inventory(selection.client, projectSnapshot);
      const family = managedClient(selection.client);
      const target = inventory.targetPath!;
      if (Object.values(this.homes).some(home => within(home, target))) {
        throw harnessError(400, 'Native user/global scope is read-only; choose a separate registered project.');
      }
      const row = this.row(selection.client, projectSnapshot, inventory);
      const notices = [...row.notices];
      let canApply = !this.unresolvedBindingReferences(selection.client, inventory);
      let policySnapshot: HarnessResolvedPolicy | null = null;
      if (selection.action === 'install') {
        policySnapshot = this.checkPolicy(selection, projectSnapshot, resolved);
        if (!projectSnapshot.executionEnabled) {
          canApply = false;
          notices.push('Enable execution for this registered project before installing a hook.');
        }
        if (runtimeSnapshot.state !== 'ready' || !runtimeSnapshot.pythonPath || !runtimeSnapshot.engineVersion) {
          canApply = false;
          notices.push('A ready Python AutoHarness engine is required before installing a hook.');
        }
        if (unsupported(selection.client, row.detectedVersion)) {
          canApply = false;
          notices.push('Installation is unavailable for this known unsupported native client version.');
        }
        if (family === 'kiro') {
          const own = this.ownCommands(selection.client, inventory);
          const conflicts = inventory.sources.filter(source => source.path === target).flatMap(sourceCommands).some(hook =>
            hook.command.includes('--binding') &&
            (hook.command.includes(this.bridgePath) || /kiro(?:-ide|-cli)?\.json/.test(hook.command)) &&
            !isOwnedCommand(own, hook.event, hook.command));
          if (conflicts) {
            canApply = false;
            notices.push('The shared Kiro target has a conflicting existing binding declaration. Resolve it explicitly before installing; its hooks are preserved.');
          }
        }
        if (policySnapshot.detail.path) {
          const path = hookAbsolute(policySnapshot.detail.path);
          const roots = [
            inventory.projectDir!, join(this.homeDir, '.autoharness'), join(this.homeDir, '.config', 'autoharness'),
            harnessPaths(this.dataDir, projectSnapshot.id).directory, harnessPaths(this.dataDir, null).directory,
          ];
          if (!roots.some(root => within(root, path))) throw harnessError(400, 'Selected policy path is outside the permitted owner roots.');
          const source = await inventory.files.read(path, { required: true, limit: HARNESS_MAX_POLICY_BYTES });
          if (source.text !== policySnapshot.content) throw harnessError(409, 'Selected policy source changed since it was resolved; create a new preview.');
        }
        if (canApply) {
          await inventory.files.readInterpreter(runtimeSnapshot.pythonPath!);
          await inventory.files.read(this.bridgePath, { required: true });
        }
      } else if (!inventory.binding && !inventory.installed) {
        canApply = false;
        notices.push('No app-owned project binding exists. Outside hooks cannot be removed.');
      }

      const changes: HookFileChange[] = [];
      if (canApply) {
        const oldDocument = inventory.document;
        let document = oldDocument ?? (family === 'kiro' ? { version: 'v1', hooks: [] } : {});
        const own = this.ownCommands(selection.client, inventory);
        document = stripOwned(document, family, own).document;
        if (selection.action === 'install') {
          const binding: HarnessHookBindingFile = {
            protocol: 1, client: family, projectId: projectSnapshot.id, projectDir: inventory.projectDir!,
            policyId: policySnapshot!.detail.id, policyRevision: policySnapshot!.detail.revision,
            policy: policySnapshot!.config, pythonPath: runtimeSnapshot.pythonPath!,
            engineVersion: runtimeSnapshot.engineVersion!,
            createdAt: inventory.binding?.createdAt ?? new Date().toISOString(),
          };
          installCommands(document, family, commands(family, binding.pythonPath, this.bridgePath, inventory.bindingPath!));
          const native = oldDocument && fingerprint(oldDocument) === fingerprint(document)
            ? inventory.files.files.get(target)!.text! : serialize(document);
          const bindingText = serialize(binding);
          const installed: InstalledState = {
            protocol: 1, owner: 'agent-ops-harness-hooks', client: family, projectId: projectSnapshot.id,
            projectDir: inventory.projectDir!, targetPath: target, bindingPath: inventory.bindingPath!,
            pythonPath: binding.pythonPath, bridgePath: this.bridgePath,
            configHash: hookHash(native), bindingHash: hookHash(bindingText),
            createdTarget: inventory.installed?.createdTarget ?? oldDocument === null,
            hadHooks: inventory.installed?.hadHooks ?? Boolean(oldDocument && Object.hasOwn(oldDocument, 'hooks')),
          };
          // Native hooks are activated only after their complete policy snapshot
          // and ownership record have been saved.
          changes.push(
            { path: inventory.bindingPath!, after: bindingText },
            { path: inventory.statePath!, after: serialize(installed) },
            { path: target, after: native },
          );
        } else {
          if (family !== 'kiro' && object(document.hooks) && !Object.keys(document.hooks).length && !inventory.installed?.hadHooks) delete document.hooks;
          const empty = family === 'kiro'
            ? Object.keys(document).every(key => ['version', 'hooks'].includes(key)) && !(document.hooks as unknown[]).length
            : Object.keys(document).length === 0;
          const native = oldDocument === null || inventory.installed?.createdTarget && empty ? null
            : oldDocument && fingerprint(oldDocument) === fingerprint(document) ? inventory.files.files.get(target)!.text! : serialize(document);
          // Deactivate first; an installed command must never reference a removed
          // binding while normal removal is in progress.
          changes.push(
            { path: target, after: native },
            { path: inventory.statePath!, after: null },
            { path: inventory.bindingPath!, after: null },
          );
        }
      }
      for (const change of changes) {
        if (change.after !== null && Buffer.byteLength(change.after) > MAX_CONFIG_BYTES) {
          throw harnessError(413, 'Rendered hook configuration exceeds the file size limit.');
        }
      }
      await inventory.files.verify();
      const id = randomUUID();
      const expires = Date.now() + this.ttl;
      const bytes = inventory.files.bytes + changes.reduce((sum, change) => sum + Buffer.byteLength(change.after ?? ''), 0) +
        Buffer.byteLength(JSON.stringify(policySnapshot)) * 2;
      if (bytes > MAX_PREVIEW_BYTES) throw harnessError(413, 'Hook preview exceeds the total byte limit.');
      const totalBytes = () => [...this.previews.values()].reduce((sum, preview) => sum + preview.bytes, 0);
      while (this.previews.size >= MAX_PREVIEWS || totalBytes() + bytes > MAX_PREVIEW_BYTES) {
        this.previews.delete(this.previews.keys().next().value!);
      }
      this.previews.set(id, {
        request: selection, projectFingerprint: fingerprint(projectSnapshot),
        runtimeFingerprint: selection.action === 'install' ? fingerprint(runtimeSnapshot) : null,
        policyFingerprint: policySnapshot ? fingerprint(policySnapshot) : null,
        policySource: selection.action === 'install' ? resolved : null, policySnapshot,
        versionsFingerprint: fingerprint(this.clientVersions(projectSnapshot)),
        expires, bytes, canApply, files: inventory.files, changes,
      });
      return {
        id, projectId: selection.projectId, client: selection.client, action: selection.action, canApply,
        expiresAt: new Date(expires).toISOString(),
        files: changes.filter(change => inventory.files.files.get(change.path)!.text !== change.after).map(change => ({
          path: change.path, existed: inventory.files.files.get(change.path)!.hash !== null,
          before: '[redacted]', after: '[redacted]',
        })),
        notices,
      };
    });
  }

  apply(previewId: string, project: Project, runtime: HarnessRuntime): Promise<HarnessBinding> {
    const projectSnapshot = structuredClone(project);
    const runtimeSnapshot = structuredClone(runtime);
    return this.serialize(async () => {
      this.expire();
      const preview = this.previews.get(previewId);
      this.previews.delete(previewId);
      if (!preview) throw harnessError(409, 'Hook preview expired or was already used.');
      if (!preview.canApply) throw harnessError(409, 'This hook preview cannot be applied.');
      if (fingerprint(projectSnapshot) !== preview.projectFingerprint) throw harnessError(409, 'Selected project changed; create a new preview.');
      if (preview.request.action === 'install') {
        if (fingerprint(runtimeSnapshot) !== preview.runtimeFingerprint) throw harnessError(409, 'Selected runtime changed; create a new preview.');
        if (!preview.policySource || fingerprint(this.checkPolicy(preview.request, projectSnapshot, preview.policySource)) !== preview.policyFingerprint ||
          fingerprint(preview.policySnapshot) !== preview.policyFingerprint) {
          throw harnessError(409, 'Selected policy changed; create a new preview.');
        }
        if (fingerprint(this.clientVersions(projectSnapshot)) !== preview.versionsFingerprint) throw harnessError(409, 'Native client versions changed; create a new preview.');
      }
      await preview.files.project(projectSnapshot.path);
      await preview.files.commit(preview.changes, join(harnessPaths(this.dataDir, projectSnapshot.id).bindingsDir, 'hook-backups'),
        managedClient(preview.request.client), projectSnapshot.id, () => this.revalidateRegistration(projectSnapshot));
      return this.row(preview.request.client, projectSnapshot, await this.inventory(preview.request.client, projectSnapshot));
    });
  }

  close() {
    this.closed = true;
    this.previews.clear();
    this.versions.clear();
  }
}
