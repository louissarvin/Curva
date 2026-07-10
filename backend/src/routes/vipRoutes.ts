/**
 * Semifinal Wave - x402 VIP room slug reservation routes.
 *
 * Docs-verification memo
 * ----------------------
 * Docs surface (WebFetched / consulted 2026-07-10):
 *   - https://x402.org (canonical spec v1: 402 body { x402Version, accepts:[...] }
 *     + X-Payment request header + X-Payment-Response confirmation header)
 *   - https://docs.wdk.tether.io/ai/x402/ (WDK-native x402 flow, confirms
 *     EIP-3009 exact scheme + facilitator settle path Curva already ships)
 *   - https://eips.ethereum.org/EIPS/eip-3009 (TransferWithAuthorization
 *     struct shared with the F11 facilitator)
 *   - OWASP API Security Top 10 (2023) API1 (Broken Object Level Auth) +
 *     API4 (Unrestricted Resource Consumption): the reservation surface is
 *     public but rate-limited and gated behind a real settled payment.
 *
 * Endpoints
 *   POST /vip/reserve
 *     - No X-Payment header             -> 402 with x402 challenge body
 *                                          (resource: 'vip-reservation',
 *                                           extras.slug carries the normalized
 *                                           slug so the client re-uses it on retry)
 *     - Valid X-Payment header + slug   -> settle via facilitator, insert row,
 *                                          200 + { reservation }
 *     - Reused nonce                    -> 409 NONCE_USED
 *     - Slug already reserved           -> 409 SLUG_ALREADY_RESERVED
 *     - Malformed X-Payment             -> 400 BAD_PAYMENT_HEADER
 *     - Bad slug shape                  -> 400 BAD_SLUG
 *     - Facilitator/x402 disabled       -> 503 FEATURE_DISABLED
 *
 *   GET /vip/status/:slug
 *     - 200 { reserved, ownerAddress?, reservedAt?, txHash?, explorerUrl? }
 *     - No auth required (public "is this slug taken?" query).
 *     - Rate-limited per IP.
 *
 * Slug prefix strategy: the client sends the bare slug (no `vip-`). The API
 * normalizes + validates against ^[a-z0-9-]{3,32}$ and stores WITHOUT the
 * prefix. The prefixed form ("vip-<slug>") is only surfaced in the challenge
 * body's optional extras so a paywall-aware client can render "Reserve vip-<x>"
 * without knowing the prefix rule.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { handleError, handleServerError } from '../utils/errorHandler.ts';
import {
  buildX402Challenge,
  parseX402PaymentHeader,
  verifyX402Payment,
  settleX402Payment,
} from '../lib/evm/x402.ts';
import { isFacilitatorEnabled, getSponsorAddress } from '../lib/evm/facilitator.ts';
import { getChain } from '../lib/evm/chains.ts';
import {
  createReservation,
  getReservation,
  isValidVipSlug,
  normalizeVipSlug,
  SlugTakenError,
  TxHashTakenError,
  type VipReservationRow,
} from '../lib/vip/store.ts';
import {
  CURVA_X402_CHAIN_ID,
  CURVA_X402_TOKEN_ADDRESS,
  CURVA_X402_CHALLENGE_TTL_SECONDS,
  CURVA_X402_PAY_TO,
  ENABLE_VIP_RESERVATIONS,
  VIP_RESERVATION_AMOUNT_ATOMIC,
  VIP_RATE_LIMIT_MAX,
  VIP_RATE_LIMIT_WINDOW,
  VIP_STATUS_RATE_LIMIT_MAX,
  VIP_STATUS_RATE_LIMIT_WINDOW,
} from '../config/main-config.ts';

const VIP_RESOURCE = 'vip-reservation';

interface ReserveBody {
  slug?: unknown;
}

// Resolved per-request so SPONSOR_ADDRESS being set post-module-init still works.
const resolvePayTo = (): string | null => {
  if (CURVA_X402_PAY_TO && /^0x[0-9a-f]{40}$/i.test(CURVA_X402_PAY_TO)) {
    return CURVA_X402_PAY_TO.toLowerCase();
  }
  const sponsor = getSponsorAddress();
  return sponsor ? sponsor.toLowerCase() : null;
};

const sendFeatureDisabled = (reply: FastifyReply): FastifyReply => {
  return reply.code(503).send({
    success: false,
    error: {
      code: 'FEATURE_DISABLED',
      message:
        'The VIP reservation feature is not enabled on this deployment.',
    },
    data: {
      enabled: false,
      requiredEnv: [
        'ENABLE_VIP_RESERVATIONS=true',
        'RELAY_SPONSOR_ENABLED=true',
        'RELAY_SPONSOR_PK',
      ],
    },
  });
};

const buildExplorerUrl = (chainId: number, txHash: string): string | null => {
  const chain = getChain(chainId);
  if (!chain || !chain.explorerBase || chain.explorerBase.length === 0) return null;
  return `${chain.explorerBase.replace(/\/$/, '')}/tx/${txHash}`;
};

const serializeReservation = (
  row: VipReservationRow
): {
  slug: string;
  vipSlug: string;
  ownerAddress: string;
  reservedAt: string;
  txHash: string;
  explorerUrl: string | null;
} => ({
  slug: row.slug,
  vipSlug: `vip-${row.slug}`,
  ownerAddress: row.ownerAddress,
  reservedAt: row.reservedAt.toISOString(),
  txHash: row.txHash,
  explorerUrl: buildExplorerUrl(CURVA_X402_CHAIN_ID, row.txHash),
});

export const vipRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // ---------------------------------------------------------------------------
  // POST /vip/reserve
  // ---------------------------------------------------------------------------
  app.post(
    '/reserve',
    {
      config: {
        rateLimit: {
          max: VIP_RATE_LIMIT_MAX,
          timeWindow: VIP_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!ENABLE_VIP_RESERVATIONS || !isFacilitatorEnabled()) {
          return sendFeatureDisabled(reply);
        }

        const payTo = resolvePayTo();
        if (!payTo) {
          return handleError(
            reply,
            503,
            'VIP reservation recipient not configured',
            'FEATURE_DISABLED'
          );
        }

        // Slug is required in the body regardless of the X-Payment header
        // presence so the challenge itself is scoped to the desired slug (a
        // client cannot pay for one slug and redeem the response against
        // another).
        const body = (request.body ?? {}) as ReserveBody;
        const rawSlug = typeof body.slug === 'string' ? body.slug : '';
        const normalizedSlug = normalizeVipSlug(rawSlug);
        if (!isValidVipSlug(normalizedSlug)) {
          return handleError(
            reply,
            400,
            'slug must match ^[a-z0-9-]{3,32}$ (send the bare slug, without the vip- prefix)',
            'BAD_SLUG'
          );
        }

        // Fast-fail: if the slug is already reserved, do not even issue a
        // challenge. A peer paying for a taken slug would waste gas.
        const existing = await getReservation(normalizedSlug);
        if (existing) {
          return reply.code(409).send({
            success: false,
            error: {
              code: 'SLUG_ALREADY_RESERVED',
              message: `vip-${normalizedSlug} is already reserved`,
            },
            data: {
              reservation: serializeReservation(existing),
            },
          });
        }

        // Grab X-Payment header (case-insensitive).
        const rawHeader =
          request.headers['x-payment'] ??
          request.headers['x-payment-header'] ??
          request.headers['X-Payment'.toLowerCase()];

        // Path 1: no payment -> fresh challenge scoped to the slug.
        if (!rawHeader) {
          const challenge = buildX402Challenge({
            chainId: CURVA_X402_CHAIN_ID,
            tokenAddress: CURVA_X402_TOKEN_ADDRESS,
            payTo,
            maxAmountRequired: VIP_RESERVATION_AMOUNT_ATOMIC,
            resource: VIP_RESOURCE,
            validForSeconds: CURVA_X402_CHALLENGE_TTL_SECONDS,
            description: `Reserve VIP room slug vip-${normalizedSlug}`,
          });
          // Extra hint field: the desired slug. Non-normative per the x402
          // spec (the spec allows extras), lets a paywall-aware client
          // render the slug label next to the price.
          const accept = challenge.accepts[0] as
            | (typeof challenge.accepts)[number]
            | undefined;
          if (accept) {
            (accept as unknown as { extra?: Record<string, unknown> }).extra = {
              slug: normalizedSlug,
              vipSlug: `vip-${normalizedSlug}`,
            };
            reply.header('X-Payment-Required', JSON.stringify(accept));
          }
          reply.header('Cache-Control', 'no-store');
          return reply.code(402).send(challenge);
        }

        // Path 2: payment submitted.
        const parsed = parseX402PaymentHeader(
          Array.isArray(rawHeader) ? rawHeader[0] : rawHeader
        );
        if (!parsed) {
          return handleError(
            reply,
            400,
            'X-Payment header is malformed',
            'BAD_PAYMENT_HEADER'
          );
        }

        // Reconstruct the challenge the client claims to have answered so
        // verifyX402Payment can compare field-by-field. Same pattern as
        // x402Routes.ts (Wave 13B). The signature check remains authoritative;
        // a fabricated nonce still cannot bypass the recovered-signer gate.
        const claimedChallenge = buildX402Challenge({
          chainId: parsed.chainId as number,
          tokenAddress: parsed.tokenAddress as string,
          payTo,
          maxAmountRequired: VIP_RESERVATION_AMOUNT_ATOMIC,
          resource: VIP_RESOURCE,
        });
        const accept = claimedChallenge.accepts[0];
        if (accept) {
          accept.nonce = parsed.nonce;
          accept.validAfter = parsed.validAfter;
          accept.validBefore = parsed.validBefore;
        }

        const verify = await verifyX402Payment(claimedChallenge, parsed);
        if (!verify.ok) {
          const statusCode =
            verify.code === 'TOKEN_METADATA_UNAVAILABLE' ? 503 : 400;
          return handleError(reply, statusCode, verify.message, verify.code);
        }

        // Settle. Fire-and-forget confirmation; the F11 confirmation worker
        // finalises the tx status. Reservation persists immediately so a
        // paying peer sees their slug locked without a multi-minute wait.
        const settle = await settleX402Payment(
          verify.chainId,
          verify.tokenAddress,
          verify.message,
          verify.signature
        );
        if (!settle.ok) {
          if (settle.code === 'NONCE_USED') {
            return handleError(reply, 409, settle.message, 'NONCE_USED');
          }
          if (settle.code === 'FACILITATOR_DISABLED') {
            return sendFeatureDisabled(reply);
          }
          return handleError(
            reply,
            502,
            'x402 settlement failed',
            'SETTLEMENT_FAILED'
          );
        }

        // Persist. The unique index on (slug) + (tx_hash) doubles as the
        // final race guard: if two peers submit concurrently for the same
        // slug and both settle, exactly one row wins and the other gets
        // 409 SLUG_ALREADY_RESERVED. The loser's on-chain payment already
        // landed — we surface the collision on the response so the client
        // can escalate to a refund flow (out of scope for this wave).
        let row: VipReservationRow;
        try {
          row = await createReservation({
            slug: normalizedSlug,
            ownerAddress: parsed.from,
            txHash: settle.result.txHash,
          });
        } catch (err) {
          if (err instanceof SlugTakenError) {
            const currentlyHeldBy = await getReservation(normalizedSlug);
            return reply.code(409).send({
              success: false,
              error: {
                code: 'SLUG_ALREADY_RESERVED',
                message: `vip-${normalizedSlug} was reserved concurrently`,
              },
              data: {
                reservation: currentlyHeldBy
                  ? serializeReservation(currentlyHeldBy)
                  : null,
                // Include the settled payment so the client can surface a
                // "your payment landed but the slug was already taken"
                // notice and start a refund conversation off-band.
                paidTxHash: settle.result.txHash,
              },
            });
          }
          if (err instanceof TxHashTakenError) {
            // Idempotent replay of the same tx hash — return the winning
            // row instead of an error. Only reachable if the client re-hits
            // /vip/reserve with a previously-settled payment.
            const priorRow = await getReservation(normalizedSlug);
            if (priorRow && priorRow.txHash === settle.result.txHash.toLowerCase()) {
              reply.header(
                'X-Payment-Response',
                JSON.stringify({
                  success: true,
                  txHash: settle.result.txHash,
                  resource: VIP_RESOURCE,
                  from: parsed.from,
                  replay: true,
                })
              );
              return reply.code(200).send({
                success: true,
                error: null,
                data: { reservation: serializeReservation(priorRow) },
              });
            }
            return handleError(
              reply,
              409,
              'tx hash already recorded',
              'TX_ALREADY_RECORDED'
            );
          }
          throw err;
        }

        reply.header(
          'X-Payment-Response',
          JSON.stringify({
            success: true,
            txHash: settle.result.txHash,
            resource: VIP_RESOURCE,
            from: parsed.from,
            replay: false,
          })
        );
        return reply.code(200).send({
          success: true,
          error: null,
          data: { reservation: serializeReservation(row) },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // GET /vip/status/:slug
  // ---------------------------------------------------------------------------
  app.get<{ Params: { slug: string } }>(
    '/status/:slug',
    {
      config: {
        rateLimit: {
          max: VIP_STATUS_RATE_LIMIT_MAX,
          timeWindow: VIP_STATUS_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      try {
        if (!ENABLE_VIP_RESERVATIONS) {
          return sendFeatureDisabled(reply);
        }
        const normalizedSlug = normalizeVipSlug(request.params.slug || '');
        if (!isValidVipSlug(normalizedSlug)) {
          return handleError(
            reply,
            400,
            'slug must match ^[a-z0-9-]{3,32}$',
            'BAD_SLUG'
          );
        }
        const row = await getReservation(normalizedSlug);
        if (!row) {
          reply.header('Cache-Control', 'no-store');
          return reply.code(200).send({
            success: true,
            error: null,
            data: {
              reserved: false,
              slug: normalizedSlug,
              vipSlug: `vip-${normalizedSlug}`,
            },
          });
        }
        reply.header('Cache-Control', 'no-store');
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            reserved: true,
            ...serializeReservation(row),
          },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};
