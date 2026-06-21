import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPolicyReader, createVaultResolver, type Hex } from '@universal-paywall/facilitator';
import { createPaywallClient } from '@universal-paywall/sdk';
import { recoverMessageAddress } from 'viem';
import { evaluateAccess, type GateConfig } from './gate.js';

export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface StakePaywallOptions {
  /** Price charged per successful request, micro-USDC. */
  price: bigint;
  /** This creator's payout address. */
  creator: Hex;
  /** Chain endpoint + rail addresses. */
  chain: {
    rpcUrl: string;
    chainId: number;
    network: string;
    asset: Hex;
    facilitatorAddress: Hex;
    stakeVaultFactory: Hex;
  };
  /** Where to report usage. */
  facilitator: { url: string; apiKey: string };
  minRemaining?: bigint;
  recommendedCap?: bigint;
  signatureWindowSeconds?: number;
  resource?: string;
  description?: string;
  /** Called when post-serve usage reporting fails (default: console.error). */
  onChargeError?: (err: unknown) => void;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Wraps a Node http handler with the stake-rail paywall. The entire creator
 * integration: gate on an on-chain grant, return a `402` with instructions when
 * absent, and report metered usage to the external facilitator after a
 * successful response. No keys, no gas, no chain code in the creator's app.
 */
export function withStakePaywall(handler: NodeHandler, opts: StakePaywallOptions): NodeHandler {
  const deps = {
    resolveVault: createVaultResolver({
      rpcUrl: opts.chain.rpcUrl,
      chainId: opts.chain.chainId,
      stakeVaultFactory: opts.chain.stakeVaultFactory,
    }),
    readPolicy: createPolicyReader({ rpcUrl: opts.chain.rpcUrl, chainId: opts.chain.chainId }),
    recoverPayer: (message: string, signature: Hex): Promise<Hex> =>
      recoverMessageAddress({ message, signature }),
  };

  const cfg: GateConfig = {
    network: opts.chain.network,
    asset: opts.chain.asset,
    facilitatorAddress: opts.chain.facilitatorAddress,
    stakeVaultFactory: opts.chain.stakeVaultFactory,
    price: opts.price,
    ...(opts.minRemaining !== undefined ? { minRemaining: opts.minRemaining } : {}),
    ...(opts.recommendedCap !== undefined ? { recommendedCap: opts.recommendedCap } : {}),
    ...(opts.signatureWindowSeconds !== undefined
      ? { signatureWindowSeconds: opts.signatureWindowSeconds }
      : {}),
    ...(opts.resource !== undefined ? { resource: opts.resource } : {}),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
  };

  const client = createPaywallClient({ facilitatorUrl: opts.facilitator.url, apiKey: opts.facilitator.apiKey });
  const onChargeError = opts.onChargeError ?? ((err: unknown) => console.error('charge_report_failed', err));

  return async (req, res) => {
    const decision = await evaluateAccess(
      {
        payer: headerValue(req, 'x-payer'),
        timestamp: headerValue(req, 'x-payer-timestamp'),
        signature: headerValue(req, 'x-payer-signature'),
      },
      deps,
      cfg,
    );

    if (!decision.allow) {
      res.writeHead(decision.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(decision.body));
      return;
    }

    await handler(req, res);

    // Charge only successful responses; usage is reported out-of-band.
    if ((res.statusCode || 200) < 400) {
      try {
        await client.charge({
          payer: decision.payer,
          creator: opts.creator,
          amount: opts.price,
          ref: `${decision.payer}:${Date.now()}`,
        });
      } catch (err) {
        onChargeError(err);
      }
    }
  };
}
