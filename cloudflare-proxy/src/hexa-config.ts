/**
 * Hexa/Flixer Runtime Configuration Reader
 *
 * Reads volatile config (API domain, fingerprint, routes, WASM hash) from
 * Cloudflare KV with an in-memory cache (5-minute TTL). Falls back to
 * hardcoded defaults when KV is unavailable or keys are missing.
 *
 * Requirements: REQ-CONFIG-1.2, REQ-CONFIG-1.3, REQ-CONFIG-1.4,
 *               REQ-DOMAIN-2.1, REQ-FP-2.1
 */

export interface ApiRoutes {
  time: string;
  movieImages: string;
  tvImages: string;
}

export interface HexaConfig {
  apiDomain: string;
  fingerprintLite: string;
  apiRoutes: ApiRoutes;
  wasmHash: string | null;
  lastCheckTimestamp: number | null;
}

export const DEFAULTS: HexaConfig = {
  apiDomain: 'https://plsdontscrapemelove.flixer.su',
  fingerprintLite: 'e9136c41504646444',
  apiRoutes: {
    time: '/api/time',
    movieImages: '/api/tmdb/movie/{tmdbId}/images',
    tvImages: '/api/tmdb/tv/{tmdbId}/season/{season}/episode/{episode}/images',
  },
  wasmHash: null,
  lastCheckTimestamp: null,
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  config: HexaConfig;
  timestamp: number;
}

let cache: CacheEntry | null = null;

/**
 * Exposed for testing — allows resetting the module-level cache.
 */
export function _resetCache(): void {
  cache = null;
}

/**
 * Exposed for testing — allows overriding the "now" function used for
 * cache freshness checks so tests can simulate time progression.
 */
export let _now: () => number = () => Date.now();

export function _setNow(fn: () => number): void {
  _now = fn;
}

async function readFromKV(kv: KVNamespace): Promise<Partial<HexaConfig>> {
  const partial: Partial<HexaConfig> = {};

  try {
    const domain = await kv.get('api_domain');
    if (domain) partial.apiDomain = domain;
  } catch { /* fallback */ }

  try {
    const fp = await kv.get('fingerprint_lite');
    if (fp) partial.fingerprintLite = fp;
  } catch { /* fallback */ }

  try {
    const routesJson = await kv.get('api_routes');
    if (routesJson) {
      const parsed = JSON.parse(routesJson);
      if (parsed && typeof parsed === 'object') {
        partial.apiRoutes = parsed as ApiRoutes;
      }
    }
  } catch { /* fallback */ }

  try {
    const hash = await kv.get('wasm_hash');
    if (hash) partial.wasmHash = hash;
  } catch { /* fallback */ }

  try {
    const ts = await kv.get('last_check_timestamp');
    if (ts) {
      const parsed = Date.parse(ts);
      if (!isNaN(parsed)) partial.lastCheckTimestamp = parsed;
    }
  } catch { /* fallback */ }

  return partial;
}

/**
 * Allowed domain patterns for the API base URL.
 * Prevents SSRF if KV is poisoned — only hexa/flixer domains are accepted.
 */
// moviedb domains (e.g. theemoviedb.hexa.su) REQUIRE captcha — blocked.
// Only allow api.* and plsdontscrapemelove.* which work without captcha.
export const ALLOWED_API_DOMAIN_PATTERN = /^https:\/\/[a-z]*(?:api|plsdontscrapemelove)\.(hexa|flixer)\.[a-z]{2,6}$/;

/**
 * Fingerprint must be alphanumeric only — prevents header injection.
 */
const FINGERPRINT_PATTERN = /^[a-zA-Z0-9]+$/;

/**
 * API route must start with / and contain only safe path characters.
 */
const SAFE_ROUTE_PATTERN = /^\/[a-zA-Z0-9\/_\-{}]+$/;

function isValidApiDomain(domain: unknown): domain is string {
  return typeof domain === 'string' && ALLOWED_API_DOMAIN_PATTERN.test(domain);
}

function isValidFingerprint(fp: unknown): fp is string {
  return typeof fp === 'string' && fp.length > 0 && FINGERPRINT_PATTERN.test(fp);
}

function isValidRoute(route: unknown): route is string {
  return typeof route === 'string' && route.length > 0 && SAFE_ROUTE_PATTERN.test(route);
}

function mergeWithDefaults(partial: Partial<HexaConfig>): HexaConfig {
  return {
    apiDomain: isValidApiDomain(partial.apiDomain)
      ? partial.apiDomain
      : DEFAULTS.apiDomain,
    fingerprintLite: isValidFingerprint(partial.fingerprintLite)
      ? partial.fingerprintLite
      : DEFAULTS.fingerprintLite,
    apiRoutes: {
      time: isValidRoute(partial.apiRoutes?.time) ? partial.apiRoutes!.time : DEFAULTS.apiRoutes.time,
      movieImages: isValidRoute(partial.apiRoutes?.movieImages) ? partial.apiRoutes!.movieImages : DEFAULTS.apiRoutes.movieImages,
      tvImages: isValidRoute(partial.apiRoutes?.tvImages) ? partial.apiRoutes!.tvImages : DEFAULTS.apiRoutes.tvImages,
    },
    wasmHash: partial.wasmHash ?? DEFAULTS.wasmHash,
    lastCheckTimestamp: partial.lastCheckTimestamp ?? DEFAULTS.lastCheckTimestamp,
  };
}

/**
 * Returns the current Hexa config, using the in-memory cache when fresh
 * (< 5 minutes old). On cache miss reads from KV and merges with defaults.
 * If KV is undefined or throws, returns hardcoded defaults.
 */
export async function getHexaConfig(kv?: KVNamespace): Promise<HexaConfig> {
  const now = _now();

  if (cache && (now - cache.timestamp) < CACHE_TTL_MS) {
    return cache.config;
  }

  if (!kv) {
    const config = { ...DEFAULTS, apiRoutes: { ...DEFAULTS.apiRoutes } };
    cache = { config, timestamp: now };
    return config;
  }

  try {
    const partial = await readFromKV(kv);
    const config = mergeWithDefaults(partial);
    cache = { config, timestamp: now };
    return config;
  } catch {
    const config = { ...DEFAULTS, apiRoutes: { ...DEFAULTS.apiRoutes } };
    cache = { config, timestamp: now };
    return config;
  }
}

/**
 * Force-refresh from KV, bypassing the cache. Used after the monitor
 * writes new values so the extraction worker picks them up immediately.
 */
export async function refreshHexaConfig(kv?: KVNamespace): Promise<HexaConfig> {
  cache = null;
  return getHexaConfig(kv);
}
