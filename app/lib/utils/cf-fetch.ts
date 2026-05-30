/**
 * Cloudflare-aware fetch utility
 * 
 * When running on Cloudflare Workers, many sites block datacenter IPs.
 * This utility detects if we're on Cloudflare and routes requests through
 * the RPI proxy to bypass these blocks.
 * 
 * Proxy strategy (in order):
 *   1. /fetch-rust — Chrome-like TLS fingerprint via rust-fetch binary.
 *      Bypasses Cloudflare bot detection that blocks Node.js https.
 *   2. /proxy      — Standard Node.js https proxy (fallback).
 *   3. Direct fetch — Last resort, may fail from datacenter IPs.
 * 
 * Usage:
 *   import { cfFetch } from '@/app/lib/utils/cf-fetch';
 *   const response = await cfFetch(url, options);
 */

// Cache the CF detection result — it won't change during a request lifecycle
let _isCfWorkerCached: boolean | null = null;

// Cache the RPI config — avoids repeated getCloudflareContext calls
let _rpiConfigCached: { url: string | undefined; key: string | undefined } | null = null;
let _rpiConfigCacheTime = 0;
const RPI_CONFIG_CACHE_TTL = 30_000; // 30 seconds

// Detect if we're running on Cloudflare Workers/Pages (via OpenNext)
function isCloudflareWorker(): boolean {
  if (_isCfWorkerCached !== null) return _isCfWorkerCached;
  
  try {
    // Method 1: caches.default only exists in Cloudflare Workers
    // @ts-ignore - caches.default only exists in Cloudflare Workers
    if (typeof caches !== 'undefined' && typeof caches.default !== 'undefined') {
      _isCfWorkerCached = true;
      return true;
    }
    
    // Method 2: Production environment is always CF Workers for this app
    // (deployed via @opennextjs/cloudflare — there is no Node.js production server)
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') {
      _isCfWorkerCached = true;
      return true;
    }
    
    _isCfWorkerCached = false;
    return false;
  } catch {
    _isCfWorkerCached = false;
    return false;
  }
}

/**
 * Get RPI proxy configuration from environment.
 * Works in both Node.js (dev) and Cloudflare Workers (production).
 * 
 * On CF Workers, secrets like RPI_PROXY_URL are NOT in process.env.
 * They're only accessible via getCloudflareContext() from @opennextjs/cloudflare.
 */
// Strip UTF-8 BOM (﻿) and surrounding whitespace from secret values.
// Some secrets were set from BOM-prefixed files via `wrangler secret put`,
// which makes them fail URL parsing and emits non-ASCII header warnings.
function cleanSecret(v: string | undefined): string | undefined {
  if (!v) return v;
  return v.replace(/^﻿/, '').trim();
}

function getRpiConfig(): { url: string | undefined; key: string | undefined } {
  // Return cached config if still fresh
  if (_rpiConfigCached && (Date.now() - _rpiConfigCacheTime) < RPI_CONFIG_CACHE_TTL) {
    return _rpiConfigCached;
  }

  // Try process.env first (works in Node.js dev and for NEXT_PUBLIC_ vars baked at build time)
  let url = cleanSecret(process.env.RPI_PROXY_URL || process.env.NEXT_PUBLIC_RPI_PROXY_URL);
  let key = cleanSecret(process.env.RPI_PROXY_KEY || process.env.NEXT_PUBLIC_RPI_PROXY_KEY);
  
  // If we already have both from process.env, cache and return
  if (url && key) {
    _rpiConfigCached = { url, key };
    _rpiConfigCacheTime = Date.now();
    return _rpiConfigCached;
  }
  
  // On Cloudflare Workers, secrets are in the CF context, not process.env.
  // Try multiple methods to access them.
  if (isCloudflareWorker()) {
    // Method 1: OpenNext's getCloudflareContext (primary method for @opennextjs/cloudflare)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getCloudflareContext } = require('@opennextjs/cloudflare');
      // Use synchronous version — works in request context
      const ctx = getCloudflareContext({ async: false });
      if (ctx?.env) {
        url = url || cleanSecret(ctx.env.RPI_PROXY_URL);
        key = key || cleanSecret(ctx.env.RPI_PROXY_KEY);
        if (url && key) {
          console.log('[cfFetch] Got RPI config from getCloudflareContext');
          _rpiConfigCached = { url, key };
          _rpiConfigCacheTime = Date.now();
          return _rpiConfigCached;
        }
      }
    } catch (e) {
      console.debug('[cfFetch] getCloudflareContext sync failed:', e instanceof Error ? e.message : e);
    }

    // Method 2: Check globalThis.__env__ (some OpenNext versions expose env here)
    try {
      const gEnv = (globalThis as any).__env__;
      if (gEnv) {
        url = url || cleanSecret(gEnv.RPI_PROXY_URL);
        key = key || cleanSecret(gEnv.RPI_PROXY_KEY);
      }
    } catch { /* ignore */ }

    // Method 3: Check globalThis.process.env (nodejs_compat shim)
    try {
      const pEnv = (globalThis as any).process?.env;
      if (pEnv) {
        url = url || cleanSecret(pEnv.RPI_PROXY_URL);
        key = key || cleanSecret(pEnv.RPI_PROXY_KEY);
      }
    } catch { /* ignore */ }
    
    if (!url || !key) {
      console.warn('[cfFetch] RPI config NOT found on CF Worker. Ensure RPI_PROXY_URL and RPI_PROXY_KEY are set via `wrangler secret put`');
    }
  }
  
  _rpiConfigCached = { url, key };
  _rpiConfigCacheTime = Date.now();
  return _rpiConfigCached;
}

/**
 * Validate an RPI URL — must be parseable and have a real host (not a CF zone
 * error page). Catches BOM-prefixed secrets and "https://" with no host.
 */
function isValidRpiUrl(s: string | undefined): s is string {
  if (!s) return false;
  try {
    const u = new URL(s);
    return !!u.host && (u.protocol === 'http:' || u.protocol === 'https:');
  } catch {
    return false;
  }
}

// Stop logging the same "RPI is dead" warning on every request.
let _rpiDeadLogged = false;

// Cache the MEDIA_PROXY service binding lookup result.
type FetcherLike = { fetch: (input: any, init?: any) => Promise<Response> };
let _mediaProxyBindingCached: FetcherLike | null | undefined;

function getMediaProxyBinding(): FetcherLike | null {
  if (_mediaProxyBindingCached !== undefined) return _mediaProxyBindingCached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCloudflareContext } = require('@opennextjs/cloudflare');
    const ctx = getCloudflareContext({ async: false });
    const binding = ctx?.env?.MEDIA_PROXY;
    if (binding && typeof binding.fetch === 'function') {
      _mediaProxyBindingCached = binding as FetcherLike;
      return _mediaProxyBindingCached;
    }
  } catch {
    // getCloudflareContext only available on CF Workers
  }
  _mediaProxyBindingCached = null;
  return null;
}

/**
 * Fetch that automatically routes through RPI proxy when on Cloudflare.
 *
 * Decision logic:
 *  - forceProxy=true → proxy through RPI (caller knows it's needed)
 *  - workers.dev target → direct fetch. Worker→worker calls on our own
 *    infrastructure don't need IP rotation, and the RPI subdomain is
 *    currently NXDOMAIN — routing through it just breaks the call.
 *  - On CF Worker + RPI valid → try RPI for external URLs (datacenter IP blocking)
 *  - Otherwise → direct fetch
 *
 * Proxy strategy when proxying:
 *   1. /fetch-rust — Chrome TLS fingerprint, bypasses bot detection
 *   2. /proxy — standard Node.js https
 *   3. direct fetch — last resort
 * Any non-2xx response from RPI now falls through to the next strategy
 * instead of being returned as-is (RPI returning a CF zone error is not a
 * real upstream response).
 */
export async function cfFetch(
  url: string,
  options: RequestInit = {},
  forceProxy: boolean = false
): Promise<Response> {
  const isCfWorker = isCloudflareWorker();

  const { url: RPI_PROXY_URL, key: RPI_PROXY_KEY } = getRpiConfig();
  const rpiUsable = isValidRpiUrl(RPI_PROXY_URL) && !!RPI_PROXY_KEY;

  const isCfWorkerUrl = url.includes('.workers.dev');
  const isMediaProxyUrl = url.includes('media-proxy.vynx-3b3.workers.dev');

  // Our own media-proxy worker: route via Service Binding when available.
  // env.MEDIA_PROXY.fetch() is a private RPC channel — subrequests inside
  // media-proxy (e.g. 27 parallel hexa.su fetches in /flixer/extract-all) do
  // NOT cascade against this worker's subrequest budget, so we don't hit
  // CF error 1042 when called from the Next.js worker.
  if (isMediaProxyUrl && !forceProxy) {
    const binding = getMediaProxyBinding();
    if (binding) {
      try {
        return await binding.fetch(url, options as any);
      } catch (err) {
        console.warn('[cfFetch] MEDIA_PROXY binding fetch failed, falling back to HTTP:', err instanceof Error ? err.message : err);
      }
    }
    // No binding (or binding failed) → direct HTTP. Worker→worker via plain
    // fetch still works for endpoints that don't fan out internally.
    return fetch(url, options);
  }

  // Other workers.dev URLs (sync, dlhd, cdn-live, etc.): direct fetch.
  if (isCfWorkerUrl && !forceProxy) {
    return fetch(url, options);
  }

  const useProxy = forceProxy || (isCfWorker && rpiUsable);

  if (useProxy && rpiUsable) {
    const headers = new Headers(options.headers);
    headers.set('X-API-Key', RPI_PROXY_KEY!);

    // ── Strategy 1: /fetch-rust (Chrome TLS fingerprint) ──
    try {
      const rustUrl = `${RPI_PROXY_URL}/fetch-rust?url=${encodeURIComponent(url)}`;
      const rustResponse = await fetch(rustUrl, {
        method: 'GET',
        headers,
        signal: options.signal || AbortSignal.timeout(20_000),
      });

      // Only accept real upstream responses. 5xx from RPI itself = fall through.
      if (rustResponse.status < 500) {
        console.log(`[cfFetch] rust-fetch OK (${rustResponse.status}) for: ${url.substring(0, 60)}`);
        return rustResponse;
      }
      console.warn(`[cfFetch] rust-fetch ${rustResponse.status} for: ${url.substring(0, 60)}, falling back to /proxy`);
    } catch (rustError) {
      console.warn(`[cfFetch] rust-fetch error for ${url.substring(0, 60)}:`, rustError instanceof Error ? rustError.message : rustError);
    }

    // ── Strategy 2: /proxy (standard Node.js https) ──
    try {
      const proxyUrl = `${RPI_PROXY_URL}/proxy?url=${encodeURIComponent(url)}`;
      const response = await fetch(proxyUrl, {
        method: options.method || 'GET',
        headers,
        signal: options.signal,
        body: options.body,
      });

      // RPI returning 4xx/5xx is NOT a real upstream response — fall through.
      // (Returning RPI's own error page leaks "error code: 1042" etc. to callers.)
      if (response.status < 500) {
        if (response.status === 429) {
          console.warn(`[cfFetch] RPI /proxy rate limited (429) for: ${url.substring(0, 60)}...`);
        }
        return response;
      }
      console.warn(`[cfFetch] RPI /proxy ${response.status} for: ${url.substring(0, 60)}, falling back to direct`);
    } catch (error) {
      console.error(`[cfFetch] RPI /proxy error for ${url.substring(0, 60)}:`, error instanceof Error ? error.message : error);
    }

    // ── Strategy 3: direct fetch (last resort) ──
    console.warn(`[cfFetch] Both RPI routes failed, trying direct fetch: ${url.substring(0, 60)}`);
    return fetch(url, options);
  }

  if (isCfWorker && !rpiUsable && !_rpiDeadLogged) {
    console.warn(`[cfFetch] RPI not usable (URL invalid or missing). Direct-fetching external URLs from CF Worker. First target: ${url.substring(0, 80)}`);
    _rpiDeadLogged = true;
  }

  return fetch(url, options);
}

/**
 * Check if RPI proxy is available
 */
export function isRpiProxyConfigured(): boolean {
  const { url, key } = getRpiConfig();
  return !!(url && key);
}

/**
 * Check if we're on Cloudflare and need proxying
 */
export function needsProxying(): boolean {
  return isCloudflareWorker();
}
