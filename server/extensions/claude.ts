import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseSkillDocument, sanitizeText } from './analysis.js';
import type { DiscoveryContext, DiscoveryResult, ExtensionCandidate } from './types.js';

type Scope = ExtensionCandidate['scope'];
type Status = ExtensionCandidate['status'];
type Setting = { value: boolean; source: string };
interface PluginSource {
  root: string;
  name: string;
  id: string;
  marketplace: string;
  scope: Scope;
  installed: boolean;
  rank: number;
  origin: 'registry' | 'cache' | 'synced' | 'skills';
  bucket?: string;
  version?: string;
}

function key(kind: ExtensionCandidate['kind'], path: string): string {
  return `claude:${kind}:${createHash('sha256').update(resolve(path)).digest('hex')}`;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? sanitizeText(value).trim().slice(0, 2000) : undefined;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function within(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function json(
  context: DiscoveryContext, path: string, label: string, warnings: string[], ownerRoot?: string,
): Promise<Record<string, unknown> | null> {
  const value = await context.io.json(path, ownerRoot);
  if (value === null && await context.io.exists(path)) {
    warnings.push(`${label} 메타데이터를 안전하게 읽을 수 없습니다.`);
  }
  return value;
}

async function skill(
  context: DiscoveryContext, path: string, scope: Scope, legacy = false, ownerRoot?: string,
): Promise<ExtensionCandidate | null> {
  const text = await context.io.text(path, ownerRoot);
  if (text === null) return null;
  const parsed = parseSkillDocument(text);
  return {
    key: key('skill', path),
    agent: 'claude',
    kind: 'skill',
    name: string(parsed.metadata.name) ?? string(legacy ? basename(path, '.md') : basename(dirname(path))) ?? '스킬',
    description: string(parsed.metadata.description),
    version: string(parsed.metadata.version),
    scope,
    path,
    rootPath: dirname(path),
    status: 'available',
    statusReason: '스킬 파일을 발견했습니다. 실제 호출 여부는 확인하지 않습니다.',
    evidence: [{
      source: legacy ? 'commands' : 'SKILL.md',
      detail: legacy ? '레거시 Markdown 명령 파일입니다.' : '스킬의 선언 메타데이터를 읽었습니다.',
    }],
    warnings: parsed.warnings,
  };
}

function componentPaths(root: string, value: unknown, warnings: string[]): string[] {
  if (value === undefined) return [];
  const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [null];
  const paths: string[] = [];
  for (const entry of values) {
    if (typeof entry !== 'string' || !entry.trim() || entry.length > 4096
      || isAbsolute(entry) || /[\\\u0000-\u001f]/.test(entry)
      || entry.split('/').includes('..') || !within(root, resolve(root, entry))) {
      warnings.push('플러그인 구성요소 경로가 올바르지 않거나 플러그인 범위를 벗어나 제외했습니다.');
      continue;
    }
    paths.push(resolve(root, entry));
  }
  return [...new Set(paths)];
}

// A globally admitted target must still belong to this plugin's canonical root.
async function ownedPluginPath(
  context: DiscoveryContext, root: string, path: string, warnings: string[],
): Promise<boolean> {
  if (await context.io.contains(root, path)) return true;
  const warning = '플러그인 소유 범위 밖이거나 소유 경로를 확인할 수 없는 구성요소를 제외했습니다.';
  if (!warnings.includes(warning)) warnings.push(warning);
  return false;
}

function statusReason(status: Status): string {
  switch (status) {
    case 'enabled': return 'enabledPlugins 설정이 true입니다. 실제 호출 여부는 확인하지 않습니다.';
    case 'disabled': return 'enabledPlugins 설정이 false입니다. 실제 호출 여부는 확인하지 않습니다.';
    case 'cached': return '설치 증거와 연결되지 않은 캐시입니다. 활성 상태는 알 수 없습니다.';
    default: return '설치 메타데이터만 확인했습니다. 세션의 활성 상태는 알 수 없습니다.';
  }
}

/** Read-only Claude metadata discovery. All filesystem access belongs to DiscoveryIO. */
export async function discoverClaude(context: DiscoveryContext): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { candidates: [], roots: [], warnings: [] };
  const candidates = new Map<string, ExtensionCandidate>();
  const settings = new Map<string, Setting>();
  const overrides = new Map<string, { value: string; source: string }>();
  const sources = new Map<string, PluginSource>();
  const standalone = new Map<string, Array<{ item: ExtensionCandidate; rank: number }>>();
  const rememberStandalone = (item: ExtensionCandidate, namespace: string, legacy: boolean) => {
    const group = standalone.get(namespace) ?? [];
    group.push({ item, rank: (legacy ? 0 : 10) + (item.scope === 'user' ? 2 : 1) });
    standalone.set(namespace, group);
  };
  const settingsPaths = [
    { path: join(context.claudeHome, 'settings.json'), source: 'user/settings.json' },
    ...(context.project ? [
      { path: join(context.project.path, '.claude', 'settings.json'), source: 'project/settings.json' },
      { path: join(context.project.path, '.claude', 'settings.local.json'), source: 'project/settings.local.json' },
    ] : []),
  ];
  for (const entry of settingsPaths) {
    const data = await json(context, entry.path, entry.source, result.warnings);
    const enabled = object(data?.enabledPlugins);
    for (const [id, value] of Object.entries(enabled ?? {})) {
      if (typeof value === 'boolean') settings.set(id, { value, source: entry.source });
    }
    for (const [name, value] of Object.entries(object(data?.skillOverrides) ?? {})) {
      if (typeof value === 'string' && ['on', 'name-only', 'user-invocable-only', 'off'].includes(value)) {
        overrides.set(name, { value, source: entry.source });
      }
    }
  }

  const roots: Array<{ path: string; scope: Scope }> = [
    { path: join(context.claudeHome, 'skills'), scope: 'user' },
  ];
  if (context.project) {
    roots.push({ path: join(context.project.path, '.claude', 'skills'), scope: 'project' });
  }
  for (const root of roots) {
    result.roots.push({
      agent: 'claude', ...root, exists: await context.io.exists(root.path),
      description: 'Claude Code 스킬 디렉터리',
    });
    const promoted: string[] = [];
    for (const directory of await context.io.directories(root.path)) {
      if (root.scope === 'user' && basename(directory) === 'synced') continue;
      if (!await context.io.exists(join(directory, '.claude-plugin', 'plugin.json'))) continue;
      promoted.push(directory);
      sources.set(resolve(directory), {
        root: resolve(directory), name: basename(directory), id: '', marketplace: '',
        scope: root.scope, installed: false, rank: 0, origin: 'skills',
      });
    }
    for (const path of await context.io.skills(root.path)) {
      if (promoted.some(directory => within(directory, path))) continue;
      const item = await skill(context, path, root.scope);
      if (!item) continue;
      const syncedRoot = join(context.claudeHome, 'skills', 'synced');
      if (root.scope === 'user' && within(syncedRoot, path)) {
        const bucket = relative(syncedRoot, path).split(sep)[0];
        if (item.name.includes(bucket)) item.name = '동기화 스킬';
        item.status = 'cached';
        item.statusReason = '계정별 동기화 캐시입니다. 현재 계정과 세션의 활성 상태는 알 수 없습니다.';
        item.evidence.push({ source: 'skills/synced', detail: '동기화된 파일만 확인했으며 계정 정보는 조회하지 않았습니다.' });
      } else {
        const qualified = relative(root.path, dirname(path)).split(sep).join(':');
        const override = overrides.get(qualified) ?? overrides.get(item.name);
        if (override) {
          if (override.value === 'off') item.status = 'disabled';
          item.statusReason = 'skillOverrides 설정을 확인했습니다. 실제 호출 여부는 확인하지 않습니다.';
          item.evidence.push({ source: override.source, detail: `skillOverrides = ${override.value}` });
        }
        const prefix = dirname(relative(root.path, dirname(path)));
        rememberStandalone(item, prefix === '.' ? item.name : `${prefix.split(sep).join(':')}:${item.name}`, false);
      }
      candidates.set(item.key, item);
    }
    const commandRoot = join(dirname(root.path), 'commands');
    result.roots.push({
      agent: 'claude', path: commandRoot, scope: root.scope, exists: await context.io.exists(commandRoot),
      description: 'Claude Code 레거시 명령 디렉터리',
    });
    for (const path of await context.io.markdown(commandRoot)) {
      const item = await skill(context, path, root.scope, true);
      if (!item) continue;
      const override = overrides.get(item.name);
      if (override) {
        if (override.value === 'off') item.status = 'disabled';
        item.statusReason = 'skillOverrides 설정을 확인했습니다. 실제 호출 여부는 확인하지 않습니다.';
        item.evidence.push({ source: override.source, detail: `skillOverrides = ${override.value}` });
      }
      const prefix = relative(commandRoot, dirname(path));
      rememberStandalone(item, prefix ? `${prefix.split(sep).join(':')}:${item.name}` : item.name, true);
      candidates.set(item.key, item);
    }
  }

  const pluginRoot = join(context.claudeHome, 'plugins');
  const cacheRoot = join(pluginRoot, 'cache');
  result.roots.push({
    agent: 'claude', path: cacheRoot, scope: 'user', exists: await context.io.exists(cacheRoot),
    description: 'Claude Code 플러그인 설치 캐시',
  });
  const installed = await json(context, join(pluginRoot, 'installed_plugins.json'), '설치 레지스트리', result.warnings);
  if (installed) {
    const plugins = object(installed.plugins);
    if (installed.version !== 2 || !plugins) {
      result.warnings.push('지원하지 않는 설치 레지스트리 형식입니다. 캐시의 활성 상태를 추정하지 않습니다.');
    } else {
      for (const [id, records] of Object.entries(plugins)) {
        const identity = /^([a-z0-9][a-z0-9._-]*)@([a-z0-9][a-z0-9._-]*)$/i.exec(id);
        if (!identity || !Array.isArray(records)) {
          result.warnings.push('설치 레지스트리의 플러그인 항목 형식이 올바르지 않아 제외했습니다.');
          continue;
        }
        for (const value of records) {
          const record = object(value);
          if (!record || typeof record.installPath !== 'string' || !isAbsolute(record.installPath)
            || !within(cacheRoot, record.installPath) || resolve(record.installPath) === resolve(cacheRoot)) {
            result.warnings.push('설치 레지스트리의 경로를 허용된 Claude 캐시 범위와 연결할 수 없습니다.');
            continue;
          }
          let scope: Scope = 'user';
          let rank = 1;
          if (record.scope === 'project' || record.scope === 'local') {
            if (!context.project || typeof record.projectPath !== 'string'
              || !isAbsolute(record.projectPath) || resolve(record.projectPath) !== resolve(context.project.path)) continue;
            scope = 'project';
            rank = record.scope === 'local' ? 3 : 2;
          } else if (record.scope === 'managed') {
            scope = 'system';
            rank = 4;
          } else if (record.scope !== 'user') {
            result.warnings.push('설치 항목의 관리 정책 또는 세션 범위를 확인할 수 없습니다.');
            continue;
          }
          const root = resolve(record.installPath);
          if ((sources.get(root)?.rank ?? -1) >= rank) continue;
          sources.set(root, {
            root, name: identity[1], marketplace: identity[2], id, scope, rank,
            installed: true, version: string(record.version), origin: 'registry',
          });
        }
      }
    }
  }
  for (const marketplace of await context.io.directories(cacheRoot)) {
    for (const plugin of await context.io.directories(marketplace)) {
      for (const version of await context.io.directories(plugin)) {
        const root = resolve(version);
        if (sources.has(root)) continue;
        sources.set(root, {
          root, name: basename(plugin), marketplace: basename(marketplace),
          id: `${basename(plugin)}@${basename(marketplace)}`,
          scope: 'user', installed: false, rank: 0, origin: 'cache',
        });
      }
    }
  }

  const syncedRoot = join(pluginRoot, 'synced');
  result.roots.push({
    agent: 'claude', path: syncedRoot, scope: 'user', exists: await context.io.exists(syncedRoot),
    description: '계정별 플러그인 동기화 캐시 (활성 계정 미확인)',
  });
  for (const bucket of await context.io.directories(syncedRoot)) {
    if (basename(bucket).startsWith('.')) continue;
    for (const directory of await context.io.directories(bucket)) {
      if (basename(directory).startsWith('.')) continue;
      sources.set(resolve(directory), {
        root: resolve(directory), name: basename(directory), id: '', marketplace: '', scope: 'user',
        installed: false, rank: 0, origin: 'synced', bucket: basename(bucket),
      });
    }
  }
  const installedIds = new Set([...sources.values()].filter(source => source.installed).map(source => source.id));
  if ([...settings].some(([id, setting]) => setting.value && !installedIds.has(id))) {
    result.warnings.push('활성 설정이 있지만 현재 범위의 설치 레코드와 연결되지 않은 플러그인이 있습니다.');
  }

  const preferred = new Map<string, { rank: number; roots: string[] }>();
  for (const source of sources.values()) {
    if (!source.installed) continue;
    const current = preferred.get(source.id);
    if (!current || current.rank < source.rank) {
      preferred.set(source.id, { rank: source.rank, roots: [source.root] });
    } else if (current.rank === source.rank) {
      current.roots.push(source.root);
    }
  }
  const catalogs = new Map<string, Record<string, unknown> | null>();
  for (const source of sources.values()) {
    const warnings: string[] = [];
    const path = join(source.root, '.claude-plugin', 'plugin.json');
    const manifest = await context.io.exists(path) && await ownedPluginPath(context, source.root, path, warnings)
      ? await json(context, path, '플러그인 매니페스트', warnings, source.root) : null;
    if (source.marketplace && !catalogs.has(source.marketplace)) {
      const catalog = await json(context,
        join(pluginRoot, 'marketplaces', source.marketplace, '.claude-plugin', 'marketplace.json'),
        '마켓플레이스', result.warnings);
      catalogs.set(source.marketplace, catalog);
    }
    const catalogPlugins = catalogs.get(source.marketplace)?.plugins;
    const catalogEntry = Array.isArray(catalogPlugins)
      ? object(catalogPlugins.find(entry => object(entry)?.name === source.name)) : null;
    const setting = settings.get(source.id);
    const present = await context.io.exists(source.root);
    const priority = preferred.get(source.id);
    const unresolvedVersion = source.installed && !!priority && (source.rank < priority.rank || priority.roots.length > 1);
    const status: Status = !present || source.scope === 'system' || source.origin === 'skills' || unresolvedVersion ? 'unknown' : !source.installed ? 'cached'
      : setting ? setting.value ? 'enabled' : 'disabled' : 'unknown';
    if (!present) warnings.push('설치 레지스트리에 기록된 플러그인 디렉터리를 찾을 수 없습니다.');
    if (unresolvedVersion) {
      warnings.push('우선하는 다른 설치 범위가 있거나 동일 우선순위의 설치 경로가 여러 개여서 이 버전의 활성 상태를 확정할 수 없습니다.');
    }
    const parent: ExtensionCandidate = {
      key: key('plugin', path), agent: 'claude', kind: 'plugin',
      name: string(manifest?.name) ?? string(source.name) ?? '플러그인',
      description: string(manifest?.description) ?? string(catalogEntry?.description),
      version: string(manifest?.version) ?? source.version,
      scope: source.scope, path, rootPath: source.root, status, statusReason: statusReason(status),
      evidence: [{
        source: source.installed ? 'installed_plugins.json' : source.origin === 'synced' ? 'plugins/synced'
          : source.origin === 'skills' ? 'skills/.claude-plugin/plugin.json' : 'plugins/cache',
        detail: source.installed ? '설치 레지스트리 v2에서 현재 범위의 설치 항목을 확인했습니다.'
          : source.origin === 'skills' ? '스킬 디렉터리의 플러그인 매니페스트입니다. 설치 레지스트리 항목은 아닙니다.'
            : '캐시 디렉터리만 확인했습니다.',
      }],
      warnings,
    };
    if (source.bucket && parent.name.includes(source.bucket)) parent.name = '동기화 플러그인';
    if (source.origin === 'synced') {
      parent.statusReason = '계정별 동기화 캐시입니다. 현재 계정과 조직 정책의 활성 상태는 알 수 없습니다.';
    } else if (source.scope === 'system') {
      parent.statusReason = '관리 범위의 설치 기록입니다. 적용 중인 관리 정책과 세션 상태는 알 수 없습니다.';
    } else if (source.origin === 'skills') {
      parent.statusReason = '스킬 디렉터리에서 플러그인을 발견했습니다. 세션의 로드 여부는 알 수 없습니다.';
    } else if (unresolvedVersion) {
      parent.statusReason = '설치 범위와 버전의 우선순위를 확인했습니다. 이 경로의 활성 상태는 알 수 없습니다.';
    }
    if (manifest) parent.evidence.push({ source: 'plugin.json', detail: '설치 경로의 플러그인 매니페스트를 읽었습니다.' });
    if (catalogEntry) parent.evidence.push({
      source: 'marketplace.json', detail: '현재 마켓플레이스 메타데이터입니다. 설치 시점의 내용과 다를 수 있습니다.',
    });
    if (setting) parent.evidence.push({ source: setting.source, detail: `enabledPlugins[${string(source.id)}] = ${setting.value}` });
    candidates.set(parent.key, parent);

    const declaredSkills = manifest && Object.hasOwn(manifest, 'skills') ? manifest.skills : catalogEntry?.skills;
    const defaultSkills = join(source.root, 'skills');
    const defaultSkillsExist = await context.io.exists(defaultSkills);
    const skillPaths = new Set<string>();
    if (defaultSkillsExist && await ownedPluginPath(context, source.root, defaultSkills, warnings)) {
      for (const entry of await context.io.skills(defaultSkills, source.root)) skillPaths.add(entry);
    }
    const rootSkill = join(source.root, 'SKILL.md');
    if (declaredSkills === undefined && !defaultSkillsExist && await context.io.exists(rootSkill)
      && await ownedPluginPath(context, source.root, rootSkill, warnings)) {
      skillPaths.add(rootSkill);
    }
    for (const root of componentPaths(source.root, declaredSkills, warnings)) {
      if (!await context.io.exists(root)) {
        warnings.push('선언된 스킬 경로가 없거나 안전하게 접근할 수 없습니다.');
        continue;
      }
      if (!await ownedPluginPath(context, source.root, root, warnings)) continue;
      for (const entry of await context.io.skills(root, source.root)) skillPaths.add(entry);
    }
    const declaredCommands = manifest && Object.hasOwn(manifest, 'commands') ? manifest.commands : catalogEntry?.commands;
    const commandRoots = declaredCommands === undefined ? [join(source.root, 'commands')]
      : componentPaths(source.root, declaredCommands, warnings);
    const commandPaths = new Set<string>();
    for (const root of commandRoots) {
      if (!await context.io.exists(root)) {
        if (declaredCommands !== undefined) warnings.push('선언된 명령 경로가 없거나 안전하게 접근할 수 없습니다.');
        continue;
      }
      if (!await ownedPluginPath(context, source.root, root, warnings)) continue;
      if (root.endsWith('.md')) {
        commandPaths.add(root);
      } else {
        for (const entry of await context.io.markdown(root, source.root)) commandPaths.add(entry);
      }
    }
    for (const entry of new Set([...skillPaths, ...commandPaths])) {
      if (!await ownedPluginPath(context, source.root, entry, warnings)) continue;
      const child = await skill(context, entry, source.scope, !skillPaths.has(entry), source.root);
      if (!child) continue;
      child.pluginKey = parent.key;
      child.pluginName = parent.name;
      if (source.bucket && child.name.includes(source.bucket)) child.name = '동기화 스킬';
      if (status !== 'unknown' || source.scope === 'system' || unresolvedVersion) {
        child.status = status;
        child.statusReason = parent.statusReason;
      }
      child.evidence.push({ source: 'plugin.json', detail: '부모 플러그인의 구성요소입니다. 실제 호출 여부는 확인하지 않습니다.' });
      candidates.set(child.key, child);
    }
  }
  for (const group of standalone.values()) {
    const highest = Math.max(...group.map(entry => entry.rank));
    for (const entry of group) {
      if (entry.rank < highest) entry.item.warnings?.push('같은 이름의 스킬이 더 높은 우선순위에 있습니다. 이 파일도 목록에 보존하지만 호출 대상으로 선택되었다는 의미는 아닙니다.');
    }
  }
  result.candidates = [...candidates.values()].sort((a, b) => a.path.localeCompare(b.path));
  return result;
}
