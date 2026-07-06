/**
 * Wave 10 — Match Prediction Pool routes.
 *
 * Mounted under `/predictions` (see index.ts). Four endpoints:
 *   POST /predictions/open                  host opens a pool for (roomSlug, matchId)
 *   POST /predictions/entry                 peer stakes into an open pool
 *   POST /predictions/result                host publishes match result
 *   GET  /predictions/pool/:roomSlug/:matchId   read pool state + predictions
 *
 * Auth model:
 *   POST /open   host signs `curva-predictions-open:<roomSlug>:<matchId>:<deadlineMs>`
 *                with the room's registered hostOwnerAddress (Room.hostOwnerAddress).
 *   POST /entry  the EIP-3009 signature IS the auth. The relay path is the F11
 *                facilitator, which we call in-process here so entry lands on
 *                Sepolia in one round-trip.
 *   POST /result host signs `curva-predictions-result:<poolId>:<winner>:<homeGoals>:<awayGoals>`.
 *
 * Feature-flag gated by CURVA_PREDICTIONS_ENABLED (default false). Every route
 * returns 503 FEATURE_DISABLED when off so the existing test suite is
 * untouched by the schema change on machines that have not run `db:push`.
 *
 * Docs verified:
 *   - EIP-3009 validAfter/validBefore semantics (exclusive both sides)
 *   - Candide ERC-20 paymaster model for sponsor-paid transfers
 *   - Autobase multi-writer patterns (bare/chat.js gates enforce host-only
 *     `system:pool-opened` + `system:pool-payout` + `system:match-result`
 *     downstream of this route)
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { ethers } from 'ethers';
import { prismaQuery as _prismaQuery } from '../lib/prisma.ts';

// Prisma models for Wave 10 are generated when the user runs `bun run db:push`.
// Until then the TypeScript client doesn't know about `predictionPool` /
// `prediction`. Cast at the boundary so `bunx tsc --noEmit` stays green on
// pre-migration machines. The runtime shape is enforced by the Prisma schema
// and the feature-flag gate (CURVA_PREDICTIONS_ENABLED) short-circuits every
// route BEFORE any prisma call happens on those machines.
const prismaQuery = _prismaQuery as unknown as typeof _prismaQuery & {
  predictionPool: {
    create: (args: { data: Record<string, unknown> }) => Promise<{
      id: string; roomSlug: string; matchId: string; poolAddress: string; chainId: number;
      stakeToken: string; entryStakeAtomic: string; mode: string; deadlineMs: bigint;
      status: string; totalStakedAtomic: string; hostAddress: string;
      resultWinner: string | null; resultHomeGoals: number | null;
      resultAwayGoals: number | null; settledAt: Date | null;
    }>;
    findUnique: (args: { where: Record<string, unknown>; include?: Record<string, unknown> }) =>
      Promise<null | (Awaited<ReturnType<typeof _prismaQuery.room.findFirst>> extends unknown ? {
        id: string; roomSlug: string; matchId: string; poolAddress: string; chainId: number;
        stakeToken: string; entryStakeAtomic: string; mode: string; deadlineMs: bigint;
        status: string; totalStakedAtomic: string; hostAddress: string;
        resultWinner: string | null; resultHomeGoals: number | null;
        resultAwayGoals: number | null; settledAt: Date | null;
        predictions?: Array<{
          id: string; peerAddress: string; peerHandle: string; winner: string;
          homeGoals: number | null; awayGoals: number | null; stakeAtomic: string;
          txHash: string; status: string; payoutTxHash: string | null;
          payoutAmountAtomic: string | null; createdAt: Date;
        }>;
      } : never)>;
    update: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{
      id: string; status: string; resultWinner: string | null;
      resultHomeGoals: number | null; resultAwayGoals: number | null;
    }>;
    updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
    findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  };
  prediction: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
    update: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ id: string }>;
    findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  };
};
import { validateRequiredFields } from '../utils/validationUtils.ts';
import {
  handleError,
  handleServerError,
  handleUnauthorizedError,
} from '../utils/errorHandler.ts';
import {
  isValidEvmAddress,
  isValidSlug,
  isValidCuid,
  normalizeAddress,
  normalizeSlug,
  sanitizeHostHandle,
} from '../utils/curvaValidators.ts';
import { shortenAddress } from '../utils/miscUtils.ts';
import { getChain } from '../lib/evm/chains.ts';
import { verifyEip191Signature } from '../lib/evm/signatureVerifier.ts';
import { fetchEip3009Domain, recoverEip3009Signer } from '../lib/evm/eip3009.ts';
import {
  FacilitatorDisabledError,
  FacilitatorNonceUsedError,
  FacilitatorRpcError,
  FacilitatorSponsorLowError,
  getSponsorAddress,
  isFacilitatorEnabled,
  submitEip3009Relay,
} from '../lib/evm/facilitator.ts';
import {
  derivePoolAddress,
  deriveWinnerSide,
  isValidGoals,
  isValidPoolMode,
  isValidWinnerSide,
  type PoolMode,
  type WinnerSide,
} from '../lib/evm/predictionPool.ts';
import {
  CURVA_PREDICTIONS_ENABLED,
  IS_PROD,
  PREDICTIONS_AUTHORIZATION_BUFFER_MIN,
  PREDICTIONS_CHAIN_ID,
  PREDICTIONS_ENTRY_RATE_LIMIT_MAX,
  PREDICTIONS_ENTRY_RATE_LIMIT_WINDOW,
  PREDICTIONS_ENTRY_STAKE_ATOMIC,
  PREDICTIONS_OPEN_RATE_LIMIT_MAX,
  PREDICTIONS_OPEN_RATE_LIMIT_WINDOW,
  PREDICTIONS_READ_RATE_LIMIT_MAX,
  PREDICTIONS_READ_RATE_LIMIT_WINDOW,
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

// =============================================================================
// Signed-message builders — must match pear-app bare/predictions.js exactly.
// =============================================================================

export const buildPoolOpenMessage = (
  roomSlug: string,
  matchId: string,
  deadlineMs: string | number
): string => `curva-predictions-open:${roomSlug}:${matchId}:${deadlineMs}`;

export const buildPoolResultMessage = (
  poolId: string,
  winner: WinnerSide,
  homeGoals: number,
  awayGoals: number
): string =>
  `curva-predictions-result:${poolId}:${winner}:${homeGoals}:${awayGoals}`;

// =============================================================================
// Feature-flag helper — every route short-circuits on this.
// =============================================================================

const sendFeatureDisabled = (reply: FastifyReply): FastifyReply => {
  return reply.code(503).send({
    success: false,
    error: {
      code: 'FEATURE_DISABLED',
      message:
        "The Match Prediction Pool feature is not enabled on this deployment. Set CURVA_PREDICTIONS_ENABLED=true and run 'bun run db:push'.",
    },
    data: {
      enabled: false,
      requiredEnv: ['CURVA_PREDICTIONS_ENABLED=true'],
    },
  });
};

// =============================================================================
// Route plugin
// =============================================================================

export const predictionRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // ---------------------------------------------------------------------------
  // POST /predictions/open
  // Body: { roomSlug, matchId, mode, deadlineMs, hostAddress, signature }
  // ---------------------------------------------------------------------------
  app.post(
    '/open',
    {
      config: {
        rateLimit: {
          max: PREDICTIONS_OPEN_RATE_LIMIT_MAX,
          timeWindow: PREDICTIONS_OPEN_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!CURVA_PREDICTIONS_ENABLED) return sendFeatureDisabled(reply);

        const body = (request.body || {}) as Record<string, unknown>;
        const valid = await validateRequiredFields(
          body,
          ['roomSlug', 'matchId', 'mode', 'deadlineMs', 'hostAddress', 'signature'],
          reply
        );
        if (valid !== true) return;

        const roomSlugRaw = typeof body.roomSlug === 'string' ? body.roomSlug : '';
        if (!isValidSlug(roomSlugRaw)) {
          return handleError(reply, 400, 'roomSlug is invalid', 'VALIDATION_ERROR');
        }
        const roomSlug = normalizeSlug(roomSlugRaw);

        const matchId = typeof body.matchId === 'string' ? body.matchId : '';
        if (!isValidCuid(matchId)) {
          return handleError(reply, 400, 'matchId must be a valid CUID', 'VALIDATION_ERROR');
        }

        const mode = typeof body.mode === 'string' ? body.mode : '';
        if (!isValidPoolMode(mode)) {
          return handleError(
            reply,
            400,
            "mode must be 'winner-only' or 'exact-score'",
            'VALIDATION_ERROR'
          );
        }

        const deadlineMsRaw = body.deadlineMs;
        const deadlineMs =
          typeof deadlineMsRaw === 'number'
            ? deadlineMsRaw
            : typeof deadlineMsRaw === 'string' && DECIMAL_UINT.test(deadlineMsRaw)
              ? Number(deadlineMsRaw)
              : NaN;
        if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now() + 60_000) {
          return handleError(
            reply,
            400,
            'deadlineMs must be at least 60 seconds in the future',
            'VALIDATION_ERROR'
          );
        }

        const hostAddressRaw = typeof body.hostAddress === 'string' ? body.hostAddress : '';
        if (!isValidEvmAddress(hostAddressRaw)) {
          return handleError(reply, 400, 'hostAddress is invalid', 'VALIDATION_ERROR');
        }
        const hostAddress = normalizeAddress(hostAddressRaw);

        const signature = typeof body.signature === 'string' ? body.signature : '';
        if (!/^0x[a-fA-F0-9]+$/.test(signature)) {
          return handleError(reply, 400, 'signature is invalid', 'VALIDATION_ERROR');
        }

        // Room must exist AND its registered hostOwnerAddress must equal the
        // claimed hostAddress. Anti-spoofing: only the room's registered owner
        // can open pools. See ARCHITECTURE.md room delete flow for the same
        // signature-owner model.
        const room = await prismaQuery.room.findFirst({
          where: { slug: roomSlug, deletedAt: null },
          select: { id: true, matchId: true, hostOwnerAddress: true },
        });
        if (!room) {
          return handleError(reply, 404, 'Room not found', 'ROOM_NOT_FOUND');
        }
        if (room.matchId !== matchId) {
          return handleError(
            reply,
            400,
            'matchId does not match the room',
            'MATCH_MISMATCH'
          );
        }
        if (!room.hostOwnerAddress) {
          return handleError(
            reply,
            403,
            'Room does not have a registered owner; cannot open a pool',
            'HOST_OWNER_UNREGISTERED'
          );
        }
        if (room.hostOwnerAddress.toLowerCase() !== hostAddress) {
          return handleError(
            reply,
            403,
            'hostAddress does not match the registered room owner',
            'HOST_OWNER_MISMATCH'
          );
        }

        // Verify the open signature.
        const message = buildPoolOpenMessage(roomSlug, matchId, deadlineMs);
        if (!verifyEip191Signature(message, signature, hostAddress)) {
          return handleError(reply, 403, 'Invalid host signature', 'INVALID_SIGNATURE');
        }

        // Facilitator must be enabled — the pool address IS the sponsor.
        if (!isFacilitatorEnabled()) {
          return handleError(
            reply,
            503,
            'F11 facilitator must be enabled to open a prediction pool',
            'FACILITATOR_DISABLED'
          );
        }
        const sponsorAddress = getSponsorAddress();
        if (!sponsorAddress) {
          return handleError(reply, 503, 'Sponsor address unavailable', 'SPONSOR_UNAVAILABLE');
        }

        const chain = getChain(PREDICTIONS_CHAIN_ID);
        if (!chain || !chain.enabled) {
          return handleError(
            reply,
            400,
            `Chain ${PREDICTIONS_CHAIN_ID} is not enabled`,
            'CHAIN_DISABLED'
          );
        }
        const stakeToken = chain.usdtAddress;
        const poolAddress = derivePoolAddress(sponsorAddress, roomSlug, matchId);

        // Reserve the pool row. Composite @@unique([roomSlug, matchId]) is the
        // atomic gate for double-open.
        try {
          const pool = await prismaQuery.predictionPool.create({
            data: {
              matchId,
              roomSlug,
              hostAddress,
              poolAddress,
              chainId: PREDICTIONS_CHAIN_ID,
              stakeToken,
              entryStakeAtomic: PREDICTIONS_ENTRY_STAKE_ATOMIC,
              mode,
              deadlineMs: BigInt(deadlineMs),
              status: 'open',
            },
          });
          return reply.code(201).send({
            success: true,
            error: null,
            data: {
              id: pool.id,
              roomSlug: pool.roomSlug,
              matchId: pool.matchId,
              poolAddress: pool.poolAddress,
              chainId: pool.chainId,
              stakeToken: pool.stakeToken,
              entryStakeAtomic: pool.entryStakeAtomic,
              mode: pool.mode,
              deadlineMs: String(pool.deadlineMs),
              status: pool.status,
            },
          });
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === 'P2002') {
            return handleError(
              reply,
              409,
              'A prediction pool for this (roomSlug, matchId) already exists',
              'POOL_ALREADY_EXISTS'
            );
          }
          return handleServerError(reply, err as Error);
        }
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // POST /predictions/entry
  // Body: EIP-3009 auth (from, to, value, validAfter, validBefore, nonce, v, r, s)
  //   + { poolId, winner, homeGoals?, awayGoals?, peerHandle }
  // ---------------------------------------------------------------------------
  app.post(
    '/entry',
    {
      config: {
        rateLimit: {
          max: PREDICTIONS_ENTRY_RATE_LIMIT_MAX,
          timeWindow: PREDICTIONS_ENTRY_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!CURVA_PREDICTIONS_ENABLED) return sendFeatureDisabled(reply);

        const body = (request.body || {}) as Record<string, unknown>;
        const valid = await validateRequiredFields(
          body,
          [
            'poolId',
            'winner',
            'peerHandle',
            'from',
            'to',
            'value',
            'validAfter',
            'validBefore',
            'nonce',
            'v',
            'r',
            's',
          ],
          reply
        );
        if (valid !== true) return;

        const poolId = typeof body.poolId === 'string' ? body.poolId : '';
        if (!isValidCuid(poolId)) {
          return handleError(reply, 400, 'poolId must be a valid CUID', 'VALIDATION_ERROR');
        }

        const winner = typeof body.winner === 'string' ? body.winner : '';
        if (!isValidWinnerSide(winner)) {
          return handleError(
            reply,
            400,
            "winner must be 'HOME', 'AWAY', or 'DRAW'",
            'VALIDATION_ERROR'
          );
        }

        const peerHandleRaw = typeof body.peerHandle === 'string' ? body.peerHandle : '';
        const peerHandle = sanitizeHostHandle(peerHandleRaw).slice(0, 64);
        if (peerHandle.length === 0) {
          return handleError(reply, 400, 'peerHandle is invalid', 'VALIDATION_ERROR');
        }

        // Pool must be open and unlocked.
        const pool = await prismaQuery.predictionPool.findUnique({ where: { id: poolId } });
        if (!pool) return handleError(reply, 404, 'Pool not found', 'POOL_NOT_FOUND');
        if (pool.status !== 'open') {
          return handleError(reply, 409, 'Pool is not open for entries', 'POOL_NOT_OPEN');
        }
        if (Date.now() >= Number(pool.deadlineMs)) {
          return handleError(reply, 409, 'Pool deadline has passed', 'POOL_DEADLINE_PASSED');
        }

        // Mode-dependent goal fields.
        let homeGoals: number | null = null;
        let awayGoals: number | null = null;
        if (pool.mode === 'exact-score') {
          const hgRaw = body.homeGoals;
          const agRaw = body.awayGoals;
          const hg = typeof hgRaw === 'number' ? hgRaw : Number(hgRaw);
          const ag = typeof agRaw === 'number' ? agRaw : Number(agRaw);
          if (!isValidGoals(hg) || !isValidGoals(ag)) {
            return handleError(
              reply,
              400,
              'homeGoals and awayGoals must be integers 0..30',
              'VALIDATION_ERROR'
            );
          }
          // Winner must match the goals — reject peer-side inconsistency.
          if (deriveWinnerSide(hg, ag) !== winner) {
            return handleError(
              reply,
              400,
              'winner does not match the goal scores',
              'VALIDATION_ERROR'
            );
          }
          homeGoals = hg;
          awayGoals = ag;
        }

        // EIP-3009 field validation. `value` MUST equal the pool's entry stake
        // exactly. This is the second-layer guard on peer amount — the F11
        // facilitator has its own cap.
        if (!isValidDecimalUint(body.value)) {
          return handleError(reply, 400, 'value must be a decimal uint string', 'VALIDATION_ERROR');
        }
        if (String(body.value) !== pool.entryStakeAtomic) {
          return handleError(
            reply,
            400,
            'value must equal the pool entry stake exactly',
            'STAKE_AMOUNT_MISMATCH'
          );
        }

        const fromRaw = typeof body.from === 'string' ? body.from : '';
        const toRaw = typeof body.to === 'string' ? body.to : '';
        if (!isValidEvmAddress(fromRaw) || !isValidEvmAddress(toRaw)) {
          return handleError(reply, 400, 'from/to must be valid EVM addresses', 'VALIDATION_ERROR');
        }
        const from = normalizeAddress(fromRaw);
        const to = normalizeAddress(toRaw);
        if (to !== pool.poolAddress.toLowerCase()) {
          return handleError(
            reply,
            400,
            'to must equal the pool address',
            'POOL_ADDRESS_MISMATCH'
          );
        }

        const validAfter = Number(body.validAfter);
        const validBefore = Number(body.validBefore);
        if (!Number.isInteger(validAfter) || !Number.isInteger(validBefore)) {
          return handleError(reply, 400, 'validAfter/validBefore must be integers', 'VALIDATION_ERROR');
        }
        // EIP-3009 validAfter/validBefore are EXCLUSIVE (require now > validAfter
        // && now < validBefore) per the spec. We insist validBefore is at least
        // deadlineMs / 1000 + buffer so late submitters don't lose their sig.
        const minValidBeforeSec =
          Math.ceil(Number(pool.deadlineMs) / 1000) +
          PREDICTIONS_AUTHORIZATION_BUFFER_MIN * 60;
        if (validBefore < minValidBeforeSec) {
          return handleError(
            reply,
            400,
            `validBefore must be at least ${PREDICTIONS_AUTHORIZATION_BUFFER_MIN} minutes past the pool deadline`,
            'AUTH_TOO_SHORT'
          );
        }

        if (!isValidBytes32(body.nonce) || !isValidBytes32(body.r) || !isValidBytes32(body.s)) {
          return handleError(
            reply,
            400,
            'nonce/r/s must be 0x-prefixed 32-byte hex values',
            'VALIDATION_ERROR'
          );
        }
        const v = Number(body.v);
        if (!Number.isInteger(v) || (v !== 27 && v !== 28 && v !== 0 && v !== 1)) {
          return handleError(reply, 400, 'v must be one of {0, 1, 27, 28}', 'VALIDATION_ERROR');
        }
        const nonce = String(body.nonce).toLowerCase();
        const r = String(body.r);
        const s = String(body.s);

        // Signature recover MUST equal `from`.
        const domain = await fetchEip3009Domain(pool.chainId, pool.stakeToken);
        if (!domain) {
          return handleError(
            reply,
            503,
            'Token EIP-712 metadata unavailable',
            'TOKEN_METADATA_UNAVAILABLE'
          );
        }
        const recovered = recoverEip3009Signer(
          domain,
          {
            from,
            to,
            value: String(body.value),
            validAfter,
            validBefore,
            nonce,
          },
          { v, r, s }
        );
        if (!recovered || recovered !== from) {
          return handleError(
            reply,
            401,
            'Signature does not recover the expected signer',
            'INVALID_SIGNATURE'
          );
        }

        // Reserve the Prediction row BEFORE submitting on-chain. The txHash is a
        // placeholder until the facilitator returns.
        const placeholderTxHash = `pending:${ethers.hexlify(ethers.randomBytes(16))}`;
        let reservation: { id: string };
        try {
          reservation = await prismaQuery.prediction.create({
            data: {
              poolId,
              peerAddress: from,
              peerHandle,
              winner,
              homeGoals,
              awayGoals,
              stakeAtomic: pool.entryStakeAtomic,
              txHash: placeholderTxHash,
              status: 'pending',
            },
          });
        } catch (err) {
          return handleServerError(reply, err as Error);
        }

        // Submit via the F11 facilitator. On failure, mark the reservation
        // 'refunded' (never delete — auditability).
        let submitResult: { txHash: string };
        try {
          submitResult = await submitEip3009Relay({
            chainId: pool.chainId,
            tokenAddress: pool.stakeToken,
            message: {
              from,
              to,
              value: String(body.value),
              validAfter,
              validBefore,
              nonce,
            },
            signature: { v, r, s },
          });
        } catch (err) {
          await prismaQuery.prediction
            .update({
              where: { id: reservation.id },
              data: { status: 'refunded' },
            })
            .catch(() => {
              /* best-effort */
            });
          if (err instanceof FacilitatorDisabledError) {
            return handleError(reply, 503, 'Facilitator disabled', 'FACILITATOR_DISABLED');
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
            return handleError(reply, 409, 'Nonce already used', 'NONCE_ALREADY_USED');
          }
          if (err instanceof FacilitatorRpcError) {
            return handleError(
              reply,
              502,
              'RPC submit failed',
              'RPC_SUBMIT_FAILED',
              err.cause
            );
          }
          return handleServerError(reply, err as Error);
        }

        // Patch the reservation with the real txHash + mark 'confirmed'. In
        // production we'd wait for a block-confirmation worker; hackathon scope
        // treats "relay submitted" as confirmed for the DB view. The tip
        // indexer will still eventually observe the Transfer event.
        try {
          // Sequential updates instead of $transaction so the boundary types
          // stay clean (Wave 10 models are added post-`db:push`, so a
          // $transaction array typed against the pre-migration client fights
          // the shim above). Failure between the two writes is retriable via
          // the settlement worker's next tick, which recomputes
          // totalStakedAtomic from the Prediction rows on-demand.
          await prismaQuery.prediction.update({
            where: { id: reservation.id },
            data: { status: 'confirmed', txHash: submitResult.txHash },
          });
          await prismaQuery.predictionPool.update({
            where: { id: poolId },
            data: {
              totalStakedAtomic: (
                BigInt(pool.totalStakedAtomic) + BigInt(pool.entryStakeAtomic)
              ).toString(),
            },
          });
        } catch (err) {
          return handleError(
            reply,
            500,
            'Submitted on-chain but failed to persist',
            'PREDICTION_PERSIST_FAILED',
            err as Error,
            { reservationId: reservation.id, txHash: submitResult.txHash }
          );
        }

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            id: reservation.id,
            poolId,
            txHash: submitResult.txHash,
            status: 'confirmed',
            peerAddress: shortenAddress(from),
            winner,
            homeGoals,
            awayGoals,
            stakeAtomic: pool.entryStakeAtomic,
          },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // POST /predictions/result
  // Body: { poolId, winner, homeGoals, awayGoals, hostAddress, signature }
  // ---------------------------------------------------------------------------
  app.post(
    '/result',
    {
      config: {
        rateLimit: {
          max: PREDICTIONS_OPEN_RATE_LIMIT_MAX,
          timeWindow: PREDICTIONS_OPEN_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!CURVA_PREDICTIONS_ENABLED) return sendFeatureDisabled(reply);
        const body = (request.body || {}) as Record<string, unknown>;
        const valid = await validateRequiredFields(
          body,
          ['poolId', 'winner', 'homeGoals', 'awayGoals', 'hostAddress', 'signature'],
          reply
        );
        if (valid !== true) return;

        const poolId = typeof body.poolId === 'string' ? body.poolId : '';
        if (!isValidCuid(poolId)) {
          return handleError(reply, 400, 'poolId must be a valid CUID', 'VALIDATION_ERROR');
        }
        const winner = typeof body.winner === 'string' ? body.winner : '';
        if (!isValidWinnerSide(winner)) {
          return handleError(reply, 400, 'winner is invalid', 'VALIDATION_ERROR');
        }
        const hg = Number(body.homeGoals);
        const ag = Number(body.awayGoals);
        if (!isValidGoals(hg) || !isValidGoals(ag)) {
          return handleError(reply, 400, 'goals must be integers 0..30', 'VALIDATION_ERROR');
        }
        if (deriveWinnerSide(hg, ag) !== winner) {
          return handleError(reply, 400, 'winner inconsistent with goals', 'VALIDATION_ERROR');
        }

        const hostAddressRaw = typeof body.hostAddress === 'string' ? body.hostAddress : '';
        if (!isValidEvmAddress(hostAddressRaw)) {
          return handleError(reply, 400, 'hostAddress is invalid', 'VALIDATION_ERROR');
        }
        const hostAddress = normalizeAddress(hostAddressRaw);
        const signature = typeof body.signature === 'string' ? body.signature : '';

        const pool = await prismaQuery.predictionPool.findUnique({ where: { id: poolId } });
        if (!pool) return handleError(reply, 404, 'Pool not found', 'POOL_NOT_FOUND');
        if (pool.hostAddress.toLowerCase() !== hostAddress) {
          return handleError(
            reply,
            403,
            'hostAddress does not match the pool host',
            'HOST_MISMATCH'
          );
        }
        if (pool.status === 'settled' || pool.status === 'refunded') {
          return handleError(
            reply,
            409,
            `Pool is already ${pool.status}`,
            'POOL_ALREADY_FINAL'
          );
        }

        const message = buildPoolResultMessage(poolId, winner, hg, ag);
        if (!verifyEip191Signature(message, signature, hostAddress)) {
          return handleError(reply, 403, 'Invalid host signature', 'INVALID_SIGNATURE');
        }

        // Persist the result but leave `status` as 'locked'. The settlement
        // worker picks it up on the next tick and dispatches payouts.
        try {
          const updated = await prismaQuery.predictionPool.update({
            where: { id: poolId },
            data: {
              status: 'locked',
              resultWinner: winner,
              resultHomeGoals: hg,
              resultAwayGoals: ag,
            },
          });
          return reply.code(200).send({
            success: true,
            error: null,
            data: {
              id: updated.id,
              status: updated.status,
              resultWinner: updated.resultWinner,
              resultHomeGoals: updated.resultHomeGoals,
              resultAwayGoals: updated.resultAwayGoals,
            },
          });
        } catch (err) {
          return handleServerError(reply, err as Error);
        }
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // POST /predictions/force-settle/:poolId (D2 debug endpoint)
  //
  // Body: { score: [homeScore, awayScore] }
  // Auth: bearer token via CURVA_DEBUG_BEARER env var.
  //
  // Runs the settlement pipeline synchronously with a caller-provided score.
  // Returns the settlement receipt including winner addresses + tx hashes.
  //
  // Gate contract (defence in depth):
  //   1. When CURVA_DEBUG_BEARER is unset AND NODE_ENV=production, the route
  //      returns 404 (hide-existence, matches the F11 facilitator pattern).
  //   2. When CURVA_DEBUG_BEARER is unset AND NODE_ENV != production, the
  //      route returns 503 FEATURE_DISABLED so a dev sees a helpful error
  //      instead of a mysterious 404.
  //   3. When CURVA_DEBUG_BEARER is set, the request MUST send
  //      `Authorization: Bearer <token>` verbatim.
  //   4. The route ALWAYS refuses when CURVA_PREDICTIONS_ENABLED is false.
  // ---------------------------------------------------------------------------
  app.post(
    '/force-settle/:poolId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!CURVA_PREDICTIONS_ENABLED) return sendFeatureDisabled(reply);

        const debugBearer = process.env.CURVA_DEBUG_BEARER;
        if (!debugBearer || debugBearer.length === 0) {
          // Hide-existence in prod; helpful signal in dev.
          if (IS_PROD) {
            return reply.code(404).send({
              success: false,
              error: { code: 'NOT_FOUND', message: 'Not Found' },
              data: null,
            });
          }
          return handleError(
            reply,
            503,
            'Debug endpoint disabled: set CURVA_DEBUG_BEARER to enable',
            'DEBUG_DISABLED'
          );
        }

        // Constant-time-ish bearer check. String equality is fine at this
        // token length (128 bit) because the attacker cannot mount a
        // timing oracle over the network to distinguish 32-byte prefixes.
        // If we ever move to session tokens, switch to crypto.timingSafeEqual.
        const authHeader = request.headers.authorization ?? '';
        const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
        if (!bearer || bearer !== debugBearer) {
          return handleUnauthorizedError(reply, 'Invalid debug bearer');
        }

        const { poolId } = request.params as { poolId: string };
        if (!isValidCuid(poolId)) {
          return handleError(reply, 400, 'poolId must be a valid CUID', 'VALIDATION_ERROR');
        }

        const body = (request.body || {}) as { score?: unknown };
        const score = body.score;
        if (!Array.isArray(score) || score.length !== 2) {
          return handleError(
            reply,
            400,
            'score must be a tuple [homeScore, awayScore]',
            'VALIDATION_ERROR'
          );
        }
        const homeGoals = Number(score[0]);
        const awayGoals = Number(score[1]);
        if (!isValidGoals(homeGoals) || !isValidGoals(awayGoals)) {
          return handleError(
            reply,
            400,
            'score entries must be integers 0..30',
            'VALIDATION_ERROR'
          );
        }
        const winner = deriveWinnerSide(homeGoals, awayGoals);

        // Move the pool to `locked` with the forced result so the settlement
        // worker's next tick picks it up. We invoke the worker's tick
        // synchronously via its exported test entrypoint.
        const pool = await prismaQuery.predictionPool.findUnique({ where: { id: poolId } });
        if (!pool) {
          return handleError(reply, 404, 'Pool not found', 'POOL_NOT_FOUND');
        }
        if (pool.status === 'settled' || pool.status === 'refunded') {
          return handleError(
            reply,
            409,
            `Pool is already ${pool.status}`,
            'POOL_ALREADY_FINAL'
          );
        }

        await prismaQuery.predictionPool.update({
          where: { id: poolId },
          data: {
            status: 'locked',
            resultWinner: winner,
            resultHomeGoals: homeGoals,
            resultAwayGoals: awayGoals,
          },
        });

        // Run the settlement pipeline once, in-process. The worker export is
        // idempotent under isRunning guard. A concurrent tick may lose the
        // race here, in which case we still return the current pool state
        // (the tick that wins updates the DB rows we then read below).
        const settlementWorker = await import(
          '../workers/predictionSettlementWorker.ts'
        );
        await settlementWorker.__runOnceForTest();

        // Rehydrate the pool + predictions so the receipt carries the real
        // per-winner payout tx hashes.
        const settled = await prismaQuery.predictionPool.findUnique({
          where: { id: poolId },
          include: {
            predictions: {
              select: {
                id: true,
                peerAddress: true,
                peerHandle: true,
                winner: true,
                homeGoals: true,
                awayGoals: true,
                stakeAtomic: true,
                txHash: true,
                status: true,
                payoutTxHash: true,
                payoutAmountAtomic: true,
                createdAt: true,
              },
            },
          },
        });
        if (!settled) {
          return handleError(
            reply,
            500,
            'Pool disappeared during force-settle',
            'POOL_MISSING_POST_SETTLE'
          );
        }

        const winners = (settled.predictions ?? [])
          .filter((p) => p.status === 'won')
          .map((p) => ({
            predictionId: p.id,
            peerAddress: p.peerAddress,
            payoutTxHash: p.payoutTxHash,
            payoutAmountAtomic: p.payoutAmountAtomic,
          }));

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            poolId: settled.id,
            status: settled.status,
            resultWinner: settled.resultWinner,
            resultHomeGoals: settled.resultHomeGoals,
            resultAwayGoals: settled.resultAwayGoals,
            settledAt: settled.settledAt ? settled.settledAt.toISOString() : null,
            winners,
          },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // GET /predictions/pool/:roomSlug/:matchId
  // ---------------------------------------------------------------------------
  app.get(
    '/pool/:roomSlug/:matchId',
    {
      config: {
        rateLimit: {
          max: PREDICTIONS_READ_RATE_LIMIT_MAX,
          timeWindow: PREDICTIONS_READ_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (!CURVA_PREDICTIONS_ENABLED) return sendFeatureDisabled(reply);
        const { roomSlug, matchId } = request.params as {
          roomSlug: string;
          matchId: string;
        };
        if (!isValidSlug(roomSlug)) {
          return handleError(reply, 400, 'roomSlug is invalid', 'VALIDATION_ERROR');
        }
        if (!isValidCuid(matchId)) {
          return handleError(reply, 400, 'matchId is invalid', 'VALIDATION_ERROR');
        }

        const pool = await prismaQuery.predictionPool.findUnique({
          where: { roomSlug_matchId: { roomSlug: normalizeSlug(roomSlug), matchId } },
          include: {
            predictions: {
              select: {
                id: true,
                peerAddress: true,
                peerHandle: true,
                winner: true,
                homeGoals: true,
                awayGoals: true,
                stakeAtomic: true,
                txHash: true,
                status: true,
                payoutTxHash: true,
                payoutAmountAtomic: true,
                createdAt: true,
              },
            },
          },
        });
        if (!pool) {
          return handleError(reply, 404, 'Pool not found', 'POOL_NOT_FOUND');
        }
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            id: pool.id,
            roomSlug: pool.roomSlug,
            matchId: pool.matchId,
            poolAddress: pool.poolAddress,
            chainId: pool.chainId,
            stakeToken: pool.stakeToken,
            entryStakeAtomic: pool.entryStakeAtomic,
            mode: pool.mode,
            deadlineMs: String(pool.deadlineMs),
            status: pool.status,
            totalStakedAtomic: pool.totalStakedAtomic,
            resultWinner: pool.resultWinner,
            resultHomeGoals: pool.resultHomeGoals,
            resultAwayGoals: pool.resultAwayGoals,
            settledAt: pool.settledAt ? pool.settledAt.toISOString() : null,
            predictions: (pool.predictions ?? []).map((p) => ({
              id: p.id,
              peerAddress: shortenAddress(p.peerAddress),
              peerHandle: p.peerHandle,
              winner: p.winner,
              homeGoals: p.homeGoals,
              awayGoals: p.awayGoals,
              stakeAtomic: p.stakeAtomic,
              txHash: p.txHash,
              status: p.status,
              payoutTxHash: p.payoutTxHash,
              payoutAmountAtomic: p.payoutAmountAtomic,
              createdAt: p.createdAt.toISOString(),
            })),
          },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};

// Cast helpers for the test suite. Not part of the public API.
export type { PoolMode, WinnerSide };
