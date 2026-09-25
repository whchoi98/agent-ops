import type { Agent, Project } from '../../shared/types.js';
import type { ExtensionEvidence, ExtensionKind, ExtensionRoot, ExtensionScope, ExtensionStatus } from '../../shared/extensions.js';

/** Providers return metadata candidates; the service owns file access and response shaping. */
export interface ExtensionCandidate {
  key: string;
  agent: Agent;
  kind: ExtensionKind;
  name: string;
  description?: string;
  version?: string;
  scope: ExtensionScope;
  path: string;
  rootPath: string;
  status: ExtensionStatus;
  statusReason: string;
  evidence: ExtensionEvidence[];
  pluginKey?: string;
  pluginName?: string;
  usedBy?: string[];
  warnings?: string[];
}
export interface DiscoveryIO {
  json(path: string, ownerRoot?: string): Promise<Record<string, unknown> | null>;
  toml(path: string): Promise<Record<string, unknown> | null>;
  text(path: string, ownerRoot?: string): Promise<string | null>;
  directories(path: string): Promise<string[]>;
  files(path: string): Promise<string[]>;
  skills(path: string, ownerRoot?: string): Promise<string[]>;
  markdown(path: string, ownerRoot?: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  contains(ownerRoot: string, path: string): Promise<boolean>;
}
export interface DiscoveryContext {
  homeDir: string;
  codexHome: string;
  claudeHome: string;
  platform: NodeJS.Platform;
  project: Pick<Project, 'id' | 'name' | 'path'> | null;
  io: DiscoveryIO;
}
export interface DiscoveryResult {
  candidates: ExtensionCandidate[];
  roots: ExtensionRoot[];
  warnings: string[];
}
