/**
 * Minimal in-process TTL memoizer. Bounded, no LRU library dependency.
 *
 * Hard cap on entries (default 100) prevents unbounded memory growth under
 * cache-key fuzzing. When the cap is reached, the oldest-expiring entry is
 * evicted.
 *
 * Usage:
 *   const data = await memoize('key', 60_000, async () => fetchSomething());
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const MAX_ENTRIES_DEFAULT = 100;

// Generic per-value-type cache. Use `new TtlCache<MyType>(N)` so the type
// system can keep callers honest: a string-valued cache and an object-valued
// cache cannot accidentally share an instance (CODE_REVIEW W2 Major #1).
class TtlCache<T = unknown> {
  private store = new Map<string, Entry<T>>();
  // Holds in-flight async fetches so a burst of identical requests yields a
  // single underlying compute. (Stampede protection.)
  private pending = new Map<string, Promise<T>>();

  constructor(private readonly maxEntries: number = MAX_ENTRIES_DEFAULT) {}

  get(key: string): T | null {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (this.store.size >= this.maxEntries) {
      // Evict the entry expiring soonest. O(n) but n <= maxEntries so OK.
      let oldestKey: string | null = null;
      let oldestExp = Infinity;
      for (const [k, v] of this.store) {
        if (v.expiresAt < oldestExp) {
          oldestExp = v.expiresAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.store.delete(oldestKey);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.pending.clear();
  }

  async memoize(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== null) return cached;

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const p = (async () => {
      try {
        const value = await fn();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, p);
    return p;
  }
}

// Shared default cache. Callers can also instantiate their own bounded cache
// when they need isolation (e.g. the status page caches by lang).
export const defaultCache = new TtlCache<unknown>();

export const memoize = <T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> =>
  defaultCache.memoize(key, ttlMs, fn as () => Promise<unknown>) as Promise<T>;

export { TtlCache };
