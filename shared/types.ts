export const AGENTS = ['codex', 'claude', 'kiro'] as const;
export type Agent = (typeof AGENTS)[number];
export type SessionStatus = 'completed' | 'failed' | 'recorded';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type Policy = 'read-only' | 'workspace-write';

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  /** Recorded Kiro credits; absent legacy fields and null both mean unrecorded. */
  credits?: number | null;
  /** Some metered turns or values were unavailable; this is a recorded partial sum. */
  creditsPartial?: boolean;
}
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  timestamp: string;
  /** Tool invocations have role=assistant; outputs have role=tool. */
  toolName?: string;
  isError?: boolean;
  model?: string;
  truncated?: boolean;
  contentLength?: number;
}
export interface MessageQuery {
  role?: Message['role'];
  q?: string;
  offset?: number;
  limit?: number;
}
export interface MessagePage {
  items: Message[];
  total: number;
  offset: number;
  limit: number;
  roleCounts: Record<Message['role'] | 'all', number>;
}
export interface Session {
  id: string;
  nativeId: string;
  agent: Agent;
  title: string;
  projectPath: string;
  projectName: string;
  model: string;
  startedAt: string;
  updatedAt: string;
  status: SessionStatus;
  messageCount: number;
  toolCallCount: number;
  usage: Usage;
  sourcePath: string;
  bookmarked: boolean;
  tags: string[];
  note: string;
  parentId?: string;
  /** False for records (such as subagents) that the native CLI cannot resume by ID. */
  resumable?: boolean;
}
export interface ImportedSession extends Omit<Session, 'bookmarked' | 'tags' | 'note'> {
  messages: Message[];
}
export interface SessionDetail extends Session {
  messages: Message[];
}
export interface Project {
  id: string;
  name: string;
  path: string;
  color: string;
  executionEnabled: boolean;
  createdAt: string;
}
export interface RunRequest {
  agent: Agent;
  projectId: string;
  prompt: string;
  title?: string;
  model?: string;
  policy: Policy;
  allowShell?: boolean;
  resumeSessionId?: string;
  sourceSessionId?: string;
  templateId?: string;
}
export interface Run extends RunRequest {
  id: string;
  title: string;
  status: RunStatus;
  projectName: string;
  projectPath: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  nativeSessionId: string | null;
  usage: Usage;
  command: string;
}
export interface RunEvent {
  id: number;
  runId: string;
  timestamp: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}
export interface CommandPreview {
  executable: string;
  args: string[];
  cwd: string;
  displayCommand: string;
  stdin: boolean;
  policyDescription: string;
  warnings: string[];
}
export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  category: 'review' | 'build' | 'debug' | 'docs' | 'custom';
  prompt: string;
  agent: Agent | 'any';
  policy: Policy;
  updatedAt: string;
}
export interface ConnectorStatus {
  agent: Agent;
  installed: boolean;
  version: string | null;
  executable: string | null;
  roots: string[];
  existingRoots: string[];
  sessionCount: number;
  error: string | null;
  supportsResume: boolean;
  supportsStreaming: boolean;
}
export interface Settings {
  concurrency: number;
  timeoutMinutes: number;
  scanIntervalSeconds: number;
  syncMode?: SyncMode;
  syncMaxSeconds?: number;
  sourceRoots: Record<Agent, string[]>;
  theme: 'light' | 'dark' | 'system';
}
export interface SyncReport {
  startedAt: string;
  finishedAt: string;
  imported: number;
  skipped: number;
  warnings: string[];
  filesScanned: number;
}
export interface CreditTotals {
  /** Sum of recorded Kiro credits; null means the aggregate exceeded numeric limits. */
  recordedCredits?: number | null;
  knownCreditSessions?: number;
  partialCreditSessions?: number;
  kiroSessions?: number;
}
export interface Analytics extends CreditTotals {
  totalSessions: number;
  totalMessages: number;
  totalToolCalls: number;
  totalTokens: number;
  knownTokenSessions: number;
  recordedCostUsd: number;
  knownCostSessions: number;
  daily: Array<{ date: string; sessions: number; tokens: number; knownTokenSessions: number; codex: number; claude: number; kiro: number } & CreditTotals>;
  agents: Array<{ agent: Agent; sessions: number; tokens: number; knownTokenSessions: number; costUsd: number; knownCostSessions: number } & CreditTotals>;
  models: Array<{ model: string; sessions: number; tokens: number; knownTokenSessions: number } & CreditTotals>;
  projects: Array<{ path: string; name: string; sessions: number; tokens: number; knownTokenSessions: number } & CreditTotals>;
  tools: Array<{ name: string; count: number }>;
  cacheReadTokens: number;
  inputTokens: number;
  runOutcomes: Record<RunStatus, number>;
}
export interface Bootstrap {
  version: string;
  demo: boolean;
  sessions: Session[];
  sessionTotal: number;
  runs: Run[];
  projects: Project[];
  templates: PromptTemplate[];
  connectors: ConnectorStatus[];
  settings: Settings;
  analytics: Analytics;
  sync: SyncReport | null;
  syncing: boolean;
  syncStatus?: SyncStatus;
}
export interface SessionQuery {
  q?: string;
  agent?: Agent;
  project?: string;
  status?: SessionStatus;
  bookmarked?: boolean;
  tag?: string;
  since?: string;
  until?: string;
  sort?: 'recent' | 'oldest' | 'tokens' | 'credits';
  limit?: number;
  offset?: number;
}
export interface SessionPage { items: Session[]; total: number }
export interface RunDetail { run: Run; events: RunEvent[] }
export interface Handoff {
  prompt: string;
  sourceSessionId: string;
  targetAgent: Agent;
  sessionTitle: string;
}
export const emptyUsage = (): Usage => ({
  inputTokens: null, outputTokens: null, cacheReadTokens: null,
  cacheWriteTokens: null, costUsd: null,
});
import type { SyncMode, SyncStatus } from './sync-control.js';
