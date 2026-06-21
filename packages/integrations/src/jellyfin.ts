import type { Reporter, ReportOutcome } from './core.js';

/**
 * VOD — Jellyfin per-minute sidecar. Subscribes to the official Jellyfin Webhook
 * plugin's playback notifications and bills per minute watched on stop.
 */

const TICKS_PER_MINUTE = 600_000_000n; // 10,000,000 ticks/sec * 60

export interface JellyfinWebhookEvent {
  NotificationType: string; // 'PlaybackProgress' | 'PlaybackStop' | ...
  UserId: string;
  ItemId: string;
  /** Playback position in Jellyfin ticks (10,000,000 ticks per second). */
  PlaybackPositionTicks?: number;
}

export interface JellyfinMeterOptions {
  /** Per-minute amount in micro-USDC. */
  ratePerMinute: bigint;
}

/**
 * Bills on `PlaybackStop` from the final position (whole minutes watched).
 * Progress events are ignored for billing (they can drive liveness elsewhere).
 */
export async function handleJellyfinEvent(
  ev: JellyfinWebhookEvent,
  reporter: Reporter,
  opts: JellyfinMeterOptions,
): Promise<ReportOutcome | null> {
  if (ev.NotificationType !== 'PlaybackStop') return null;
  const ticks = BigInt(Math.max(0, Math.floor(ev.PlaybackPositionTicks ?? 0)));
  const minutes = ticks / TICKS_PER_MINUTE;
  if (minutes === 0n) return { status: 'zero_amount' };
  return reporter.report({
    payerKey: ev.UserId,
    creatorKey: ev.ItemId,
    amount: minutes * opts.ratePerMinute,
    ref: `jellyfin:${ev.UserId}:${ev.ItemId}:${ticks}`,
  });
}
