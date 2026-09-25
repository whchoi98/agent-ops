import { basename, dirname, join, resolve } from 'node:path';
import type { ExtensionScope, ExtensionStatus } from '../../shared/extensions.js';
import { within } from './io.js';
import type { DiscoveryContext, DiscoveryResult, ExtensionCandidate } from './types.js';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const paths = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const keyFor = (kind: string, path: string) => `codex:${kind}:${path}`;
type Override = { enabled: boolean | undefined; source: string };

export async function discoverCodex(context: DiscoveryContext): Promise<DiscoveryResult> {
  const { io, codexHome, homeDir, project } = context;
  const result: DiscoveryResult = { candidates: [], roots: [], warnings: [] };
  const layers: Array<{ source: string; value: Record<string, unknown> }> = [];
  const systemConfig = '/etc/codex/config.toml';
  const userConfig = join(codexHome, 'config.toml');
  const system = context.platform === 'win32' ? null : await io.toml(systemConfig);
  if (system) layers.push({ source: systemConfig, value: system });
  const user = await io.toml(userConfig) ?? {};
  layers.push({ source: userConfig, value: user });
  if (project) {
    const source = join(project.path, '.codex/config.toml');
    const local = await io.toml(source);
    if (local) {
      const trust = Object.entries(record(user.projects))
        .filter(([path]) => within(resolve(path), resolve(project.path)))
        .sort(([a], [b]) => b.length - a.length)[0]?.[1];
      if (record(trust).trust_level === 'trusted') layers.push({ source, value: local });
      else result.warnings.push(`Codex 프로젝트 신뢰가 확인되지 않아 프로젝트 설정을 적용하지 않았습니다: ${source}`);
    }
  }
  const plugins = new Map<string, Override>();
  const skillOverrides: Array<{ path: string; enabled: boolean; source: string }> = [];
  for (const layer of layers) {
    for (const [id, value] of Object.entries(record(layer.value.plugins))) {
      const enabled = record(value).enabled;
      plugins.set(id, { enabled: typeof enabled === 'boolean' ? enabled : undefined, source: layer.source });
      if (enabled !== undefined && typeof enabled !== 'boolean') result.warnings.push(`Codex 플러그인 활성화 설정 형식을 확인해 주세요: ${id}`);
    }
    const overrides = record(layer.value.skills).config;
    if (Array.isArray(overrides)) for (const raw of overrides) {
      const item = record(raw);
      if (typeof item.path !== 'string' || typeof item.enabled !== 'boolean') continue;
      const expanded = item.path.startsWith('~/') ? join(homeDir, item.path.slice(2)) : resolve(dirname(layer.source), item.path);
      skillOverrides.push({ path: expanded, enabled: item.enabled, source: layer.source });
    }
  }
  async function addSkills(root: string, scope: ExtensionScope, parent?: ExtensionCandidate) {
    if (parent && await io.exists(root) && !await io.contains(parent.rootPath, root)) {
      result.warnings.push('소속 플러그인 범위 밖의 skills 링크를 제외했습니다.');
      return;
    }
    const entries = basename(root) === 'SKILL.md'
      ? await io.exists(root) ? [root] : []
      : await io.skills(root, parent?.rootPath);
    for (const entry of entries) {
      if (parent && !await io.contains(parent.rootPath, entry)) {
        result.warnings.push('소속 플러그인 범위 밖의 스킬 파일을 제외했습니다.');
        continue;
      }
      const localName = basename(dirname(entry));
      const candidate: ExtensionCandidate = {
        key: keyFor('skill', entry), agent: 'codex', kind: 'skill',
        name: parent ? `${parent.name}:${localName}` : localName,
        scope: !parent && within(join(codexHome, 'skills/.system'), entry) ? 'system' : scope,
        path: entry, rootPath: dirname(entry),
        status: parent?.status ?? 'available',
        statusReason: parent ? `소속 플러그인의 상태를 따릅니다: ${parent.statusReason}` : 'Codex 스킬 경로에서 발견한 정의입니다.',
        evidence: [{ source: entry, detail: 'SKILL.md 발견' }, ...(parent?.evidence ?? [])],
        ...(parent ? { pluginKey: parent.key, pluginName: parent.name } : {}),
      };
      if (!parent || parent.status !== 'disabled') for (const rule of skillOverrides) {
        if (rule.path === entry || rule.path === dirname(entry)) {
          candidate.status = rule.enabled ? parent?.status ?? 'available' : 'disabled';
          candidate.statusReason = `skills.config에서 enabled = ${rule.enabled}로 설정했습니다.`;
          candidate.evidence.push({ source: rule.source, detail: `skills.config: ${rule.enabled}` });
        }
      }
      result.candidates.push(candidate);
    }
  }
  const skillRoots: Array<{ path: string; scope: ExtensionScope; description: string }> = [
    { path: join(homeDir, '.agents/skills'), scope: 'user', description: '개인 공용 스킬' },
    { path: join(codexHome, 'skills'), scope: 'user', description: 'Codex 개인·기본 제공 스킬' },
    ...(context.platform === 'win32' ? [] : [{ path: '/etc/codex/skills', scope: 'system' as const, description: '관리자 스킬' }]),
    ...(project ? [
      { path: join(project.path, '.agents/skills'), scope: 'project' as const, description: '선택한 프로젝트의 공용 스킬' },
      { path: join(project.path, '.codex/skills'), scope: 'project' as const, description: '프로젝트 Codex 스킬 경로' },
    ] : []),
  ];
  for (const root of skillRoots) {
    const exists = await io.exists(root.path);
    result.roots.push({ agent: 'codex', ...root, exists });
    if (exists) await addSkills(root.path, root.scope);
  }

  const cache = join(codexHome, 'plugins/cache');
  result.roots.push({ agent: 'codex', path: cache, scope: 'user', exists: await io.exists(cache), description: 'Codex 플러그인 캐시 및 활성화 설정' });
  const found = new Set<string>();
  for (const market of await io.directories(cache)) for (const pluginDir of await io.directories(market)) {
    const id = `${basename(pluginDir)}@${basename(market)}`;
    const versions: Array<{ root: string; path: string; manifest: Record<string, unknown> }> = [];
    for (const root of await io.directories(pluginDir)) {
      const path = join(root, '.codex-plugin/plugin.json');
      if (await io.exists(path) && !await io.contains(root, path)) {
        result.warnings.push('소속 플러그인 범위 밖의 매니페스트 링크를 제외했습니다.');
        continue;
      }
      const manifest = await io.json(path, root);
      if (manifest) versions.push({ root, path, manifest });
    }
    for (const version of versions) {
      found.add(id);
      const override = plugins.get(id);
      let status: ExtensionStatus = override?.enabled === false ? 'disabled' : override?.enabled === true ? 'enabled' : override ? 'unknown' : 'cached';
      let reason = override?.enabled === false ? '로컬 플러그인 설정에서 비활성화했습니다.'
        : override?.enabled === true ? '로컬 플러그인 설정에서 활성화했고 캐시 버전이 하나입니다.'
          : override ? '플러그인의 명시적 enabled 값을 확인하지 못했습니다.'
            : '캐시에 존재하지만 활성화 설정은 확인되지 않았습니다.';
      if (override?.enabled === true && versions.length > 1) {
        status = 'unknown';
        reason = '여러 캐시 버전 중 현재 선택된 버전을 확인할 수 없습니다.';
      }
      const item: ExtensionCandidate = {
        key: keyFor('plugin', version.path), agent: 'codex', kind: 'plugin',
        name: typeof version.manifest.name === 'string' ? version.manifest.name : basename(pluginDir),
        description: typeof version.manifest.description === 'string' ? version.manifest.description : undefined,
        version: typeof version.manifest.version === 'string' ? version.manifest.version : basename(version.root),
        scope: 'user', path: version.path, rootPath: version.root, status, statusReason: reason,
        evidence: [
          { source: version.path, detail: `플러그인 매니페스트: ${id}` },
          ...(override ? [{ source: override.source, detail: `plugins.${id}.enabled = ${String(override.enabled ?? 'unknown')}` }] : []),
        ],
      };
      result.candidates.push(item);
      const components = paths(version.manifest.skills);
      const roots = components.length ? components : ['./skills'];
      const seenRoots = new Set<string>();
      for (const component of roots) {
        const root = resolve(version.root, component);
        if (!within(version.root, root)) {
          result.warnings.push(`소속 플러그인 범위 밖의 skills 경로를 제외했습니다: ${item.name}`);
          continue;
        }
        if (!seenRoots.has(root)) { seenRoots.add(root); await addSkills(root, item.scope, item); }
      }
    }
  }
  for (const [id, override] of plugins) {
    if (found.has(id)) continue;
    const path = join(cache, '_unresolved', encodeURIComponent(id), '.codex-plugin/plugin.json');
    result.candidates.push({
      key: keyFor('plugin', path), agent: 'codex', kind: 'plugin', name: id.split('@')[0],
      scope: 'user', path, rootPath: dirname(dirname(path)),
      status: override.enabled === false ? 'disabled' : 'unknown',
      statusReason: '설정에는 존재하지만 설치된 플러그인 매니페스트를 찾지 못했습니다.',
      evidence: [{ source: override.source, detail: `plugins.${id}.enabled = ${String(override.enabled ?? 'unknown')}` }],
      warnings: ['플러그인 파일을 확인하지 못해 내용을 분석할 수 없습니다.'],
    });
  }
  result.candidates = [...new Map(result.candidates.map(item => [item.key, item])).values()];
  return result;
}
