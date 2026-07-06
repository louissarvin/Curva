/**
 * Match live SSE stream (F3 backend half).
 *
 *   GET /matches/live/stream[?matchIds=<id1>,<id2>]
 *
 * Emits three event types over `text/event-stream`:
 *   match.goal   payload { matchId, minute, scorer, team, score }
 *   match.score  payload { matchId, home, away, minute }
 *   match.pulse  payload { ts } every 15 seconds as heartbeat
 *
 * The route is a pure consumer of the in-process `eventBus`. All upstream
 * poisoned-input guards live in `liveMatchPulseWorker.ts` (MAX_REASONABLE_SCORE,
 * MAX_GOALS_PER_TICK, MAX_REASONABLE_MINUTE), so this route only needs to
 * translate typed bus events into the leaner SSE contract that the pear-app
 * Bare worker consumes.
 *
 * Connection cap policy mirrors `activityRoutes.ts` verbatim (see
 * SECURITY_AUDIT W2-HIGH-02):
 *   Global cap: SSE_MAX_CONNECTIONS via eventBus.subscribe returning null.
 *   Per-IP cap: SSE_MAX_CONNECTIONS_PER_IP tracked in a Map local to this file.
 *
 * Docs cited:
 *   Fastify Reply.hijack: https://fastify.dev/docs/latest/Reference/Reply/
 *   SSE / EventSource:     https://html.spec.whatwg.org/multipage/server-sent-events.html
 *   football-data v4:      https://docs.football-data.org/general/v4/match.html
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { eventBus, type EventBusEvent } from '../lib/activity/eventBus.ts';
import { handleError } from '../utils/errorHandler.ts';
import { SSE_MAX_CONNECTIONS_PER_IP } from '../config/main-config.ts';

// Heartbeat cadence per the F3 contract. The stream sends a `match.pulse` event
// every PULSE_MS ms so clients (Bare worker or EventSource) can distinguish a
// silent-but-healthy connection from a dead socket. Cadence trades keepalive
// noise against edge idle timeouts (Fly.io = 60s default, nginx = 60s).
const PULSE_MS = 15_000;

// Only the two upstream event types the F3 contract cares about. The bus emits
// other match.* events (kickoff, starting_soon, halftime, fulltime) which we
// intentionally do not re-emit here. Bare clients that want the full firehose
// use /activity/stream?topics=matches instead.
const MATCH_EMIT_TYPES: ReadonlySet<EventBusEvent['type']> = new Set([
  'match.goal',
  'match.score_changed',
  // Cup Final: minute-clock pulse. The route re-emits it verbatim as a
  // `match.pulse` wire frame so the Bare consumer's existing pulse branch
  // handles it without a wire-name rename.
  'match.minute',
]);

// Per-IP tracker. Same shape as activityRoutes.ts; a separate Map so activity
// consumers cannot exhaust the match/live budget or vice versa.
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
const sseCountForIp = (ip: string): number =>
  sseConnectionsByIp.get(ip)?.size ?? 0;

// Test-only: reset the per-IP tracker between test cases so long-lived
// connections from one test do not exhaust the cap for the next.
export const __sseResetMatchConnectionsForTest = (): void => {
  sseConnectionsByIp.clear();
};

const parseMatchIds = (raw: unknown): Set<string> | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 64);
  return ids.length > 0 ? new Set(ids) : null;
};

// Translate an EventBus match.* event into the F3 wire contract. Returns the
// SSE frame body without the event id (added at write time). Returns null when
// the event's typed payload is missing required fields (defensive: publisher
// guarantees these, but we do not blow up the stream if a future publisher
// misses one).
const translateEvent = (
  ev: EventBusEvent
): { type: string; payload: Record<string, unknown> } | null => {
  if (ev.type === 'match.goal') {
    const p = ev.payload;
    return {
      type: 'match.goal',
      payload: {
        matchId: p.matchId,
        minute: p.minute,
        scorer: p.scorer,
        team: p.team,
        score: p.newScore,
      },
    };
  }
  if (ev.type === 'match.score_changed') {
    const p = ev.payload;
    return {
      type: 'match.score',
      payload: {
        matchId: p.matchId,
        home: p.current.home,
        away: p.current.away,
        // The bus does not carry a minute on score_changed; the goal event that
        // preceded it does. Emit null so the wire shape stays stable.
        minute: null,
      },
    };
  }
  if (ev.type === 'match.minute') {
    const p = ev.payload;
    // Wire type stays `match.pulse` so the Bare consumer's existing pulse
    // branch (already deployed) picks it up. Payload is additive: legacy
    // consumers that only read `ts` keep working; new consumers read the
    // minute/status/injuryTime fields.
    return {
      type: 'match.pulse',
      payload: {
        matchId: p.matchId,
        minute: p.minute,
        status: p.status,
        injuryTime: p.injuryTime,
      },
    };
  }
  return null;
};

const writeFrame = (
  reply: FastifyReply,
  id: string,
  type: string,
  payload: Record<string, unknown>
): boolean => {
  const data = JSON.stringify({ type, ts: Date.now(), payload });
  const frame = `id: ${id}\nevent: ${type}\ndata: ${data}\n\n`;
  const ok = reply.raw.write(frame);
  if (!ok) eventBus.noteDropped();
  return ok;
};

export const matchLiveStreamRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get(
    '/live/stream',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // request.ip is resolved through Fastify's trustProxy config (numeric
      // hop count per SECURITY_AUDIT HIGH-01), so it is the real client IP
      // after N proxy hops; an attacker cannot spoof it via X-Forwarded-For.
      const ip = request.ip;

      if (sseCountForIp(ip) >= SSE_MAX_CONNECTIONS_PER_IP) {
        // Best-effort SSE-shaped error frame + close.
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

      // Global cap BEFORE we commit to hijacking the response.
      if (eventBus.getConnectionCount() >= eventBus.getStats().maxConnections) {
        return handleError(
          reply,
          503,
          'SSE connection limit reached; retry shortly',
          'SSE_OVERLOADED'
        );
      }

      const q = (request.query || {}) as Record<string, unknown>;
      const matchIdFilter = parseMatchIds(q.matchIds);

      // Last-Event-ID via header (EventSource auto-resend on reconnect) or
      // query param for curl convenience.
      const lastEventIdHeader = request.headers['last-event-id'];
      const lastEventId =
        (typeof lastEventIdHeader === 'string' ? lastEventIdHeader : undefined) ||
        (typeof q.lastEventId === 'string' ? q.lastEventId : undefined);

      // CORS: the global @fastify/cors plugin already allows pear:// origins
      // and localhost. We do NOT set our own Access-Control-Allow-Origin here;
      // helmet + @fastify/cors handle that on the response headers before we
      // write. Anything we add would double-set the header.
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Tell the client how long to wait before reconnecting.
      reply.raw.write('retry: 5000\n\n');

      const connectionToken = Symbol('sse-match-conn');
      sseAddConnection(ip, connectionToken);

      // Replay: only match.* events, translated + filtered by matchIds if set.
      const backlog = eventBus.getHistorySince(lastEventId, {
        topics: new Set(['matches']),
      });
      for (const ev of backlog) {
        if (!MATCH_EMIT_TYPES.has(ev.type)) continue;
        if (matchIdFilter) {
          const pMatchId = (ev.payload as { matchId?: string }).matchId;
          if (!pMatchId || !matchIdFilter.has(pMatchId)) continue;
        }
        const translated = translateEvent(ev);
        if (translated) writeFrame(reply, ev.id, translated.type, translated.payload);
      }

      const unsubscribe = eventBus.subscribe(
        (ev) => {
          if (!MATCH_EMIT_TYPES.has(ev.type)) return;
          if (matchIdFilter) {
            const pMatchId = (ev.payload as { matchId?: string }).matchId;
            if (!pMatchId || !matchIdFilter.has(pMatchId)) return;
          }
          const translated = translateEvent(ev);
          if (translated) writeFrame(reply, ev.id, translated.type, translated.payload);
        },
        { topics: new Set(['matches']) }
      );

      if (!unsubscribe) {
        // Race: passed the cap check, lost the slot. Close cleanly.
        sseRemoveConnection(ip, connectionToken);
        reply.raw.end();
        return;
      }

      // match.pulse heartbeat. Uses a plain incrementing id per connection so
      // downstream Last-Event-ID replay stays deterministic; the ring buffer
      // itself never sees these ids.
      let pulseSeq = 0;
      const pulseTimer = setInterval(() => {
        try {
          pulseSeq += 1;
          writeFrame(
            reply,
            `p-${pulseSeq}`,
            'match.pulse',
            { ts: Date.now() }
          );
        } catch {
          // Connection already closed; cleanup fires from the 'close' handler.
        }
      }, PULSE_MS);

      const cleanup = (): void => {
        clearInterval(pulseTimer);
        unsubscribe();
        sseRemoveConnection(ip, connectionToken);
      };

      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);

      reply.hijack();
    }
  );

  done();
};
