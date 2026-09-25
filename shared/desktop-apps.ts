import type { Agent } from './types.js';

export type DesktopAppId = 'codex-app' | 'claude-desktop' | 'kiro-ide';
export type DesktopAppLocation = 'system' | 'user';
export type DesktopAppStatus = 'installed' | 'not-installed' | 'unverified' | 'unsupported-host';
export type DesktopAppMetadataField = 'version' | 'build' | 'bundleIdentifier';
export type DesktopAppIssueCode =
  | 'unsafe-path' | 'path-unavailable' | 'plist-missing' | 'plist-unreadable' | 'plist-too-large'
  | 'plist-invalid' | 'metadata-limit' | 'field-missing' | 'field-invalid'
  | 'conversion-failed' | 'conversion-timeout' | 'changed-during-read';

export interface DesktopAppIssue {
  code: DesktopAppIssueCode;
  field?: DesktopAppMetadataField;
}

export interface DesktopAppInstallation {
  path: string;
  location: DesktopAppLocation;
  /** Observed plist strings; never normalized, inferred from another key or compared to CLI releases. */
  version: string | null;
  build: string | null;
  bundleIdentifier: string | null;
  metadataStatus: 'complete' | 'partial' | 'unavailable';
  source: {
    type: 'info-plist';
    path: string;
    keys: {
      version: 'CFBundleShortVersionString';
      build: 'CFBundleVersion';
      bundleIdentifier: 'CFBundleIdentifier';
    };
  };
  issues: DesktopAppIssue[];
}

export interface DesktopAppCandidate {
  path: string;
  location: DesktopAppLocation;
  status: 'found' | 'not-found' | 'unverified';
  issues: DesktopAppIssue[];
}

export interface DesktopApp {
  id: DesktopAppId;
  agent: Agent;
  name: string;
  versionScope: 'app' | 'app-container' | 'ide';
  status: DesktopAppStatus;
  /** null means presence/absence was not established, including on other operating systems. */
  installed: boolean | null;
  /** Ordered system then user. The first entry is the displayed installation, even with partial metadata. */
  installations: DesktopAppInstallation[];
  candidates: DesktopAppCandidate[];
  unverified: {
    authentication: 'unverified';
    cloudChats: 'unverified';
    privateHistories: 'unverified';
    codeEngineVersion: 'unverified';
  };
}

export interface DesktopAppReport {
  status: 'supported' | 'unsupported-host' | 'demo';
  platform: string;
  scope: 'server-host';
  demo: boolean;
  checkedAt: string;
  expiresAt: string;
  cacheTtlMs: number;
  items: DesktopApp[];
}
