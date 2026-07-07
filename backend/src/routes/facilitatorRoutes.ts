/**
 * F11 EIP-3009 facilitator routes.
 *
 * Mounted under `/wdk/relay` (see index.ts). Three endpoints:
 *   POST /wdk/relay/eip3009        submit a signed authorization (rate 20/min/IP)
 *   GET  /wdk/relay/status/:txHash confirmation status              (60/min/IP)
 *   GET  /wdk/relay/health         sponsor + balance snapshot        (30/min/IP)
 *
 * When the facilitator is disabled (RELAY_SPONSOR_PK unset OR
 * RELAY_SPONSOR_ENABLED=false), every route returns 503 Service Unavailable
 * with a FACILITATOR_DISABLED body that names the required env vars, so judges
 * running the Cup demo see a self-diagnostic message instead of a bare 404.
 * The prior hide-existence 404 (ADR-010) is retained in code history; the
 * demo posture overrides it for legibility.
 *
 * Auth: the EIP-3009 signature IS the auth. No bearer.
 *
 * Response envelope: standard { success, error, data }. Errors go through
 * `handleError`.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { ethers } from 'ethers';
import { prismaQuery } from '../lib/prisma.ts';
import { validateRequiredFields } from '../utils/validationUtils.ts';
import { handleError, handleServerError } from '../utils/errorHandler.ts';
import { isValidEvmAddress, normalizeAddress } from '../utils/curvaValidators.ts';
import { shortenAddress } from '../utils/miscUtils.ts';
import { getChain } from '../lib/evm/chains.ts';
import { EIP3009_TYPES, fetchEip3009Domain, recoverEip3009Signer } from '../lib/evm/eip3009.ts';
import {
  FacilitatorDisabledError,
  FacilitatorNonceUsedError,
  FacilitatorRpcError,
  FacilitatorSponsorLowError,
  __getSponsorWallet,
  getFacilitatorHealth,
  getMaxAmountBaseUnits,
  getSponsorAddress,
  isFacilitatorEnabled,
  isOnlyRegisteredHosts,
  isTokenAllowed,
  submitEip3009Relay,
} from '../lib/evm/facilitator.ts';
import { formatUsdt } from '../lib/evm/usdtIndexer.ts';
import { eventBus } from '../lib/activity/eventBus.ts';
import {
  RELAY_DEMO_ENABLED,
  RELAY_DEMO_RATE_LIMIT_MAX,
  RELAY_DEMO_RATE_LIMIT_WINDOW,
  RELAY_HEALTH_RATE_LIMIT_MAX,
  RELAY_HEALTH_RATE_LIMIT_WINDOW,
  RELAY_RATE_LIMIT_MAX,
  RELAY_RATE_LIMIT_WINDOW,
  RELAY_STATUS_RATE_LIMIT_MAX,
  RELAY_STATUS_RATE_LIMIT_WINDOW,
  SEPOLIA_CHAIN_ID,
} from '../config/main-config.ts';

// =============================================================================
// Validators
// =============================================================================

const HEX_BYTES32 = /^0x[0-9a-f]{64}$/i;
const DECIMAL_UINT = /^[0-9]+$/;

const isValidBytes32 = (s: unknown): s is string =>
  typeof s === 'string' && HEX_BYTES32.test(s);

const isValidDecimalUint = (s: unknown): s is string =>
  typeof s === 'string' && DECIMAL_UINT.test(s);

// Grace window per architecture: allow a small clock skew on both sides.
const VALID_AFTER_GRACE_S = 60;
const VALID_BEFORE_MIN_S = 30;

// =============================================================================
// Body schema
// =============================================================================

interface RelayBody {
  chainId: number;
  tokenAddress?: string;
  from: string;
  to: string;
  value: string;
  validAfter: number;
  validBefore: number;
  nonce: string;
  v: number;
  r: string;
  s: string;
}

const REQUIRED_FIELDS: Array<keyof RelayBody> = [
  'chainId',
  'from',
  'to',
  'value',
  'validAfter',
  'validBefore',
  'nonce',
  'v',
  'r',
  's',
];

// =============================================================================
// Disabled-state response.
//
// We return 503 (not 404) so callers can distinguish "facilitator turned off on
// this deployment" from "route does not exist". The body names the exact env
// vars the operator must set — mirrors the pre-flight checklist in README.
// =============================================================================

const sendFacilitatorDisabled = (reply: FastifyReply): FastifyReply => {
  return reply.code(503).send({
    success: false,
    error: {
      code: 'FACILITATOR_DISABLED',
      message:
        "The WDK EIP-3009 facilitator is not enabled on this deployment. See README section 'Enabling the facilitator'.",
    },
    data: {
      enabled: false,
      requiredEnv: ['RELAY_SPONSOR_ENABLED=true', 'RELAY_SPONSOR_PK'],
    },
  });
};

// =============================================================================
// Route plugin
// =============================================================================

export const facilitatorRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // ---------------------------------------------------------------------------
  // POST /wdk/relay/eip3009
  // ---------------------------------------------------------------------------
  app.post(
    '/eip3009',
    {
      config: {
        rateLimit: { max: RELAY_RATE_LIMIT_MAX, timeWindow: RELAY_RATE_LIMIT_WINDOW },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // 503 with a self-describing body when disabled (see helper comment).
        if (!isFacilitatorEnabled()) {
          return sendFacilitatorDisabled(reply);
        }

        const body = (request.body || {}) as Record<string, unknown>;
        const valid = await validateRequiredFields(
          body,
          REQUIRED_FIELDS as unknown as string[],
          reply
        );
        if (valid !== true) return;

        // Type coercion + validation. Reject on ANY malformed field before
        // touching the DB or the RPC.
        const chainId = Number(body.chainId);
        if (!Number.isInteger(chainId)) {
          return handleError(reply, 400, 'chainId must be an integer', 'VALIDATION_ERROR');
        }
        const chain = getChain(chainId);
        if (!chain) {
          return handleError(reply, 400, `Chain ${chainId} is not supported`, 'CHAIN_UNSUPPORTED');
        }
        if (!chain.enabled) {
          return handleError(reply, 400, `Chain ${chainId} is currently disabled`, 'CHAIN_DISABLED');
        }

        const fromRaw = typeof body.from === 'string' ? body.from : '';
        const toRaw = typeof body.to === 'string' ? body.to : '';
        if (!isValidEvmAddress(fromRaw)) {
          return handleError(reply, 400, 'from must be a valid EVM address', 'VALIDATION_ERROR');
        }
        if (!isValidEvmAddress(toRaw)) {
          return handleError(reply, 400, 'to must be a valid EVM address', 'VALIDATION_ERROR');
        }
        const from = normalizeAddress(fromRaw);
        const to = normalizeAddress(toRaw);

        // tokenAddress: optional in the request; when omitted we default to the
        // chain's configured USDT contract. Every allowed token must match the
        // RELAY_ALLOWED_TOKENS gate.
        const tokenRaw =
          typeof body.tokenAddress === 'string' && body.tokenAddress.length > 0
            ? body.tokenAddress
            : chain.usdtAddress;
        if (!isValidEvmAddress(tokenRaw)) {
          return handleError(
            reply,
            400,
            'tokenAddress must be a valid EVM address',
            'VALIDATION_ERROR'
          );
        }
        const tokenAddress = normalizeAddress(tokenRaw);
        if (!isTokenAllowed(tokenAddress)) {
          return handleError(
            reply,
            400,
            'Token contract is not in the allowed list',
            'TOKEN_NOT_ALLOWED'
          );
        }

        if (!isValidDecimalUint(body.value)) {
          return handleError(reply, 400, 'value must be a decimal uint string', 'VALIDATION_ERROR');
        }
        const value = String(body.value);
        let valueBig: bigint;
        try {
          valueBig = BigInt(value);
        } catch {
          return handleError(reply, 400, 'value is not a valid integer', 'VALIDATION_ERROR');
        }
        if (valueBig <= 0n) {
          return handleError(reply, 400, 'value must be > 0', 'VALIDATION_ERROR');
        }
        if (valueBig > getMaxAmountBaseUnits()) {
          return handleError(
            reply,
            400,
            'Amount exceeds facilitator cap',
            'AMOUNT_EXCEEDS_CAP'
          );
        }

        const validAfter = Number(body.validAfter);
        const validBefore = Number(body.validBefore);
        if (!Number.isInteger(validAfter) || validAfter < 0) {
          return handleError(reply, 400, 'validAfter must be a non-negative integer', 'VALIDATION_ERROR');
        }
        if (!Number.isInteger(validBefore) || validBefore < 0) {
          return handleError(reply, 400, 'validBefore must be a non-negative integer', 'VALIDATION_ERROR');
        }
        const nowSec = Math.floor(Date.now() / 1000);
        if (validAfter > nowSec + VALID_AFTER_GRACE_S) {
          return handleError(
            reply,
            400,
            'Authorization is not yet valid (validAfter in the future)',
            'VALIDATION_ERROR'
          );
        }
        if (validBefore <= nowSec + VALID_BEFORE_MIN_S) {
          return handleError(
            reply,
            400,
            'Authorization is expired or expires too soon',
            'VALIDATION_ERROR'
          );
        }

        if (!isValidBytes32(body.nonce)) {
          return handleError(reply, 400, 'nonce must be a 0x-prefixed 32-byte hex value', 'VALIDATION_ERROR');
        }
        const nonce = String(body.nonce).toLowerCase();

        if (!isValidBytes32(body.r)) {
          return handleError(reply, 400, 'r must be a 0x-prefixed 32-byte hex value', 'VALIDATION_ERROR');
        }
        if (!isValidBytes32(body.s)) {
          return handleError(reply, 400, 's must be a 0x-prefixed 32-byte hex value', 'VALIDATION_ERROR');
        }
        const v = Number(body.v);
        if (!Number.isInteger(v) || (v !== 27 && v !== 28 && v !== 0 && v !== 1)) {
          return handleError(reply, 400, 'v must be one of {0, 1, 27, 28}', 'VALIDATION_ERROR');
        }
        const r = String(body.r);
        const s = String(body.s);

        // Registered-host gate. When enabled, `to` must equal an active
        // Room.hostSmartAddress (case-insensitive; addresses stored lowercase).
        let roomSlug: string | null = null;
        if (isOnlyRegisteredHosts()) {
          const room = await prismaQuery.room.findFirst({
            where: { hostSmartAddress: to, deletedAt: null },
            select: { slug: true },
          });
          if (!room) {
            return handleError(
              reply,
              400,
              'Recipient is not a registered host',
              'HOST_NOT_REGISTERED'
            );
          }
          roomSlug = room.slug;
        } else {
          // Still try to resolve for the event payload (best effort).
          const room = await prismaQuery.room.findFirst({
            where: { hostSmartAddress: to, deletedAt: null },
            select: { slug: true },
          });
          roomSlug = room?.slug ?? null;
        }

        // EIP-712 domain lookup (cached per token). If the token contract
        // doesn't expose name()/version() the facilitator refuses this chain.
        // Do this BEFORE reserving the DB row so a bad token never wastes a
        // reservation.
        const domain = await fetchEip3009Domain(chainId, tokenAddress);
        if (!domain) {
          return handleError(
            reply,
            503,
            'Token EIP-712 metadata unavailable',
            'TOKEN_METADATA_UNAVAILABLE'
          );
        }

        // Signature verification — recover MUST equal claimed `from`.
        const recovered = recoverEip3009Signer(
          domain,
          {
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce,
          },
          { v, r, s }
        );
        if (!recovered || recovered !== from) {
          return handleError(reply, 400, 'Signature does not recover the expected signer', 'INVALID_SIGNATURE');
        }

        // W4-HIGH-01 fix: RESERVE the FacilitatorTx row BEFORE any on-chain
        // submit. The composite @@unique([chainId, nonce]) is the atomic gate:
        // only one concurrent request wins the insert; the losers get P2002 and
        // never reach the RPC. This prevents sponsor-gas amplification under a
        // burst of identical-nonce requests (see SECURITY_AUDIT W4-HIGH-01).
        const submittedAt = new Date();
        const placeholderTxHash = `pending:${randomUUID()}`;
        let reservation: { id: string };
        try {
          reservation = await prismaQuery.facilitatorTx.create({
            data: {
              chainId,
              txHash: placeholderTxHash,
              fromAddress: from,
              toAddress: to,
              amount: value,
              tokenAddress,
              nonce,
              validAfter,
              validBefore,
              status: 'pending',
              submittedAt,
            },
          });
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === 'P2002') {
            return handleError(reply, 409, 'Authorization nonce already used', 'NONCE_ALREADY_USED');
          }
          return handleServerError(reply, err as Error);
        }

        // Submit on-chain via sponsor wallet. On any failure we mark the
        // reservation `failed` (never delete — auditability).
        let submitResult: { txHash: string; sponsorAddress: string };
        try {
          submitResult = await submitEip3009Relay({
            chainId,
            tokenAddress,
            message: { from, to, value, validAfter, validBefore, nonce },
            signature: { v, r, s },
          });
        } catch (err) {
          const errorMessage = (err as Error)?.message?.slice(0, 500) ?? 'unknown';
          await prismaQuery.facilitatorTx
            .update({
              where: { id: reservation.id },
              data: { status: 'failed', errorMessage },
            })
            .catch((updateErr) => {
              console.warn(
                '[facilitator] failed to mark reservation failed:',
                (updateErr as Error)?.message
              );
            });
          if (err instanceof FacilitatorDisabledError) {
            return sendFacilitatorDisabled(reply);
          }
          if (err instanceof FacilitatorSponsorLowError) {
            return handleError(
              reply,
              503,
              'Sponsor balance below required floor',
              'SPONSOR_INSUFFICIENT_FUNDS'
            );
          }
          if (err instanceof FacilitatorNonceUsedError) {
            return handleError(reply, 409, 'Authorization nonce already used on-chain', 'NONCE_ALREADY_USED');
          }
          if (err instanceof FacilitatorRpcError) {
            // Log the cause to ErrorLog via handleError but return a generic
            // message so we never leak RPC internals to the client.
            return handleError(
              reply,
              502,
              'Failed to submit transaction to the network',
              'RPC_SUBMIT_FAILED',
              err.cause,
              { chainId, tokenAddress }
            );
          }
          return handleServerError(reply, err as Error);
        }

        // Patch the reservation with the real txHash + submitted status.
        try {
          await prismaQuery.facilitatorTx.update({
            where: { id: reservation.id },
            data: {
              status: 'submitted',
              txHash: submitResult.txHash,
            },
          });
        } catch (err) {
          // Very rare: the reservation exists (we own the nonce) but the update
          // failed. The tx is already on-chain and the row exists with the
          // pending: placeholder txHash. The confirmation worker filters by
          // status='submitted' so it won't pick this up; ops can reconcile by
          // querying by (chainId, nonce). Log loud and return 500.
          return handleError(
            reply,
            500,
            'Submitted on-chain but failed to update reservation; check /wdk/relay/status',
            'FACILITATOR_PERSIST_FAILED',
            err as Error,
            { reservationId: reservation.id, txHash: submitResult.txHash }
          );
        }

        // Best-effort resolve of matchId from the room (F8 dashboard groups the
        // tip ticker by match when this is populated). Never let a lookup
        // failure block the response — the tx has already landed on-chain.
        let matchId: string | null = null;
        if (roomSlug) {
          try {
            const roomRow = await prismaQuery.room.findFirst({
              where: { slug: roomSlug },
              select: { matchId: true },
            });
            matchId = roomRow?.matchId ?? null;
          } catch {
            /* ignore — best-effort enrichment */
          }
        }

        // Explorer URL for judges to click through. Only built when the chain
        // config exposes an explorerBase (Sepolia does; Plasma testnet does).
        const explorerUrl =
          chain.explorerBase && chain.explorerBase.length > 0
            ? `${chain.explorerBase.replace(/\/$/, '')}/tx/${submitResult.txHash}`
            : null;

        // Fire-and-forget event publish. Payloads carry shortened addresses.
        // We publish full txHashFull separately so the dashboard can build
        // click-through links without re-fetching /wdk/relay/status.
        try {
          eventBus.publish('facilitator.submitted', {
            txHash: shortenAddress(submitResult.txHash, 10, 6),
            txHashFull: submitResult.txHash,
            explorerUrl,
            chainId,
            chainName: chain.name,
            fromAddress: shortenAddress(from),
            toAddress: shortenAddress(to),
            amount: value,
            amountFormatted: formatUsdt(value),
            roomSlug,
            matchId,
          });
        } catch (err) {
          console.warn('[facilitator] eventBus publish failed:', (err as Error)?.message);
        }

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            txHash: submitResult.txHash,
            reservationId: reservation.id,
            status: 'submitted',
            chainId,
            from: shortenAddress(from),
            to: shortenAddress(to),
            amount: value,
            amountFormatted: formatUsdt(value),
            submittedAt: submittedAt.toISOString(),
          },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // GET /wdk/relay/status/:txHash
  // ---------------------------------------------------------------------------
  app.get(
    '/status/:txHash',
    {
      config: {
        rateLimit: {
          max: RELAY_STATUS_RATE_LIMIT_MAX,
          timeWindow: RELAY_STATUS_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!isFacilitatorEnabled()) {
          return sendFacilitatorDisabled(reply);
        }
        const { txHash } = request.params as { txHash: string };
        // ethers.isHexString rejects anything not 0x + even hex; length 66 is
        // exactly a tx hash. Reject fast to avoid a DB lookup on garbage.
        if (typeof txHash !== 'string' || !ethers.isHexString(txHash, 32)) {
          return handleError(reply, 400, 'txHash must be a 0x-prefixed 32-byte hex value', 'VALIDATION_ERROR');
        }
        const normalized = txHash.toLowerCase();
        const row = await prismaQuery.facilitatorTx.findUnique({
          where: { txHash: normalized },
        });
        if (!row) {
          return handleError(reply, 404, 'Transaction not found', 'TX_NOT_FOUND');
        }
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            txHash: row.txHash,
            chainId: row.chainId,
            status: row.status,
            from: shortenAddress(row.fromAddress),
            to: shortenAddress(row.toAddress),
            amount: row.amount,
            amountFormatted: formatUsdt(row.amount),
            submittedAt: row.submittedAt.toISOString(),
            confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
            confirmedBlock: row.confirmedBlock,
            error: row.errorMessage,
          },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // GET /wdk/relay/health
  // ---------------------------------------------------------------------------
  app.get(
    '/health',
    {
      config: {
        rateLimit: {
          max: RELAY_HEALTH_RATE_LIMIT_MAX,
          timeWindow: RELAY_HEALTH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!isFacilitatorEnabled()) {
          return sendFacilitatorDisabled(reply);
        }
        const health = getFacilitatorHealth();
        const sponsor = getSponsorAddress();
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            enabled: health.enabled,
            sponsorAddress: sponsor ? shortenAddress(sponsor) : null,
            balances: health.balances,
            allowedTokens: health.allowedTokens.map((t) => shortenAddress(t)),
            onlyRegisteredHosts: health.onlyRegisteredHosts,
            maxAmountUsdt: health.maxAmountUsdt,
          },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // POST /wdk/relay/demo-self-tip
  //
  // EIP-3009 SELF-TIP MODE (eip3009_self_tip):
  //   Path B is live. The sponsor wallet builds and signs an EIP-3009
  //   `TransferWithAuthorization` payload where `from == to == sponsor`, then
  //   relays it through the same `submitEip3009Relay()` code path used by
  //   POST /wdk/relay/eip3009. On-chain this emits BOTH the ERC-20
  //   `Transfer(sponsor, sponsor, amount)` event AND the EIP-3009
  //   `AuthorizationUsed(sponsor, nonce)` event, exercising the full facilitator
  //   flow end-to-end for demo purposes without needing a second wallet.
  //
  //   The sponsor is intentionally the recipient here, so we bypass the
  //   RELAY_ONLY_REGISTERED_HOSTS gate — no third-party recipient exists to
  //   register, and the sponsor's own address is trusted by construction.
  //
  // Guarantees preserved from the original design:
  //   1. RELAY_DEMO_ENABLED gate (404 hide-existence when off).
  //   2. Base facilitator gate (503 FACILITATOR_DISABLED when sponsor unset).
  //   3. Amount validation + facilitator cap.
  //   4. Token allowed-list gate.
  //   5. FacilitatorTx row reserved BEFORE submit (P2002 amplification guard,
  //      keyed on the fresh random EIP-3009 nonce).
  //   6. facilitator.submitted event emitted after success.
  //   7. Rate limit 5 req/min/IP (via RELAY_DEMO_RATE_LIMIT_*).
  // ---------------------------------------------------------------------------
  app.post(
    '/demo-self-tip',
    {
      config: {
        rateLimit: {
          max: RELAY_DEMO_RATE_LIMIT_MAX,
          timeWindow: RELAY_DEMO_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // 1. Gate on RELAY_DEMO_ENABLED.
        if (!RELAY_DEMO_ENABLED) {
          return reply.code(404).send({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Route not found' },
            data: null,
          });
        }

        // 2. Base facilitator must be enabled (we need the sponsor wallet to
        // sign the EIP-3009 authorization AND to relay it on-chain).
        if (!isFacilitatorEnabled()) {
          return sendFacilitatorDisabled(reply);
        }

        const sponsorWallet = __getSponsorWallet();
        const sponsorAddress = getSponsorAddress();
        if (!sponsorWallet || !sponsorAddress) {
          return sendFacilitatorDisabled(reply);
        }

        // 3. Parse + validate amount. Default 1 USDT (1_000_000 base units).
        const body = (request.body || {}) as Record<string, unknown>;
        const amountRaw =
          typeof body.amount === 'string' && body.amount.length > 0
            ? body.amount
            : '1000000';
        if (!DECIMAL_UINT.test(amountRaw)) {
          return handleError(
            reply,
            400,
            'amount must be a decimal uint string',
            'VALIDATION_ERROR'
          );
        }
        let amountBig: bigint;
        try {
          amountBig = BigInt(amountRaw);
        } catch {
          return handleError(reply, 400, 'amount is not a valid integer', 'VALIDATION_ERROR');
        }
        if (amountBig <= 0n) {
          return handleError(reply, 400, 'amount must be > 0', 'VALIDATION_ERROR');
        }
        if (amountBig > getMaxAmountBaseUnits()) {
          return handleError(
            reply,
            400,
            'Amount exceeds facilitator cap',
            'AMOUNT_EXCEEDS_CAP'
          );
        }

        // 4. Chain + token. Sepolia is the demo default.
        const chainId = SEPOLIA_CHAIN_ID;
        const chain = getChain(chainId);
        if (!chain || !chain.enabled) {
          return handleError(
            reply,
            400,
            `Chain ${chainId} is not enabled`,
            'CHAIN_DISABLED'
          );
        }
        const tokenAddress = normalizeAddress(chain.usdtAddress);
        if (!isTokenAllowed(tokenAddress)) {
          return handleError(
            reply,
            400,
            'Token contract is not in the allowed list',
            'TOKEN_NOT_ALLOWED'
          );
        }

        // NOTE: intentionally skip the RELAY_ONLY_REGISTERED_HOSTS gate here.
        // The sponsor is BOTH signer and recipient by construction — there is
        // no third-party host to register. Every other guard (token allowlist,
        // amount cap, sponsor balance floor, nonce reservation) still applies.

        // 5. EIP-3009 authorization setup. from == to == sponsor. Fresh random
        // 32-byte nonce; validAfter=0 (immediately valid); validBefore = now +
        // 3600s. The nonce doubles as the FacilitatorTx (chainId, nonce)
        // reservation key so replay of an identical payload is guarded by the
        // DB unique index even before the token contract's on-chain
        // AuthorizationUsed check fires.
        const from = sponsorAddress;
        const to = sponsorAddress;
        const validAfter = 0;
        const validBefore = Math.floor(Date.now() / 1000) + 3600;
        const nonce = ('0x' + randomBytes(32).toString('hex')).toLowerCase();
        const value = amountBig.toString();

        // 6. Fetch the token's EIP-712 domain from-chain (cached per token).
        // Must happen BEFORE the DB reservation so a bad token never wastes a
        // reserved nonce slot.
        const domain = await fetchEip3009Domain(chainId, tokenAddress);
        if (!domain) {
          return handleError(
            reply,
            503,
            'Token EIP-712 metadata unavailable',
            'TOKEN_METADATA_UNAVAILABLE'
          );
        }

        // 7. Sponsor signs its own TransferWithAuthorization message.
        // signTypedData(EIP-712) returns the joined 65-byte 0x... signature;
        // ethers.Signature.from(...) splits it back to {v, r, s} for the
        // on-chain transferWithAuthorization(...) call.
        let v: number;
        let r: string;
        let s: string;
        try {
          const joinedSig = await sponsorWallet.signTypedData(
            {
              name: domain.name,
              version: domain.version,
              chainId: domain.chainId,
              verifyingContract: domain.verifyingContract,
            },
            EIP3009_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
            { from, to, value, validAfter, validBefore, nonce }
          );
          const split = ethers.Signature.from(joinedSig);
          v = split.v;
          r = split.r;
          s = split.s;
        } catch (err) {
          return handleError(
            reply,
            500,
            'Failed to sign EIP-3009 authorization',
            'SIGN_FAILED',
            err as Error,
            { chainId, tokenAddress }
          );
        }

        // 8. Reserve the FacilitatorTx row BEFORE any on-chain submit. Same
        // P2002 amplification guard as the /eip3009 path — the fresh random
        // nonce is the atomic reservation key.
        const submittedAt = new Date();
        const placeholderTxHash = `pending:${randomUUID()}`;
        let reservation: { id: string };
        try {
          reservation = await prismaQuery.facilitatorTx.create({
            data: {
              chainId,
              txHash: placeholderTxHash,
              fromAddress: from,
              toAddress: to,
              amount: value,
              tokenAddress,
              nonce,
              validAfter,
              validBefore,
              status: 'pending',
              submittedAt,
            },
          });
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === 'P2002') {
            return handleError(
              reply,
              409,
              'Authorization nonce already used',
              'NONCE_ALREADY_USED'
            );
          }
          return handleServerError(reply, err as Error);
        }

        // 9. Route through the same submitEip3009Relay() code path used by the
        // public /wdk/relay/eip3009 endpoint. This enforces the sponsor balance
        // floor, classifies FacilitatorNonceUsedError, and calls
        // transferWithAuthorization(...) on the token contract.
        let submitResult: { txHash: string; sponsorAddress: string };
        try {
          submitResult = await submitEip3009Relay({
            chainId,
            tokenAddress,
            message: { from, to, value, validAfter, validBefore, nonce },
            signature: { v, r, s },
          });
        } catch (err) {
          const errorMessage = (err as Error)?.message?.slice(0, 500) ?? 'unknown';
          await prismaQuery.facilitatorTx
            .update({
              where: { id: reservation.id },
              data: { status: 'failed', errorMessage },
            })
            .catch((updateErr) => {
              console.warn(
                '[facilitator] demo-self-tip: failed to mark reservation failed:',
                (updateErr as Error)?.message
              );
            });
          if (err instanceof FacilitatorDisabledError) {
            return sendFacilitatorDisabled(reply);
          }
          if (err instanceof FacilitatorSponsorLowError) {
            return handleError(
              reply,
              503,
              'Sponsor balance below required floor',
              'SPONSOR_INSUFFICIENT_FUNDS'
            );
          }
          if (err instanceof FacilitatorNonceUsedError) {
            return handleError(
              reply,
              409,
              'Authorization nonce already used on-chain',
              'NONCE_ALREADY_USED'
            );
          }
          if (err instanceof FacilitatorRpcError) {
            return handleError(
              reply,
              502,
              'Failed to submit transaction to the network',
              'RPC_SUBMIT_FAILED',
              err.cause,
              { chainId, tokenAddress }
            );
          }
          return handleServerError(reply, err as Error);
        }

        const txHash = submitResult.txHash;

        // 10. Patch reservation to submitted with the real tx hash.
        try {
          await prismaQuery.facilitatorTx.update({
            where: { id: reservation.id },
            data: {
              status: 'submitted',
              txHash,
            },
          });
        } catch (err) {
          console.warn(
            '[facilitator] demo-self-tip: reservation update after submit failed:',
            (err as Error)?.message
          );
        }

        // 11. Explorer URL.
        const explorerUrl =
          chain.explorerBase && chain.explorerBase.length > 0
            ? `${chain.explorerBase.replace(/\/$/, '')}/tx/${txHash}`
            : null;

        // 12. Publish facilitator.submitted so dashboard subscribers render
        // the demo tip identically to a real peer tip.
        try {
          eventBus.publish('facilitator.submitted', {
            txHash: shortenAddress(txHash, 10, 6),
            txHashFull: txHash,
            explorerUrl,
            chainId,
            chainName: chain.name,
            fromAddress: shortenAddress(from),
            toAddress: shortenAddress(to),
            amount: value,
            amountFormatted: formatUsdt(value),
            roomSlug: null,
            matchId: null,
            mode: 'eip3009_self_tip',
          });
        } catch (err) {
          console.warn(
            '[facilitator] demo-self-tip: eventBus publish failed:',
            (err as Error)?.message
          );
        }

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            txHash,
            explorerUrl,
            from,
            to,
            amount: value,
            amountFormatted: formatUsdt(value),
            nonce,
            chainId,
            reservationId: reservation.id,
            status: 'submitted',
            mode: 'eip3009_self_tip',
            submittedAt: submittedAt.toISOString(),
          },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};
