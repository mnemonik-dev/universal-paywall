// Config + account construction for the background worker. Kept separate so the
// secrets/wallet wiring is explicit and swappable (browser wallet vs. a managed,
// cap-bounded session account). NEVER hardcode a raw private key here.

/* global chrome */

const DEFAULTS = {
  rpcUrl: 'http://127.0.0.1:8545',
  chainId: 31337,
  stakeVaultFactory: '0x0000000000000000000000000000000000000000',
  usdc: '0x0000000000000000000000000000000000000000',
  allowList: [],
};

export async function loadConfig() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
    return { ...DEFAULTS, ...stored };
  }
  return { ...DEFAULTS };
}

/**
 * Returns a viem `Account` for the agent. Two supported models:
 *   1. Browser wallet (preferred): pass an EIP-1193 provider and derive a
 *      JsonRpcAccount + custom transport (writes are wallet-approved).
 *   2. Managed session account: a cap-bounded key the extension generates and
 *      stores (the on-chain grant bounds spend); still never shipped in code.
 *
 * The concrete wiring is deployment-specific; this throws until configured so the
 * extension can't silently run without a signer.
 */
export async function buildAccount(_cfg) {
  throw new Error(
    'configure a signer: an EIP-1193 browser-wallet account (preferred) or a managed cap-bounded session account — see README',
  );
}
