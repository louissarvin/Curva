/**
 * Activity feed routes (F1).
 *
 *   GET /activity/stream — SSE stream
 *   GET /activity        — paginated history (JSON envelope)
 *
 * /activity/stream is the ONE endpoint in this codebase that does not use the
 * standard `{success,error,data}` envelope because Content-Type is text/event-stream.
 *
 * Cap enforcement: SSE_MAX_CONNECTIONS. Over the cap we return 503 with the
 * envelope (the request never escalates to a stream).
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { eventBus, isValidTopic, type EventBusEvent, type EventTopic } from '../lib/activity/eventBus.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { handleError, handleServerError } from '../utils/errorHandler.ts';
import { parseBoundedInt } from '../utils/curvaValidators.ts';
import { shortenAddress } from '../utils/miscUtils.ts';
import { formatUsdt } from '../lib/evm/usdtIndexer.ts';
import {
  ACTIVITY_HISTORY_RATE_LIMIT_MAX,
  ACTIVITY_HISTORY_RATE_LIMIT_WINDOW,
  SSE_MAX_CONNECTIONS_PER_IP,
} from '../config/main-config.ts';

const HEARTBEAT_MS = 30_000;

// Per-IP SSE connection tracker. SSE connections are long-lived, so a token-
// bucket rate limit cannot prevent a single attacker from holding hundreds of
// connections. We track the open set per IP and reject the (N+1)th. See
// SECURITY_AUDIT.md W2-HIGH-02.
const sseConnectionsByIp = new Map<string, Set<symbol>>();
const sseAddConnection = (ip: string, token: symbol): void => {
  let set = sseConnectionsByIp.get(ip);
  if (!set) {
    set = new Set<symbol>();
    sseConnectionsByIp.set(ip, set);
  }
  set.add(token);
};
const sseRemoveConnection = (ip: string, token: symbol): void => {
  const set = sseConnectionsByIp.get(ip);
  if (!set) return;
  set.delete(token);
  if (set.size === 0) sseConnectionsByIp.delete(ip);
};
const sseCountForIp = (ip: string): number => sseConnectionsByIp.get(ip)?.size ?? 0;
// Test-only: reset the per-IP tracker between test cases.
export const __sseResetConnectionsForTest = (): void => {
  sseConnectionsByIp.clear();
};

const parseTopicsQuery = (raw: unknown): Set<EventTopic> | undefined => {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  const out = new Set<EventTopic>();
  for (const p of parts) {
    if (isValidTopic(p)) out.add(p);
  }
  return out.size > 0 ? out : undefined;
};

const writeEvent = (reply: FastifyReply, ev: EventBusEvent): boolean => {
  // Single-line JSON in data:. SSE expects: id:, event:, data:, blank line.
  const dataLine = JSON.stringify({ type: ev.type, ts: ev.ts, payload: ev.payload });
  const frame = `id: ${ev.id}\nevent: ${ev.type}\ndata: ${dataLine}\n\n`;
  // raw.write returns false when the kernel buffer is full; surface as a drop.
  const ok = reply.raw.write(frame);
  if (!ok) eventBus.noteDropped();
  return ok;
};

export const activityRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // ---------------------------------------------------------------------------
  // GET /activity/stream — SSE
  //
  // Connection cap policy (see ARCHITECTURE.md Section 19 F1 + SECURITY_AUDIT
  // W2-HIGH-02):
  //  1. Global cap: SSE_MAX_CONNECTIONS (default 1000) enforced inside EventBus.
  //  2. Per-IP cap: SSE_MAX_CONNECTIONS_PER_IP (default 5). Tracked in a local
  //     Map of IP -> Set<connectionId>. Long-lived connections cannot be evicted
  //     by a token-bucket rate limit, so we reject the (N+1)th explicitly.
  // ---------------------------------------------------------------------------
  app.get(
    '/stream',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // request.ip uses Fastify's trustProxy config (numeric hop count, per
      // SECURITY_AUDIT HIGH-01), so this is the client IP after exactly N
      // proxy hops; an attacker cannot spoof it via X-Forwarded-For.
      const ip = request.ip;
      if (sseCountForIp(ip) >= SSE_MAX_CONNECTIONS_PER_IP) {
        // Best-effort SSE-shaped error frame so an EventSource client can
        // surface the reason. Then close.
        try {
          reply.raw.writeHead(429, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'close',
          });
          reply.raw.write('event: error\ndata: {"code":"SSE_PER_IP_LIMIT"}\n\n');
          reply.raw.end();
          reply.hijack();
        } catch {
          // If the raw socket is already broken, fall through to handleError.
          if (!reply.sent) {
            return handleError(
              reply,
              429,
              'Too many SSE connections from this IP',
              'SSE_PER_IP_LIMIT'
            );
          }
        }
        return;
      }

      // Global cap BEFORE we hijack the response.
      if (eventBus.getConnectionCount() >= eventBus.getStats().maxConnections) {
        return handleError(
          reply,
          503,
          'SSE connection limit reached; retry shortly',
          'SSE_OVERLOADED'
        );
      }

      const q = (request.query || {}) as Record<string, unknown>;
      const topics = parseTopicsQuery(q.topics);

      // Last-Event-ID can come as a header (browser EventSource auto-sends it on
      // reconnect) or as a query param for curl convenience.
      const lastEventIdHeader = request.headers['last-event-id'];
      const lastEventId =
        (typeof lastEventIdHeader === 'string' ? lastEventIdHeader : undefined) ||
        (typeof q.lastEventId === 'string' ? q.lastEventId : undefined);

      // SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Disable nginx / Fly.io edge buffering on this stream.
        'X-Accel-Buffering': 'no',
      });

      // Tell the client how long to wait before reconnecting.
      reply.raw.write('retry: 5000\n\n');

      // Reserve a per-IP slot now that we are committing to a live stream.
      const connectionToken = Symbol('sse-conn');
      sseAddConnection(ip, connectionToken);

      // Replay missed events from the ring buffer.
      const backlog = eventBus.getHistorySince(lastEventId, { topics });
      for (const ev of backlog) {
        writeEvent(reply, ev);
      }

      // Subscribe to live events.
      const unsubscribe = eventBus.subscribe(
        (ev) => {
          writeEvent(reply, ev);
        },
        { topics }
      );

      if (!unsubscribe) {
        // Race: we passed the cap check but lost the slot. Close cleanly.
        sseRemoveConnection(ip, connectionToken);
        reply.raw.end();
        return;
      }

      // Heartbeat to keep proxies from closing idle connections.
      const heartbeatInterval = setInterval(() => {
        try {
          reply.raw.write(':ping\n\n');
        } catch {
          // Connection already closed; cleanup handler will run.
        }
      }, HEARTBEAT_MS);

      const cleanup = (): void => {
        clearInterval(heartbeatInterval);
        unsubscribe();
        sseRemoveConnection(ip, connectionToken);
      };

      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);

      // Hijack: tell Fastify to stop trying to serialize the response.
      reply.hijack();
    }
  );

  // ---------------------------------------------------------------------------
  // GET /activity — durable history (ring buffer + Postgres-backed)
  // 30/min/IP rate limit (matches /status). The stream endpoint is
  // connection-capped per IP instead. See SECURITY_AUDIT W2-HIGH-02.
  // ---------------------------------------------------------------------------
  app.get('/', {
    config: {
      rateLimit: {
        max: ACTIVITY_HISTORY_RATE_LIMIT_MAX,
        timeWindow: ACTIVITY_HISTORY_RATE_LIMIT_WINDOW,
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const q = (request.query || {}) as Record<string, unknown>;
      const limit = parseBoundedInt(q.limit, 1, 100, 50);
      const topics = parseTopicsQuery(q.topics);
      const typesFilterRaw = typeof q.type === 'string' ? q.type : undefined;
      const typeFilter = typesFilterRaw
        ? new Set(typesFilterRaw.split(',').map((s) => s.trim()).filter(Boolean))
        : undefined;

      // Pull recent events from the ring buffer first; they are authoritative
      // for operational topics that have no Postgres source.
      const inMemory = eventBus.getRecent({ topics, limit });

      // Pull durable rows from Postgres for tip + room topics. We synthesize
      // events so the response shape matches the SSE stream.
      const wantTips = !topics || topics.has('tips');
      const wantRooms = !topics || topics.has('rooms');

      const [recentTips, recentRoomsCreated, recentRoomsDeleted] = await Promise.all([
        wantTips
          ? prismaQuery.tipEvent.findMany({
              orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
              take: limit,
              select: {
                fromAddress: true,
                toAddress: true,
                amount: true,
                txHash: true,
                logIndex: true,
                blockNumber: true,
                blockTime: true,
                roomId: true,
              },
            })
          : Promise.resolve([] as Array<{
              fromAddress: string;
              toAddress: string;
              amount: string;
              txHash: string;
              logIndex: number;
              blockNumber: number;
              blockTime: Date;
              roomId: string | null;
            }>),
        wantRooms
          ? prismaQuery.room.findMany({
              where: { deletedAt: null },
              orderBy: { createdAt: 'desc' },
              take: limit,
              select: {
                slug: true,
                matchId: true,
                hostHandle: true,
                isAutoWarmed: true,
                createdAt: true,
              },
            })
          : Promise.resolve([] as Array<{
              slug: string;
              matchId: string;
              hostHandle: string;
              isAutoWarmed: boolean;
              createdAt: Date;
            }>),
        wantRooms
          ? prismaQuery.room.findMany({
              where: { deletedAt: { not: null } },
              orderBy: { deletedAt: 'desc' },
              take: limit,
              select: { slug: true, deletedAt: true, isAutoWarmed: true, expiresAt: true },
            })
          : Promise.resolve([] as Array<{
              slug: string;
              deletedAt: Date | null;
              isAutoWarmed: boolean;
              expiresAt: Date;
            }>),
      ]);

      type SyntheticEvent = {
        id: string;
        type: string;
        topic: EventTopic;
        ts: number;
        payload: unknown;
      };

      // Resolve roomId -> slug in a single batched lookup so we don't N+1.
      const roomIds = Array.from(
        new Set(recentTips.map((t) => t.roomId).filter((x): x is string => Boolean(x)))
      );
      const slugById = new Map<string, string>();
      if (roomIds.length > 0) {
        const slugRows = await prismaQuery.room.findMany({
          where: { id: { in: roomIds } },
          select: { id: true, slug: true },
        });
        for (const r of slugRows) slugById.set(r.id, r.slug);
      }

      const synthTips: SyntheticEvent[] = recentTips.map((t) => ({
        id: `t-${t.txHash}-${t.logIndex}`,
        type: 'tip.confirmed',
        topic: 'tips',
        ts: t.blockTime.getTime(),
        payload: {
          // SECURITY_AUDIT MED-02: match the /metrics/live redaction contract
          // (10/6 shorten). Full hash stays on the operator-opt-in SSE
          // facilitator.submitted payload only.
          txHash: shortenAddress(t.txHash, 10, 6),
          fromAddress: shortenAddress(t.fromAddress),
          toAddress: shortenAddress(t.toAddress),
          amount: t.amount,
          amountFormatted: formatUsdt(t.amount),
          blockNumber: t.blockNumber,
          blockTime: t.blockTime.toISOString(),
          roomSlug: t.roomId ? slugById.get(t.roomId) ?? null : null,
        },
      }));
      const synthCreated: SyntheticEvent[] = recentRoomsCreated.map((r) => ({
        id: `r-${r.slug}-c`,
        type: 'room.created',
        topic: 'rooms',
        ts: r.createdAt.getTime(),
        payload: {
          slug: r.slug,
          matchId: r.matchId,
          hostHandle: r.hostHandle.length > 3 ? r.hostHandle.slice(0, 3) + '***' : r.hostHandle,
          isAutoWarmed: r.isAutoWarmed,
        },
      }));
      const synthDeleted: SyntheticEvent[] = recentRoomsDeleted.map((r) => {
        // Best-effort reason inference for replayed deletes (CODE_REVIEW W2
        // nice-to-have): if the row was soft-deleted at-or-after its expiry,
        // it was the cleanup worker; else auto-warmed -> auto-cleanup; else
        // host. Live SSE has the authoritative reason; this is only for
        // history replay from Postgres.
        let reason: 'host' | 'expired' | 'auto-cleanup' = 'host';
        if (
          r.deletedAt &&
          r.expiresAt &&
          r.deletedAt.getTime() > r.expiresAt.getTime()
        ) {
          reason = 'expired';
        } else if (r.isAutoWarmed) {
          reason = 'auto-cleanup';
        }
        return {
          id: `r-${r.slug}-d`,
          type: 'room.deleted',
          topic: 'rooms',
          ts: r.deletedAt ? r.deletedAt.getTime() : Date.now(),
          payload: { slug: r.slug, reason },
        };
      });

      // Merge: in-memory wins on collision (it has the freshest data). Then
      // sort by ts DESC, filter by type, slice to limit.
      const byId = new Map<string, SyntheticEvent>();
      for (const e of [...synthTips, ...synthCreated, ...synthDeleted]) byId.set(e.id, e);
      for (const e of inMemory) byId.set(e.id, e as SyntheticEvent);
      let events = Array.from(byId.values()).sort((a, b) => b.ts - a.ts);

      if (typeFilter) {
        events = events.filter((e) => typeFilter.has(e.type));
      }

      // Topics we cannot reconstruct from Postgres. Only mark `seeder` /
      // `matches` as omitted when the in-memory buffer ALSO has no events for
      // them — per ARCHITECTURE.md F1 the contract is "omitted when the data
      // is actually missing", not "omitted whenever requested". See
      // CODE_REVIEW W2 Major #4.
      const memoryTopics = new Set(inMemory.map((e) => e.topic));
      const omittedTopics: string[] = [];
      if (topics) {
        if (topics.has('seeder') && !memoryTopics.has('seeder')) omittedTopics.push('seeder');
        if (topics.has('matches') && !memoryTopics.has('matches')) omittedTopics.push('matches');
      }

      events = events.slice(0, limit);

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          events: events.map((e) => ({
            id: e.id,
            type: e.type,
            topic: e.topic,
            ts: new Date(e.ts).toISOString(),
            payload: e.payload,
          })),
          omittedTopics,
        },
      });
    } catch (err) {
      return handleServerError(reply, err as Error);
    }
  });

  done();
};
