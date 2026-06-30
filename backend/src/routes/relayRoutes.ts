import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { SEEDER_NOISE_SEED, SEEDER_REGION } from '../config/main-config.ts';
import { seederSupervisor } from '../lib/pears/seeder.ts';

/**
 * GET /relay/info
 *
 * Returns the Companion seeder's real Hyperswarm Noise public key so peers
 * behind symmetric NAT can construct their Hyperswarm with
 * `relayThrough: <pubkey>` and hole-punch via us. See:
 *   - https://github.com/holepunchto/hyperswarm  (constructor `{ keyPair }`,
 *     PeerInfo, connection-relay)
 *   - pear-app/workers/main.js (renderer side that consumes `relayThrough`)
 *
 * Final Fix Wave T1: previous implementation returned
 *   `pubkey = sha256(SEEDER_NOISE_SEED)`
 * which is NOT a Hyperswarm Noise pubkey. `CURVA_FORCE_RELAY=1` on demo day
 * would silently no-op because the DHT could not resolve the fake key.
 * We now read the pubkey the seeder subprocess emits over stdout.
 *
 * States:
 *   - seeder disabled                -> 200 with `note: 'seeder disabled ...'`
 *   - seeder enabled but not ready   -> 503 + Retry-After: 5
 *   - seeder ready                   -> 200 with real Noise pubkey
 */
export const relayRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.get('/info', async (_request: FastifyRequest, reply: FastifyReply) => {
    // swarmKey is unused for hot-swap purposes today; kept as a per-tournament
    // scoping placeholder. Derivation is stable across restarts so client
    // caches stay warm.
    const seedBytes = Buffer.from(SEEDER_NOISE_SEED || '', 'hex');
    const swarmKey = createHash('sha256')
      .update(Buffer.concat([seedBytes, Buffer.from('curva-swarm')]))
      .digest('hex');

    if (!seederSupervisor.isEnabled()) {
      // Advisory fallback so clients on the direct-connect path still receive
      // a well-shaped response.
      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          pubkey: null,
          swarmKey,
          regions: [SEEDER_REGION],
          note: 'seeder disabled, direct-connect only',
        },
      });
    }

    const pubkey = seederSupervisor.getNoisePubkey();
    if (!pubkey) {
      reply.header('Retry-After', '5');
      return reply.code(503).send({
        success: false,
        error: {
          code: 'SEEDER_NOT_READY',
          message: 'Seeder is starting; retry shortly',
        },
        data: null,
      });
    }

    return reply.code(200).send({
      success: true,
      error: null,
      data: {
        pubkey,
        swarmKey,
        regions: [SEEDER_REGION],
      },
    });
  });

  done();
};
