import type { Reporter, ReportOutcome } from './core.js';

/**
 * Live video — Owncast per-second presence sidecar. `userJoined`/`userParted`
 * bracket a settlement window; the viewer pays the streamer for proven presence.
 */

export type OwncastEventType = 'USER_JOINED' | 'USER_PARTED';

export interface OwncastWebhookEvent {
  type: OwncastEventType;
  eventData: {
    user: { id: string };
    timestamp?: string;
  };
}

export interface OwncastMeterOptions {
  /** Per-second amount in micro-USDC. */
  ratePerSecond: bigint;
  /** Creator key for the streamer (one stream per Owncast instance). */
  streamerKey: string;
}

function toSeconds(timestamp: string | undefined, fallback: number): number {
  if (timestamp === undefined) return fallback;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? fallback : Math.floor(ms / 1000);
}

/**
 * Tracks join times and, on part, reports `(parted - joined) * ratePerSecond`.
 * Owncast's own 15s active-viewer prune fires `userParted`, so a dropped viewer
 * stops being billed automatically.
 */
export class OwncastPresenceMeter {
  private readonly joins = new Map<string, number>();

  constructor(
    private readonly reporter: Reporter,
    private readonly opts: OwncastMeterOptions,
  ) {}

  /** Returns the report outcome on a part with a recorded join, else null. */
  async handle(ev: OwncastWebhookEvent, now: number = Math.floor(Date.now() / 1000)): Promise<ReportOutcome | null> {
    const userId = ev.eventData.user.id;
    const ts = toSeconds(ev.eventData.timestamp, now);

    if (ev.type === 'USER_JOINED') {
      this.joins.set(userId, ts);
      return null;
    }

    // USER_PARTED
    const joinedAt = this.joins.get(userId);
    if (joinedAt === undefined) return null;
    this.joins.delete(userId);

    const seconds = Math.max(0, ts - joinedAt);
    return this.reporter.report({
      payerKey: userId,
      creatorKey: this.opts.streamerKey,
      amount: BigInt(seconds) * this.opts.ratePerSecond,
      ref: `owncast:${userId}:${joinedAt}-${ts}`,
    });
  }

  /** Number of viewers currently being metered (for liveness/metrics). */
  activeViewers(): number {
    return this.joins.size;
  }
}
