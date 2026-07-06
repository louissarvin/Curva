/**
 * Football-data.org HTTP client (F7 / ARCHITECTURE.md Section 20).
 *
 * Surface:
 *  - listCompetitionMatches({ competitionCode, dateFrom, dateTo }) — bulk fetch
 *    used by the live-pulse worker. One call per tick.
 *  - getMatch(externalMatchId) — per-match fallback. Not used in the happy path
 *    but exposed for parity with the architect's spec.
 *
 * Operational invariants:
 *  - Never throws. On error the client returns `[]` / `null` so the worker can
 *    keep ticking without crashing the API process.
 *  - When the API key is unset, `isEnabled()` returns false and all calls
 *    short-circuit (no HTTP made).
 *  - On 401/403 the client self-disables for the rest of the process lifetime
 *    so a wrong key does not burn the rate-limit budget.
 *  - On 429 the client logs and returns null/[]; the worker honours the
 *    next-tick schedule.
 *  - On 5xx the client retries once after 1s, then returns null/[].
 *  - PII: never logs the API key or full request URL with query params.
 *
 * Doc citation: https://docs.football-data.org/general/v4/resources/match.html
 */

import axios, { type AxiosError, type AxiosInstance } from 'axios';

const BASE_URL = 'https://api.football-data.org/v4';
const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 1000;

export type FdMatchStatus =
  | 'SCHEDULED'
  | 'TIMED'
  | 'LIVE'
  | 'IN_PLAY'
  | 'PAUSED'
  | 'FINISHED'
  | 'POSTPONED'
  | 'SUSPENDED'
  | 'CANCELED'
  | 'CANCELLED'
  | 'AWARDED';

export interface FdTeam {
  id: number;
  name: string;
  shortName?: string;
  tla?: string;
}

export interface FdGoal {
  minute: number;
  scorer?: { name: string } | null;
  team?: { id: number; name?: string } | null;
  // Some response shapes use 'type' to mark VAR/penalty/own goal.
  type?: string;
}

export interface FdMatch {
  id: number;
  status: FdMatchStatus;
  utcDate: string;
  minute?: number | null;
  // Added-time minutes marker. Populated by football-data v4 at half-end
  // boundaries (typically minute 45 or 90). Nullable because the free tier
  // and most non-live states omit the field. Verified against
  // https://docs.football-data.org/general/v4/match.html on 2026-07-06.
  injuryTime?: number | null;
  homeTeam: FdTeam;
  awayTeam: FdTeam;
  score: {
    fullTime: { home: number | null; away: number | null };
    halfTime?: { home: number | null; away: number | null };
    duration?: string;
  };
  goals?: FdGoal[];
}

export interface FootballDataClientOpts {
  apiKey: string | undefined;
  tier?: 'free' | 'livescores';
  timeoutMs?: number;
  // Test seam — inject a pre-configured axios instance.
  axiosInstance?: AxiosInstance;
}

const isAxiosError = (err: unknown): err is AxiosError => {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { isAxiosError?: boolean }).isAxiosError === true
  );
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class FootballDataClient {
  private readonly apiKey: string | undefined;
  public readonly tier: 'free' | 'livescores';
  private readonly http: AxiosInstance;
  /**
   * Latch flipped to true on 401/403. Once tripped, the client is dead for the
   * rest of the process lifetime. Restarting the process re-evaluates the key.
   */
  private authDisabled = false;

  constructor(opts: FootballDataClientOpts) {
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.tier = opts.tier === 'livescores' ? 'livescores' : 'free';
    this.http =
      opts.axiosInstance ??
      axios.create({
        baseURL: BASE_URL,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        // Important: do NOT throw on non-2xx; we want to inspect status.
        validateStatus: () => true,
      });
  }

  /** True iff a non-empty API key is present and the client has not self-disabled. */
  isEnabled(): boolean {
    return Boolean(this.apiKey) && !this.authDisabled;
  }

  /**
   * Bulk fetch of competition matches in a date window. Returns [] on any
   * non-2xx, network error, or when disabled. Never throws.
   */
  async listCompetitionMatches(opts: {
    competitionCode: string;
    dateFrom: string; // YYYY-MM-DD
    dateTo: string; // YYYY-MM-DD
  }): Promise<FdMatch[]> {
    if (!this.isEnabled()) return [];

    const url = `/competitions/${encodeURIComponent(opts.competitionCode)}/matches`;
    const params = { dateFrom: opts.dateFrom, dateTo: opts.dateTo };
    const response = await this.requestWithRetry(url, params);
    if (!response) return [];

    const data = response.data as { matches?: FdMatch[] } | undefined;
    if (!data || !Array.isArray(data.matches)) return [];
    return data.matches;
  }

  /**
   * Single-match detail fetch. Returns null on any failure. Never throws.
   */
  async getMatch(externalMatchId: number): Promise<FdMatch | null> {
    if (!this.isEnabled()) return null;
    if (!Number.isFinite(externalMatchId) || externalMatchId <= 0) return null;

    const url = `/matches/${externalMatchId}`;
    const response = await this.requestWithRetry(url);
    if (!response) return null;

    const data = response.data as FdMatch | undefined;
    if (!data || typeof data.id !== 'number') return null;
    return data;
  }

  /**
   * Internal: GET with the auth header, optional retry on 5xx. Returns the
   * raw axios response on 2xx, null otherwise. Logs at WARN on rate-limit /
   * auth-failure paths.
   */
  private async requestWithRetry(
    url: string,
    params?: Record<string, string>
  ): Promise<{ status: number; data: unknown } | null> {
    const headers = { 'X-Auth-Token': this.apiKey as string };

    const attempt = async (): Promise<{ status: number; data: unknown } | null> => {
      try {
        const res = await this.http.get(url, { headers, params });
        return { status: res.status, data: res.data };
      } catch (err) {
        // Network-level error (DNS, refused, timeout). Axios may throw despite
        // validateStatus when the request never completes.
        if (isAxiosError(err)) {
          console.warn(
            `[footballData] network error on GET ${url}: ${err.code ?? err.message}`
          );
        } else {
          console.warn(
            `[footballData] unknown error on GET ${url}:`,
            (err as Error)?.message
          );
        }
        return null;
      }
    };

    let response = await attempt();
    if (!response) return null;

    // 2xx — return immediately.
    if (response.status >= 200 && response.status < 300) {
      return response;
    }

    // 401 / 403 — bad key. Disable for this process and log loudly.
    if (response.status === 401 || response.status === 403) {
      console.error(
        `[footballData] auth failed (${response.status}); disabling client for this process`
      );
      this.authDisabled = true;
      return null;
    }

    // 429 — rate limited. Log + bail. The worker's cron schedule is our backoff.
    if (response.status === 429) {
      console.warn(`[footballData] rate-limited on ${url}; backing off until next tick`);
      return null;
    }

    // 5xx — one retry after a short pause.
    if (response.status >= 500 && response.status < 600) {
      console.warn(
        `[footballData] ${response.status} on ${url}; retrying once after ${RETRY_DELAY_MS}ms`
      );
      await sleep(RETRY_DELAY_MS);
      response = await attempt();
      if (!response) return null;
      if (response.status >= 200 && response.status < 300) return response;
      console.warn(
        `[footballData] ${response.status} on ${url} after retry; giving up this tick`
      );
      return null;
    }

    // Anything else (e.g. 4xx other than auth/rate) — log and bail.
    console.warn(`[footballData] unexpected status ${response.status} on ${url}`);
    return null;
  }
}

// =============================================================================
// F2: Deterministic slug derivation for the World Cup 2026 fixture warmer.
//
// Slug shape (see memory/impl_fixture_deeplinks_sse.md):
//   wc2026-<phase>[-<matchNumber>]
//
// Phase codes match backend/prisma/schema.prisma MatchStage enum:
//   group -> g, r16 -> r16, qf -> qf, sf -> sf, third_place -> third, final -> final
//
// Examples:
//   wc2026-final           (unique fixture, no ordinal)
//   wc2026-third           (unique fixture, no ordinal)
//   wc2026-sf2             (2 semi-finals, compact form)
//   wc2026-qf3             (4 quarter-finals, compact form)
//   wc2026-r16-5           (16 R16 matches, readable dashed form)
//   wc2026-r32-12          (32 R32 matches, readable dashed form)
//   wc2026-g-100034        (group stage, externalId as tail)
//
// Slugs must satisfy the renderer's ROOM_SLUG_REGEX (^[a-z0-9-]{3,32}$).
// =============================================================================

export type CurvaMatchStage =
  | 'group'
  | 'r16'
  | 'qf'
  | 'sf'
  | 'third_place'
  | 'final';

export const PHASE_SLUG_CODE: Record<CurvaMatchStage, string> = {
  group: 'g',
  r16: 'r16',
  qf: 'qf',
  sf: 'sf',
  third_place: 'third',
  final: 'final',
};

// Unused position argument names are still emitted at type check for clarity.
export function slugForMatch(opts: {
  stage: CurvaMatchStage;
  phaseOrdinal: number; // 1-indexed within phase (ignored for unique phases)
  externalId?: number | null; // used as tail for the group stage
}): string {
  const code = PHASE_SLUG_CODE[opts.stage];
  if (opts.stage === 'final' || opts.stage === 'third_place') {
    return `wc2026-${code}`;
  }
  if (opts.stage === 'group') {
    // Group stage: 48 matches; externalId is the compact stable disambiguator.
    // Fallback to phaseOrdinal only if externalId is missing so the slug still
    // renders (should never happen with a hydrated DB row).
    const tail = opts.externalId ?? opts.phaseOrdinal;
    return `wc2026-${code}-${tail}`;
  }
  // sf/qf are two- and four-phase; drop the dash for hand-typeable compactness.
  if (opts.stage === 'sf' || opts.stage === 'qf') {
    return `wc2026-${code}${opts.phaseOrdinal}`;
  }
  // r16 / r32: keep the dash for readability at the 16- and 32-match count.
  return `wc2026-${code}-${opts.phaseOrdinal}`;
}
