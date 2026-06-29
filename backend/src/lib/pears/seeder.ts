/**
 * SeederSupervisor manages one subprocess per active room slug.
 *
 * Each subprocess runs `seeder/bareSeeder.mjs`, joins the Hyperswarm topic for
 * `hypercore-crypto.data('curva/' + slug)` (BLAKE2b-256, matches pear-app),
 * and emits `{"event":"peers","count":N,"slug":"...","lifetimeBytes":N}`
 * on stdout every ~10s. We parse those lines into an in-memory telemetry map
 * and serve them via the /rooms/:slug/peers and /health routes.
 *
 * Important design notes:
 *   - The seeder is OPTIONAL. If `ENABLE_SEEDER=false`, we no-op everywhere. This
 *     keeps the rest of the backend (catalog, room directory, tip indexer) usable
 *     during development without having `bare-runtime` or the Pears stack installed.
 *   - The subprocess never sees room secrets. It only joins a topic derived from
 *     the public slug and acts as a passive blob replicator. This matches the
 *     Tether/Keet public-seeder pattern.
 *   - Hard cap at SEEDER_MAX_ROOMS to prevent runaway memory on free-tier VMs.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import {
  ENABLE_SEEDER,
  SEEDER_BARE_ENTRY,
  SEEDER_MAX_ROOMS,
  SEEDER_NOISE_SEED,
} from '../../config/main-config.ts';
import { eventBus } from '../activity/eventBus.ts';

// F1: debounce window for seeder.peers_changed publishes (per ARCH 19 F1).
const PEERS_CHANGED_DEBOUNCE_MS = 5_000;

export interface RoomTelemetry {
  slug: string;
  peerCount: number;
  lifetimeBytes: number;
  uptimeMs: number;
  lastUpdated: number; // epoch ms
  spawnedAt: number;
}

interface ChildEntry {
  child: ChildProcess;
  telemetry: RoomTelemetry;
}

class SeederSupervisor {
  private children = new Map<string, ChildEntry>();
  private stoppedSlugs = new Set<string>(); // slugs we explicitly killed; don't auto-respawn
  // F1 debounce state per slug. We publish only when (a) at least
  // PEERS_CHANGED_DEBOUNCE_MS has passed since the last publish, AND (b) the
  // peer count actually changed (min delta 1).
  private lastPublishedPeers = new Map<string, { count: number; at: number }>();

  // Final Fix Wave T1: real Hyperswarm Noise pubkey captured from each
  // subprocess's `seeder-pubkey` stdout frame. `/relay/info` reads this so
  // demo-day CURVA_FORCE_RELAY=1 clients actually resolve us on the DHT.
  // Room-scoped: keyed by slug. There is also a first-ready pubkey we cache
  // for the app-wide /relay/info endpoint (any single running seeder is
  // sufficient as a hole-punch relay).
  private noisePubkeys = new Map<string, string>(); // slug -> hex pubkey
  private firstPubkey: string | null = null;

  isEnabled(): boolean {
    return ENABLE_SEEDER;
  }

  /**
   * Spawn a child for `slug` if not already running. Returns true if a new
   * child was spawned, false if it already existed or we hit the cap.
   */
  spawnRoom(slug: string): boolean {
    if (!ENABLE_SEEDER) return false;
    if (this.children.has(slug)) return false;
    if (this.children.size >= SEEDER_MAX_ROOMS) {
      console.warn(`[Seeder] At cap ${SEEDER_MAX_ROOMS}, refusing to spawn ${slug}`);
      return false;
    }

    const entryPath = resolve(process.cwd(), SEEDER_BARE_ENTRY);
    const env = {
      ...process.env,
      CURVA_SLUG: slug,
      CURVA_SEEDER_NOISE_SEED: SEEDER_NOISE_SEED,
    };

    // Why `node` and not `bare`: this defaults to Node so dev environments without
    // the Bare runtime still boot. If `bare-runtime` is installed and you set
    // `SEEDER_BARE_ENTRY` to a .mjs script that uses it, this still works because
    // Node ignores the bare-specific imports (the script is expected to detect
    // its runtime). In production with `ENABLE_SEEDER=true`, override the spawn
    // command via SEEDER_BARE_ENTRY pointing to a CLI wrapper if needed.
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [entryPath], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
    } catch (err) {
      console.error(`[Seeder] Failed to spawn ${slug}:`, (err as Error)?.message || err);
      return false;
    }

    const now = Date.now();
    const entry: ChildEntry = {
      child,
      telemetry: {
        slug,
        peerCount: 0,
        lifetimeBytes: 0,
        uptimeMs: 0,
        lastUpdated: now,
        spawnedAt: now,
      },
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.handleStdout(slug, chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      console.warn(`[Seeder:${slug}] stderr: ${chunk.trim()}`);
    });
    child.on('exit', (code, signal) => {
      console.log(`[Seeder:${slug}] exited code=${code} signal=${signal}`);
      this.children.delete(slug);
      // Drop this room's pubkey; if it was the "first" one, invalidate the
      // cache so the next spawner takes over.
      const dropped = this.noisePubkeys.get(slug);
      this.noisePubkeys.delete(slug);
      if (dropped && dropped === this.firstPubkey) {
        this.firstPubkey = this.noisePubkeys.values().next().value || null;
      }
    });
    child.on('error', (err) => {
      console.error(`[Seeder:${slug}] child error:`, err.message);
    });

    this.children.set(slug, entry);
    this.stoppedSlugs.delete(slug);
    console.log(`[Seeder] Spawned subprocess for room "${slug}" (pid=${child.pid})`);
    return true;
  }

  /**
   * Kill the child for `slug`. Returns true if a child was running.
   */
  stopRoom(slug: string): boolean {
    const entry = this.children.get(slug);
    if (!entry) return false;
    this.stoppedSlugs.add(slug);
    try {
      entry.child.kill('SIGTERM');
    } catch (err) {
      console.warn(`[Seeder] SIGTERM failed for ${slug}:`, (err as Error)?.message);
    }
    // The 'exit' handler will delete from the map.
    return true;
  }

  getTelemetry(slug: string): RoomTelemetry | null {
    const entry = this.children.get(slug);
    if (!entry) return null;
    return {
      ...entry.telemetry,
      uptimeMs: Date.now() - entry.telemetry.spawnedAt,
    };
  }

  getAllSlugs(): string[] {
    return Array.from(this.children.keys());
  }

  getActiveRoomCount(): number {
    return this.children.size;
  }

  getTotalPeers(): number {
    let total = 0;
    for (const entry of this.children.values()) {
      total += entry.telemetry.peerCount;
    }
    return total;
  }

  /**
   * Final Fix Wave T1: return the first-known Hyperswarm Noise pubkey the
   * seeder pool is running on. Consumed by /relay/info. `null` means either
   * seeder is disabled or no subprocess has emitted `seeder-pubkey` yet.
   */
  getNoisePubkey(): string | null {
    return this.firstPubkey;
  }

  /** Test-only: seed the pubkey cache without spawning a subprocess. */
  __setNoisePubkeyForTest(hex: string | null): void {
    this.firstPubkey = hex;
    this.noisePubkeys.clear();
    if (hex) this.noisePubkeys.set('__test__', hex);
  }

  /**
   * Kill every subprocess. Called on graceful shutdown.
   */
  async shutdown(): Promise<void> {
    const slugs = Array.from(this.children.keys());
    for (const slug of slugs) this.stopRoom(slug);

    // Wait up to 3s for children to exit.
    const deadline = Date.now() + 3000;
    while (this.children.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // SIGKILL any survivors.
    for (const entry of this.children.values()) {
      try {
        entry.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    this.children.clear();
  }

  private handleStdout(slug: string, chunk: string): void {
    const entry = this.children.get(slug);
    if (!entry) return;

    // Lines may be partial; split on newlines and parse complete JSON lines.
    for (const rawLine of chunk.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as {
          event?: string;
          count?: number;
          lifetimeBytes?: number;
          publicKey?: string;
        };
        if (msg.event === 'seeder-pubkey' && typeof msg.publicKey === 'string') {
          // Only accept a plausible 32-byte hex string; reject anything else so
          // /relay/info never surfaces junk that would fail DHT resolution.
          if (/^[0-9a-f]{64}$/i.test(msg.publicKey)) {
            const hex = msg.publicKey.toLowerCase();
            this.noisePubkeys.set(slug, hex);
            if (!this.firstPubkey) this.firstPubkey = hex;
            console.log(`[Seeder:${slug}] noise pubkey captured (first8=${hex.slice(0, 8)})`);
          }
          continue;
        }
        if (msg.event === 'peers') {
          const newCount = Math.max(0, Number(msg.count) || 0);
          entry.telemetry.peerCount = newCount;
          if (typeof msg.lifetimeBytes === 'number') {
            entry.telemetry.lifetimeBytes = msg.lifetimeBytes;
          }
          entry.telemetry.lastUpdated = Date.now();

          // F1: debounced publish to the activity feed.
          const last = this.lastPublishedPeers.get(slug);
          const now = Date.now();
          if (!last || (last.count !== newCount && now - last.at >= PEERS_CHANGED_DEBOUNCE_MS)) {
            this.lastPublishedPeers.set(slug, { count: newCount, at: now });
            try {
              eventBus.publish('seeder.peers_changed', {
                slug,
                peerCount: newCount,
                lifetimeBytes: entry.telemetry.lifetimeBytes,
              });
            } catch (err) {
              console.warn('[Seeder] eventBus publish failed:', (err as Error)?.message);
            }
          }
        }
      } catch {
        // Non-JSON log line from the subprocess; ignore.
      }
    }
  }
}

// Singleton
export const seederSupervisor = new SeederSupervisor();
