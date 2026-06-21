import { createPolicyReader, createVaultResolver } from '@universal-paywall/facilitator';
import { createPaywallClient, type PaywallClient } from '@universal-paywall/sdk';
import { recoverMessageAddress } from 'viem';
import type { GateConfig, GateDeps } from './gate.js';
import type { StakePaywallOptions } from './options.js';

export interface GateRuntime {
  deps: GateDeps;
  cfg: GateConfig;
  client: PaywallClient;
  onChargeError: (err: unknown) => void;
}

/** Builds the chain deps, gate config, and charge client shared by every adapter. */
export function buildGateRuntime(opts: StakePaywallOptions): GateRuntime {
  const deps: GateDeps = {
    resolveVault: createVaultResolver({
      rpcUrl: opts.chain.rpcUrl,
      chainId: opts.chain.chainId,
      stakeVaultFactory: opts.chain.stakeVaultFactory,
    }),
    readPolicy: createPolicyReader({ rpcUrl: opts.chain.rpcUrl, chainId: opts.chain.chainId }),
    recoverPayer: (message, signature) => recoverMessageAddress({ message, signature }),
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

  return { deps, cfg, client, onChargeError };
}
