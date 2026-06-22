// MV3 background service worker: hosts the PayerAgent and routes messages through
// the (tested) core handler. Registers both in-extension (onMessage) and external
// (onMessageExternal) channels so other extensions can request paid fetches.
//
// Wallet model: build the agent with an injected viem `account` (+ optional
// `walletTransport` for an EIP-1193 wallet) — never a raw key embedded in code.
// Config (facilitator/factory/usdc/chain, allowList, caps) lives in chrome.storage.

import { createPayerAgent } from '@universal-paywall/agent';
import { createMessageHandler } from './handler.js';
import { loadConfig, buildAccount } from './config.js';

let handlerPromise = null;

async function getHandler() {
  if (handlerPromise) return handlerPromise;
  handlerPromise = (async () => {
    const cfg = await loadConfig();
    const account = await buildAccount(cfg); // browser wallet / session account — not a raw key in code
    const agent = createPayerAgent({
      rpcUrl: cfg.rpcUrl,
      chainId: cfg.chainId,
      account,
      ...(cfg.walletTransport ? { walletTransport: cfg.walletTransport } : {}),
      stakeVaultFactory: cfg.stakeVaultFactory,
      usdc: cfg.usdc,
    });
    return createMessageHandler({ agent, allowList: cfg.allowList || [] });
  })();
  return handlerPromise;
}

function wire(channel, external) {
  if (!channel) return;
  channel.addListener((msg, sender, sendResponse) => {
    getHandler()
      .then((handle) => handle(msg, { external, id: sender && sender.id, origin: sender && sender.origin, url: sender && sender.url }))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : 'error' }));
    return true; // async sendResponse
  });
}

// Test hook: lets an E2E invoke the REAL handler inside the loaded service worker
// (content scripts run in an isolated world; this exercises the in-browser agent).
// Unused in production.
globalThis.__upHandle = (msg, sender) => getHandler().then((h) => h(msg, sender));

// chrome is provided by the WebExtension runtime.
/* global chrome */
if (typeof chrome !== 'undefined' && chrome.runtime) {
  wire(chrome.runtime.onMessage, false);
  wire(chrome.runtime.onMessageExternal, true);
  // Rebuild the handler if config changes.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(() => {
      handlerPromise = null;
    });
  }
}
