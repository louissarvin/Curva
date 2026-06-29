/**
 * In-memory goal log used by `/matches/:id/live` (F7 / ARCHITECTURE.md Section 20).
 *
 * Process-local Map<matchId, GoalLogEntry[]>. Capped per-match (20 entries —
 * enough for extra time + injury time + reasonable VAR churn) and capped
 * globally (200 active matches — well above the World Cup parallel-match peak).
 *
 * Eviction:
 *  - Per-match: oldest entry dropped when the array exceeds the cap.
 *  - Global: when total tracked matches exceeds 200, the least-recently-updated
 *    match's entire log is dropped (simple LRU).
 *
 * Not persisted. On process restart the worker re-derives the final score from
 * football-data.org and the goal narrative is lost. Architect's ADR accepts
 * this for the hackathon scope.
 */

const PER_MATCH_CAP = 20;
const GLOBAL_MATCH_CAP = 200;

export interface GoalLogEntry {
  minute: number | null;
  team: 'home' | 'away';
  scorer: string | null;
  homeScoreAfter: number;
  awayScoreAfter: number;
  observedAt: number;
}

interface MatchSlot {
  entries: GoalLogEntry[];
  lastUpdate: number;
}

const slots = new Map<string, MatchSlot>();

const evictLruIfNeeded = (): void => {
  if (slots.size <= GLOBAL_MATCH_CAP) return;
  let oldestKey: string | undefined;
  let oldestTs = Number.POSITIVE_INFINITY;
  for (const [k, v] of slots) {
    if (v.lastUpdate < oldestTs) {
      oldestTs = v.lastUpdate;
      oldestKey = k;
    }
  }
  if (oldestKey) slots.delete(oldestKey);
};

/**
 * Append a goal entry to the match's log. Caps per-match at 20 and globally
 * at 200 matches. Touches the LRU timestamp.
 */
export const append = (matchId: string, entry: GoalLogEntry): void => {
  if (!matchId) return;
  const now = entry.observedAt || Date.now();
  let slot = slots.get(matchId);
  if (!slot) {
    slot = { entries: [], lastUpdate: now };
    slots.set(matchId, slot);
    evictLruIfNeeded();
  }
  slot.entries.push(entry);
  if (slot.entries.length > PER_MATCH_CAP) {
    slot.entries.splice(0, slot.entries.length - PER_MATCH_CAP);
  }
  slot.lastUpdate = now;
};

/**
 * Return a copy of the goal log for a match (oldest first). Empty array when
 * the match has no entries.
 */
export const get = (matchId: string): GoalLogEntry[] => {
  const slot = slots.get(matchId);
  if (!slot) return [];
  return slot.entries.slice();
};

/** Test-only: clear all logs. */
export const reset = (): void => {
  slots.clear();
};

/** Test-only: number of tracked matches. */
export const __sizeForTest = (): number => slots.size;
