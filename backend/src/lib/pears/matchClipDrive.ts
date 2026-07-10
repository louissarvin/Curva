/**
 * F1: Match-clip Hyperdrive.
 *
 * The backend constructs a single Hyperdrive at boot, ingests every file under
 * `backend/tmp/match-clips-source/` (via `drive.put(path, buffer)`), and
 * publishes the drive key + per-clip metadata via `GET /clips/manifest`. Peers
 * that dial the same discovery topic can replicate the drive read-only.
 *
 * This is companion infrastructure — the drive holds highlight-clip bytes, not
 * user-generated content. Ingestion runs exactly once per process start; the
 * source directory is treated as read-only from the module's perspective.
 *
 * Docs consulted (fetched 2026-07-10):
 *   https://docs.pears.com/reference/building-blocks/hyperdrive/
 *   https://docs.pears.com/reference/building-blocks/hyperblobs/
 *   backend/node_modules/hyperdrive/index.js (installed 13.3.3) — verified API
 *     surface: `.put(name, buf)`, `.entry(name)`, `.get(name)`, `.entries()`,
 *     `.key`, `.discoveryKey`. There is NO `.mount(path, key)` method.
 *
 * Feature-flag posture:
 *   - Off by default via ENABLE_MATCH_CLIP_DRIVE. When off, `initMatchClipDrive`
 *     is never called, `getManifest()` returns { enabled: false, clips: [] },
 *     and no corestore is opened (zero boot cost).
 *   - The source dir + drive dir are created on demand; a missing source dir
 *     yields an empty manifest rather than a boot crash.
 *
 * Security notes:
 *   - Path input is filesystem-local, not user-provided. We still sanitize
 *     (basename only, no traversal) so an operator dropping a symlink named
 *     "../../etc/passwd" can't leak host state into the manifest.
 *   - Sidecar JSON is validated against a strict allowlist; unknown fields are
 *     dropped.
 *   - Manifest never includes absolute filesystem paths.
 */

import { readFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { basename, resolve, join } from 'node:path';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ClipMetadata {
  /** Drive-relative path, always starting with `/highlights/`. */
  path: string;
  /** Byte length of the clip. */
  size: number;
  /** SHA-256 hex digest of the bytes — clients verify replicated content. */
  sha256: string;
  /** Optional numeric external match id from the sidecar. */
  matchId: number | null;
  /** Human-readable clip title from the sidecar or filename fallback. */
  title: string;
  /** Optional in-match minute from the sidecar. */
  minute: number | null;
  /** Flag marking placeholder / ffmpeg-testsrc content. */
  placeholder: boolean;
}

export interface ClipManifest {
  enabled: boolean;
  ready: boolean;
  /** Hex-encoded drive key (32 bytes). Null when the drive is disabled. */
  key: string | null;
  /** Hex-encoded discovery key. Peers join swarm on this topic. */
  discoveryKey: string | null;
  clips: ClipMetadata[];
  ingestedAt: string | null;
  /** Which directory the operator dropped clips into, filesystem-relative. */
  sourceDir: string;
  note: string;
}

// -----------------------------------------------------------------------------
// Module-level state
// -----------------------------------------------------------------------------

interface DriveState {
  drive: unknown | null; // hyperdrive instance
  store: unknown | null; // corestore instance
  clips: ClipMetadata[];
  ingestedAt: string | null;
  key: string | null;
  discoveryKey: string | null;
  ready: boolean;
  enabled: boolean;
}

const state: DriveState = {
  drive: null,
  store: null,
  clips: [],
  ingestedAt: null,
  key: null,
  discoveryKey: null,
  ready: false,
  enabled: false,
};

// Path constants — CWD-relative so tests can drive them via process.chdir().
const DEFAULT_DRIVE_DIR_REL = 'tmp/match-clips';
const DEFAULT_SOURCE_DIR_REL = 'tmp/match-clips-source';

// -----------------------------------------------------------------------------
// Sidecar parsing
// -----------------------------------------------------------------------------

interface Sidecar {
  matchId: number | null;
  title: string | null;
  minute: number | null;
  placeholder: boolean;
}

const ALLOWED_SIDECAR_KEYS = new Set(['matchId', 'title', 'minute', 'placeholder', 'note']);

const parseSidecar = (rawText: string): Sidecar => {
  const empty: Sidecar = { matchId: null, title: null, minute: null, placeholder: false };
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return empty;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const obj = raw as Record<string, unknown>;
  // Reject sidecars with any unknown top-level key (strict allowlist).
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_SIDECAR_KEYS.has(k)) return empty;
  }
  const matchId =
    typeof obj.matchId === 'number' && Number.isFinite(obj.matchId) && obj.matchId >= 0
      ? Math.floor(obj.matchId)
      : null;
  const title =
    typeof obj.title === 'string' && obj.title.length > 0 && obj.title.length <= 200
      ? obj.title
      : null;
  const minute =
    typeof obj.minute === 'number' && Number.isFinite(obj.minute) && obj.minute >= 0 && obj.minute <= 200
      ? Math.floor(obj.minute)
      : null;
  const placeholder = obj.placeholder === true;
  return { matchId, title, minute, placeholder };
};

// -----------------------------------------------------------------------------
// Filename safety
// -----------------------------------------------------------------------------

/** Return true iff `name` is a safe MP4 filename with no path separators. */
const isSafeMp4Name = (name: string): boolean => {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) return false;
  // Reject any path separator or traversal marker.
  if (name.includes('/') || name.includes('\\') || name.includes('..') || name.startsWith('.')) {
    return false;
  }
  return /^[A-Za-z0-9_.-]+\.mp4$/.test(name);
};

// -----------------------------------------------------------------------------
// Drive init + ingestion
// -----------------------------------------------------------------------------

/**
 * Injectable drive factory. The default implementation loads
 * corestore + hyperdrive from node_modules. Tests inject a fake that returns
 * a deterministic key without touching NAPI modules (Bun's uv_get_osfhandle
 * gap prevents corestore from booting inside `bun test`, see
 * [[feedback-bun-napi-corestore]]).
 */
export interface DriveLike {
  key: Buffer | Uint8Array;
  discoveryKey: Buffer | Uint8Array;
  ready(): Promise<void>;
  put(name: string, buf: Buffer): Promise<void>;
  close?(): Promise<void>;
}
export interface StoreLike {
  close?(): Promise<void>;
}
export type DriveFactory = (driveDirAbs: string) => Promise<{ drive: DriveLike; store: StoreLike }>;

let _driveFactory: DriveFactory | null = null;

/** Test-only. Replace the drive+corestore factory. */
export const __setDriveFactoryForTest = (f: DriveFactory | null): void => {
  _driveFactory = f;
};

const defaultDriveFactory: DriveFactory = async (driveDirAbs: string) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Corestore = require('corestore');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Hyperdrive = require('hyperdrive');
  const store = new Corestore(driveDirAbs);
  const drive = new Hyperdrive(store) as DriveLike;
  await drive.ready();
  return { drive, store: store as StoreLike };
};

interface InitOpts {
  driveDirRel?: string;
  sourceDirRel?: string;
}

/**
 * Initialise the match-clip drive. Idempotent — a second call is a no-op that
 * returns the existing manifest. Never throws: on any error the state stays in
 * "enabled but not ready" and the caller receives a well-formed manifest with
 * an empty clip list. This matches the F13 graceful-degradation posture.
 */
export const initMatchClipDrive = async (opts: InitOpts = {}): Promise<ClipManifest> => {
  if (state.ready) return getManifest();

  state.enabled = true;
  const driveDirRel = opts.driveDirRel ?? DEFAULT_DRIVE_DIR_REL;
  const sourceDirRel = opts.sourceDirRel ?? DEFAULT_SOURCE_DIR_REL;
  const driveDirAbs = resolve(process.cwd(), driveDirRel);
  const sourceDirAbs = resolve(process.cwd(), sourceDirRel);

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('node:crypto');

    if (!existsSync(driveDirAbs)) {
      mkdirSync(driveDirAbs, { recursive: true });
    }

    const factory = _driveFactory ?? defaultDriveFactory;
    const { drive, store } = await factory(driveDirAbs);

    state.store = store;
    state.drive = drive;
    state.key = Buffer.from(drive.key as Uint8Array).toString('hex');
    state.discoveryKey = Buffer.from(drive.discoveryKey as Uint8Array).toString('hex');

    // Enumerate source files. If the source dir is missing the ingest is
    // simply empty — the drive still stands up with a real key.
    const clips: ClipMetadata[] = [];
    if (existsSync(sourceDirAbs)) {
      const entries = readdirSync(sourceDirAbs);
      for (const rawName of entries) {
        const name = basename(rawName);
        if (!isSafeMp4Name(name)) continue;
        const abs = join(sourceDirAbs, name);
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        if (st.size <= 0 || st.size > 128 * 1024 * 1024) continue; // 128 MB cap per clip

        let buf: Buffer;
        try {
          buf = readFileSync(abs);
        } catch {
          continue;
        }

        // Sidecar (optional).
        const sidecarAbs = `${abs}.json`;
        let sidecar: Sidecar = { matchId: null, title: null, minute: null, placeholder: false };
        if (existsSync(sidecarAbs)) {
          try {
            sidecar = parseSidecar(readFileSync(sidecarAbs, 'utf8'));
          } catch {
            /* keep default */
          }
        }

        const drivePath = `/highlights/${name}`;
        try {
          await drive.put(drivePath, buf);
        } catch (err) {
          console.warn(
            `[MatchClipDrive] drive.put failed for ${name}:`,
            (err as Error)?.message,
          );
          continue;
        }

        const sha = crypto.createHash('sha256').update(buf).digest('hex') as string;
        clips.push({
          path: drivePath,
          size: buf.length,
          sha256: sha,
          matchId: sidecar.matchId,
          title: sidecar.title ?? name.replace(/\.mp4$/i, '').replace(/-/g, ' '),
          minute: sidecar.minute,
          placeholder: sidecar.placeholder,
        });
      }
    }

    state.clips = clips;
    state.ingestedAt = new Date().toISOString();
    state.ready = true;
    console.log(
      `[MatchClipDrive] Ready. key=${state.key?.slice(0, 12)}... clips=${clips.length}`,
    );
    return getManifest();
  } catch (err) {
    console.error('[MatchClipDrive] init failed:', (err as Error)?.message);
    state.ready = false;
    return getManifest();
  }
};

// -----------------------------------------------------------------------------
// Manifest / clip accessors
// -----------------------------------------------------------------------------

export const getManifest = (): ClipManifest => ({
  enabled: state.enabled,
  ready: state.ready,
  key: state.key,
  discoveryKey: state.discoveryKey,
  clips: state.clips.slice(),
  ingestedAt: state.ingestedAt,
  sourceDir: DEFAULT_SOURCE_DIR_REL,
  note: state.ready
    ? 'Peers replicate this drive read-only via the discoveryKey. Clip bytes ' +
      'may be placeholder ffmpeg testsrc content until real WC26 highlights are dropped in.'
    : state.enabled
      ? 'Drive is enabled but not yet ready; init failed or is still running.'
      : 'ENABLE_MATCH_CLIP_DRIVE is off; no clips available on this backend.',
});

/**
 * Return metadata for clips matching a match externalId. Bounded to 20 results
 * as a defence against a caller asking for a highly-populated matchId in a
 * future ingest (label-cardinality analogue).
 */
export const getHighlightsForMatch = (matchId: number): ClipMetadata[] => {
  if (!Number.isFinite(matchId) || matchId < 0) return [];
  const flooredId = Math.floor(matchId);
  return state.clips.filter((c) => c.matchId === flooredId).slice(0, 20);
};

// -----------------------------------------------------------------------------
// Shutdown + test reset
// -----------------------------------------------------------------------------

export const shutdownMatchClipDrive = async (): Promise<void> => {
  try {
    const drive = state.drive as { close?: () => Promise<void> } | null;
    if (drive?.close) await drive.close();
  } catch {
    /* ignore */
  }
  try {
    const store = state.store as { close?: () => Promise<void> } | null;
    if (store?.close) await store.close();
  } catch {
    /* ignore */
  }
  state.drive = null;
  state.store = null;
};

/**
 * Test-only reset. Production code MUST NOT call this.
 */
export const __resetForTest = (): void => {
  state.drive = null;
  state.store = null;
  state.clips = [];
  state.ingestedAt = null;
  state.key = null;
  state.discoveryKey = null;
  state.ready = false;
  state.enabled = false;
};
