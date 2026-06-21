import type { Reporter, ReportOutcome } from './core.js';

/**
 * Photo — Immich shared-link license wrapper. Each external resolve of a shared
 * link pays a fractional license fee to the photographer. Per the article, the
 * payee is the EXIF `Artist`, falling back to the Immich `ownerId` when EXIF is
 * absent. Coexists with Immich's own supporter "license" program (different
 * value chain: photographer-paid, not project-supporter).
 */

export interface SharedLinkResolveEvent {
  /** The downloader/agent resolving the link (resolves to the payer wallet). */
  resolverId: string;
  /** Asset id (used for the idempotency ref). */
  assetId: string;
  /** EXIF `Artist` — preferred payee key (the photographer). */
  exifArtist?: string;
  /** Immich `ownerId` — fallback payee when EXIF `Artist` is missing. */
  ownerId: string;
}

export interface SharedLinkOptions {
  /** Per-resolve license fee in micro-USDC. */
  licenseFee: bigint;
}

/** Reports one shared-link resolve as a license fee to the photographer. */
export function handleSharedLinkResolve(
  ev: SharedLinkResolveEvent,
  reporter: Reporter,
  opts: SharedLinkOptions,
): Promise<ReportOutcome> {
  const creatorKey = ev.exifArtist !== undefined && ev.exifArtist.length > 0 ? ev.exifArtist : ev.ownerId;
  return reporter.report({
    payerKey: ev.resolverId,
    creatorKey,
    amount: opts.licenseFee,
    ref: `immich:${ev.resolverId}:${ev.assetId}`,
  });
}
