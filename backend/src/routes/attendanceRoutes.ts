/**
 * Attendance Pass verifier (Wave 14).
 *
 *   GET /wdk/verify-attendance/:slug/:address?signature=<sig>&matchId=<id>&issuedAt=<sec>
 *
 * Verifies an off-chain EIP-191 attendance signature that a room host issues to
 * every peer that joins their room. The pass is not stored server-side by
 * default — the pear app writes it to the shared room-state Hyperbee and to
 * chat as `system:attendance-issued`. Any peer (or third party) can hit this
 * endpoint to independently recover the host address and confirm the pass has
 * not expired.
 *
 * If the room slug matches a registered `Room` row AND that row has a
 * `hostOwnerAddress` set, the recovered signer is required to match it,
 * hardening the verifier against unregistered spoofers. Rooms without a
 * registered owner still return a valid result (off-chain trust).
 *
 * Auth: none. Every value in the response is derivable from public bytes.
 *
 * Feature flag: CURVA_ATTENDANCE_ENABLED. When off, every request returns
 * 503 FEATURE_DISABLED so the existing test suite is unaffected.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  CURVA_ATTENDANCE_ENABLED,
  CURVA_ATTENDANCE_MAX_AGE_SECONDS,
  CURVA_ATTENDANCE_RATE_LIMIT_MAX,
  CURVA_ATTENDANCE_RATE_LIMIT_WINDOW,
} from '../config/main-config.ts';
import { handleError, handleServerError } from '../utils/errorHandler.ts';
import {
  isValidEvmAddress,
  isValidSlug,
  normalizeAddress,
  normalizeSlug,
} from '../utils/curvaValidators.ts';
import { shortenAddress } from '../utils/miscUtils.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { verifyAttendancePass } from '../lib/evm/attendance.ts';

interface Params {
  slug: string;
  address: string;
}

interface Query {
  signature?: string;
  matchId?: string;
  issuedAt?: string | number;
}

export const attendanceRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get(
    '/:slug/:address',
    {
      config: {
        rateLimit: {
          max: CURVA_ATTENDANCE_RATE_LIMIT_MAX,
          timeWindow: CURVA_ATTENDANCE_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: Params; Querystring: Query }>,
      reply: FastifyReply
    ) => {
      try {
        if (!CURVA_ATTENDANCE_ENABLED) {
          return handleError(
            reply,
            503,
            'Attendance feature is disabled',
            'FEATURE_DISABLED'
          );
        }

        const { slug: rawSlug, address: rawAddr } = request.params;
        const q = request.query || {};

        // Ingress validation. Reject before touching the DB or the recover
        // routine so garbage inputs never reach ethers.verifyMessage.
        if (!isValidSlug(rawSlug)) {
          return handleError(reply, 400, 'Invalid room slug', 'VALIDATION_ERROR');
        }
        if (!isValidEvmAddress(rawAddr)) {
          return handleError(reply, 400, 'Invalid peer EVM address', 'VALIDATION_ERROR');
        }
        const signature = typeof q.signature === 'string' ? q.signature : '';
        if (!/^0x[0-9a-fA-F]{130,132}$/.test(signature)) {
          return handleError(
            reply,
            400,
            'signature must be a 65-byte hex signature (0x + 130 hex chars)',
            'VALIDATION_ERROR'
          );
        }
        const issuedAtRaw = q.issuedAt;
        const issuedAt = Math.floor(Number(issuedAtRaw));
        if (!Number.isFinite(issuedAt) || issuedAt <= 0) {
          return handleError(
            reply,
            400,
            'issuedAt must be a positive unix-second integer',
            'VALIDATION_ERROR'
          );
        }
        const matchId =
          typeof q.matchId === 'string' && q.matchId.length > 0 ? q.matchId : null;
        if (matchId !== null && !/^[a-zA-Z0-9_-]{1,64}$/.test(matchId)) {
          return handleError(reply, 400, 'Invalid matchId', 'VALIDATION_ERROR');
        }

        const slug = normalizeSlug(rawSlug);
        const peerAddress = normalizeAddress(rawAddr);

        // Best-effort room lookup. When the slug is registered AND has a
        // hostOwnerAddress, we require the recovered signer to match it.
        // Unregistered slugs still verify (off-chain trust model).
        let expectedHostAddress: string | null = null;
        let roomMatchId: string | null = null;
        try {
          const room = await prismaQuery.room.findFirst({
            where: { slug, deletedAt: null },
            select: { hostOwnerAddress: true, matchId: true },
          });
          if (room?.hostOwnerAddress) {
            expectedHostAddress = room.hostOwnerAddress.toLowerCase();
          }
          if (room?.matchId) {
            roomMatchId = room.matchId;
          }
        } catch {
          // Non-fatal: verification is off-chain regardless of DB availability.
        }

        const result = verifyAttendancePass({
          slug,
          matchId,
          peerAddress,
          issuedAt,
          signature,
          expectedHostAddress,
          maxAgeSeconds: CURVA_ATTENDANCE_MAX_AGE_SECONDS,
        });

        if (!result.valid) {
          // Distinguish expiry from generic mismatch so clients can render a
          // proper "pass expired" state without guessing.
          if (result.reason === 'EXPIRED') {
            return handleError(
              reply,
              410,
              'Attendance pass has expired',
              'PASS_EXPIRED'
            );
          }
          if (result.reason === 'HOST_MISMATCH') {
            return handleError(
              reply,
              400,
              'Signature recovered to a different host address',
              'HOST_MISMATCH'
            );
          }
          if (
            result.reason === 'SIGNATURE_MALFORMED' ||
            result.reason === 'SIGNATURE_MISMATCH'
          ) {
            return handleError(
              reply,
              400,
              'Signature does not verify against the canonical attendance message',
              'SIGNATURE_INVALID'
            );
          }
          return handleError(reply, 400, 'Invalid attendance pass', 'VALIDATION_ERROR');
        }

        const hostAddress = result.recoveredHostAddress ?? '';
        const ageSeconds = result.ageSeconds ?? 0;
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            valid: true,
            slug,
            matchId: matchId ?? roomMatchId,
            peerAddress,
            peerAddressShort: shortenAddress(peerAddress, 6, 4),
            hostAddress,
            hostAddressShort: shortenAddress(hostAddress, 6, 4),
            issuedAt,
            ageSeconds,
            ageHours: Number((ageSeconds / 3600).toFixed(2)),
            registered: expectedHostAddress !== null,
            signature,
          },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};
