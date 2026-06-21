import type { Reporter, ReportOutcome } from './core.js';

/**
 * Music — Subsonic-protocol scrobble sidecar (Navidrome, gonic, ampache, …).
 * Per-listen user-centric royalty: each scrobble pays the track's payee from the
 * listener's stake. Coded against the wire protocol, not one server.
 */

export interface ScrobbleEvent {
  /** Subsonic username / user id (resolves to the listener's payer wallet). */
  userId: string;
  /** Track id (resolves to the artist payee; the registry maps id → MBID → wallet). */
  mediaFileId: string;
  /** Submission time (unix seconds); used for the idempotency ref. */
  timestamp?: number;
}

export interface ScrobbleOptions {
  /** Per-play amount in micro-USDC. */
  ratePerPlay: bigint;
}

/** Reports one scrobble as a per-listen charge. */
export function handleScrobble(ev: ScrobbleEvent, reporter: Reporter, opts: ScrobbleOptions): Promise<ReportOutcome> {
  return reporter.report({
    payerKey: ev.userId,
    creatorKey: ev.mediaFileId,
    amount: opts.ratePerPlay,
    ref: `scrobble:${ev.userId}:${ev.mediaFileId}:${ev.timestamp ?? ''}`,
  });
}

/** Parses a Subsonic `scrobble.view` query (`u`, `id`, `time`) into an event. */
export function parseSubsonicScrobble(query: URLSearchParams): ScrobbleEvent | null {
  const userId = query.get('u');
  const mediaFileId = query.get('id');
  if (userId === null || mediaFileId === null) return null;
  const timeRaw = query.get('time');
  const ev: ScrobbleEvent = { userId, mediaFileId };
  if (timeRaw !== null && /^[0-9]+$/.test(timeRaw)) {
    // Subsonic `time` is epoch milliseconds.
    ev.timestamp = Math.floor(Number(timeRaw) / 1000);
  }
  return ev;
}
