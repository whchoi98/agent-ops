import type { DesktopAppIssueCode } from '../../shared/desktop-apps.js';

/** Diagnostics contain only fixed codes, never converter output or filesystem error strings. */
export class DesktopAppProbeError extends Error {
  constructor(readonly code: DesktopAppIssueCode) {
    super(code);
  }
}
