import type { Reporter, ReportOutcome } from './core.js';

/**
 * Music — ListenBrainz-protocol sidecar (Navidrome's native scrobble target).
 *
 * Navidrome scrobbles to any ListenBrainz-compatible server set via
 * `ND_LISTENBRAINZ_BASEURL`. Pointing it at this sidecar attaches per-listen
 * royalties with **zero changes to Navidrome** — we implement just the two
 * endpoints its client uses (`validate-token`, `submit-listens`).
 *
 * Wire contract verified against navidrome `adapters/listenbrainz/client.go`:
 *  - `GET  /1/validate-token`  with `Authorization: Token <token>` → `{ valid, user_name, code }`
 *  - `POST /1/submit-listens`  with `Authorization: Token <token>` and body
 *    `{ listen_type, payload: [{ listened_at, track_metadata: { additional_info: { recording_mbid, artist_mbids } } }] }`
 *    → `{ status: 'ok' }`
 *
 * The token is the listener's payer key (`resolvePayer`); the recording MBID
 * (fallback: first artist MBID) is the creator key (`resolveCreator`).
 */

export interface ListenAdditionalInfo {
  recording_mbid?: string;
  artist_mbids?: string[];
}

export interface ListenTrackMetadata {
  artist_name?: string;
  track_name?: string;
  additional_info?: ListenAdditionalInfo;
}

export interface ListenPayloadItem {
  listened_at?: number;
  track_metadata?: ListenTrackMetadata;
}

export interface ListenSubmission {
  /** `single` | `import` are billed; `playing_now` is metered-and-skipped. */
  listen_type?: string;
  payload?: ListenPayloadItem[];
}

export interface ListenBrainzOptions {
  /** Per-listen amount in micro-USDC. */
  ratePerListen: bigint;
}

/** Parses `Authorization: Token <tok>` → the listener's token, or null. */
export function parseListenToken(authHeader: string | string[] | undefined): string | null {
  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (raw === undefined) return null;
  const m = /^Token\s+(.+)$/i.exec(raw.trim());
  return m === null ? null : (m[1]?.trim() ?? null);
}

/** Creator key for a listen: recording MBID, else the first non-empty artist MBID. */
export function listenCreatorKey(item: ListenPayloadItem): string | null {
  const info = item.track_metadata?.additional_info;
  const rec = info?.recording_mbid;
  if (typeof rec === 'string' && rec !== '') return rec;
  const artist = info?.artist_mbids?.find((a) => typeof a === 'string' && a !== '');
  return artist ?? null;
}

/**
 * Reports each billable listen in a `submit-listens` body as a per-listen charge.
 * `playing_now` submissions and an absent/unparseable token are skipped (no
 * charge). Returns one outcome per payload item for observability/testing — the
 * HTTP route returns only the ListenBrainz-shaped `{ status: 'ok' }`.
 */
export async function handleListenSubmit(
  submission: ListenSubmission,
  token: string | null,
  reporter: Reporter,
  opts: ListenBrainzOptions,
): Promise<ReportOutcome[]> {
  if (submission.listen_type === 'playing_now' || token === null) return [];
  const items = Array.isArray(submission.payload) ? submission.payload : [];
  const outcomes: ReportOutcome[] = [];
  for (const item of items) {
    const creatorKey = listenCreatorKey(item);
    if (creatorKey === null) {
      outcomes.push({ status: 'unresolved_creator' });
      continue;
    }
    outcomes.push(
      await reporter.report({
        payerKey: token,
        creatorKey,
        amount: opts.ratePerListen,
        ref: `listen:${token}:${creatorKey}:${item.listened_at ?? ''}`,
      }),
    );
  }
  return outcomes;
}
