/**
 * In-process event bus + SSE broker for the Curva Companion activity feed (F1).
 *
 * Design (per ARCHITECTURE.md Section 19 and ADR-006):
 *  - Bounded ring buffer (SSE_BUFFER_SIZE, default 500) keeps recent events for
 *    Last-Event-ID replay on reconnect.
 *  - Connection cap (SSE_MAX_CONNECTIONS, default 1000) — over the cap the
 *    /activity/stream route returns 503.
 *  - Single in-process Set of subscribers; fan-out is a synchronous for loop so
 *    a slow consumer never blocks a fast one.
 *  - Memory ceiling: ~500 events x ~1 KB each = ~500 KB. Hard upper bound.
 *
 * Publishers wired in:
 *  - tipIndexerWorker / usdtIndexer.runIndexerScan -> tip.confirmed
 *  - roomRoutes POST/DELETE -> room.created / room.deleted
 *  - matchAutoWarmWorker -> match.starting_soon (+ room.created/deleted)
 *  - seederSupervisor (debounced)            -> seeder.peers_changed (out of scope this PR)
 *
 * All payloads are PII-redacted at the publish site (shortenAddress for any
 * EVM address; host handle masking matches /metrics/live pattern). The broker
 * itself does NO redaction — that responsibility is owned by the caller per
 * SECURITY_AUDIT HIGH-04.
 */

import { randomBytes } from 'node:crypto';
import { SSE_BUFFER_SIZE, SSE_MAX_CONNECTIONS } from '../../config/main-config.ts';

// =============================================================================
// Discriminated union for type-safe event payloads
// =============================================================================

export type EventTopic = 'tips' | 'rooms' | 'seeder' | 'matches' | 'distribution';

export interface TipConfirmedPayload {
  txHash: string;
  fromAddress: string; // shortened
  toAddress: string; // shortened
  amount: string;
  amountFormatted: string;
  blockNumber: number;
  blockTime: string; // ISO
  roomSlug: string | null;
  // Wave 3 / F10 multi-chain readiness: optional so existing publishers compile
  // unchanged. The indexer will populate these once F10 lands (next step). The
  // dashboard (F8) reads them for the chain-name badge on the tip ticker.
  chainId?: number;
  chainName?: string;
}

export interface RoomCreatedPayload {
  slug: string;
  matchId: string;
  hostHandle: string; // masked
  isAutoWarmed: boolean;
}

export interface RoomDeletedPayload {
  slug: string;
  reason: 'host' | 'expired' | 'auto-cleanup';
}

export interface SeederPeersChangedPayload {
  slug: string;
  peerCount: number;
  lifetimeBytes: number;
}

export interface MatchStartingSoonPayload {
  matchId: string;
  slug: string;
  kickoffUtc: string;
  minutesUntilKickoff: number;
}

// =============================================================================
// Wave 3 / F7 live-match payloads. Published by the live match pulse worker
// (next step). All are topic `matches` and PII-free by construction (team
// names and minute markers only).
// =============================================================================

export interface MatchKickoffPayload {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: string;
}

export interface MatchGoalPayload {
  matchId: string;
  team: 'home' | 'away';
  newScore: { home: number; away: number };
  // Free tier of football-data.org returns no scorer info; payload allows null.
  scorer: string | null;
  // Match minute when the goal landed; null if the upstream feed omits it.
  minute: number | null;
}

export interface MatchScoreChangedPayload {
  matchId: string;
  previous: { home: number; away: number };
  current: { home: number; away: number };
}

export interface MatchHalftimePayload {
  matchId: string;
  score: { home: number; away: number };
}

export interface MatchFulltimePayload {
  matchId: string;
  score: { home: number; away: number };
}

/**
 * Cup Final: live match minute pulse. Published by liveMatchPulseWorker once
 * per tick per in-window match so the SSE route can re-emit it as an enriched
 * `match.pulse` heartbeat. The renderer's floating minute badge consumes this
 * to display the on-field clock ("34'", "45+3'", "HT", "FT", etc.). All values
 * are bounds-checked at the publisher, never trusted verbatim from upstream.
 */
export interface MatchMinutePayload {
  matchId: string;
  // Null when the match has not started or the upstream feed omits minute.
  minute: number | null;
  // Football-data.org v4 lookup_tables status enum. See docs verified 2026-07-06.
  status: string;
  // Added time at the current half boundary. Null outside stoppage windows.
  injuryTime: number | null;
}

// =============================================================================
// Wave 4 / F11 EIP-3009 facilitator payloads. Published by the relay route
// (submitted) and the confirmation worker (confirmed / failed). All addresses
// are pre-shortened by the publisher per HIGH-04. Topic is `tips` so the F1
// SSE dashboard picks them up automatically without a new subscription filter.
// =============================================================================

export interface FacilitatorSubmittedPayload {
  txHash: string; // shortened
  txHashFull: string; // full 0x hash, for explorer links
  explorerUrl: string | null; // built from chains.json explorerBase + txHash
  chainId: number;
  chainName: string;
  fromAddress: string; // shortened
  toAddress: string; // shortened
  amount: string; // base units
  amountFormatted: string;
  roomSlug: string | null;
  matchId: string | null;
}

export interface FacilitatorConfirmedPayload extends FacilitatorSubmittedPayload {
  confirmedBlock: number;
  confirmedAt: string; // ISO
}

export interface FacilitatorFailedPayload {
  txHash: string; // shortened
  chainId: number;
  chainName: string;
  fromAddress: string; // shortened
  errorMessage: string; // anonymised, never a raw RPC string
}

// =============================================================================
// Wave 4 / F13 Pear app distribution payloads. Published by the
// PearAppDistributionSeeder supervisor. All PII-free by construction (public
// app key + timestamps + reason strings only). Topic `distribution` is its
// own SSE bucket so dashboards can subscribe/omit independently of tip flow.
// =============================================================================

export interface DistributionSeederStartedPayload {
  appKey: string; // full public key — the manifest already publishes it
  pid: number;
  startedAt: string; // ISO
}

export interface DistributionSeederStoppedPayload {
  appKey: string;
  reason: 'shutdown' | 'disabled' | 'manual';
  uptimeSeconds: number;
}

export interface DistributionSeederCrashedPayload {
  appKey: string;
  exitCode: number | null;
  signal: string | null;
  restartCount: number;
  nextRetryInMs: number | null; // null when the retry budget is exhausted
  errorMessage: string | null;
}

// =============================================================================
// Wave 10 — Match Prediction Pool payloads. Published by predictionRoutes on
// entry submit + the settlement worker on payout + settle. Topic `tips` so the
// existing dashboard bucket surfaces them without a new subscription.
// =============================================================================

export interface PredictionPayoutPayload {
  poolId: string;
  predictionId: string;
  txHash: string;
  toAddress: string; // shortened
  amount: string; // base units
  amountFormatted: string;
  roomSlug: string;
  matchId: string;
}

export interface PredictionSettledPayload {
  poolId: string;
  roomSlug: string;
  matchId: string;
  resultWinner: string | null;
  resultHomeGoals: number | null;
  resultAwayGoals: number | null;
  winnersCount: number;
  usedExactScoreFallback: boolean;
}

export type EventBusEvent =
  | { id: string; type: 'tip.confirmed'; topic: 'tips'; ts: number; payload: TipConfirmedPayload }
  | { id: string; type: 'room.created'; topic: 'rooms'; ts: number; payload: RoomCreatedPayload }
  | { id: string; type: 'room.deleted'; topic: 'rooms'; ts: number; payload: RoomDeletedPayload }
  | {
      id: string;
      type: 'seeder.peers_changed';
      topic: 'seeder';
      ts: number;
      payload: SeederPeersChangedPayload;
    }
  | {
      id: string;
      type: 'match.starting_soon';
      topic: 'matches';
      ts: number;
      payload: MatchStartingSoonPayload;
    }
  | {
      id: string;
      type: 'match.kickoff';
      topic: 'matches';
      ts: number;
      payload: MatchKickoffPayload;
    }
  | {
      id: string;
      type: 'match.goal';
      topic: 'matches';
      ts: number;
      payload: MatchGoalPayload;
    }
  | {
      id: string;
      type: 'match.score_changed';
      topic: 'matches';
      ts: number;
      payload: MatchScoreChangedPayload;
    }
  | {
      id: string;
      type: 'match.halftime';
      topic: 'matches';
      ts: number;
      payload: MatchHalftimePayload;
    }
  | {
      id: string;
      type: 'match.fulltime';
      topic: 'matches';
      ts: number;
      payload: MatchFulltimePayload;
    }
  | {
      id: string;
      type: 'match.minute';
      topic: 'matches';
      ts: number;
      payload: MatchMinutePayload;
    }
  | {
      id: string;
      type: 'facilitator.submitted';
      topic: 'tips';
      ts: number;
      payload: FacilitatorSubmittedPayload;
    }
  | {
      id: string;
      type: 'facilitator.confirmed';
      topic: 'tips';
      ts: number;
      payload: FacilitatorConfirmedPayload;
    }
  | {
      id: string;
      type: 'facilitator.failed';
      topic: 'tips';
      ts: number;
      payload: FacilitatorFailedPayload;
    }
  | {
      id: string;
      type: 'distribution.seeder_started';
      topic: 'distribution';
      ts: number;
      payload: DistributionSeederStartedPayload;
    }
  | {
      id: string;
      type: 'distribution.seeder_stopped';
      topic: 'distribution';
      ts: number;
      payload: DistributionSeederStoppedPayload;
    }
  | {
      id: string;
      type: 'distribution.seeder_crashed';
      topic: 'distribution';
      ts: number;
      payload: DistributionSeederCrashedPayload;
    }
  | {
      id: string;
      type: 'prediction.payout';
      topic: 'tips';
      ts: number;
      payload: PredictionPayoutPayload;
    }
  | {
      id: string;
      type: 'prediction.settled';
      topic: 'tips';
      ts: number;
      payload: PredictionSettledPayload;
    };

type EventType = EventBusEvent['type'];

// Map event type -> topic, single source of truth.
const TYPE_TO_TOPIC: Record<EventType, EventTopic> = {
  'tip.confirmed': 'tips',
  'room.created': 'rooms',
  'room.deleted': 'rooms',
  'seeder.peers_changed': 'seeder',
  'match.starting_soon': 'matches',
  'match.kickoff': 'matches',
  'match.goal': 'matches',
  'match.score_changed': 'matches',
  'match.halftime': 'matches',
  'match.fulltime': 'matches',
  'match.minute': 'matches',
  'facilitator.submitted': 'tips',
  'facilitator.confirmed': 'tips',
  'facilitator.failed': 'tips',
  'distribution.seeder_started': 'distribution',
  'distribution.seeder_stopped': 'distribution',
  'distribution.seeder_crashed': 'distribution',
  'prediction.payout': 'tips',
  'prediction.settled': 'tips',
};

export const ALL_TOPICS: ReadonlyArray<EventTopic> = [
  'tips',
  'rooms',
  'seeder',
  'matches',
  'distribution',
];

export const isValidTopic = (t: string): t is EventTopic =>
  t === 'tips' ||
  t === 'rooms' ||
  t === 'seeder' ||
  t === 'matches' ||
  t === 'distribution';

// =============================================================================
// Event ID generator. cuid2-style: timestamp prefix + crypto random suffix.
// Self-contained so we don't add a new dep just for this.
// =============================================================================

let monotonicCounter = 0;
const genEventId = (): string => {
  monotonicCounter = (monotonicCounter + 1) & 0xffffff;
  const seq = monotonicCounter.toString(36).padStart(5, '0');
  const ts = Date.now().toString(36);
  const rand = randomBytes(8).toString('hex');
  return `m-${ts}-${seq}-${rand}`;
};

// =============================================================================
// Subscriber type. Each SSE connection registers a callback.
// =============================================================================

export type SubscriberCallback = (ev: EventBusEvent) => void;

interface Subscription {
  topics: Set<EventTopic>;
  cb: SubscriberCallback;
}

// =============================================================================
// EventBus class
// =============================================================================

export class EventBus {
  private buffer: EventBusEvent[] = [];
  private subs = new Set<Subscription>();
  private droppedPerSecond = 0;
  private lastDropLogAt = 0;

  constructor(
    private readonly bufferSize: number = SSE_BUFFER_SIZE,
    private readonly maxConnections: number = SSE_MAX_CONNECTIONS
  ) {}

  /**
   * Publish a new event. Tags with id+ts, appends to ring buffer, fans out to
   * subscribers whose topic filter matches.
   */
  publish<T extends EventType>(
    type: T,
    payload: Extract<EventBusEvent, { type: T }>['payload']
  ): EventBusEvent {
    const topic = TYPE_TO_TOPIC[type];
    const ev: EventBusEvent = {
      id: genEventId(),
      type,
      topic,
      ts: Date.now(),
      payload,
    } as EventBusEvent;

    // Ring buffer append + trim.
    this.buffer.push(ev);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.splice(0, this.buffer.length - this.bufferSize);
    }

    // Synchronous fan-out. Subscribers MUST not throw; we guard anyway.
    for (const sub of this.subs) {
      if (!sub.topics.has(topic)) continue;
      try {
        sub.cb(ev);
      } catch (err) {
        // Don't let one bad subscriber take down the publisher.
        console.warn('[EventBus] subscriber error:', (err as Error)?.message);
      }
    }

    return ev;
  }

  /**
   * Register a subscriber. Returns an unsubscribe function. If the cap is
   * reached, returns `null` and the caller should reject with 503.
   */
  subscribe(
    cb: SubscriberCallback,
    opts: { topics?: Set<EventTopic> } = {}
  ): (() => void) | null {
    if (this.subs.size >= this.maxConnections) {
      return null;
    }
    const sub: Subscription = {
      cb,
      topics: opts.topics && opts.topics.size > 0 ? opts.topics : new Set(ALL_TOPICS),
    };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  /**
   * Replay events from the ring buffer that occurred strictly after `eventId`.
   * Returns up to `limit` events (oldest first). Used by SSE on reconnect when
   * the client sends `Last-Event-ID`.
   */
  getHistorySince(
    eventId: string | undefined,
    opts: { topics?: Set<EventTopic>; limit?: number } = {}
  ): EventBusEvent[] {
    const limit = Math.max(1, Math.min(opts.limit ?? this.bufferSize, this.bufferSize));
    const filterTopics = opts.topics;
    if (!eventId) {
      // No cursor: return recent slice within the topic filter.
      return this.buffer
        .filter((e) => !filterTopics || filterTopics.has(e.topic))
        .slice(-limit);
    }
    const idx = this.buffer.findIndex((e) => e.id === eventId);
    if (idx === -1) {
      // ID is older than the buffer or unknown — return everything we have
      // matching the filter.
      return this.buffer
        .filter((e) => !filterTopics || filterTopics.has(e.topic))
        .slice(-limit);
    }
    return this.buffer
      .slice(idx + 1)
      .filter((e) => !filterTopics || filterTopics.has(e.topic))
      .slice(0, limit);
  }

  /**
   * Return the most recent N events, optionally filtered by topic. Newest last.
   */
  getRecent(opts: { topics?: Set<EventTopic>; limit?: number } = {}): EventBusEvent[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, this.bufferSize));
    const filterTopics = opts.topics;
    return this.buffer
      .filter((e) => !filterTopics || filterTopics.has(e.topic))
      .slice(-limit);
  }

  getStats(): {
    bufferSize: number;
    bufferCapacity: number;
    subscriberCount: number;
    maxConnections: number;
    droppedPerSecond: number;
  } {
    return {
      bufferSize: this.buffer.length,
      bufferCapacity: this.bufferSize,
      subscriberCount: this.subs.size,
      maxConnections: this.maxConnections,
      droppedPerSecond: this.droppedPerSecond,
    };
  }

  getConnectionCount(): number {
    return this.subs.size;
  }

  /**
   * Close every active subscription. Called on graceful shutdown so SSE
   * clients receive an EOF and reconnect to the next deploy.
   */
  closeAll(): void {
    this.subs.clear();
  }

  /**
   * Test-only: drop the in-memory buffer. Production code MUST NOT call this;
   * the buffer is owned by the ring-buffer invariant. Kept here so test files
   * that share the singleton can isolate themselves.
   */
  __resetForTest(): void {
    this.buffer.length = 0;
  }

  /**
   * Track a dropped event for backpressure logging. Currently the SSE write
   * pipeline drops events when the kernel socket buffer is full; we log at
   * most once per second to avoid log spam.
   */
  noteDropped(): void {
    this.droppedPerSecond += 1;
    const now = Date.now();
    if (now - this.lastDropLogAt > 1000) {
      console.warn(
        `[EventBus] dropped ${this.droppedPerSecond} event(s) in the last second (slow consumer)`
      );
      this.lastDropLogAt = now;
      this.droppedPerSecond = 0;
    }
  }
}

// Singleton instance reused across the process.
export const eventBus = new EventBus();
