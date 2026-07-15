// Typed client other extensions / pages use to request paid fetches from the
// installed Universal Paywall extension. `send` is injected (chrome.runtime
// .sendMessage for in-extension, chrome.runtime.sendMessage(extId, …) for
// external, or window.postMessage relay for pages) so it is testable.

import { status, ensureGrant, fetchPaid } from './messages.js';

export function createBridge(send) {
  async function call(message) {
    const res = await send(message);
    if (!res || res.ok !== true) {
      throw new Error((res && res.error) || 'up_bridge_error');
    }
    return res;
  }
  return {
    /** Vault + payer status. */
    status: () => call(status()),
    /** Establish/refresh the facilitator grant. */
    ensureGrant: (req) => call(ensureGrant(req)),
    /**
     * Paid fetch: auto-pays an x402 paywall and returns a Response-like object.
     */
    async upFetch(url, init) {
      const res = await call(fetchPaid(url, init));
      return new Response(res.body, { status: res.status, headers: res.headers });
    },
  };
}
