/**
 * Wave 13B - WDK x402 paid-resource route.
 *
 * Mounted at `/x402` (see index.ts). Two entry points share the same URL:
 *
 *   GET /x402/premium-translations
 *     - No X-Payment header       -> 402 Payment Required + challenge JSON body
 *     - Valid X-Payment header    -> settles via facilitator, 200 + resource
 *     - Reused nonce              -> 409 NONCE_USED
 *     - Malformed X-Payment       -> 400 BAD_PAYMENT_HEADER
 *     - Facilitator/x402 disabled -> 503 FEATURE_DISABLED
 *
 * Auth model: the EIP-3009 signature IS the auth (same pattern as the F11
 * facilitator). Rate limiting keeps naive scraping in check. The resource
 * payload itself is a JSON object describing which Bergamot translation model
 * bundles the peer just unlocked; the pear-app renderer surfaces the URLs to
 * the wallet-bound peer.
 *
 * Response envelope for 200s follows the standard { success, error, data }
 * shape used across the backend. 402 responses deliberately deviate to match
 * the canonical x402 spec (raw { x402Version, accepts:[...] } body) so that
 * existing x402-aware clients can consume our gateway without translation.
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
  grantUnlock,
  isUnlocked,
} from '../lib/evm/x402.ts';
import { isFacilitatorEnabled, getSponsorAddress } from '../lib/evm/facilitator.ts';
import {
  CURVA_X402_ENABLED,
  CURVA_X402_PRICE_ATOMIC,
  CURVA_X402_RESOURCE,
  CURVA_X402_CHAIN_ID,
  CURVA_X402_TOKEN_ADDRESS,
  CURVA_X402_PAY_TO,
  CURVA_X402_CHALLENGE_TTL_SECONDS,
  CURVA_X402_RATE_LIMIT_MAX,
  CURVA_X402_RATE_LIMIT_WINDOW,
} from '../config/main-config.ts';

// The unlocked resource payload. Kept intentionally small and stable so the
// pear-app renderer can whitelist which strings it forwards to Bergamot.
const PREMIUM_TRANSLATIONS = {
  resource: 'premium-translations',
  description: 'Curva premium translation set: EN-DE + EN-FR Bergamot bundles.',
  models: [
    {
      id: 'bergamot-en-de',
      pair: 'en-de',
      sizeBytes: 17_000_000,
      // Pointer only. The QVAC registry (F12) serves the actual bytes. The
      // paywall unlocks the *reference*, not a mirror.
      downloadRef: '/qvac/models/bergamot-en-de/download',
    },
    {
      id: 'bergamot-en-fr',
      pair: 'en-fr',
      sizeBytes: 17_500_000,
      downloadRef: '/qvac/models/bergamot-en-fr/download',
    },
  ],
} as const;

// Effective payTo: fall back to sponsor address when unset so the demo works
// out of the box. Resolved per-request because SPONSOR_ADDRESS is only set
// after the facilitator module init.
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
        'The WDK x402 paid-resource protocol is not enabled on this deployment. See README section on x402.',
    },
    data: {
      enabled: false,
      requiredEnv: ['CURVA_X402_ENABLED=true', 'RELAY_SPONSOR_ENABLED=true', 'RELAY_SPONSOR_PK'],
    },
  });
};

export const x402Routes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get(
    `/${CURVA_X402_RESOURCE}`,
    {
      config: {
        rateLimit: {
          max: CURVA_X402_RATE_LIMIT_MAX,
          timeWindow: CURVA_X402_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Fail closed when the flag is off OR the underlying facilitator is
        // unavailable. Both must be true for any on-chain path to fire.
        if (!CURVA_X402_ENABLED || !isFacilitatorEnabled()) {
          return sendFeatureDisabled(reply);
        }

        const payTo = resolvePayTo();
        if (!payTo) {
          return handleError(
            reply,
            503,
            'x402 recipient address not configured',
            'FEATURE_DISABLED'
          );
        }

        // Grab the (case-insensitive) X-Payment header. Fastify lowercases
        // header names for us; both `x-payment` and `X-Payment` end up here.
        const rawHeader =
          request.headers['x-payment'] ??
          request.headers['x-payment-header'] ??
          request.headers['X-Payment'.toLowerCase()];

        // Path 1: no payment -> emit a fresh challenge with a 15-min TTL.
        if (!rawHeader) {
          const challenge = buildX402Challenge({
            chainId: CURVA_X402_CHAIN_ID,
            tokenAddress: CURVA_X402_TOKEN_ADDRESS,
            payTo,
            maxAmountRequired: CURVA_X402_PRICE_ATOMIC,
            resource: CURVA_X402_RESOURCE,
            validForSeconds: CURVA_X402_CHALLENGE_TTL_SECONDS,
            description: 'Unlock premium Bergamot translation bundles',
          });
          // Mirror the primary accept-entry into an X-Payment-Required header
          // so simple clients that read headers instead of the body can still
          // discover payment terms.
          const accept = challenge.accepts[0];
          if (accept) {
            reply.header('X-Payment-Required', JSON.stringify(accept));
          }
          reply.header('Cache-Control', 'no-store');
          return reply.code(402).send(challenge);
        }

        // Path 2: payment submitted. Parse strictly; malformed -> 400.
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

        // Fast path: already-unlocked peer (24h cache). Skip the on-chain
        // settle so a peer that already paid and reloads the resource does
        // not double-pay.
        const already = isUnlocked(CURVA_X402_RESOURCE, parsed.from);
        if (already.unlocked) {
          reply.header('X-Payment-Response', JSON.stringify({
            success: true,
            txHash: already.txHash,
            resource: CURVA_X402_RESOURCE,
            from: parsed.from,
            replay: true,
          }));
          return reply.code(200).send({
            success: true,
            error: null,
            data: PREMIUM_TRANSLATIONS,
          });
        }

        // Build the challenge shape the payment header claims to answer so we
        // can verify field-by-field. We reconstruct from the payment header's
        // own claims — the actual challenge nonce is validated indirectly by
        // the facilitator's composite unique (chainId, nonce). A malicious
        // client that fabricates a nonce still cannot bypass the signature
        // check nor the token allow-list nor the amount ceiling.
        const claimedChallenge = buildX402Challenge({
          chainId: parsed.chainId as number,
          tokenAddress: parsed.tokenAddress as string,
          payTo,
          maxAmountRequired: CURVA_X402_PRICE_ATOMIC,
          resource: CURVA_X402_RESOURCE,
        });
        // Override the nonce+validity with what the client actually signed so
        // verify passes when the fields all line up.
        const accept = claimedChallenge.accepts[0];
        if (accept) {
          accept.nonce = parsed.nonce;
          accept.validAfter = parsed.validAfter;
          accept.validBefore = parsed.validBefore;
        }

        const verify = await verifyX402Payment(claimedChallenge, parsed);
        if (!verify.ok) {
          // Distinguish 400 (validation / mismatch) from 503 (token metadata
          // unavailable — retryable). Signature failure is 400, not 401,
          // to match the F11 facilitator convention.
          const statusCode =
            verify.code === 'TOKEN_METADATA_UNAVAILABLE' ? 503 : 400;
          return handleError(reply, statusCode, verify.message, verify.code);
        }

        // Settle on-chain. Fire-and-forget confirmation: submission returns as
        // soon as the sponsor broadcasts. Confirmation lives in the F11
        // relayConfirmationWorker; the unlock is granted immediately so the
        // paywall UX is not gated on multi-minute block times.
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
          return handleError(reply, 502, 'x402 settlement failed', 'SETTLEMENT_FAILED');
        }

        grantUnlock(CURVA_X402_RESOURCE, parsed.from, settle.result.txHash);
        reply.header('X-Payment-Response', JSON.stringify({
          success: true,
          txHash: settle.result.txHash,
          resource: CURVA_X402_RESOURCE,
          from: parsed.from,
          replay: false,
        }));
        return reply.code(200).send({
          success: true,
          error: null,
          data: PREMIUM_TRANSLATIONS,
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};
