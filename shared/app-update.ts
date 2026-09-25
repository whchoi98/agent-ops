export const APP_UPDATE_SOURCE_URL = 'https://api.github.com/repos/whchoi98/agent-ops/releases/latest';
export const APP_UPDATE_REPOSITORY_URL = 'https://github.com/whchoi98/agent-ops';

export type AppUpdateStatus = 'not-checked' | 'current' | 'update-available' | 'ahead' | 'unavailable' | 'demo';
export type AppUpdateErrorCode =
  | 'invalid-current-version' | 'invalid-release' | 'request-failed'
  | 'redirect-rejected' | 'response-too-large' | 'timeout' | 'closed';

export interface AppUpdateRelease {
  version: string;
  tag: string;
  publishedAt: string;
  releaseUrl: string;
  /** Only an unambiguous installation archive at this repository's exact tag is retained. */
  archive: { name: string; url: string } | null;
}

export interface AppUpdateCommands {
  /** Commands are instructions for the operator, never server-side execution inputs. */
  npm: string | null;
  git: string | null;
}

export interface AppUpdateReport {
  currentVersion: string;
  demo: boolean;
  status: AppUpdateStatus;
  checking: boolean;
  latest: AppUpdateRelease | null;
  /** Completion time of the last explicit attempt, including an unsuccessful attempt. */
  checkedAt: string | null;
  /** Earliest next allowed attempt, not an automatically scheduled check. */
  nextCheckAt: string | null;
  sourceUrl: string;
  error: AppUpdateErrorCode | null;
  commands: AppUpdateCommands;
}
