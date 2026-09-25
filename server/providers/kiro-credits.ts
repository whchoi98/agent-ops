import { array, hash, object, timestamp } from './common.js';

const MAX_TURNS = 20_000;
const MAX_MESSAGE_IDENTITIES = 40_000;
interface Snapshot {
  credits: number | null;
  partial: boolean;
  records: number;
  at: number | null;
  order: number;
}
export interface CreditTurnIdentity { loop: string | null; messages: string[]; position: number; excessive: boolean }
interface FallbackGroup { parent: FallbackGroup | null; rank: number; snapshot: Snapshot }
interface MessageIdentity { loop?: string | null; fallback?: FallbackGroup }

/** Loop IDs are data, not display text. Bound canonicalization before hashing them. */
function canonicalIdentity(value: unknown): string | null {
  let remaining = 128;
  function visit(item: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 8) throw new Error('identity limit');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) {
      if (Number.isInteger(item) && !Number.isSafeInteger(item)) throw new Error('identity precision');
      return item;
    }
    if (typeof item === 'string' && item.length <= 1024) return item;
    if (Array.isArray(item) && item.length <= 64) return item.map(child => visit(child, depth + 1));
    if (item && typeof item === 'object') {
      const keys = Object.keys(item).sort();
      if (keys.length > 32 || keys.some(key => key.length > 128)) throw new Error('identity limit');
      return Object.fromEntries(keys.map(key => [key, visit((item as Record<string, unknown>)[key], depth + 1)]));
    }
    throw new Error('invalid identity');
  }
  try {
    const text = JSON.stringify(visit(value, 0));
    return text.length <= 8192 ? text : null;
  } catch { return null; }
}

export function kiroCreditTurnIdentity(turn: Record<string, unknown>, index: number): CreditTurnIdentity {
  let loopKey: string | null = null;
  const loop = turn.loop_id;
  if (loop !== null && loop !== undefined && loop !== '') {
    const canonical = canonicalIdentity(loop);
    if (canonical && canonical !== '[]' && canonical !== '{}') loopKey = `loop:${hash(canonical)}`;
  }
  const ids = array(turn.message_ids);
  if (ids.length > MAX_MESSAGE_IDENTITIES) return { loop: loopKey, messages: [], position: index, excessive: true };
  const messages = new Set<string>();
  for (const id of ids) if (typeof id === 'string' && id.length > 0 && id.length <= 1024) messages.add(`message:${hash(id)}`);
  return { loop: loopKey, messages: [...messages], position: index, excessive: false };
}

/** Per-turn snapshots, separate from monotonic token counters and USD. */
export class KiroCreditLedger {
  private readonly loops = new Map<string, Snapshot>();
  private readonly groups = new Set<FallbackGroup>();
  private readonly messages = new Map<string, MessageIdentity>();
  private readonly unidentified = new Set<number>();
  private overflow = false;
  private order = 0;

  constructor(private readonly warn: (message: string) => void) {}

  private invalidate(message: string) {
    this.overflow = true;
    this.loops.clear(); this.groups.clear(); this.messages.clear(); this.unidentified.clear();
    this.warn(message);
  }

  private root(group: FallbackGroup): FallbackGroup {
    let result = group;
    while (result.parent) result = result.parent;
    while (group.parent) {
      const parent = group.parent;
      group.parent = result;
      group = parent;
    }
    return result;
  }

  private latest(previous: Snapshot | undefined, incoming: Snapshot): Snapshot {
    if (!previous) return incoming;
    if (previous.at !== null && (incoming.at === null || incoming.at < previous.at)) return previous;
    if (incoming.at !== null && (previous.at === null || incoming.at > previous.at)) return incoming;
    if (incoming.records !== previous.records) return incoming.records > previous.records ? incoming : previous;
    return incoming.order > previous.order ? incoming : previous;
  }

  private join(left: FallbackGroup, right: FallbackGroup): FallbackGroup {
    left = this.root(left); right = this.root(right);
    if (left === right) return left;
    if (left.rank < right.rank) [left, right] = [right, left];
    right.parent = left;
    if (left.rank === right.rank) left.rank++;
    left.snapshot = this.latest(left.snapshot, right.snapshot);
    this.groups.delete(right);
    return left;
  }

  record(identity: CreditTurnIdentity, metering: unknown, endedAt: unknown, snapshotAt?: unknown) {
    if (this.overflow) return;
    if (identity.excessive) {
      this.invalidate('Too many Kiro credit identities; recorded credits are unknown.');
      return;
    }
    const entries = array(metering);
    if (!identity.loop && !identity.messages.length) {
      this.unidentified.add(identity.position);
      if (entries.length) this.warn('A Kiro credit turn had no stable identity; recorded credits may be partial.');
      if (this.loops.size + this.groups.size + this.unidentified.size > MAX_TURNS) {
        this.invalidate('Too many Kiro credit turns; recorded credits are unknown.');
      }
      return;
    }
    const links: MessageIdentity[] = [];
    for (const message of identity.messages) {
      if (!this.messages.has(message) && this.messages.size >= MAX_MESSAGE_IDENTITIES) {
        this.invalidate('Too many Kiro credit identities; recorded credits are unknown.');
        return;
      }
      const link = this.messages.get(message) ?? {};
      this.messages.set(message, link);
      links.push(link);
    }
    // Keep explicit-loop values and fallback values separate until all identity
    // evidence has been seen. Later aliases must not leave provisional sums behind.
    const stamp = timestamp(snapshotAt) ?? timestamp(endedAt);
    const incomingAt = stamp ? Date.parse(stamp) : null;
    let credits: number | null = null;
    let partial = false;
    for (const value of entries) {
      const entry = object(value);
      if (entry.unit !== 'credit' && entry.unit !== 'credits') continue;
      if (typeof entry.value !== 'number' || !Number.isFinite(entry.value) || entry.value < 0) {
        partial = true;
        this.warn('Some Kiro credit values were invalid; recorded credits may be partial.');
        continue;
      }
      credits = (credits ?? 0) + entry.value;
      if (!Number.isFinite(credits)) {
        credits = null;
        partial = true;
        this.warn('Kiro credit values exceeded the numeric limit; recorded credits are unknown.');
        break;
      }
    }
    const snapshot = { credits, partial, records: entries.length, at: incomingAt, order: ++this.order };
    if (identity.loop) {
      this.loops.set(identity.loop, this.latest(this.loops.get(identity.loop), snapshot));
      for (const link of links) {
        if (link.loop === undefined) link.loop = identity.loop;
        else if (link.loop !== identity.loop) link.loop = null;
      }
    } else {
      let group: FallbackGroup | undefined;
      for (const link of links) {
        if (link.fallback) group = group ? this.join(group, link.fallback) : this.root(link.fallback);
      }
      if (!group) {
        group = { parent: null, rank: 0, snapshot };
        this.groups.add(group);
      } else group.snapshot = this.latest(group.snapshot, snapshot);
      for (const link of links) link.fallback = group;
    }
    if (this.loops.size + this.groups.size + this.unidentified.size > MAX_TURNS) {
      this.invalidate('Too many Kiro credit turns; recorded credits are unknown.');
    }
  }

  finish(): { credits: number | null; creditsPartial: boolean } {
    if (this.overflow) return { credits: null, creditsPartial: true };
    const ownership = new Map<FallbackGroup, { loops: Set<string>; ambiguous: boolean }>();
    for (const group of this.groups) ownership.set(group, { loops: new Set(), ambiguous: false });
    for (const link of this.messages.values()) {
      if (!link.fallback) continue;
      const entry = ownership.get(this.root(link.fallback))!;
      if (link.loop === null) entry.ambiguous = true;
      else if (link.loop !== undefined) entry.loops.add(link.loop);
    }
    const resolved = new Map(this.loops);
    const independent: Snapshot[] = [];
    for (const [group, owners] of ownership) {
      if (owners.loops.size > 1 || (!owners.loops.size && owners.ambiguous)) {
        this.warn('Kiro credit turn identities were ambiguous; recorded credits are unknown.');
        return { credits: null, creditsPartial: true };
      }
      const loop = owners.loops.values().next().value as string | undefined;
      if (loop) resolved.set(loop, this.latest(resolved.get(loop), group.snapshot));
      else independent.push(group.snapshot);
    }
    let total: number | null = null;
    let incomplete = this.unidentified.size > 0;
    for (const turn of [...resolved.values(), ...independent]) {
      incomplete ||= turn.partial || turn.credits === null;
      if (turn.credits === null) continue;
      total = (total ?? 0) + turn.credits;
      if (!Number.isFinite(total)) {
        this.warn('Kiro credit values exceeded the numeric limit; recorded credits are unknown.');
        return { credits: null, creditsPartial: true };
      }
    }
    return { credits: total, creditsPartial: total !== null && incomplete };
  }
}
