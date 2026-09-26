import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../shared/types.js';
import { HarnessPolicyStore } from '../server/harness/policy.js';
import { HarnessAuditReader } from '../server/harness/audit.js';
import { harnessPaths } from '../server/harness/types.js';

const temporary: string[] = [];
const policy = 'version: "1.0"\nmode: standard\nrisk: {classifier: rules}\nhooks: {profile: standard}\n';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function put(path: string, content: string | Buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
async function fixture(options: { maxPolicyBytes?: number } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'agent-ops-harness-policy-'));
  temporary.push(base);
  const homeDir = join(base, 'home');
  const dataDir = join(base, 'data');
  const project: Project = {
    id: 'fixture-project', name: 'Fixture', path: join(base, 'project'),
    color: '#123456', executionEnabled: false, createdAt: '2026-09-26T00:00:00.000Z',
  };
  await Promise.all([homeDir, dataDir, project.path].map(path => mkdir(path)));
  return { base, homeDir, dataDir, project, store: new HarnessPolicyStore({ dataDir, homeDir, ...options }) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('harness policy discovery and selection', () => {
  it('offers a usable standard policy without reading or creating native configuration', async () => {
    const { store, project, homeDir, dataDir } = await fixture();
    const snapshot = await store.list(project);
    expect(snapshot.policies).toHaveLength(1);
    const builtin = snapshot.policies[0];
    expect(builtin).toMatchObject({ scope: 'builtin', path: null, valid: true, mode: 'standard', editable: false });
    expect(builtin.ruleCount).toBeGreaterThan(0);
    expect(builtin.revision).toBe(hash(builtin.content));
    const resolved = await store.resolve(builtin.id, builtin.revision, project);
    expect(resolved.config).toMatchObject({
      mode: 'standard', risk: { classifier: 'rules', thresholds: { high: 'deny', critical: 'deny' } },
      hooks: { profile: 'standard' }, permissions: { defaults: { unknown_tool: 'ask', on_error: 'deny' } },
    });
    expect(await readdir(homeDir)).toEqual([]);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('presents individual sources in upstream precedence and does not merge their contents', async () => {
    const { store, project, homeDir, dataDir } = await fixture();
    await put(join(homeDir, '.autoharness/config.yaml'), 'mode: core\nidentity: {name: user-fixture}\n');
    await put(join(project.path, '.autoharness.yaml'), 'mode: standard\nidentity: {name: first-project}\n');
    await put(join(project.path, 'constitution.yaml'), 'identity: {name: ignored-second}\n');
    await put(join(project.path, '.autoharness/constitution.yaml'), 'identity: {name: ignored-third}\n');
    await put(join(project.path, 'autoharness.yaml'), 'identity: {name: ignored-fourth}\n');
    await put(join(project.path, '.autoharness.local.yaml'), 'identity: {name: local-fixture}\n');
    await put(harnessPaths(dataDir, project.id).policyPath, policy);
    const snapshot = await store.list(project);
    expect(snapshot.policies.map(item => item.scope)).toEqual(['builtin', 'user', 'project', 'local', 'managed']);
    expect(snapshot.policies.filter(item => item.editable).map(item => item.scope)).toEqual(['managed']);
    const selected = snapshot.policies.find(item => item.scope === 'project')!;
    expect(selected.path).toBe(join(project.path, '.autoharness.yaml'));
    expect(selected.content).not.toMatch(/user-fixture|local-fixture|ignored-/);
    expect((await store.resolve(selected.id, selected.revision, project)).config).toEqual({
      mode: 'standard', identity: { name: 'first-project' },
    });
    expect(snapshot.warnings.join(' ')).toMatch(/individual|separate|merge/i);
  });

  it('uses the first existing candidate even when its YAML is invalid', async () => {
    const { store, project } = await fixture();
    await put(join(project.path, '.autoharness.yaml'), 'mode: [broken\npassword: parser-secret');
    await put(join(project.path, 'constitution.yaml'), policy);
    const snapshot = await store.list(project);
    const selected = snapshot.policies.filter(item => item.scope === 'project');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ valid: false, path: join(project.path, '.autoharness.yaml') });
    expect(JSON.stringify(snapshot)).not.toContain('parser-secret');
    await expect(store.resolve(selected[0].id, selected[0].revision, project)).rejects.toMatchObject({ statusCode: 400 });
  });

  it.each(['constitution.yaml', '.autoharness/constitution.yaml', 'autoharness.yaml'])(
    'discovers %s when no earlier candidate exists', async candidate => {
      const { store, project } = await fixture();
      await put(join(project.path, candidate), policy);
      expect((await store.list(project)).policies.find(item => item.scope === 'project')?.path)
        .toBe(join(project.path, candidate));
    },
  );

  it('binds opaque IDs to the selected project and its current owner path', async () => {
    const { store, project, base } = await fixture();
    await put(join(project.path, '.autoharness.yaml'), policy);
    const selected = (await store.list(project)).policies.find(item => item.scope === 'project')!;
    expect(selected.id).not.toContain(project.path);
    expect(selected.id).not.toContain(project.id);
    await expect(store.detail(selected.id, null)).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.resolve(selected.id, selected.revision, { ...project, id: 'other' }))
      .rejects.toMatchObject({ statusCode: 409 });
    const otherPath = join(base, 'other');
    await put(join(otherPath, '.autoharness.yaml'), policy);
    await expect(store.resolve(selected.id, selected.revision, { ...project, path: otherPath }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('keeps policy and audit source IDs stable across store restarts for persisted bindings', async () => {
    const { store, project, homeDir, dataDir } = await fixture();
    await put(join(project.path, '.autoharness.yaml'), policy);
    const managed = await store.save(project, policy, null);
    const before = await store.list(project);
    const restarted = new HarnessPolicyStore({ dataDir, homeDir });
    const after = await restarted.list(project);
    expect(after.policies.map(item => [item.scope, item.id])).toEqual(before.policies.map(item => [item.scope, item.id]));
    expect(after.auditSources.map(item => item.id)).toEqual(before.auditSources.map(item => item.id));
    expect((await restarted.resolve(managed.id, managed.revision, project)).content).toBe(policy);
  });

  it('re-reads selected bytes and rejects changed revisions, disappearance and changed precedence', async () => {
    const { store, project } = await fixture();
    const path = join(project.path, 'constitution.yaml');
    await put(path, policy);
    const selected = (await store.list(project)).policies.find(item => item.scope === 'project')!;
    await writeFile(path, `${policy}# revision two\n`);
    await expect(store.resolve(selected.id, selected.revision, project)).rejects.toMatchObject({ statusCode: 409 });
    const current = await store.detail(selected.id, project);
    expect(current.revision).toBe(hash(`${policy}# revision two\n`));
    await put(join(project.path, '.autoharness.yaml'), policy);
    await expect(store.resolve(selected.id, current.revision, project)).rejects.toMatchObject({ statusCode: 409 });
    await rm(join(project.path, '.autoharness.yaml'));
    await rm(path);
    await expect(store.resolve(selected.id, current.revision, project)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('hashes original BOM, UTF-8 and CRLF bytes without normalizing the revision', async () => {
    const { store, project } = await fixture();
    const bytes = Buffer.from('\ufeffmode: standard\r\nidentity: {name: "한글"}\r\n');
    await put(join(project.path, '.autoharness.yaml'), bytes);
    const selected = (await store.list(project)).policies.find(item => item.scope === 'project')!;
    expect(selected.bytes).toBe(bytes.length);
    expect(selected.revision).toBe(hash(bytes));
    expect((await store.resolve(selected.id, selected.revision, project)).content).toBe(bytes.toString('utf8'));
  });

  it('provides confined configured, default and app-owned audit paths without touching them', async () => {
    const { store, project, dataDir, homeDir } = await fixture();
    await put(join(project.path, '.autoharness.yaml'), `${policy}audit: {output: logs/decisions.jsonl}\n`);
    await put(join(project.path, '.autoharness.local.yaml'), `${policy}audit: {output: ../outside.jsonl}\n`);
    const snapshot = await store.list(project);
    expect(snapshot.auditSources.map(item => item.path)).toEqual(expect.arrayContaining([
      join(project.path, '.autoharness/audit.jsonl'),
      join(project.path, 'logs/decisions.jsonl'),
      harnessPaths(dataDir, project.id).auditPath,
    ]));
    expect(snapshot.auditSources.some(item => item.path.endsWith('/outside.jsonl'))).toBe(false);
    expect(snapshot.auditSources.every(item => typeof item.root === 'string')).toBe(true);
    expect(snapshot.warnings.join(' ')).toMatch(/audit/i);
    const global = await store.list(null);
    expect(global.auditSources.map(item => item.path)).toEqual(expect.arrayContaining([
      join(homeDir, '.autoharness/audit.jsonl'), harnessPaths(dataDir, null).auditPath,
    ]));
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('discovers only the runtime’s two fixed managed archives, with the same owner checks', async () => {
    const { store, project, dataDir, base } = await fixture();
    const paths = harnessPaths(dataDir, project.id);
    const archive = join(dirname(paths.auditPath), 'events.1.jsonl');
    await put(archive, '{"fixture":true}\n');
    await put(join(dirname(paths.auditPath), 'events.2.jsonl'), '{"fixture":true}\n');
    await put(join(dirname(paths.auditPath), 'events.3.jsonl'), '{"fixture":true}\n');
    await put(join(project.path, '.autoharness/audit.1.jsonl'), '{"fixture":true}\n');
    const snapshot = await store.list(project);
    expect(snapshot.auditSources.filter(item => item.managed).map(item => item.path)).toEqual([
      paths.auditPath, archive, join(dirname(paths.auditPath), 'events.2.jsonl'),
    ]);
    expect(snapshot.auditSources.some(item => item.path.endsWith('audit.1.jsonl'))).toBe(false);
    const outside = join(base, 'outside-audit.jsonl');
    await put(outside, '{"fixture":true}\n');
    await rm(archive);
    await symlink(outside, archive);
    expect((await store.list(project)).auditSources.some(item => item.path === archive)).toBe(false);
  });

  it.each(['absolute', 'relative', 'overlapping project default'])('keeps %s shared user audit output unscoped across project selections', async kind => {
    const { store, project: registered, homeDir, base } = await fixture();
    const project = kind === 'overlapping project default'
      ? { ...registered, path: join(homeDir, '.autoharness/inside-project') } : registered;
    await mkdir(project.path, { recursive: true });
    const other = { ...project, id: 'other-project', path: join(base, 'other-project') };
    await mkdir(other.path);
    const auditPath = kind === 'overlapping project default'
      ? join(project.path, '.autoharness/audit.jsonl') : join(homeDir, '.autoharness/shared.jsonl');
    await put(join(homeDir, '.autoharness/config.yaml'), `${policy}audit: {output: ${JSON.stringify(kind === 'relative' ? 'shared.jsonl' : auditPath)}}\n`);
    const nativeRecord = {
      timestamp: new Date().toISOString(), session_id: 'shared-session', event_type: 'tool_call',
      tool_name: 'unknown-project', permission: { action: 'allow', reason: 'Fixture' },
    };
    const original = [
      nativeRecord,
      { ...nativeRecord, project_id: project.id, tool_name: 'explicit-first-project' },
      { ...nativeRecord, project_id: other.id, tool_name: 'explicit-other-project' },
    ].map(item => JSON.stringify(item) + '\n').join('');
    await put(auditPath, original);
    const firstSource = (await store.list(project)).auditSources.find(item => item.path === auditPath)!;
    const otherSource = (await store.list(other)).auditSources.find(item => item.path === auditPath)!;
    expect(firstSource.projectId).toBeNull();
    expect(otherSource.projectId).toBeNull();
    expect(firstSource.id).toBe(otherSource.id);
    const reader = new HarnessAuditReader();
    const first = await reader.read([firstSource], { projectId: project.id });
    const second = await reader.read([otherSource], { projectId: other.id });
    expect(first.items.map(item => item.toolName)).toEqual(['explicit-first-project']);
    expect(second.items.map(item => item.toolName)).toEqual(['explicit-other-project']);
    const unfiltered = await reader.read([firstSource]);
    expect(unfiltered.items.find(item => item.toolName === 'unknown-project')?.projectId).toBeNull();
    expect(await readFile(auditPath, 'utf8')).toBe(original);
  });

  it('does not treat arbitrary managed-policy output files as trusted app writers', async () => {
    const { store, project, dataDir } = await fixture();
    await store.save(project, `${policy}audit: {output: custom.jsonl}\n`, null);
    const paths = harnessPaths(dataDir, project.id);
    const snapshot = await store.list(project);
    expect(snapshot.auditSources.find(item => item.path === join(paths.directory, 'custom.jsonl'))?.managed).toBe(false);
    expect(snapshot.auditSources.find(item => item.path === paths.auditPath)?.managed).toBe(true);
  });

  it.each(['.env', 'credentials.json', '.ssh/decisions.jsonl', 'nested/secrets.yaml', `${'deep/'.repeat(20)}audit.jsonl`])(
    'excludes unsafe configured audit output %s', async output => {
      const { store, project } = await fixture();
      await put(join(project.path, '.autoharness.yaml'), `${policy}audit: {output: ${JSON.stringify(output)}}\n`);
      const snapshot = await store.list(project);
      expect(snapshot.auditSources.some(item => item.path === join(project.path, output))).toBe(false);
      expect(snapshot.warnings.join(' ')).toMatch(/audit/i);
    },
  );
});

describe('restricted YAML and public policy redaction', () => {
  it('exposes the same bounded parser for draft engine validation without projecting private values', async () => {
    const { store } = await fixture();
    const source = `${policy}credentials: {password: fixture-draft-secret}\n`;
    expect(store.parse(source)).toMatchObject({ mode: 'standard', credentials: { password: 'fixture-draft-secret' } });
    for (const invalid of ['risk: {classifier: hybrid}\n', 'x: &x [*x]', 'rules: [', `${policy}---\n${policy}`]) {
      expect(() => store.parse(invalid)).toThrow(expect.objectContaining({ statusCode: 400 }));
    }
  });

  it.each([
    '', 'null', '[]', 'plain scalar',
    'mode: [standard', 'mode: core\nmode: standard\n',
    'shared: &x {a: 1}\nrisk: *x\n',
    'shared: &x {a: 1}\n', 'mode: !!str standard\n',
    'mode: !python/object:fixture standard\n',
    'mode: standard\n---\nmode: core\n',
    '%YAML 1.1\n---\nmode: standard\n',
    'constructor: {prototype: {polluted: true}}\n', 'risk: {<<: {classifier: rules}}\n',
    `risk: ${'['.repeat(80)}0${']'.repeat(80)}\n`,
    `extra: [${Array(6000).fill('0').join(',')}]\n`,
    'mode: standard\u0000',
    `# ${'a'.repeat(65536)}\nmode: standard\n`,
  ])('rejects unsafe or malformed YAML without exposing source diagnostics: %#', async content => {
    const { store } = await fixture();
    const result = store.validate(content);
    expect(result.valid).toBe(false);
    expect(result.engineValidated).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('python/object:fixture');
  });

  it.each([
    'mode: invented\n', 'version: 1\n', 'rules: {}\n', 'rules: [{id: "", description: x}]\n',
    'rules: [{id: x, description: 1}]\n', 'rules: [{id: x, description: x, severity: critical}]\n',
    'rules: [{id: x, description: x, enforcement: block}]\n',
    'risk: {classifier: llm}\n', 'risk: {classifier: hybrid}\n',
    'risk: {thresholds: {high: execute}}\n', 'risk: {custom_rules: [{level: high}]}\n',
    'hooks: {profile: arbitrary.py}\n', 'hooks: {pre: [{command: "never execute"}]}\n',
    'hooks: {post: [{python: "never execute"}]}\n', 'hooks: {shell: "never execute"}\n',
    'permissions: {defaults: {on_error: ignore}}\n', 'permissions: {tools: [Bash]}\n',
    'permissions: {tools: {Bash: {policy: ask}}}\n',
    'permissions: {tools: {Bash: {policy: restricted, deny_patterns: [4]}}}\n',
    'audit: {enabled: "false"}\n', 'audit: {format: sqlite}\n', 'audit: {retention_days: -1}\n',
  ])('rejects unsupported evaluation settings: %#', async content => {
    const { store } = await fixture();
    const validation = store.validate(content);
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  it('checks upstream shapes while disclosing local validation and unsupported extra fields', async () => {
    const { store } = await fixture();
    const validation = store.validate(`${policy}
identity: {name: fixture, boundaries: ["Stay local"]}
rules:
  - {id: review, description: "Review changes", severity: warning, enforcement: prompt}
permissions:
  defaults: {unknown_tool: ask, unknown_path: deny, on_error: deny}
  tools:
    Bash: {policy: restricted, deny_patterns: ['rm\\s+-rf'], ask_patterns: ['git\\s+push']}
risk:
  classifier: rules
  custom_rules: [{pattern: 'fixture-command', level: high, reason: 'Fixture', tool: bash}]
extra_feature: true
`.replace('risk: {classifier: rules}\n', ''));
    expect(validation).toMatchObject({ valid: true, engineValidated: false, mode: 'standard', ruleCount: 1 });
    expect(validation.warnings.join(' ')).toMatch(/unknown|unsupported|ignored/i);
    expect(validation.warnings.join(' ')).toMatch(/engine|local|structur/i);
  });

  it('redacts repeated and encoded secrets in content, names and rules while resolving the original', async () => {
    const { store, project } = await fixture();
    const secret = 'fixture-private-value/one';
    const content = `${policy}
identity: {name: "fixture-private-value/one"}
credentials:
  api_key: "fixture-private-value/one"
  password: |
    fixture-block-secret
rules:
  - id: "fixture-private-value/one"
    description: "credential fixture-private-value%2Fone and fixture-block-secret"
    severity: error
    enforcement: hook
# authorization: Bearer fixture-header-secret
`;
    await put(join(project.path, '.autoharness.yaml'), content);
    const snapshot = await store.list(project);
    const selected = snapshot.policies.find(item => item.scope === 'project')!;
    expect(selected.redacted).toBe(true);
    expect(selected.content).toContain('[REDACTED]');
    expect(JSON.stringify(snapshot)).not.toMatch(/fixture-private-value|fixture-block-secret|fixture-header-secret/);
    const resolved = await store.resolve(selected.id, selected.revision, project);
    expect(resolved.content).toBe(content);
    expect(resolved.config.credentials).toMatchObject({ api_key: secret, password: 'fixture-block-secret\n' });
    expect(JSON.stringify(resolved.detail)).not.toContain(secret);
  });

  it('rejects oversized and non-UTF-8 source files without previewing their content', async () => {
    const { store, project } = await fixture({ maxPolicyBytes: 128 });
    await put(join(project.path, '.autoharness.yaml'), `${policy}# ${'x'.repeat(200)}`);
    expect((await store.list(project)).policies.some(item => item.scope === 'project')).toBe(false);
    await writeFile(join(project.path, '.autoharness.yaml'), Buffer.from([0xff, 0xfe, 0x41]));
    const snapshot = await store.list(project);
    expect(snapshot.policies.some(item => item.scope === 'project')).toBe(false);
    expect(snapshot.warnings.length).toBeGreaterThan(0);
  });
});

describe('read-only owners and atomic managed policy saves', () => {
  it('saves managed bytes and a private exact backup while leaving native files unchanged', async () => {
    const { store, project, dataDir, homeDir } = await fixture();
    await put(join(project.path, '.autoharness.yaml'), policy);
    await put(join(homeDir, '.autoharness/config.yaml'), policy);
    const first = await store.save(project, policy, null);
    expect(first).toMatchObject({ scope: 'managed', editable: true, revision: hash(policy) });
    expect(first.path).toBe(harnessPaths(dataDir, project.id).policyPath);
    const secondText = `${policy}# Second revision\n`;
    const second = await store.save(project, secondText, first.revision);
    expect(second.revision).toBe(hash(secondText));
    expect(await readFile(first.path!, 'utf8')).toBe(secondText);
    const backups = (await readdir(dirname(first.path!))).filter(name => name.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    const backupPath = join(dirname(first.path!), backups[0]);
    expect(await readFile(backupPath, 'utf8')).toBe(policy);
    expect((await lstat(first.path!)).mode & 0o777).toBe(0o600);
    expect((await lstat(backupPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(project.path, '.autoharness.yaml'), 'utf8')).toBe(policy);
    expect(await readFile(join(homeDir, '.autoharness/config.yaml'), 'utf8')).toBe(policy);
    expect((await readdir(dirname(first.path!))).some(name => /\.(?:tmp|lock)$/.test(name))).toBe(false);
  });

  it('keeps global and project managed policies in their own app scopes', async () => {
    const { store, project, dataDir } = await fixture();
    const global = await store.save(null, policy, null);
    const local = await store.save(project, `${policy}# project\n`, null);
    expect(global.path).toBe(harnessPaths(dataDir, null).policyPath);
    expect(global.id).not.toBe(local.id);
    await expect(store.resolve(global.id, global.revision, project)).rejects.toMatchObject({ statusCode: 409 });
    expect(await readFile(global.path!, 'utf8')).toBe(policy);
  });

  it('rejects stale creates, stale updates and invalid replacements without changing the current policy', async () => {
    const { store, project } = await fixture();
    await expect(store.save(project, policy, 'missing-revision')).rejects.toMatchObject({ statusCode: 409 });
    const first = await store.save(project, policy, null);
    await expect(store.save(project, `${policy}# unexpected\n`, null)).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.save(project, `${policy}# unexpected\n`, 'stale')).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.save(project, 'mode: [broken', first.revision)).rejects.toMatchObject({ statusCode: 400 });
    expect(await readFile(first.path!, 'utf8')).toBe(policy);
  });

  it('allows exactly one concurrent create and one concurrent update across store instances', async () => {
    const { store, project, dataDir, homeDir } = await fixture();
    const other = new HarnessPolicyStore({ dataDir, homeDir });
    const created = await Promise.allSettled([
      store.save(project, `${policy}# one\n`, null),
      other.save(project, `${policy}# two\n`, null),
    ]);
    expect(created.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(created.filter(result => result.status === 'rejected').map(result => result.reason.statusCode)).toEqual([409]);
    const first = created.find(result => result.status === 'fulfilled')!.value;
    const updated = await Promise.allSettled([
      store.save(project, `${policy}# three\n`, first.revision),
      other.save(project, `${policy}# four\n`, first.revision),
    ]);
    expect(updated.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(updated.filter(result => result.status === 'rejected').map(result => result.reason.statusCode)).toEqual([409]);
    expect(await readFile(`${first.path}.bak`, 'utf8')).toBe(first.content);
  });

  it('will not save a masked copy over secrets or as a new managed policy', async () => {
    const { store, project } = await fixture();
    const original = `${policy}credentials: {password: fixture-save-secret}\n`;
    const first = await store.save(project, original, null);
    expect(first.redacted).toBe(true);
    await expect(store.save(project, `${first.content}# edited\n`, first.revision))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(store.save(null, 'identity: {name: "[REDACTED]"}\n', null))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(await readFile(first.path!, 'utf8')).toBe(original);
  });

  it.each(['file-symlink', 'parent-symlink', 'hardlink', 'directory', 'fifo'])(
    'rejects a native policy %s without leaking outside data', async kind => {
      const { store, project, base } = await fixture();
      const outside = join(base, 'outside.yaml');
      await writeFile(outside, `${policy}identity: {name: outside-private-fixture}\n`);
      const target = join(project.path, '.autoharness.yaml');
      if (kind === 'file-symlink') await symlink(outside, target);
      if (kind === 'hardlink') await link(outside, target);
      if (kind === 'directory') await mkdir(target);
      if (kind === 'fifo') await promisify(execFile)('mkfifo', [target]);
      if (kind === 'parent-symlink') {
        await mkdir(join(base, 'outside-dir'));
        await writeFile(join(base, 'outside-dir/constitution.yaml'), `${policy}identity: {name: outside-private-fixture}\n`);
        await symlink(join(base, 'outside-dir'), join(project.path, '.autoharness'));
      }
      const snapshot = await store.list(project);
      expect(snapshot.policies.some(item => item.scope === 'project')).toBe(false);
      expect(JSON.stringify(snapshot)).not.toContain('outside-private-fixture');
    },
  );

  it('rejects managed parent, target and backup escapes without modifying their targets', async () => {
    const { store, project, dataDir, base } = await fixture();
    const outsideDir = join(base, 'outside');
    await mkdir(outsideDir);
    await symlink(outsideDir, join(dataDir, 'harness'));
    await expect(store.save(project, policy, null)).rejects.toMatchObject({ statusCode: 400 });
    expect(await readdir(outsideDir)).toEqual([]);
    await rm(join(dataDir, 'harness'));
    const first = await store.save(project, policy, null);
    const outside = join(outsideDir, 'constitution.yaml');
    await writeFile(outside, 'fixture-outside');
    await symlink(outside, `${first.path}.bak`);
    await expect(store.save(project, `${policy}# changed\n`, first.revision)).rejects.toMatchObject({ statusCode: 400 });
    expect(await readFile(first.path!, 'utf8')).toBe(policy);
    expect(await readFile(outside, 'utf8')).toBe('fixture-outside');
    await rm(`${first.path}.bak`);
    await rm(first.path!);
    await link(outside, first.path!);
    await expect(store.save(project, policy, first.revision)).rejects.toMatchObject({ statusCode: 400 });
    expect(await readFile(outside, 'utf8')).toBe('fixture-outside');
  });

  it('does not redefine the user owner through a symlinked home directory', async () => {
    const { store, homeDir, base } = await fixture();
    const outsideHome = join(base, 'outside-home');
    await put(join(outsideHome, '.autoharness/config.yaml'), `${policy}identity: {name: outside-home-private}\n`);
    await rm(homeDir, { recursive: true });
    await symlink(outsideHome, homeDir);
    const snapshot = await store.list(null);
    expect(snapshot.policies.some(item => item.scope === 'user')).toBe(false);
    expect(snapshot.auditSources.some(item => item.path === join(homeDir, '.autoharness/audit.jsonl'))).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('outside-home-private');
  });

  it('cleans temporary policy bytes and releases its lock when a write fails after a partial write', async () => {
    const { store, project, dataDir } = await fixture();
    const probe = await open(join(dataDir, 'fixture-probe'), 'w');
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    const originalWrite = prototype.writeFile;
    await probe.close();
    // Disk-full/IO failures are not reliably reproducible with a real test filesystem.
    vi.spyOn(prototype, 'writeFile').mockImplementationOnce(async function(this: FileHandle, data) {
      await originalWrite.call(this, Buffer.from(data as Uint8Array).subarray(0, 12));
      throw Object.assign(new Error('fixture partial-write failure'), { code: 'EIO' });
    });
    await expect(store.save(project, policy, null)).rejects.toThrow('fixture partial-write failure');
    const paths = harnessPaths(dataDir, project.id);
    expect(await readdir(paths.directory)).toEqual([]);
    const recovered = await store.save(project, policy, null);
    expect(recovered.revision).toBe(hash(policy));
  });
});
