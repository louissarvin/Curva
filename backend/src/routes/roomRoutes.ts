import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { validateRequiredFields } from '../utils/validationUtils.ts';
import {
  handleError,
  handleNotFoundError,
  handleServerError,
  handleUnauthorizedError,
} from '../utils/errorHandler.ts';
import {
  isValidSlug,
  isValidEvmAddress,
  isValidHostHandle,
  isValidPearLink,
  isValidCuid,
  normalizeSlug,
  normalizeAddress,
  sanitizeHostHandle,
  parseBoundedInt,
  isValidMatchStage,
  slugHasReservedPrefix,
} from '../utils/curvaValidators.ts';
import { ChallengeStore, ChallengePendingError } from '../lib/challengeStore.ts';
import {
  buildDeleteChallengeMessage,
  verifyEip191Signature,
} from '../lib/evm/signatureVerifier.ts';
import { seederSupervisor } from '../lib/pears/seeder.ts';
import { eventBus } from '../lib/activity/eventBus.ts';

// Match the masking convention from healthRoutes /metrics/live.
const maskHandle = (h: string): string => (h.length <= 3 ? h.slice(0, 1) + '***' : h.slice(0, 3) + '***');
import {
  ROOM_CHALLENGE_TTL_SECONDS,
  ROOM_DELETE_CHALLENGE_RATE_LIMIT_MAX,
  ROOM_DELETE_CHALLENGE_RATE_LIMIT_WINDOW,
  ROOM_DELETE_RATE_LIMIT_MAX,
  ROOM_DELETE_RATE_LIMIT_WINDOW,
  ROOM_MATCH_DURATION_HOURS,
  ROOM_POST_MATCH_BUFFER_HOURS,
  ROOM_RATE_LIMIT_MAX,
  ROOM_RATE_LIMIT_WINDOW,
  SEEDER_MAX_ROOMS,
} from '../config/main-config.ts';

const challengeStore = new ChallengeStore(ROOM_CHALLENGE_TTL_SECONDS);

const TEAM_SELECT = {
  id: true,
  code: true,
  name: true,
  flagUrl: true,
} as const;

const buildRoomView = (
  r: {
    id: string;
    slug: string;
    matchId: string;
    hostHandle: string;
    hostSmartAddress: string;
    hostOwnerAddress?: string | null;
    pearLink: string | null;
    expiresAt: Date;
    createdAt: Date;
    match?: {
      id: string;
      kickoffUtc: Date;
      stage: string;
      status: string;
      homeTeam: { id: string; code: string; name: string; flagUrl: string | null };
      awayTeam: { id: string; code: string; name: string; flagUrl: string | null };
    };
  },
  peerCount?: number
) => ({
  id: r.id,
  slug: r.slug,
  matchId: r.matchId,
  hostHandle: r.hostHandle,
  hostSmartAddress: r.hostSmartAddress,
  hostOwnerAddress: r.hostOwnerAddress ?? null,
  pearLink: r.pearLink,
  expiresAt: r.expiresAt.toISOString(),
  createdAt: r.createdAt.toISOString(),
  peerCount: peerCount ?? 0,
  match: r.match
    ? {
        id: r.match.id,
        kickoffUtc: r.match.kickoffUtc.toISOString(),
        stage: r.match.stage,
        status: r.match.status,
        homeTeam: r.match.homeTeam,
        awayTeam: r.match.awayTeam,
      }
    : undefined,
});

export const roomRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // POST /rooms — rate-limited
  app.post(
    '/',
    {
      config: {
        rateLimit: { max: ROOM_RATE_LIMIT_MAX, timeWindow: ROOM_RATE_LIMIT_WINDOW },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = (request.body || {}) as Record<string, unknown>;
        const valid = await validateRequiredFields(
          body,
          ['slug', 'matchId', 'hostHandle', 'hostSmartAddress', 'hostOwnerAddress'],
          reply
        );
        if (valid !== true) return;

        const rawSlug = String(body.slug);
        const slug = normalizeSlug(rawSlug);
        const matchId = String(body.matchId);
        const hostHandle = sanitizeHostHandle(String(body.hostHandle));
        const hostSmartAddressRaw = String(body.hostSmartAddress);
        const hostSmartAddress = normalizeAddress(hostSmartAddressRaw);
        const hostOwnerAddressRaw = String(body.hostOwnerAddress);
        const hostOwnerAddress = normalizeAddress(hostOwnerAddressRaw);
        const pearLinkRaw = body.pearLink ? String(body.pearLink) : null;

        if (!isValidSlug(slug)) {
          return handleError(
            reply,
            400,
            'slug must match ^[a-z0-9]([a-z0-9-]{2,30})[a-z0-9]$ (4-32 chars)',
            'VALIDATION_ERROR'
          );
        }
        // auto-* slugs are owned by matchAutoWarmWorker (ARCHITECTURE.md F2).
        // Reject public registration so an attacker cannot squat on the
        // deterministic auto-<matchId> namespace and divert tips intended for
        // the house room. See SECURITY_AUDIT.md W2-HIGH-01.
        if (slugHasReservedPrefix(slug)) {
          return handleError(
            reply,
            400,
            "Slugs prefixed with 'auto-' are reserved for the Curva auto-warm system.",
            'RESERVED_SLUG_PREFIX'
          );
        }
        if (!isValidCuid(matchId)) {
          return handleError(reply, 400, 'matchId must be a valid cuid', 'VALIDATION_ERROR');
        }
        if (!isValidHostHandle(hostHandle)) {
          return handleError(
            reply,
            400,
            'hostHandle must be 1-32 chars (no control chars)',
            'VALIDATION_ERROR'
          );
        }
        if (!isValidEvmAddress(hostSmartAddressRaw)) {
          return handleError(reply, 400, 'hostSmartAddress must be a valid EVM address', 'VALIDATION_ERROR');
        }
        if (!isValidEvmAddress(hostOwnerAddressRaw)) {
          return handleError(
            reply,
            400,
            'hostOwnerAddress must be a valid EVM address (the EOA controlling the WDK Safe; used to verify deletion signatures)',
            'VALIDATION_ERROR'
          );
        }
        if (pearLinkRaw !== null && !isValidPearLink(pearLinkRaw)) {
          return handleError(
            reply,
            400,
            'pearLink must start with pear:// and be <= 200 chars',
            'VALIDATION_ERROR'
          );
        }

        // Verify match exists
        const match = await prismaQuery.match.findUnique({ where: { id: matchId } });
        if (!match) return handleNotFoundError(reply, 'Match');

        // expiresAt = kickoff + 4h match window + 24h post-match buffer
        const expiresAt = new Date(
          match.kickoffUtc.getTime() +
            (ROOM_MATCH_DURATION_HOURS + ROOM_POST_MATCH_BUFFER_HOURS) * 60 * 60 * 1000
        );

        // Pre-check cap (cheap, avoids burning a DB roundtrip when obviously over).
        // The authoritative check happens inside spawnRoom() below.
        if (
          seederSupervisor.isEnabled() &&
          seederSupervisor.getActiveRoomCount() >= SEEDER_MAX_ROOMS
        ) {
          return handleError(
            reply,
            503,
            `Seeder at capacity (${SEEDER_MAX_ROOMS} rooms)`,
            'SEEDER_AT_CAPACITY'
          );
        }

        // Insert (slug unique constraint enforces no collision)
        let room;
        try {
          room = await prismaQuery.room.create({
            data: {
              slug,
              matchId,
              hostHandle,
              hostSmartAddress,
              hostOwnerAddress,
              pearLink: pearLinkRaw,
              expiresAt,
            },
          });
        } catch (err) {
          // Prisma unique-constraint failure => 409
          const code = (err as { code?: string }).code;
          const meta = (err as { meta?: { target?: string[] | string } }).meta;
          const target = meta?.target;
          const onSlug = Array.isArray(target) ? target.includes('slug') : target === 'slug';
          if (code === 'P2002' && onSlug) {
            return handleError(reply, 409, 'Slug already taken', 'SLUG_TAKEN');
          }
          throw err;
        }

        // Try-spawn-then-rollback: spawnRoom() is the authoritative cap gate.
        // If it refuses (race with concurrent registrations), soft-delete the
        // freshly-inserted row so the rooms table doesn't fill with orphans.
        // See SECURITY_AUDIT.md HIGH-02.
        if (seederSupervisor.isEnabled()) {
          const spawned = seederSupervisor.spawnRoom(slug);
          if (!spawned) {
            await prismaQuery.room
              .update({ where: { slug }, data: { deletedAt: new Date() } })
              .catch((e) => console.error('[Rooms] cap-rollback failed:', (e as Error)?.message));
            return handleError(
              reply,
              503,
              `Seeder at capacity (${SEEDER_MAX_ROOMS} rooms)`,
              'SEEDER_AT_CAPACITY'
            );
          }
        }

        // F1: publish to activity feed (handle masked per HIGH-04).
        try {
          eventBus.publish('room.created', {
            slug: room.slug,
            matchId: room.matchId,
            hostHandle: maskHandle(room.hostHandle),
            isAutoWarmed: false,
          });
        } catch (err) {
          console.warn('[Rooms] eventBus publish failed:', (err as Error)?.message);
        }

        return reply.code(201).send({
          success: true,
          error: null,
          data: { room: buildRoomView(room) },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // GET /rooms
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const q = (request.query || {}) as Record<string, unknown>;
      const matchId = typeof q.matchId === 'string' ? q.matchId : undefined;
      const stage = typeof q.stage === 'string' ? q.stage : undefined;
      const activeOnly = q.activeOnly !== 'false'; // default true
      const limit = parseBoundedInt(q.limit, 1, 100, 50);
      const offset = parseBoundedInt(q.offset, 0, 100000, 0);

      if (matchId !== undefined && !isValidCuid(matchId)) {
        return handleError(reply, 400, 'Invalid matchId', 'VALIDATION_ERROR');
      }
      if (stage !== undefined && !isValidMatchStage(stage)) {
        return handleError(reply, 400, 'Invalid stage', 'VALIDATION_ERROR');
      }

      const where: Record<string, unknown> = {};
      if (activeOnly) {
        where.deletedAt = null;
        where.expiresAt = { gt: new Date() };
      }
      if (matchId) where.matchId = matchId;
      if (stage) where.match = { stage };

      const [rooms, total] = await Promise.all([
        prismaQuery.room.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
          include: {
            match: {
              select: {
                id: true,
                kickoffUtc: true,
                stage: true,
                status: true,
                homeTeam: { select: TEAM_SELECT },
                awayTeam: { select: TEAM_SELECT },
              },
            },
          },
        }),
        prismaQuery.room.count({ where }),
      ]);

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          rooms: rooms.map((r) =>
            buildRoomView(r, seederSupervisor.getTelemetry(r.slug)?.peerCount ?? 0)
          ),
          pagination: { limit, offset, total },
        },
      });
    } catch (err) {
      return handleServerError(reply, err as Error);
    }
  });

  // GET /rooms/:slug
  app.get('/:slug', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { slug } = request.params as { slug: string };
      if (!isValidSlug(slug)) return handleError(reply, 400, 'Invalid slug', 'VALIDATION_ERROR');

      const room = await prismaQuery.room.findUnique({
        where: { slug },
        include: {
          match: {
            select: {
              id: true,
              kickoffUtc: true,
              stage: true,
              status: true,
              homeTeam: { select: TEAM_SELECT },
              awayTeam: { select: TEAM_SELECT },
            },
          },
        },
      });
      if (!room || room.deletedAt || room.expiresAt < new Date()) {
        return handleNotFoundError(reply, 'Room');
      }
      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          room: buildRoomView(room, seederSupervisor.getTelemetry(slug)?.peerCount ?? 0),
        },
      });
    } catch (err) {
      return handleServerError(reply, err as Error);
    }
  });

  // GET /rooms/:slug/delete-challenge — per-IP rate-limited (3/min) to throttle
  // attackers who probe for valid slugs. The challenge store itself is also
  // non-overwriting so spammers can't invalidate a host's in-flight signature.
  app.get(
    '/:slug/delete-challenge',
    {
      config: {
        rateLimit: {
          max: ROOM_DELETE_CHALLENGE_RATE_LIMIT_MAX,
          timeWindow: ROOM_DELETE_CHALLENGE_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { slug } = request.params as { slug: string };
        if (!isValidSlug(slug)) return handleError(reply, 400, 'Invalid slug', 'VALIDATION_ERROR');

        const room = await prismaQuery.room.findUnique({ where: { slug } });
        if (!room || room.deletedAt) return handleNotFoundError(reply, 'Room');

        let challenge: string;
        let expiresIn: number;
        try {
          const issued = challengeStore.issue(slug);
          challenge = issued.challenge;
          expiresIn = issued.expiresIn;
        } catch (err) {
          if (err instanceof ChallengePendingError) {
            return handleError(
              reply,
              503,
              'Challenge store at capacity; retry shortly',
              'CHALLENGE_STORE_FULL'
            );
          }
          throw err;
        }
        const signPayload = buildDeleteChallengeMessage(slug, challenge);

        return reply.code(200).send({
          success: true,
          error: null,
          data: { challenge, expiresIn, signPayload },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // DELETE /rooms/:slug — rate-limited
  app.delete(
    '/:slug',
    {
      config: {
        rateLimit: {
          max: ROOM_DELETE_RATE_LIMIT_MAX,
          timeWindow: ROOM_DELETE_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { slug } = request.params as { slug: string };
        if (!isValidSlug(slug)) return handleError(reply, 400, 'Invalid slug', 'VALIDATION_ERROR');

        const body = (request.body || {}) as Record<string, unknown>;
        const valid = await validateRequiredFields(body, ['challenge', 'signature'], reply);
        if (valid !== true) return;

        const challenge = String(body.challenge);
        const signature = String(body.signature);

        const room = await prismaQuery.room.findUnique({ where: { slug } });
        if (!room || room.deletedAt) return handleNotFoundError(reply, 'Room');

        // Atomic consume — single-use, prevents replay.
        if (!challengeStore.consume(slug, challenge)) {
          return handleUnauthorizedError(reply, 'Challenge invalid or expired');
        }

        // We recover the EOA from EIP-191 personal_sign and compare to the
        // host-registered OWNER EOA, not the smart-account address. The Safe
        // smart-account address would never match an ECDSA recovery result.
        // ERC-1271 smart-account direct signing (where verification is an
        // on-chain isValidSignature() call) is v2.
        if (!room.hostOwnerAddress) {
          return handleError(
            reply,
            409,
            'Room has no hostOwnerAddress; host must re-register to enable signature-based deletion',
            'OWNER_ADDRESS_MISSING'
          );
        }

        const message = buildDeleteChallengeMessage(slug, challenge);
        const ok = verifyEip191Signature(message, signature, room.hostOwnerAddress);
        if (!ok) {
          return handleError(reply, 401, 'Invalid signature', 'INVALID_SIGNATURE');
        }

        await prismaQuery.room.update({
          where: { slug },
          data: { deletedAt: new Date() },
        });

        // Tear down the seeder subprocess if running.
        seederSupervisor.stopRoom(slug);

        // F1: publish to activity feed.
        try {
          eventBus.publish('room.deleted', { slug, reason: 'host' });
        } catch (err) {
          console.warn('[Rooms] eventBus publish failed:', (err as Error)?.message);
        }

        return reply.code(200).send({
          success: true,
          error: null,
          data: { deleted: true },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // GET /rooms/:slug/peers
  app.get('/:slug/peers', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { slug } = request.params as { slug: string };
      if (!isValidSlug(slug)) return handleError(reply, 400, 'Invalid slug', 'VALIDATION_ERROR');

      const room = await prismaQuery.room.findUnique({
        where: { slug },
        select: { id: true, deletedAt: true, expiresAt: true },
      });
      if (!room || room.deletedAt || room.expiresAt < new Date()) {
        return handleNotFoundError(reply, 'Room');
      }

      const telemetry = seederSupervisor.getTelemetry(slug);
      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          slug,
          peerCount: telemetry?.peerCount ?? 0,
          lifetimeBytes: telemetry?.lifetimeBytes ?? 0,
          uptimeMs: telemetry?.uptimeMs ?? 0,
          lastUpdated: telemetry?.lastUpdated ?? null,
          seederEnabled: seederSupervisor.isEnabled(),
        },
      });
    } catch (err) {
      return handleServerError(reply, err as Error);
    }
  });

  done();
};
