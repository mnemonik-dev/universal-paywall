import { createPaywallClient, type PaywallClient } from '@universal-paywall/sdk';

export type Hex = `0x${string}`;

/** Maps a platform-native id (userId, mediaFileId, artist MBID, author URL, …) to
 *  a wallet. This registry is the integration's moat. */
export type Resolve = (key: string) => Hex | null | undefined;

export interface ReporterConfig {
  /** Resolves the consuming user → payer wallet (who pre-staked via the agent). */
  resolvePayer: Resolve;
  /** Resolves the content/creator key → payee wallet. */
  resolveCreator: Resolve;
  /** A ready PaywallClient, or supply `facilitatorUrl` + `apiKey` to build one. */
  client?: PaywallClient;
  facilitatorUrl?: string;
  apiKey?: string;
}

export type ReportOutcome =
  | { status: 'charged'; id: string; payer: Hex; creator: Hex; amount: bigint }
  | { status: 'unresolved_payer' }
  | { status: 'unresolved_creator' }
  | { status: 'zero_amount' };

export interface ReportInput {
  payerKey: string;
  creatorKey: string;
  amount: bigint;
  ref?: string;
}

export interface Reporter {
  /** Resolves payer + creator and reports a metered charge to the facilitator. */
  report(input: ReportInput): Promise<ReportOutcome>;
}

/**
 * The shared primitive every sidecar uses: resolve the two wallets and report a
 * charge. Returns a structured outcome rather than throwing on unresolved keys,
 * so a sidecar can meter-and-skip unknown users/content cleanly.
 */
export function createReporter(cfg: ReporterConfig): Reporter {
  let client = cfg.client;
  if (client === undefined) {
    if (cfg.facilitatorUrl === undefined || cfg.apiKey === undefined) {
      throw new Error('createReporter requires `client` or `facilitatorUrl` + `apiKey`');
    }
    client = createPaywallClient({ facilitatorUrl: cfg.facilitatorUrl, apiKey: cfg.apiKey });
  }
  const charge = client;

  return {
    async report({ payerKey, creatorKey, amount, ref }: ReportInput): Promise<ReportOutcome> {
      if (amount <= 0n) return { status: 'zero_amount' };
      const payer = cfg.resolvePayer(payerKey);
      if (payer === null || payer === undefined) return { status: 'unresolved_payer' };
      const creator = cfg.resolveCreator(creatorKey);
      if (creator === null || creator === undefined) return { status: 'unresolved_creator' };
      const ack = await charge.charge({ payer, creator, amount, ...(ref !== undefined ? { ref } : {}) });
      return { status: 'charged', id: ack.id, payer, creator, amount };
    },
  };
}

/** Convenience: build a `Resolve` from a static map (case-insensitive keys). */
export function mapResolver(entries: Record<string, Hex>): Resolve {
  const lower = new Map<string, Hex>();
  for (const [k, v] of Object.entries(entries)) lower.set(k.toLowerCase(), v);
  return (key: string) => lower.get(key.toLowerCase()) ?? null;
}
