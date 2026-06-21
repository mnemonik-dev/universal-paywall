import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Hex } from '@universal-paywall/facilitator';
import { evaluateAccess } from './gate.js';
import { buildGateRuntime } from './runtime.js';
import type { StakePaywallOptions } from './options.js';

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Fastify plugin form of the stake-rail paywall. Register it on a scoped
 * instance covering the paid routes:
 *
 *   fastify.register(fastifyStakePaywall(opts));
 *
 * A `preHandler` gates each request (402 with grant instructions when there is
 * no active grant); an `onResponse` reports metered usage after a successful
 * response.
 */
export function fastifyStakePaywall(opts: StakePaywallOptions): (fastify: FastifyInstance) => Promise<void> {
  const { deps, cfg, client, onChargeError } = buildGateRuntime(opts);
  const allowed = new WeakMap<FastifyRequest, Hex>();

  const plugin = async function plugin(fastify: FastifyInstance): Promise<void> {
    fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
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
        await reply.code(decision.status).send(decision.body);
        return;
      }
      allowed.set(req, decision.payer);
    });

    fastify.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
      const payer = allowed.get(req);
      if (payer !== undefined && reply.statusCode < 400) {
        try {
          await client.charge({
            payer,
            creator: opts.creator,
            amount: opts.price,
            ref: `${payer}:${Date.now()}`,
          });
        } catch (err) {
          onChargeError(err);
        }
      }
    });
  };

  // Apply hooks to the enclosing scope's routes rather than an encapsulated
  // child context (Fastify's default), so a parent route is gated.
  (plugin as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;
  return plugin;
}
