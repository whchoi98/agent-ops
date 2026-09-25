import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { minimatch } from 'minimatch';
import type { ExtensionScope } from '../../shared/extensions.js';
import { parseSkillDocument } from './analysis.js';
import type { DiscoveryContext, DiscoveryResult, ExtensionCandidate } from './types.js';

const MAX_ENTRIES = 256;
const MAX_CANDIDATES = 512;
const MAX_RESOURCE_CHECKS = 2_048;
const MAX_DEPTH = 6;
const MAX_RESOURCE_LENGTH = 2_048;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function string(value: unknown, limit = 1_024): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined;
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function sensitive(path: string): boolean {
  return path.split(/[\\/]/).some(part =>
    /^(?:\.env|\.ssh|\.aws|auth(?:entication)?|oauth|credentials?|tokens?|secrets?|(?:api[-_])?keys?|private[-_]key|id_(?:rsa|dsa|ecdsa|ed25519))(?:[._-]|$)/i.test(part)
    || /\.(?:pem|key|p12|pfx)$/i.test(part));
}

function frontmatter(content: string | null): Record<string, unknown> | null {
  if (content === null) return null;
  const parsed = parseSkillDocument(content);
  return parsed.warnings.length || !Object.keys(parsed.metadata).length ? null : parsed.metadata;
}

/**
 * Kiro resources are configuration evidence, not invocation evidence.
 * See https://kiro.dev/docs/skills/ and https://kiro.dev/docs/powers/installation/.
 * The shared IO owns physical-path, symlink, size and redaction enforcement.
 */
export async function discoverKiro(context: DiscoveryContext): Promise<DiscoveryResult> {
  const { io } = context;
  const result: DiscoveryResult = { candidates: [], roots: [], warnings: [] };
  const warnings = new Set<string>();
  const candidates = new Map<string, ExtensionCandidate>();
  const skillRoots: string[] = [];
  const agents = new Map<string, { path: string; name: string; resources: unknown[] }>();
  const home = resolve(context.homeDir);
  const project = context.project ? resolve(context.project.path) : null;

  async function read<T>(source: string, fallback: T, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      warnings.add(`Kiro 메타데이터를 읽지 못했습니다: ${source}`);
      return fallback;
    }
  }

  async function root(path: string, scope: ExtensionScope, description: string) {
    const exists = await read(path, false, () => io.exists(path));
    result.roots.push({ agent: 'kiro', path, scope, exists, description });
    return exists;
  }

  function paths(values: string[], parent: string, accept: (path: string) => boolean): string[] {
    const eligible = values.filter(path =>
      isAbsolute(path) && resolve(path) !== parent && inside(parent, path)
      && !path.split(/[\\/]/).includes('..') && !sensitive(relative(parent, path)) && accept(resolve(path)));
    if (eligible.length !== values.length) {
      warnings.add(`Kiro 검색 범위 밖이거나 지원하지 않는 항목을 제외했습니다: ${parent}`);
    }
    if (eligible.length > MAX_ENTRIES) {
      warnings.add(`Kiro 항목 수 제한으로 일부 메타데이터를 생략했습니다: ${parent}`);
    }
    return [...new Set(eligible.map(path => resolve(path)))].sort().slice(0, MAX_ENTRIES);
  }

  function candidate(
    path: string,
    kind: 'skill' | 'power',
    scope: ExtensionScope,
    metadata: Record<string, unknown> | null,
  ): ExtensionCandidate {
    const itemWarnings: string[] = [];
    const folder = basename(dirname(path));
    const declaredName = string(metadata?.name, 256);
    const name = declaredName ?? string(metadata?.displayName, 256) ?? folder;
    const description = string(metadata?.description);
    if (!metadata) itemWarnings.push('메타데이터가 없거나 형식이 올바르지 않습니다.');
    if (kind === 'skill') {
      if (!declaredName || !description) itemWarnings.push('스킬의 name 또는 description이 없습니다.');
      if (declaredName && declaredName !== folder) itemWarnings.push('스킬 이름이 디렉터리 이름과 다릅니다.');
      if (declaredName && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(declaredName)) {
        itemWarnings.push('스킬 이름이 문서의 이름 형식과 다릅니다.');
      }
      if (typeof metadata?.description === 'string' && metadata.description.length > 1_024) {
        itemWarnings.push('스킬 설명이 1,024자를 초과합니다.');
      }
    }
    return {
      key: `kiro:${kind}:${path}`,
      agent: 'kiro', kind, name, description,
      version: string(metadata?.version, 100) ?? string(object(metadata?.metadata)?.version, 100),
      scope, path, rootPath: dirname(path),
      status: kind === 'skill' && declaredName && description ? 'available' : 'unknown',
      statusReason: kind === 'skill'
        ? '스킬 파일이 있습니다. 에이전트 선택과 실제 활성화·호출 여부는 알 수 없습니다.'
        : 'Kiro Powers 설치 경로에 패키지가 있습니다. IDE·CLI 활성화와 호출 여부는 알 수 없습니다.',
      evidence: [{ source: path, detail: `${basename(path)} 파일을 발견했습니다. 호출 증거가 아닙니다.` }],
      usedBy: [], warnings: itemWarnings,
    };
  }

  async function skills(path: string, scope: ExtensionScope, parent?: ExtensionCandidate) {
    if (parent) {
      if (!await read(path, false, () => io.exists(path))) return;
      if (!await read(path, false, () => io.contains(parent.rootPath, path))) {
        warnings.add(`Kiro Power 소유 경로 밖의 스킬 디렉터리를 제외했습니다: ${path}`);
        return;
      }
    }
    skillRoots.push(path);
    if (candidates.size >= MAX_CANDIDATES) {
      warnings.add(`Kiro 전체 항목 수 제한으로 일부 메타데이터를 생략했습니다: ${path}`);
      return;
    }
    const entries = paths(
      await read(path, [], () => parent ? io.skills(path, parent.rootPath) : io.skills(path)),
      path, entry => basename(entry) === 'SKILL.md',
    );
    const remaining = MAX_CANDIDATES - candidates.size;
    if (entries.length > remaining) warnings.add(`Kiro 전체 항목 수 제한으로 일부 메타데이터를 생략했습니다: ${path}`);
    for (const entry of entries.slice(0, remaining)) {
      if (parent && !await read(entry, false, () => io.contains(parent.rootPath, entry))) {
        warnings.add(`Kiro Power 소유 경로 밖의 스킬 파일을 제외했습니다: ${entry}`);
        continue;
      }
      const metadata = frontmatter(await read(
        entry, null, () => parent ? io.text(entry, parent.rootPath) : io.text(entry),
      ));
      const item = candidate(entry, 'skill', scope, metadata);
      if (parent) {
        item.pluginKey = parent.key;
        item.pluginName = parent.name;
        item.status = parent.status;
        item.statusReason = parent.statusReason;
        item.evidence.push({ source: parent.path, detail: '이 Power에 포함된 스킬입니다. 활성화·호출 증거가 아닙니다.' });
      }
      candidates.set(item.key, item);
    }
  }

  async function agentFiles(path: string): Promise<string[]> {
    const markdown = paths(
      await read(path, [], () => io.markdown(path)), path,
      entry => entry.endsWith('.md') && relative(path, entry).split(sep).length <= MAX_DEPTH + 1,
    );
    const entries = [...markdown];
    const queue = [{ path, depth: 0 }];
    for (let index = 0; index < queue.length && index < MAX_ENTRIES; index++) {
      const current = queue[index];
      const files = await read(current.path, [], () => io.files(current.path));
      entries.push(...paths(
        files.filter(entry => entry.endsWith('.json')), current.path,
        entry => dirname(entry) === current.path,
      ));
      const directories = paths(
        await read(current.path, [], () => io.directories(current.path)), current.path,
        entry => dirname(entry) === current.path,
      );
      if (current.depth === MAX_DEPTH) {
        if (directories.length) warnings.add(`Kiro 에이전트 검색 깊이 제한으로 일부 항목을 생략했습니다: ${path}`);
      } else {
        for (const directory of directories) queue.push({ path: directory, depth: current.depth + 1 });
      }
      if (entries.length >= MAX_ENTRIES) break;
    }
    if (queue.length > MAX_ENTRIES || entries.length > MAX_ENTRIES) {
      warnings.add(`Kiro 에이전트 수 제한으로 일부 항목을 생략했습니다: ${path}`);
    }
    return [...new Set(entries)].sort().slice(0, MAX_ENTRIES);
  }

  async function readAgents(path: string) {
    for (const entry of await agentFiles(path)) {
      const metadata = entry.endsWith('.json')
        ? await read(entry, null, () => io.json(entry))
        : frontmatter(await read(entry, null, () => io.text(entry)));
      if (!metadata) {
        warnings.add(`Kiro 에이전트 메타데이터 형식을 확인할 수 없습니다: ${entry}`);
        continue;
      }
      const name = string(metadata.name, 256) ?? relative(path, entry).replace(/\.(?:json|md)$/, '').split(sep).join('/');
      if (metadata.resources !== undefined && !Array.isArray(metadata.resources)) {
        warnings.add(`Kiro 에이전트 resources가 배열이 아닙니다: ${entry}`);
      }
      agents.set(name, { path: entry, name, resources: Array.isArray(metadata.resources) ? metadata.resources : [] });
    }
  }

  for (const location of [{ path: home, scope: 'user' as const }, ...(project ? [{ path: project, scope: 'project' as const }] : [])]) {
    const skillRoot = join(location.path, '.kiro', 'skills');
    if (await root(skillRoot, location.scope, 'Kiro 스킬 메타데이터')) await skills(skillRoot, location.scope);
    const agentRoot = join(location.path, '.kiro', 'agents');
    if (await root(agentRoot, location.scope, 'Kiro CLI 사용자 에이전트의 skill:// 리소스 선언')) await readAgents(agentRoot);
  }

  const powerRoot = join(home, '.kiro', 'powers');
  if (await root(powerRoot, 'user', 'Kiro Powers 등록 메타데이터 및 IDE 설치 패키지')) {
    const registryPath = join(powerRoot, 'registry.json');
    let registry: Record<string, unknown> | null = null;
    if (await read(registryPath, false, () => io.exists(registryPath))) {
      const document = await read(registryPath, null, () => io.json(registryPath));
      registry = object(document?.powers);
      if (!registry) warnings.add(`Kiro Powers 등록 메타데이터 형식을 확인할 수 없습니다: ${registryPath}`);
    }
    const installedRoot = join(powerRoot, 'installed');
    const directories = paths(
      await read(installedRoot, [], () => io.directories(installedRoot)), installedRoot,
      entry => dirname(entry) === installedRoot,
    );
    for (const directory of directories) {
      if (candidates.size >= MAX_CANDIDATES) {
        warnings.add(`Kiro 전체 항목 수 제한으로 일부 Power를 생략했습니다: ${installedRoot}`);
        break;
      }
      const manifest = join(directory, 'plugin.json');
      const legacy = join(directory, 'POWER.md');
      let entry: string;
      let metadata: Record<string, unknown> | null;
      if (await read(manifest, false, () => io.exists(manifest))) {
        if (!await io.contains(directory, manifest)) {
          warnings.add('소속 Power 범위 밖의 매니페스트 링크를 제외했습니다.');
          continue;
        }
        entry = manifest;
        metadata = await read(manifest, null, () => io.json(manifest, directory));
      } else if (await read(legacy, false, () => io.exists(legacy))) {
        if (!await io.contains(directory, legacy)) {
          warnings.add('소속 Power 범위 밖의 POWER.md 링크를 제외했습니다.');
          continue;
        }
        entry = legacy;
        metadata = frontmatter(await read(legacy, null, () => io.text(legacy, directory)));
      } else {
        warnings.add(`Kiro Power 설치 디렉터리에 지원하는 매니페스트가 없습니다: ${directory}`);
        continue;
      }
      const item = candidate(entry, 'power', 'user', metadata);
      const registration = registry
        ? object(Object.hasOwn(registry, basename(directory)) ? registry[basename(directory)]
          : Object.hasOwn(registry, item.name) ? registry[item.name] : null)
        : null;
      if (typeof registration?.installed === 'boolean') {
        item.evidence.push({
          source: registryPath,
          detail: `Power 등록 정보의 installed=${registration.installed}입니다. IDE·CLI 활성화 설정이 아닙니다.`,
        });
        if (!registration.installed) {
          item.status = 'cached';
          item.statusReason = '등록 정보가 installed=false인 패키지 파일입니다. 설치 또는 활성화 상태로 간주하지 않습니다.';
        }
      }
      candidates.set(item.key, item);
      await skills(join(directory, 'skills'), 'user', item);
    }
  }

  let resourceChecks = 0;
  resourceAgents: for (const agent of agents.values()) {
    for (const resource of agent.resources.slice(0, MAX_ENTRIES)) {
      if (typeof resource !== 'string' || !resource.startsWith('skill://')) continue;
      if (++resourceChecks > MAX_RESOURCE_CHECKS) {
        warnings.add('Kiro 전체 리소스 확인 수 제한으로 일부 에이전트 연결을 생략했습니다.');
        break resourceAgents;
      }
      const value = resource.slice('skill://'.length);
      if (!value || value.length > MAX_RESOURCE_LENGTH
        || value.split(/[\\/]/).includes('..') || /%2[ef]|%5c|[\r\n\0]/i.test(value)) {
        warnings.add(`Kiro 에이전트의 지원하지 않는 skill:// 리소스를 제외했습니다: ${agent.path}`);
        continue;
      }
      if (value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
        const named = [...candidates.values()].filter(item =>
          item.kind === 'skill' && !item.pluginKey && item.name === value);
        if (!named.length) warnings.add(`Kiro 에이전트가 참조한 스킬을 검색 범위에서 찾지 못했습니다: ${agent.path}`);
        const scope = named.some(item => item.scope === 'project') ? 'project' : 'user';
        for (const item of named.filter(item => item.scope === scope)) {
          if (!item.usedBy!.includes(agent.name)) item.usedBy!.push(agent.name);
          if (!item.evidence.some(evidence => evidence.source === agent.path && evidence.detail === `resources: ${resource}`)) {
            item.evidence.push({ source: agent.path, detail: `resources: ${resource}` });
          }
        }
        continue;
      }
      let pattern: string;
      if (value.startsWith('~/')) pattern = resolve(home, value.slice(2));
      else if (isAbsolute(value)) pattern = resolve(value);
      else if (project) pattern = resolve(project, value);
      else {
        warnings.add(`프로젝트 경로 없이 상대 skill:// 리소스를 해석하지 않았습니다: ${agent.path}`);
        continue;
      }
      if (!skillRoots.some(path => inside(path, pattern))) {
        warnings.add(`고정된 Kiro 검색 경로 밖의 skill:// 리소스를 제외했습니다: ${agent.path}`);
        continue;
      }
      let matched = false;
      for (const item of candidates.values()) {
        if (item.kind !== 'skill' || !minimatch(item.path.split(sep).join('/'), pattern.split(sep).join('/'), {
          dot: true, nobrace: true, noext: true, nonegate: true, nocomment: true,
        })) continue;
        matched = true;
        if (!item.usedBy!.includes(agent.name)) item.usedBy!.push(agent.name);
        if (!item.evidence.some(evidence => evidence.source === agent.path && evidence.detail === `resources: skill://${pattern}`)) {
          item.evidence.push({ source: agent.path, detail: `resources: skill://${pattern}` });
        }
      }
      if (!matched) warnings.add(`Kiro 에이전트가 참조한 스킬을 검색 범위에서 찾지 못했습니다: ${agent.path}`);
    }
    if (agent.resources.length > MAX_ENTRIES) warnings.add(`Kiro 에이전트의 리소스 수 제한으로 일부 선언을 생략했습니다: ${agent.path}`);
  }

  result.candidates = [...candidates.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  for (const item of result.candidates) item.usedBy?.sort();
  result.warnings = [...warnings].sort();
  return result;
}
