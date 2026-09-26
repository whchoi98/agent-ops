import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project } from '../../shared/types.js';
import type {
  HarnessAuditPage, HarnessAuditQuery, HarnessCatalog, HarnessClient, HarnessEvaluationRequest,
  HarnessHookRequest, HarnessPolicyDetail, HarnessSettings, HarnessValidation,
} from '../../shared/harness.js';
import { redact } from '../privacy.js';
import { HarnessPolicyStore } from './policy.js';
import { HarnessAuditReader } from './audit.js';
import { HarnessRuntimeManager } from './runtime.js';
import { HarnessHookManager } from './hooks.js';
import { demoAudit, demoBindings, demoHookPreview, demoPolicy, demoRuntime } from './demo.js';
import { harnessError, harnessPaths, type HarnessResolvedPolicy } from './types.js';

export const defaultHarnessSettings = (): HarnessSettings => ({
  revision: 0, pythonPath: null, retentionDays: 30, maxCacheRecords: 2000,
});
export interface HarnessServiceOptions {
  dataDir: string;
  demo?: boolean;
  homeDir?: string;
  codexHome?: string;
  claudeHome?: string;
  kiroHome?: string;
  bridgePath?: string;
  runtimeOptions?: {
    timeoutMs?: number; cleanupGraceMs?: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv;
  };
}
export interface HarnessServiceDependencies {
  getProjects: () => Project[];
  readSettings: () => HarnessSettings | null;
  writeSettings: (next: HarnessSettings, expectedRevision: number) => Promise<void>;
  clientVersions?: () => Promise<Partial<Record<HarnessClient, string | null>>>;
}
export class HarnessService {
  private readonly policies: HarnessPolicyStore;
  private readonly auditReader = new HarnessAuditReader();
  private readonly runtime: HarnessRuntimeManager;
  private readonly hooks: HarnessHookManager;
  private readonly home: string;
  private readonly demoManaged = new Map<string, HarnessPolicyDetail>();
  private closed = false;
  private mutating = false;
  private operation: Promise<unknown> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: HarnessServiceOptions, private readonly deps: HarnessServiceDependencies) {
    this.home = resolve(options.homeDir ?? homedir());
    const bridgePath = options.bridgePath ?? fileURLToPath(new URL(
      import.meta.url.endsWith('.ts') ? './bridge.py' : './harness-bridge.py', import.meta.url,
    ));
    this.policies = new HarnessPolicyStore({ dataDir: options.dataDir, homeDir: this.home });
    this.runtime = new HarnessRuntimeManager({ ...options.runtimeOptions, dataDir: options.dataDir, bridgePath });
    this.hooks = new HarnessHookManager({
      dataDir: options.dataDir, homeDir: this.home, codexHome: options.codexHome,
      claudeHome: options.claudeHome, kiroHome: options.kiroHome, bridgePath,
      getProject: id => this.deps.getProjects().find(project => project.id === id) ?? null,
    });
  }
  private project(id?: string): Project | null {
    if (this.closed) throw harnessError(503, '하니스 관리가 종료 중입니다.');
    if (!id) return null;
    const project = this.deps.getProjects().find(item => item.id === id);
    if (!project) throw harnessError(404, '등록된 프로젝트를 찾을 수 없습니다.');
    return { ...project };
  }
  private revalidate(project: Project | null): Project | null {
    const current = this.project(project?.id);
    if (current?.path !== project?.path || current?.executionEnabled !== project?.executionEnabled) {
      throw harnessError(409, '프로젝트 설정이 변경되었습니다. 다시 확인하세요.');
    }
    return current;
  }
  get settings(): HarnessSettings {
    const saved = this.deps.readSettings();
    return saved ? { ...saved } : defaultHarnessSettings();
  }
  get resourceRoots() { return this.runtime.resourceRoots; }
  status() {
    return { busy: this.mutating, processCount: this.resourceRoots.length, closing: this.closed, demo: Boolean(this.options.demo) };
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw harnessError(503, '하니스 관리가 종료 중입니다.');
    if (this.mutating) throw harnessError(409, '다른 하니스 요청을 처리 중입니다. 완료 후 다시 시도하세요.');
    this.mutating = true;
    const pending = Promise.resolve().then(operation);
    this.operation = pending;
    try { return await pending; }
    finally { this.mutating = false; if (this.operation === pending) this.operation = null; }
  }
  async catalog(projectId?: string): Promise<HarnessCatalog> {
    const project = this.project(projectId);
    const settings = this.settings;
    const scope = project?.id ?? '';
    if (this.options.demo) {
      const audit = demoAudit({ projectId }, settings);
      return {
        projectId: project?.id ?? null, scannedAt: new Date().toISOString(), demo: true,
        runtime: demoRuntime(), settings,
        policies: [demoPolicy(project?.id ?? null), ...(this.demoManaged.has(scope) ? [this.demoManaged.get(scope)!] : [])]
          .map(({ content: _content, rules: _rules, ...item }) => item),
        bindings: demoBindings(project?.id ?? null), auditSources: audit.sources, storage: audit.storage,
        warnings: ['데모에서는 실제 엔진 실행과 훅 설정 변경을 할 수 없습니다.'],
      };
    }
    const [snapshot, versions] = await Promise.all([
      this.policies.list(project), this.deps.clientVersions?.().catch(() => ({})) ?? Promise.resolve({}),
    ]);
    this.revalidate(project);
    const [bindings, audit] = await Promise.all([
      this.hooks.list(project, versions),
      this.auditReader.read(snapshot.auditSources, { projectId, limit: 1 }, settings),
    ]);
    this.revalidate(project);
    const observed = audit.observed ?? {};
    return {
      projectId: project?.id ?? null, scannedAt: new Date().toISOString(), demo: false,
      runtime: this.runtime.info, settings,
      policies: snapshot.policies.map(({ content: _content, rules: _rules, ...item }) => item),
      bindings: bindings.map(binding => ({
        ...binding, lastObservedAt: observed[binding.client] ?? (binding.client.startsWith('kiro') ? observed.kiro : null) ?? null,
      })),
      auditSources: snapshot.auditSources.map(({ root: _root, ...source }) => source),
      storage: audit.storage, warnings: [...snapshot.warnings, ...audit.warnings],
    };
  }
  async refresh(projectId?: string) { return this.catalog(projectId); }
  async saveSettings(input: HarnessSettings): Promise<HarnessSettings> {
    return this.exclusive(async () => {
      const previous = this.settings;
      if (previous.revision !== input.revision) throw harnessError(409, '하니스 설정이 변경되었습니다. 다시 불러온 뒤 저장하세요.');
      const next = { ...input, revision: input.revision + 1 };
      await this.deps.writeSettings(next, previous.revision);
      if (previous.pythonPath !== next.pythonPath) this.runtime.invalidate();
      if (previous.retentionDays !== next.retentionDays || previous.maxCacheRecords !== next.maxCacheRecords) {
        this.auditReader.clear();
      }
      return next;
    });
  }
  async checkRuntime(signal?: AbortSignal) {
    if (this.options.demo) throw harnessError(403, '데모에서는 실제 엔진 실행과 훅 설정 변경을 할 수 없습니다.');
    return this.exclusive(() => this.runtime.probe(this.settings.pythonPath, signal));
  }
  async policy(id: string, projectId?: string): Promise<HarnessPolicyDetail> {
    const project = this.project(projectId);
    if (!this.options.demo) return this.policies.detail(id, project);
    const builtin = demoPolicy(project?.id ?? null);
    const managed = this.demoManaged.get(project?.id ?? '');
    if (id === builtin.id) return builtin;
    if (managed?.id === id) return structuredClone(managed);
    throw harnessError(404, '선택한 범위에서 정책을 찾을 수 없습니다.');
  }
  private async resolvePolicy(id: string, revision: string, project: Project | null): Promise<HarnessResolvedPolicy> {
    if (!this.options.demo) return this.policies.resolve(id, revision, project);
    const detail = await this.policy(id, project?.id);
    if (detail.revision !== revision) throw harnessError(409, '정책이 변경되었습니다. 다시 불러온 뒤 계속하세요.');
    return { detail, content: detail.content, config: {} };
  }
  async validatePolicy(input: { projectId?: string; policyId?: string; revision?: string; content?: string }, signal?: AbortSignal): Promise<HarnessValidation> {
    const project = this.project(input.projectId);
    let content = input.content;
    let resolved: HarnessResolvedPolicy | undefined;
    if (input.policyId && input.revision) {
      resolved = await this.resolvePolicy(input.policyId, input.revision, project);
      content = resolved.content;
    }
    if (content === undefined) throw harnessError(400, '검증할 정책을 선택하거나 내용을 입력하세요.');
    const structural = this.policies.validate(content);
    if (!structural.valid || this.options.demo || this.runtime.info.state !== 'ready') return structural;
    // A draft is parsed by the same bounded policy parser as stored sources.
    const config = resolved?.config ?? this.policies.parse(content);
    return this.exclusive(() => this.runtime.validate({ policy: config, projectDir: project?.path ?? this.home, signal }));
  }
  async savePolicy(input: { projectId?: string; content: string; expectedRevision: string | null }) {
    const project = this.project(input.projectId);
    return this.exclusive(async () => {
      if (!this.options.demo) return this.policies.save(project, input.content, input.expectedRevision);
      const scope = project?.id ?? '';
      const previous = this.demoManaged.get(scope);
      if ((previous?.revision ?? null) !== input.expectedRevision) throw harnessError(409, '정책이 변경되었습니다. 다시 불러온 뒤 계속하세요.');
      if (!previous && this.demoManaged.size >= 64) throw harnessError(429, '데모 정책 수 한도에 도달했습니다.');
      const validation = this.policies.validate(input.content);
      if (!validation.valid) throw harnessError(400, validation.errors.join(' '));
      const content = redact(input.content);
      const detail: HarnessPolicyDetail = {
        ...demoPolicy(project?.id ?? null), id: 'demo-harness-managed', name: 'Managed demo policy',
        scope: 'managed', editable: content === input.content, content, redacted: content !== input.content,
        revision: createHash('sha256').update(input.content).digest('hex'),
        bytes: Buffer.byteLength(input.content), mode: validation.mode, ruleCount: validation.ruleCount,
      };
      this.demoManaged.set(scope, detail);
      return structuredClone(detail);
    });
  }
  async evaluate(input: HarnessEvaluationRequest, signal?: AbortSignal) {
    const project = this.project(input.projectId);
    if (this.options.demo) throw harnessError(403, '데모에서는 실제 엔진 실행과 훅 설정 변경을 할 수 없습니다.');
    if (this.runtime.info.state !== 'ready') throw harnessError(409, '먼저 AutoHarness 엔진을 확인하세요.');
    return this.exclusive(async () => {
      const resolved = await this.resolvePolicy(input.policyId, input.revision, project);
      const result = await this.runtime.evaluate({
        policy: resolved.config, projectDir: project?.path ?? this.home,
        auditPath: harnessPaths(this.options.dataDir, project?.id ?? null).auditPath,
        client: input.client, projectId: project?.id ?? null, policyId: input.policyId,
        policyRevision: input.revision, toolName: input.toolName, toolInput: input.toolInput, signal,
      });
      this.revalidate(project);
      return { ...result, reason: redact(result.reason) };
    });
  }
  async previewHooks(input: HarnessHookRequest, signal?: AbortSignal) {
    const project = this.project(input.projectId)!;
    if (this.options.demo) return demoHookPreview(input);
    return this.exclusive(async () => {
      const versions = await this.deps.clientVersions?.().catch(() => ({})) ?? {};
      await this.hooks.list(project, versions);
      const resolved = input.action === 'install'
        ? await this.resolvePolicy(input.policyId!, input.revision!, project) : null;
      if (resolved && this.runtime.info.state === 'ready') {
        const validation = await this.runtime.validate({ policy: resolved.config, projectDir: project.path, signal });
        if (!validation.valid) throw harnessError(400, validation.errors.join(' '));
      }
      if (signal?.aborted) throw harnessError(499, '훅 미리보기 요청이 취소되었습니다.');
      return this.hooks.preview(input, this.revalidate(project)!, resolved, this.runtime.info);
    });
  }
  async applyHooks(previewId: string, projectId: string) {
    const project = this.project(projectId)!;
    if (this.options.demo) throw harnessError(403, '데모에서는 실제 엔진 실행과 훅 설정 변경을 할 수 없습니다.');
    return this.exclusive(async () => {
      const selection = this.hooks.getSelection(previewId);
      if (selection.projectId !== projectId) throw harnessError(409, '미리보기의 프로젝트가 다릅니다. 다시 미리보세요.');
      if (selection.action === 'install') await this.resolvePolicy(selection.policyId!, selection.revision!, project);
      const versions = await this.deps.clientVersions?.().catch(() => ({})) ?? {};
      await this.hooks.list(this.revalidate(project), versions);
      return this.hooks.apply(previewId, this.revalidate(project)!, this.runtime.info);
    });
  }
  async audit(query: HarnessAuditQuery): Promise<HarnessAuditPage> {
    const project = this.project(query.projectId);
    if (this.options.demo) return demoAudit(query, this.settings);
    const snapshot = await this.policies.list(project);
    const result = await this.auditReader.read(snapshot.auditSources, query, this.settings);
    this.revalidate(project);
    return result;
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await this.runtime.close();
      await this.operation?.catch(() => {});
      this.hooks.close();
      this.auditReader.clear();
    })();
    return this.closePromise;
  }
}
