/**
 * Node http adapter — `withPaywall(handler, opts)`.
 *
 * Wraps a user request handler with the paywall pipeline (per D6). On the
 * 402 branch the adapter writes status + headers + JSON body. On the
 * passthrough branch it sets `X-PAYMENT-RESPONSE` on the response BEFORE
 * invoking the user handler so the header flushes alongside the user's
 * 200 response. Exceptions from the user handler propagate unchanged.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { paywall } from '../core.js';
import type { PaywallCoreOptions, PaywallRequest } from '../core.js';

export type NodeHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

export function withPaywall(
  handler: NodeHttpHandler,
  opts: PaywallCoreOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const paywallReq: PaywallRequest = {
      headers: req.headers as Record<string, string | string[] | undefined>,
    };
    if (req.method !== undefined) paywallReq.method = req.method;
    if (req.url !== undefined) paywallReq.url = req.url;
    const result = await paywall(paywallReq, opts);
    if (result.kind === '402') {
      res.writeHead(result.status, {
        'Content-Type': 'application/json',
        ...result.headers,
      });
      res.end(JSON.stringify(result.body));
      return;
    }
    // Set X-PAYMENT-RESPONSE BEFORE invoking the user handler so the
    // response header is observable at the moment the user handler
    // writes its 200 body.
    for (const [name, value] of Object.entries(result.responseHeaders)) {
      res.setHeader(name, value);
    }
    await handler(req, res);
  };
}
