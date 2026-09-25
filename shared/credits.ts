import type { Usage } from './types.js';

/** Missing legacy fields and malformed persisted values must never become zero. */
export function creditValue(usage: Pick<Usage, 'credits'>): number | null {
  const value = usage.credits;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
