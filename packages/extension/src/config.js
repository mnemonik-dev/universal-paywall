// Config + account construction for the background worker. Kept separate so the
// secrets/wallet wiring is explicit and swappable (browser wallet vs. a managed,
// cap-bounded session account). NEVER hardcode a raw private key here.

/* global chrome */

import { privateKeyToAccount } from 'viem/accounts';

const DEFAULTS = {
  rpcUrl: 'http://127.0.0.1:8545',
  chainId: 31337,
  stakeVaultFactory: '0x0000000000000000000000000000000000000000',
  usdc: '0x0000000000000000000000000000000000000000',
  allowList: [],
  // sessionPrivateKey: a cap-bounded managed session account (see buildAccount).
};

export async function loadConfig() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    const stored = await chrome.storage.local.get([...Object.keys(DEFAULTS), 'sessionPrivateKey']);
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
export async function buildAccount(cfg) {
  // Model 2: managed session account — a cap-bounded key the extension stores; the
  // on-chain grant `cap` + `validUntil` bound the spend. (Model 1, an EIP-1193
  // browser wallet, is deployment-specific SW wiring; configure that or this.)
  if (cfg && cfg.sessionPrivateKey) return privateKeyToAccount(cfg.sessionPrivateKey);
  throw new Error('configure a signer: `sessionPrivateKey` (managed session account) or an EIP-1193 provider — see README');
}
