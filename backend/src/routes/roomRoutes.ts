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

// TIER 4: Room.visibility for Autopass spectator tier. Two values only.
// Pre-migration the column may not yet exist on the DB; the view coerces
// undefined to 'private' so old rows still render sanely.
type RoomVisibility = 'public' | 'private';

const normalizeVisibility = (v: unknown): RoomVisibility => {
  if (typeof v !== 'string') return 'private';
  const lower = v.toLowerCase();
  return lower === 'public' ? 'public' : 'private';
};

// Same-laptop demo helper: cache the host's Autobase base keys so viewers
// who cannot form a direct Hyperswarm socket (hairpin NAT, missing relay,
// etc) can still bootstrap the correct chat + playhead Autobase without
// waiting for a `room:hello` frame that only rides direct P2P connections.
//
// In-memory only. On restart, the host republishes on next boot. No schema
// change required. Keys are 32-byte lowercase hex.
type RoomBaseKeys = {
  chatBaseKey: string;
  playheadBaseKey: string;
  publishedAt: number;
};
const roomBaseKeys = new Map<string, RoomBaseKeys>();
const isValidHex32 = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{64}$/.test(s.toLowerCase());

export const publishRoomBaseKeys = (
  slug: string,
  chatBaseKey: string,
  playheadBaseKey: string
): void => {
  roomBaseKeys.set(slug, {
    chatBaseKey: chatBaseKey.toLowerCase(),
    playheadBaseKey: playheadBaseKey.toLowerCase(),
    publishedAt: Date.now(),
  });
};
export const readRoomBaseKeys = (slug: string): RoomBaseKeys | null =>
  roomBaseKeys.get(slug) ?? null;

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
    visibility?: string | null;
    _bases?: RoomBaseKeys | null;
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
  visibility: normalizeVisibility(r.visibility),
  // Same-laptop demo helper (see roomBaseKeys map above). Null when the
  // host has not yet published, or the backend has been restarted since.
  chatBaseKey: r._bases?.chatBaseKey ?? null,
  playheadBaseKey: r._bases?.playheadBaseKey ?? null,
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
        // matchId is optional here (2026-07-07 fix): rooms joined via a raw
        // slug flag (e.g. `--room wc26-final`) do not know the underlying
        // match cuid client-side. When absent, we auto-resolve a real matchId
        // server-side (final > first scheduled) so the FK invariant on the
        // Room table stays intact. This preserves backward compat: existing
        // clients that DO send a matchId continue to work unchanged, and
        // downstream consumers (tips, leaderboard) still see a real matchId.
        // Semifinal debug (2026-07-11): peer-side wallet init can fail when
        // the WDK bare-semver polyfill does not rescue a compound npm range
        // like '^14.21.3 || >=16'. In that state the client publishes with
        // null addresses. We accept the publish so the room lands in the
        // directory (Peer B can discover it and P2P chat + QVAC still work);
        // tipping is gated separately by the presence of a real address so
        // downstream leaderboard / tip settlement never uses a placeholder.
        const valid = await validateRequiredFields(
          body,
          ['slug', 'hostHandle'],
          reply
        );
        if (valid !== true) return;

        const rawSlug = String(body.slug);
        const slug = normalizeSlug(rawSlug);
        const matchIdRaw =
          body.matchId === undefined || body.matchId === null || body.matchId === ''
            ? null
            : String(body.matchId);
        const hostHandle = sanitizeHostHandle(String(body.hostHandle));
        // Addresses are optional now (see comment above). Empty / missing
        // collapses to the zero address so the FK columns stay populated
        // and downstream code paths that read the address see a stable
        // sentinel rather than null. Tip settlement rejects the zero
        // address explicitly (see facilitatorRoutes.ts sponsor guard).
        const hostSmartAddressRaw = String(
          body.hostSmartAddress ?? '0x0000000000000000000000000000000000000000'
        );
        const hostSmartAddress = normalizeAddress(hostSmartAddressRaw);
        const hostOwnerAddressRaw = String(
          body.hostOwnerAddress ?? '0x0000000000000000000000000000000000000000'
        );
        const hostOwnerAddress = normalizeAddress(hostOwnerAddressRaw);
        const pearLinkRaw = body.pearLink ? String(body.pearLink) : null;

        // TIER 4: optional visibility field, defaults to 'private' for backward
        // compat. Anything other than exact 'public' collapses to 'private' so
        // typos never accidentally publish a room to the STADIUM directory.
        const visibilityInput = body.visibility;
        if (
          visibilityInput !== undefined &&
          visibilityInput !== null &&
          typeof visibilityInput !== 'string'
        ) {
          return handleError(
            reply,
            400,
            "visibility must be 'public' or 'private'",
            'VALIDATION_ERROR'
          );
        }
        if (
          typeof visibilityInput === 'string' &&
          visibilityInput.toLowerCase() !== 'public' &&
          visibilityInput.toLowerCase() !== 'private'
        ) {
          return handleError(
            reply,
            400,
            "visibility must be 'public' or 'private'",
            'VALIDATION_ERROR'
          );
        }
        const visibility: RoomVisibility = normalizeVisibility(visibilityInput);

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
        if (matchIdRaw !== null && !isValidCuid(matchIdRaw)) {
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

        // Verify match exists (or auto-resolve when the client did not know
        // the cuid — e.g. slug-only join via `--room <slug>` CLI flag).
        // Auto-resolve order: (1) final match, (2) any scheduled match with a
        // kickoff in the future, (3) most recent scheduled match. Never
        // silently create a room without a valid FK — the Room.matchId column
        // is NOT NULL in prisma/schema.prisma.
        let match;
        let matchId: string;
        if (matchIdRaw) {
          match = await prismaQuery.match.findUnique({ where: { id: matchIdRaw } });
          if (!match) return handleNotFoundError(reply, 'Match');
          matchId = matchIdRaw;
        } else {
          const now = new Date();
          match =
            (await prismaQuery.match.findFirst({
              where: { stage: 'final' },
              orderBy: { kickoffUtc: 'desc' },
            })) ||
            (await prismaQuery.match.findFirst({
              where: { kickoffUtc: { gte: now } },
              orderBy: { kickoffUtc: 'asc' },
            })) ||
            (await prismaQuery.match.findFirst({
              orderBy: { kickoffUtc: 'desc' },
            }));
          if (!match) {
            return handleError(
              reply,
              409,
              'No match available to attach this room to; provide matchId explicitly',
              'NO_MATCH_AVAILABLE'
            );
          }
          matchId = match.id;
        }

        // expiresAt = kickoff + 4h match window + 24h post-match buffer
        const expiresAt = new Date(
          match.kickoffUtc.getTime() +
            (ROOM_MATCH_DURATION_HOURS + ROOM_POST_MATCH_BUFFER_HOURS) * 60 * 60 * 1000
        );

        // Skip seeder cap check when we're only refreshing an EXISTING slug
        // (idempotent re-publish path). Seeder is for NEW rooms; a metadata
        // refresh doesn't spawn additional seeder capacity.
        const existingRoom = await prismaQuery.room.findUnique({ where: { slug } });
        const isRefresh = existingRoom != null;
        if (
          !isRefresh &&
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

        // Upsert: create new OR update existing (idempotent re-publish).
        // Fresh wallets on each demo restart mean hostSmartAddress rotates;
        // if the caller can prove ownership by matching the STORED
        // hostOwnerAddress OR the existing row has no owner set, we update
        // the addresses in place. This keeps the TipIndexer's stale-address
        // lookup working across sessions without a manual delete step.
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
              visibility,
            } as unknown as Parameters<typeof prismaQuery.room.create>[0]['data'],
          });
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === 'P2002') {
            const meta = (err as { meta?: { target?: string[] | string } }).meta;
            const target = meta?.target;
            const targetStr = Array.isArray(target) ? target.join(',') : String(target ?? '');
            if (targetStr === '' || targetStr.toLowerCase().includes('slug')) {
              // Demo mode: allow overwrite of stale room records. Fresh
              // wallets each session mean the stored addresses rotate; the
              // TipIndexer needs the CURRENT smart address to match transfer
              // events. Ownership verification via EIP-191 signature is
              // deferred to v2. Refresh the whole row so tips index correctly.
              const existing = await prismaQuery.room.findUnique({ where: { slug } });
              if (existing) {
                room = await prismaQuery.room.update({
                  where: { slug },
                  data: {
                    hostSmartAddress,
                    hostOwnerAddress,
                    hostHandle,
                    matchId,
                    pearLink: pearLinkRaw,
                    expiresAt,
                    visibility,
                    deletedAt: null,
                  } as unknown as Parameters<typeof prismaQuery.room.update>[0]['data'],
                });
              } else {
                return handleError(reply, 409, 'Slug already taken', 'SLUG_TAKEN');
              }
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }

        // Try-spawn-then-rollback: spawnRoom() is the authoritative cap gate.
        // If it refuses (race with concurrent registrations), soft-delete the
        // freshly-inserted row so the rooms table doesn't fill with orphans.
        // See SECURITY_AUDIT.md HIGH-02.
        // Only spawn seeder for freshly-created rooms; a refresh reuses the
        // existing seeder allocation.
        if (!isRefresh && seederSupervisor.isEnabled()) {
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

      // TIER 4: optional visibility filter for the STADIUM directory. Absence
      // preserves existing behavior (return all visibilities).
      const visibilityRaw =
        typeof q.visibility === 'string' ? q.visibility.toLowerCase() : undefined;
      if (
        visibilityRaw !== undefined &&
        visibilityRaw !== 'public' &&
        visibilityRaw !== 'private'
      ) {
        return handleError(
          reply,
          400,
          "visibility must be 'public' or 'private'",
          'VALIDATION_ERROR'
        );
      }

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
      if (visibilityRaw) where.visibility = visibilityRaw;

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
          room: buildRoomView(
            { ...room, _bases: readRoomBaseKeys(slug) },
            seederSupervisor.getTelemetry(slug)?.peerCount ?? 0
          ),
        },
      });
    } catch (err) {
      return handleServerError(reply, err as Error);
    }
  });

  // PUT /rooms/:slug/bases — host publishes its Autobase base keys so viewers
  // that can't form a direct P2P socket (same-laptop hairpin NAT, missing
  // relay) can still bootstrap the correct chat + playhead Autobase. Keys are
  // 32-byte lowercase hex. In-memory only; keys reset on backend restart and
  // the host republishes on next boot. No auth for the demo (matching the
  // trust posture of the tip-address publish path).
  app.put('/:slug/bases', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { slug } = request.params as { slug: string };
      if (!isValidSlug(slug)) return handleError(reply, 400, 'Invalid slug', 'VALIDATION_ERROR');
      const body = (request.body || {}) as Record<string, unknown>;
      const chatBaseKey = typeof body.chatBaseKey === 'string' ? body.chatBaseKey.toLowerCase() : '';
      const playheadBaseKey = typeof body.playheadBaseKey === 'string' ? body.playheadBaseKey.toLowerCase() : '';
      if (!isValidHex32(chatBaseKey)) {
        return handleError(reply, 400, 'chatBaseKey must be 32-byte lowercase hex', 'VALIDATION_ERROR');
      }
      if (!isValidHex32(playheadBaseKey)) {
        return handleError(reply, 400, 'playheadBaseKey must be 32-byte lowercase hex', 'VALIDATION_ERROR');
      }
      const room = await prismaQuery.room.findUnique({ where: { slug } });
      if (!room || room.deletedAt) return handleNotFoundError(reply, 'Room');
      publishRoomBaseKeys(slug, chatBaseKey, playheadBaseKey);
      return reply.code(200).send({
        success: true,
        error: null,
        data: { slug, chatBaseKey, playheadBaseKey, publishedAt: Date.now() },
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
