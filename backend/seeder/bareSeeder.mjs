// Pears seeder subprocess (Bare-compatible / Node-compatible).
//
// Two spawn modes (selected via env):
//   1. `room` (default): one-per-room, joins topic = hypercore-crypto.data('curva/' + slug).
//      This MUST match pear-app/bare/topics.js exactly. See topicForSlug.mjs.
//      Emits {"event":"peers","count":N,"lifetimeBytes":N} every 10s.
//   2. `app-distribution` (F13): one process for the whole app distribution.
//      Joins topic = sha256('pear-app:' + CURVA_PEAR_APP_KEY) so any Pear
//      runtime that pulls `pear://<appKey>` finds us as a persistent seeder.
//      Same telemetry protocol.
//
// This script intentionally degrades gracefully:
//   - If hyperswarm / corestore are not installed (i.e. running in dev without
//     the Pears stack), it emits a stub "peers count = 0" line every 10s and
//     stays alive. This keeps the supervisor happy in test environments.
//   - In production (ENABLE_SEEDER=true on a host with hyperswarm + corestore),
//     it does real replication.
//
// Required env: CURVA_SLUG. Optional: CURVA_SEEDER_NOISE_SEED (hex),
//   CURVA_SEEDER_MODE ('room' | 'app-distribution'; defaults to 'room'),
//   CURVA_PEAR_APP_KEY (required when mode='app-distribution').

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { topicForSlug } from './topicForSlug.mjs';

const slug = process.env.CURVA_SLUG;
if (!slug || typeof slug !== 'string' || slug.length === 0) {
  process.stderr.write('[bareSeeder] CURVA_SLUG required\n');
  process.exit(1);
}

const seedHex = process.env.CURVA_SEEDER_NOISE_SEED || '';
const _noiseSeed = seedHex.length === 64
  ? Buffer.from(seedHex, 'hex')
  : randomBytes(32);

const mode = process.env.CURVA_SEEDER_MODE === 'app-distribution' ? 'app-distribution' : 'room';

// Topic derivation:
//   room mode              -> hypercore-crypto.data('curva/' + slug)  (matches pear-app)
//   app-distribution mode  -> sha256('pear-app:' + appKey)             (backend-only namespace)
// In room mode we MUST match pear-app/bare/topics.js exactly, or seeder and
// clients land on different topics and never discover each other. See
// topicForSlug.mjs for the canonical derivation.
let topic;
if (mode === 'app-distribution') {
  const appKey = process.env.CURVA_PEAR_APP_KEY;
  if (!appKey || typeof appKey !== 'string' || appKey.length === 0) {
    process.stderr.write('[bareSeeder] CURVA_PEAR_APP_KEY required in app-distribution mode\n');
    process.exit(1);
  }
  // app-distribution has no pear-app counterpart today; keep sha256 for now.
  topic = createHash('sha256').update(`pear-app:${appKey}`).digest();
} else {
  topic = topicForSlug(slug);
}

let storeDir = null;
let swarm = null;
let store = null;
let connectionCount = 0;
let lifetimeBytes = 0;

const emit = (event, extra = {}) => {
  try {
    process.stdout.write(JSON.stringify({ event, slug, mode, ...extra }) + '\n');
  } catch {
    /* ignore */
  }
};

// T1 (Final Fix Wave): derive a deterministic Noise keypair so the backend
// /relay/info route can advertise the real Hyperswarm public key. Peers behind
// symmetric NAT resolve this pubkey on the DHT to hole-punch via us.
//
// Docs verified:
//   - https://github.com/holepunchto/hyperswarm  (constructor accepts { keyPair })
//   - https://github.com/holepunchto/hypercore-crypto  (keyPair(seed))
//
// If SEEDER_NOISE_SEED is a valid 32-byte hex, we use it as-is. Otherwise we
// re-derive a 32-byte seed via hypercore-crypto.data(<seed bytes>) which is
// the documented way to obtain a domain-separated 32-byte hash from arbitrary
// input. Random fallback keeps the seeder alive in dev when no seed is set.
const derivePubkeyBytes = (bytes) => bytes; // kept for clarity in refactors
async function deriveKeyPair() {
  let cryptoMod;
  try {
    cryptoMod = (await import('hypercore-crypto')).default || (await import('hypercore-crypto'));
  } catch {
    return null;
  }
  let seed;
  if (seedHex.length === 64) {
    seed = Buffer.from(seedHex, 'hex');
  } else if (seedHex.length > 0) {
    // hash arbitrary user input into a 32-byte seed
    try {
      const b4a = (await import('b4a')).default || (await import('b4a'));
      seed = cryptoMod.data(b4a.from(seedHex));
    } catch {
      seed = _noiseSeed;
    }
  } else {
    seed = _noiseSeed;
  }
  if (!seed || seed.length !== 32) return null;
  try {
    return cryptoMod.keyPair(seed);
  } catch {
    return null;
  }
}

const startReal = async () => {
  // Dynamic import so missing deps don't crash the script in dev.
  let Hyperswarm, Corestore;
  try {
    Hyperswarm = (await import('hyperswarm')).default;
    Corestore = (await import('corestore')).default;
  } catch (err) {
    emit('peers', { count: 0, lifetimeBytes: 0, mode: 'stub', reason: 'hyperswarm-not-installed' });
    return;
  }

  storeDir = mkdtempSync(join(tmpdir(), `curva-seeder-${slug}-`));
  store = new Corestore(storeDir);
  await store.ready();

  // Build Hyperswarm with a deterministic Noise keypair when possible so we
  // can advertise a stable pubkey to relay clients. Falls back to hyperswarm's
  // default (random keypair) if crypto import fails.
  const keyPair = await deriveKeyPair();
  swarm = keyPair ? new Hyperswarm({ keyPair }) : new Hyperswarm();

  // Emit the real Noise pubkey immediately so the supervisor can populate
  // /relay/info without waiting for the first peer join. Format:
  //   {"event":"seeder-pubkey","publicKey":"<hex>","slug":"..."}
  try {
    const pubBuf = swarm.keyPair?.publicKey || keyPair?.publicKey;
    if (pubBuf) {
      emit('seeder-pubkey', { publicKey: Buffer.from(pubBuf).toString('hex') });
    }
  } catch (err) {
    process.stderr.write(`[bareSeeder:${slug}] pubkey emit failed: ${err?.message ?? err}\n`);
  }

  swarm.on('connection', (socket, info) => {
    connectionCount += 1;
    socket.on('data', (data) => {
      lifetimeBytes += data?.length ?? 0;
    });
    socket.on('close', () => {
      connectionCount = Math.max(0, connectionCount - 1);
    });
    socket.on('error', () => { /* swallow; replication failures are expected */ });
    try {
      store.replicate(socket);
    } catch (err) {
      process.stderr.write(`[bareSeeder:${slug}] replicate error: ${err?.message ?? err}\n`);
    }
  });

  const discovery = swarm.join(topic, { server: true, client: true });
  await discovery.flushed();
  emit('joined', { topicHex: topic.toString('hex') });
};

const reportLoop = () => {
  emit('peers', {
    count: swarm ? swarm.connections.size : connectionCount,
    lifetimeBytes,
  });
};

const shutdown = async () => {
  try {
    if (swarm) await swarm.destroy();
  } catch { /* ignore */ }
  try {
    if (store) await store.close();
  } catch { /* ignore */ }
  try {
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
  } catch { /* ignore */ }
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Boot. If real-mode init fails for any reason, keep emitting stub telemetry
// so the supervisor still reports a "live" subprocess.
startReal().catch((err) => {
  process.stderr.write(`[bareSeeder:${slug}] startReal failed: ${err?.message ?? err}\n`);
});

setInterval(reportLoop, 10000);
// Emit one immediately so the supervisor doesn't sit at 0 forever in stub mode.
setTimeout(reportLoop, 1000);
