/**
 * In-memory short-lived nonce store for signature challenges.
 *
 * Why in-memory: a hackathon-scope deployment runs one Companion VM. Single-process
 * Map is the simplest correct implementation. If we ever scale horizontally,
 * swap for Redis SET with EX. The interface stays the same.
 *
 * Security properties:
 *  - Single-use: once consumed via `consume()`, the entry is deleted.
 *  - TTL'd: entries expire after `ttlSeconds`; we also lazy-evict on every read.
 *  - Bounded: hard cap on size to prevent memory exhaustion via spam.
 *  - Non-overwriting: if an unexpired challenge already exists for the key,
 *    `issue()` returns it instead of overwriting. This prevents the DoS where
 *    a remote attacker calls /delete-challenge in a loop and invalidates the
 *    legitimate host's in-flight signature. See SECURITY_AUDIT.md CRIT-01a.
 */

import { randomBytes } from 'node:crypto';

interface Entry {
  challenge: string;
  expiresAt: number; // epoch ms
}

// Global cap across all keys; prevents memory exhaustion under sustained spam.
const MAX_ENTRIES = 1000;

export class ChallengePendingError extends Error {
  constructor(public readonly expiresIn: number) {
    super('CHALLENGE_PENDING');
    this.name = 'ChallengePendingError';
  }
}

export class ChallengeStore {
  private store = new Map<string, Entry>();

  constructor(private readonly ttlSeconds: number) {}

  /**
   * Issue (or re-return) a challenge for a given key (e.g. room slug).
   *
   * If an unexpired challenge already exists for `key`, the existing challenge
   * is returned unchanged. This guarantees a single in-flight signature window
   * per key and stops attackers from invalidating a legitimate host's signature
   * by spamming this endpoint.
   *
   * On hitting the global cap, throws ChallengePendingError to surface a 503
   * to the client (we never silently evict to free room for an attacker).
   */
  issue(key: string): { challenge: string; expiresIn: number } {
    this.evictExpired();

    const existing = this.store.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      const expiresIn = Math.max(1, Math.ceil((existing.expiresAt - Date.now()) / 1000));
      return { challenge: existing.challenge, expiresIn };
    }

    if (this.store.size >= MAX_ENTRIES) {
      // Refuse rather than evict; eviction would let an attacker bump out
      // legitimate hosts' challenges.
      throw new ChallengePendingError(this.ttlSeconds);
    }

    const challenge = randomBytes(24).toString('hex'); // 192 bits entropy
    const expiresAt = Date.now() + this.ttlSeconds * 1000;
    this.store.set(key, { challenge, expiresAt });
    return { challenge, expiresIn: this.ttlSeconds };
  }

  /**
   * Atomically validate-and-consume a challenge. Returns true iff the supplied
   * `challenge` matches the active one for `key` and has not expired.
   * Deletes the entry on success so it cannot be replayed.
   */
  consume(key: string, challenge: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return false;
    }
    if (entry.challenge !== challenge) return false;
    this.store.delete(key);
    return true;
  }

  /**
   * Evict expired entries. Called lazily on issue.
   */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt < now) this.store.delete(key);
    }
  }

  size(): number {
    return this.store.size;
  }
}
