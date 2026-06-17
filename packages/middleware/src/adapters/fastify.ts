/**
 * Fastify adapter — `fastifyPaywall(opts): FastifyPluginAsync`.
 *
 * Registers a `preHandler` hook on the host Fastify instance. On 402:
 * `reply.code(402).send(body)` then `return reply` to short-circuit the
 * route handler (Fastify treats the returned reply as "response sent —
 * skip route"). On passthrough: set `X-PAYMENT-RESPONSE` via
 * `reply.header(...)` and return nothing so Fastify proceeds to the user's
 * route handler.
 *
 * The plugin is stamped with the `skip-override` symbol — the same trick
 * `fastify-plugin` uses to bubble the hook up out of its child
 * encapsulation. Without this stamp the preHandler hook would only fire on
 * routes registered inside this plugin's child scope, not on routes
 * registered directly on the parent Fastify instance — which would
 * defeat the documented "register once at the top, applies to everything"
 * usage.
 *
 * `fastify` is a peer dependency — type-only import (no runtime import).
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { paywall } from '../core.js';
import type { PaywallCoreOptions, PaywallRequest } from '../core.js';

const SKIP_OVERRIDE = Symbol.for('skip-override');

export function fastifyPaywall(opts: PaywallCoreOptions): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
      const paywallReq: PaywallRequest = {
        headers: request.headers as Record<string, string | string[] | undefined>,
        method: request.method,
        url: request.url,
      };
      const result = await paywall(paywallReq, opts);
      if (result.kind === '402') {
        for (const [name, value] of Object.entries(result.headers)) {
          reply.header(name, value);
        }
        reply.code(result.status).send(result.body);
        return reply;
      }
      reply.header('X-PAYMENT-RESPONSE', result.responseHeaders['X-PAYMENT-RESPONSE']);
      return;
    });
  };
  (plugin as unknown as Record<symbol, boolean>)[SKIP_OVERRIDE] = true;
  return plugin;
}
