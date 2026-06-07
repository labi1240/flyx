/**
 * Turnstile VPS Client — Lightweight, commit-safe.
 *
 * Calls the OVH VPS Turnstile solver service to get cf_clearance tokens.
 * Contains NO solver logic — just an HTTP client with local caching.
 * The actual solver (server.js) runs ONLY on the OVH VPS and this machine.
 *
 * Endpoints called on VPS:
 *   GET /solve?target=videasy|primesrc[&force=true]
 *   GET /health
 */

// ═══════════════════════════════════════════════════════════════════
// CONFIG (set via env vars in Worker bootstrap)
// ═══════════════════════════════════════════════════════════════════

let vpsUrl: string | null = null;
let vpsToken: string | null = null;

export function configureVpsSolver(url?: string, token?: string): void {
  if (url) vpsUrl = url.replace(/\/+$/, '');
  if (token) vpsToken = token;
  if (url) console.log(`[TurnstileClient] VPS solver: ${vpsUrl}`);
}

// ═══════════════════════════════════════════════════════════════════
// TARGETS (commit-safe — just sitekeys, no solver logic)
// ═══════════════════════════════════════════════════════════════════

export interface TurnstileTarget {
  name: string;
  sitekey: string;
  origin: string;
  referer: string;
  mode: string;
}

export const TARGETS: Record<string, TurnstileTarget> = {
  videasy: {
    name: 'Videasy',
    sitekey: '0x4AAAAAADerxS_C3ByUbYxH',
    origin: 'https://player.videasy.net',
    referer: 'https://player.videasy.net/',
    mode: 'mlf2t',
  },
  primesrc: {
    name: 'PrimeSrc',
    sitekey: '0x4AAAAAACox-LngVREu55Y4',
    origin: 'https://primesrc.me',
    referer: 'https://primesrc.me/',
    mode: 'mlf2t',
  },
};

// ═══════════════════════════════════════════════════════════════════
// LOCAL CACHE (avoids calling VPS for every request)
// ═══════════════════════════════════════════════════════════════════

const SESSION_TTL_MS = 25 * 60_000; // cf_clearance lasts ~30min

interface CacheEntry {
  cfClearance: string;
  obtainedAt: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(targetKey: string): string | null {
  const entry = cache.get(targetKey);
  if (entry && (Date.now() - entry.obtainedAt) < SESSION_TTL_MS) {
    return entry.cfClearance;
  }
  if (entry) cache.delete(targetKey);
  return null;
}

function setCached(targetKey: string, cfClearance: string): void {
  cache.set(targetKey, { cfClearance, obtainedAt: Date.now() });
}

// ═══════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════

export interface TargetStats {
  attempts: number;
  successes: number;
  failures: number;
  failureReasons: Record<string, number>;
  totalSolveTimeMs: number;
  solveCount: number;
}

export interface SolverStats {
  targets: Record<string, TargetStats>;
  cacheHits: number;
  cacheMisses: number;
  vpsReachable: boolean;
  uptime: number;
}

const stats: {
  targets: Record<string, TargetStats>;
  cacheHits: number;
  cacheMisses: number;
  uptime: number;
} = {
  targets: {},
  cacheHits: 0,
  cacheMisses: 0,
  uptime: Date.now(),
};

function getTargetStats(targetKey: string): TargetStats {
  if (!stats.targets[targetKey]) {
    stats.targets[targetKey] = {
      attempts: 0, successes: 0, failures: 0,
      failureReasons: {},
      totalSolveTimeMs: 0, solveCount: 0,
    };
  }
  return stats.targets[targetKey];
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════

/**
 * Get a cf_clearance cookie for the given target.
 * Calls the OVH VPS solver service (which runs the actual solver logic).
 * Results are cached locally to minimize VPS calls.
 */
export async function getCfClearance(
  targetKey: string,
  forceFresh = false,
): Promise<string | null> {
  if (!vpsUrl) {
    console.error('[TurnstileClient] VPS solver not configured (missing TURNSTILE_SOLVER_URL)');
    return null;
  }

  if (!TARGETS[targetKey]) {
    console.error(`[TurnstileClient] Unknown target: ${targetKey}`);
    return null;
  }

  // Check local cache
  if (!forceFresh) {
    const cached = getCached(targetKey);
    if (cached) {
      stats.cacheHits++;
      return cached;
    }
  }
  stats.cacheMisses++;

  const s = getTargetStats(targetKey);
  s.attempts++;
  const startTime = Date.now();

  try {
    const params = new URLSearchParams({ target: targetKey });
    if (forceFresh) params.set('force', 'true');

    const headers: Record<string, string> = {};
    if (vpsToken) {
      headers['Authorization'] = `Bearer ${vpsToken}`;
    }

    const url = `${vpsUrl}/solve?${params.toString()}`;
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error(`[TurnstileClient] VPS HTTP ${resp.status}: ${body.substring(0, 200)}`);
      s.failures++;
      s.failureReasons[`vps_http_${resp.status}`] = (s.failureReasons[`vps_http_${resp.status}`] || 0) + 1;
      return null;
    }

    const data = await resp.json() as {
      success: boolean;
      cfClearance: string | null;
      cached?: boolean;
    };

    if (data.success && data.cfClearance) {
      setCached(targetKey, data.cfClearance);
      s.successes++;
      s.totalSolveTimeMs += Date.now() - startTime;
      s.solveCount++;
      console.log(`[TurnstileClient] ✅ cf_clearance from VPS (${data.cached ? 'cached' : 'fresh'}, ${Date.now() - startTime}ms)`);
      return data.cfClearance;
    }

    s.failures++;
    s.failureReasons['vps_solve_failed'] = (s.failureReasons['vps_solve_failed'] || 0) + 1;
    console.log(`[TurnstileClient] VPS returned success=false`);
    return null;
  } catch (e) {
    const msg = (e as Error).message || String(e);
    s.failures++;
    if (msg.includes('timeout') || msg.includes('abort')) {
      s.failureReasons['vps_timeout'] = (s.failureReasons['vps_timeout'] || 0) + 1;
    } else {
      s.failureReasons['vps_network'] = (s.failureReasons['vps_network'] || 0) + 1;
    }
    console.error(`[TurnstileClient] VPS error: ${msg}`);
    return null;
  }
}

export function invalidateCfClearance(targetKey: string): void {
  cache.delete(targetKey);
}

export function hasCachedSession(targetKey: string): boolean {
  return getCached(targetKey) !== null;
}

export function getSessionCacheSize(): number {
  // Clean expired entries
  const now = Date.now();
  for (const [k, v] of cache) {
    if ((now - v.obtainedAt) >= SESSION_TTL_MS) cache.delete(k);
  }
  return cache.size;
}

export function getSolverStats(): SolverStats {
  const result: SolverStats = {
    targets: {},
    cacheHits: stats.cacheHits,
    cacheMisses: stats.cacheMisses,
    vpsReachable: !!vpsUrl,
    uptime: Date.now() - stats.uptime,
  };

  for (const [key, s] of Object.entries(stats.targets)) {
    const total = s.successes + s.failures;
    result.targets[key] = {
      attempts: s.attempts,
      successes: s.successes,
      failures: s.failures,
      failureReasons: { ...s.failureReasons },
      totalSolveTimeMs: s.totalSolveTimeMs,
      solveCount: s.solveCount,
    };
  }

  return result;
}

export { configureVpsSolver as initTurnstileSolver };
