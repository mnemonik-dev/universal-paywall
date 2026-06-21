import type { IncomingMessage, ServerResponse } from 'node:http';
import { evaluateAccess } from './gate.js';
import { buildGateRuntime } from './runtime.js';
import type { StakePaywallOptions } from './options.js';

export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Wraps a Node http handler with the stake-rail paywall. The entire creator
 * integration: gate on an on-chain grant, return a `402` with instructions when
 * absent, serve on success, and report metered usage to the external
 * facilitator. No keys, no gas, no chain code in the creator's app.
 */
export function withStakePaywall(handler: NodeHandler, opts: StakePaywallOptions): NodeHandler {
  const { deps, cfg, client, onChargeError } = buildGateRuntime(opts);

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

export type { StakePaywallOptions } from './options.js';
