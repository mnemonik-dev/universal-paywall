import { createFacilitator } from './index.js';
import type { FacilitatorConfig, Hex } from './types.js';

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`missing env: ${name}`);
  return value;
}

function main(): void {
  const config: FacilitatorConfig = {
    rpcUrl: env('ARC_RPC_URL'),
    chainId: Number(env('CHAIN_ID')),
    facilitatorKey: env('FACILITATOR_KEY') as Hex,
    stakeVaultFactory: env('STAKE_VAULT_FACTORY') as Hex,
    apiKeys: env('FACILITATOR_API_KEYS')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    batch: {
      maxCharges: Number(process.env.BATCH_MAX_CHARGES ?? '50'),
      maxAgeMs: Number(process.env.BATCH_MAX_AGE_MS ?? '15000'),
    },
  };

  const { service, server } = createFacilitator(config);
  service.start();

  const port = Number(process.env.PORT ?? '8402');
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`up-facilitator listening on :${port}`);
  });
}

main();
