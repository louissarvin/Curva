/**
 * Fix Wave B / T3 — GET /wdk/token-domain
 *
 *   GET /wdk/token-domain?chainId=<n>&token=<0x...>
 *   -> 200 { name, version, chainId, tokenAddress, fetchedAt }
 *   -> 400 unknown/disabled chain, malformed token address
 *   -> 404 contract has no name() / not deployed
 *   -> 503 RPC failure (client should retry)
 *
 * Purpose: expose the on-chain EIP-712 domain (name/version) so the Pear-app
 * client builds the EIP-3009 digest against the SAME domain the F11 facilitator
 * recovers against. Previously bare/wallet/eip3009.js hardcoded USDT/1; if the
 * contract's `name()` returned "Tether USD" or `EIP712_VERSION()` returned "2",
 * ecrecover on the facilitator side would fail silently and every tip would
 * error with SIGNATURE_INVALID.
 *
 * Implementation: delegates to the already-tested `fetchEip3009Domain` in
 * src/lib/evm/eip3009.ts, which owns the probe order (EIP712_VERSION -> version
 * -> '1'), the in-process cache, and negative caching for failed probes.
 *
 * Security posture (per OWASP REST Security Cheat Sheet):
 *   - Input validation before touching any RPC (allowlist chainId, regex for token).
 *   - Rate limit: 60/min/IP via @fastify/rate-limit.
 *   - Generic error messages; internal errors go through handleServerError which
 *     already redacts stack traces per the errorHandler contract.
 *   - No RPC URL / provider details leaked in responses.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { fetchEip3009Domain } from '../lib/evm/eip3009.ts';
import { getChain } from '../lib/evm/chains.ts';
import { handleError, handleServerError } from '../utils/errorHandler.ts';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

interface QueryShape {
  chainId?: string;
  token?: string;
}

export const tokenDomainRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get(
    '/token-domain',
    {
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (
      request: FastifyRequest<{ Querystring: QueryShape }>,
      reply: FastifyReply
    ) => {
      try {
        const rawChainId = request.query.chainId;
        const rawToken = request.query.token;

        if (typeof rawChainId !== 'string' || rawChainId.length === 0) {
          return handleError(
            reply,
            400,
            'chainId query param is required',
            'VALIDATION_ERROR'
          );
        }
        const chainId = Number(rawChainId);
        if (!Number.isInteger(chainId) || chainId <= 0 || chainId > Number.MAX_SAFE_INTEGER) {
          return handleError(
            reply,
            400,
            'chainId must be a positive integer',
            'VALIDATION_ERROR'
          );
        }

        if (typeof rawToken !== 'string' || !ADDR_RE.test(rawToken)) {
          return handleError(
            reply,
            400,
            'token must be a 0x-prefixed 20-byte address',
            'VALIDATION_ERROR'
          );
        }
        const tokenAddress = rawToken.toLowerCase();

        // Reject unknown / disabled chains up-front: fetchEip3009Domain returns
        // null for both cases, but the correct status codes are different.
        // Unknown chain = 400 (client sent nonsense). Disabled chain = 400 too
        // (nothing to serve; not an internal failure).
        const chain = getChain(chainId);
        if (!chain) {
          return handleError(
            reply,
            400,
            `Unknown chainId ${chainId}`,
            'UNKNOWN_CHAIN'
          );
        }
        if (!chain.enabled) {
          return handleError(
            reply,
            400,
            `chainId ${chainId} is not enabled`,
            'CHAIN_DISABLED'
          );
        }

        let domain;
        try {
          domain = await fetchEip3009Domain(chainId, tokenAddress);
        } catch (err) {
          // Any thrown error from the probe path is treated as an upstream RPC
          // failure. The client can retry after the Retry-After hint.
          reply.header('Retry-After', '30');
          return handleError(
            reply,
            503,
            'Upstream RPC failed while probing token domain',
            'RPC_UNAVAILABLE',
            err as Error,
            { chainId, tokenAddress }
          );
        }

        if (!domain) {
          // Probe returned null: either the contract has no name() view or the
          // provider chain is completely down. We cannot distinguish here
          // without leaking RPC internals, so return 404 with the token echo
          // so the client sees what it asked for. A separate 503 path is used
          // when the probe throws (see catch above).
          return handleError(
            reply,
            404,
            'Token contract does not expose an EIP-712 domain',
            'TOKEN_DOMAIN_UNAVAILABLE'
          );
        }

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            chainId: domain.chainId,
            tokenAddress: domain.verifyingContract,
            name: domain.name,
            version: domain.version,
            fetchedAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};
