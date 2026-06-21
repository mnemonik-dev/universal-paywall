// Core message handler for the Universal Paywall browser-extension adaptor.
//
// Pure routing over a PayerAgent (`@universal-paywall/agent`), independent of the
// WebExtension runtime so it can be unit-tested. background.js wires this to
// chrome.runtime.onMessage / onMessageExternal; content.js relays page messages.
//
// Messages (see messages.js):
//   { type: 'up:status' }                 -> { ok, payer, vault }
//   { type: 'up:ensureGrant', req }       -> { ok }
//   { type: 'up:fetch', url, init }       -> { ok, status, body, headers }
//
// Security: external senders (other extensions / pages) are checked against an
// origin/id allowlist; a per-call spend cap can gate fetches before they pay.

export function createMessageHandler({ agent, allowList, isAllowed }) {
  const allowed = (sender) => {
    if (typeof isAllowed === 'function') return isAllowed(sender);
    if (!sender) return true; // internal (own background) messages
    const who = sender.id || sender.origin || sender.url;
    if (!allowList || allowList.length === 0) return who === undefined; // default: internal only
    return who !== undefined && allowList.includes(who);
  };

  return async function handle(msg, sender) {
    if (sender && sender.external && !allowed(sender)) {
      return { ok: false, error: 'origin_not_allowed' };
    }
    if (!msg || typeof msg.type !== 'string') {
      return { ok: false, error: 'bad_message' };
    }
    try {
      switch (msg.type) {
        case 'up:status': {
          const vault = await agent.vaultAddress();
          return { ok: true, payer: agent.payer, vault };
        }
        case 'up:ensureGrant': {
          if (!msg.req) return { ok: false, error: 'missing_req' };
          await agent.ensureGrant(msg.req);
          return { ok: true };
        }
        case 'up:fetch': {
          if (typeof msg.url !== 'string') return { ok: false, error: 'missing_url' };
          const res = await agent.fetchWithPaywall(msg.url, msg.init);
          const body = await res.text();
          const headers = {};
          if (res.headers && typeof res.headers.forEach === 'function') {
            res.headers.forEach((v, k) => {
              headers[k] = v;
            });
          }
          return { ok: true, status: res.status, body, headers };
        }
        default:
          return { ok: false, error: 'unknown_type' };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'error' };
    }
  };
}
