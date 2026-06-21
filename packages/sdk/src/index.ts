export type Hex = `0x${string}`;

export interface PaywallClientConfig {
  /** Base URL of the external facilitator (no trailing slash required). */
  facilitatorUrl: string;
  /** API key the facilitator accepts for this creator. */
  apiKey: string;
  /** Injectable fetch (defaults to global `fetch`); handy for tests. */
  fetchImpl?: typeof fetch;
}

export interface ChargeInput {
  /** Payer EOA whose staked vault funds the charge. */
  payer: Hex;
  /** Creator/payee address that receives the USDC. */
  creator: Hex;
  /** Amount in micro-USDC (6 decimals). */
  amount: bigint;
  /** Optional idempotency / audit reference. */
  ref?: string;
}

export interface ChargeAck {
  id: string;
}

export interface PaywallClient {
  /** Reports one metered usage event to the facilitator. Non-blocking settlement. */
  charge(input: ChargeInput): Promise<ChargeAck>;
}

/**
 * The entire creator/platform integration: construct once, call `charge()` per
 * billable event (per-listen, per-second, per-resolve). No keys, no gas, no
 * chain code — the external facilitator batches and settles.
 */
export function createPaywallClient(config: PaywallClientConfig): PaywallClient {
  const doFetch = config.fetchImpl ?? fetch;
  const base = config.facilitatorUrl.replace(/\/+$/, '');

  return {
    async charge(input: ChargeInput): Promise<ChargeAck> {
      if (input.amount <= 0n) throw new Error('amount_must_be_positive');

      const res = await doFetch(`${base}/charge`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
        },
        body: JSON.stringify({
          payer: input.payer,
          creator: input.creator,
          amount: input.amount.toString(),
          ...(input.ref !== undefined ? { ref: input.ref } : {}),
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`charge_failed: ${res.status} ${detail}`.trim());
      }

      return (await res.json()) as ChargeAck;
    },
  };
}
