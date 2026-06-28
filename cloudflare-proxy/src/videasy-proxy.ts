/**
 * Videasy Source Proxy
 *
 * CORS proxy for api.videasy.to. Fetches the raw hex-encrypted API response
 * and returns it to the caller. WASM + AES decryption happens client-side.
 *
 * Extraction priority:
 *   1. Session pool (extension-contributed cf_clearance, ~1-3s)
 *   2. Direct API call (no auth, works for movies on /cdn/sources-with-title)
 *   3. Return directUrl for browser fetch (last resort, ~5-10s)
 *
 * NOTE: CF Workers cannot reach challenges.cloudflare.com (403 from own infra).
 * The Turnstile HTTP solver works from non-Cloudflare IPs but not from Workers.
 * Session pool is the primary auth path for the Worker.
 *
 * Routes:
 *   GET  /videasy/extract?tmdbId=X&type=movie|tv&title=Y&...
 *   POST /videasy/pool     — contribute a session to the pool
 *   GET  /videasy/health   — pool + solver status
 */

import { createLogger } from './logger';
import { CORS_HEADERS } from './cors';
import { getCfClearance, invalidateCfClearance, hasCachedSession, getSessionCacheSize, getSolverStats, TARGETS } from './turnstile-client';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';

const VIDEOASY_API = 'https://api.videasy.to';
const SESSION_MAX_AGE_MS = 45 * 60 * 1000; // 45 min — evict before natural expiry

const API_HEADERS: Record<string, string> = {
  'Origin': 'https://player.videasy.to',
  'Referer': 'https://player.videasy.to/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'x-app-id': 'videasy',
};

const API_ENDPOINTS = [
  '/cdn/sources-with-title',
  '/mb-flix/sources-with-title',
  '/1movies/sources-with-title',
  '/moviebox/sources-with-title',
  '/myflixerzupcloud/sources-with-title',
  '/m4uhd/sources-with-title',
  '/vidsrc/sources-with-title',
  '/flixer/sources-with-title',
];

// /downloader2 uses a different parameter format (tmdbId, type, title, season, episode)
// — must be handled separately, not through fetchVideasyApi()
const DOWNLOADER2_PATH = '/downloader2/sources-with-title';

const ENDPOINT_TIMEOUT_MS = 15_000;

interface VideasyExtractParams {
  tmdbId: string;
  title: string;
  type: string;
  year?: string;
  season?: string;
  episode?: string;
  imdbId?: string;
  totalSeasons?: string;
}

// ── Session Pool ─────────────────────────────────────────────────────────

interface PooledSession {
  token: string;       // session token (cookie value or JSON response)
  cookieName: string;  // e.g. "session" or "videasy.sid"
  addedAt: number;
  contributor: string; // IP or "extension"
}

let sessionPool: PooledSession[] = [];
let poolLastCleanup = 0;

function cleanPool() {
  const now = Date.now();
  sessionPool = sessionPool.filter(s => (now - s.addedAt) < SESSION_MAX_AGE_MS);
  poolLastCleanup = now;
}

function addToPool(session: PooledSession) {
  if (sessionPool.length < 50) {
    sessionPool.push(session);
    console.log(`[Videasy] Session added to pool (total: ${sessionPool.length})`);
  }
}

function getFromPool(): PooledSession | null {
  if (Date.now() - poolLastCleanup > 300_000) cleanPool();
  if (sessionPool.length === 0) return null;
  // Round-robin: take the oldest session (most likely still valid)
  return sessionPool.shift() || null;
}

function removeFromPool(session: PooledSession) {
  sessionPool = sessionPool.filter(s => s !== session);
}

// ── API Helpers ──────────────────────────────────────────────────────────

function buildApiParams(params: VideasyExtractParams): URLSearchParams {
  return new URLSearchParams({
    title: params.title,
    mediaType: params.type === 'tv' ? 'TV Series' : 'Movie',
    year: params.year || '',
    totalSeasons: params.totalSeasons || '0',
    episodeId: params.episode || '0',
    seasonId: params.season || '0',
    tmdbId: params.tmdbId,
    imdbId: params.imdbId || '',
  });
}

/**
 * Fetch from Videasy API with an optional session cookie or cf_clearance.
 * Tries all endpoints in priority order.
 */
async function fetchVideasyApi(
  params: VideasyExtractParams,
  session: PooledSession | null,
  cfClearance?: string | null,
): Promise<{ hexData: string; endpoint: string }> {
  const apiParams = buildApiParams(params);
  const errors: string[] = [];

  for (const endpoint of API_ENDPOINTS) {
    try {
      const headers: Record<string, string> = { ...API_HEADERS };
      if (session) {
        headers['Cookie'] = `${session.cookieName}=${session.token}`;
      } else if (cfClearance) {
        headers['Cookie'] = `cf_clearance=${cfClearance}`;
      }

      const url = `${VIDEOASY_API}${endpoint}?${apiParams.toString()}`;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
      });

      if (!res.ok) {
        errors.push(`${endpoint}: HTTP ${res.status}`);
        continue;
      }

      const text = await res.text();

      if (text.startsWith('{')) {
        try {
          const err = JSON.parse(text);
          const msg = err.message || err.error || 'API error';
          errors.push(`${endpoint}: ${msg}`);

          // Session expired/invalid — signal caller to evict this session
          if (msg.includes('session')) {
            throw new SessionInvalidError(msg);
          }
        } catch (e) {
          if (e instanceof SessionInvalidError) throw e;
          errors.push(`${endpoint}: JSON error response`);
        }
        continue;
      }

      // Got hex — success!
      return { hexData: text, endpoint };
    } catch (err) {
      if (err instanceof SessionInvalidError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${endpoint}: ${msg}`);
    }
  }

  throw new Error(
    `All ${API_ENDPOINTS.length} Videasy endpoints failed: ${errors.join('; ')}`,
  );
}

/**
 * Try fetching hex from Videasy API with Turnstile cf_clearance.
 * Uses the pure-HTTP Turnstile solver to get a clearance cookie,
 * then calls the API with it. Falls back to null if solving fails.
 */
async function fetchWithTurnstile(
  params: VideasyExtractParams,
): Promise<{ hexData: string; endpoint: string } | null> {
  // Get cf_clearance from solver (cached if still valid)
  const cfClearance = await getCfClearance('videasy');
  if (!cfClearance) {
    console.log('[Videasy] No cf_clearance available from solver');
    return null;
  }

  try {
    const result = await fetchVideasyApi(params, null, cfClearance);
    console.log(`[Videasy] ✅ Turnstile-solved fetch OK (${result.endpoint}, ${result.hexData.length} hex bytes)`);
    return result;
  } catch (err) {
    if (err instanceof SessionInvalidError) {
      // cf_clearance was rejected — invalidate and retry once
      console.log('[Videasy] cf_clearance rejected, invalidating and retrying...');
      invalidateCfClearance('videasy');

      const freshClearance = await getCfClearance('videasy', true);
      if (freshClearance) {
        try {
          const result = await fetchVideasyApi(params, null, freshClearance);
          console.log(`[Videasy] ✅ Retry with fresh cf_clearance OK (${result.endpoint})`);
          return result;
        } catch (e2) {
          console.log('[Videasy] Retry with fresh cf_clearance also failed');
        }
      }
    }
    console.log(`[Videasy] Turnstile fetch failed: ${(err as Error).message}`);
    return null;
  }
}

class SessionInvalidError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SessionInvalidError';
  }
}

// ── Route Handler ────────────────────────────────────────────────────────

/**
 * Decrypt hex data and return proxied stream URLs.
 * The CDN URLs are IP-bound to the Worker (since the Worker fetched the hex),
 * so they must be proxied through the Worker's own /stream/ endpoint.
 */
async function decryptAndProxySources(
  hexData: string,
  tmdbId: string,
  workerOrigin: string,
): Promise<{ m3u8Url: string | null; proxiedSources: Array<{ quality: string; url: string; type: string }> }> {
  const result = { m3u8Url: null as string | null, proxiedSources: [] as Array<{ quality: string; url: string; type: string }> };
  try {
    const { decryptVideasyPayload, getWasm } = await import('./videasy-crypto');
    await getWasm({ wasmUrls: ['https://tv.vynx.cc/videasy.bin'] });
    const decrypted = await decryptVideasyPayload(hexData, parseFloat(tmdbId));
    const rawSources = Array.isArray(decrypted) ? decrypted : (decrypted?.sources || []);

    for (const s of rawSources.slice(0, 8)) {
      const rawUrl = s.url || s.stream || s.file;
      if (!rawUrl) continue;
      const proxiedUrl = `${workerOrigin}/stream/?url=${encodeURIComponent(rawUrl)}&source=videasy&referer=${encodeURIComponent('https://player.videasy.to/')}`;
      result.proxiedSources.push({
        quality: s.quality || s.label || 'auto',
        url: proxiedUrl,
        type: s.type || 'hls',
      });
    }
    result.m3u8Url = result.proxiedSources[0]?.url || null;
  } catch (err) {
    console.log('[Videasy] decryptAndProxySources failed:', err instanceof Error ? err.message : err);
  }
  return result;
}

export async function handleVideasyRequest(
  request: Request,
  _env: unknown,
  _ctx: ExecutionContext,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Serve patched WASM module
  if (path === '/videasy-module-patched.wasm' || path === '/videasy.bin') {
    try {
      const wasmResp = await fetch('https://tv.vynx.cc/videasy.bin', {
        signal: AbortSignal.timeout(10000),
      });
      if (!wasmResp.ok) throw new Error(`Upstream returned ${wasmResp.status}`);
      const wasmBytes = await wasmResp.arrayBuffer();
      return new Response(wasmBytes, {
        status: 200,
        headers: {
          'Content-Type': 'application/wasm',
          'Cache-Control': 'public, max-age=86400',
          ...CORS_HEADERS,
        },
      });
    } catch (err) {
      logger.error('Videasy WASM serve error', err as Error);
      return new Response(JSON.stringify({ error: 'WASM not available' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
  }

  // Health check + Turnstile stats
  if (path === '/videasy/health') {
    if (Date.now() - poolLastCleanup > 300_000) cleanPool();
    const solverStats = getSolverStats();
    return new Response(JSON.stringify({
      status: 'ok',
      endpoints: API_ENDPOINTS.length,
      poolSize: sessionPool.length,
      turnstile: {
        sessions: getSessionCacheSize(),
        hasCachedSession: hasCachedSession('videasy'),
        stats: solverStats,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  // Session pool contribution (from extension users)
  if (path === '/videasy/pool' && request.method === 'POST') {
    try {
      const body = await request.json() as {
        token: string;
        cookieName?: string;
      };
      if (!body.token) {
        return new Response(JSON.stringify({ error: 'Missing token' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
      addToPool({
        token: body.token,
        cookieName: body.cookieName || 'session',
        addedAt: Date.now(),
        contributor: request.headers.get('cf-connecting-ip') || 'unknown',
      });
      if (Date.now() - poolLastCleanup > 300_000) cleanPool();
      return new Response(JSON.stringify({ ok: true, poolSize: sessionPool.length }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
  }

  // Serve WASM module for decryption
  if (path === '/videasy-module-patched.wasm' || path === '/videasy.bin') {
    try {
      const wasmResp = await fetch('https://tv.vynx.cc/videasy.bin', {
        signal: AbortSignal.timeout(10000),
      });
      if (!wasmResp.ok) throw new Error(`Upstream returned ${wasmResp.status}`);
      const wasmBytes = await wasmResp.arrayBuffer();
      return new Response(wasmBytes, {
        status: 200,
        headers: {
          'Content-Type': 'application/wasm',
          'Cache-Control': 'public, max-age=86400',
          ...CORS_HEADERS,
        },
      });
    } catch (err) {
      logger.error('Videasy WASM serve error', err as Error);
      return new Response(JSON.stringify({ error: 'WASM not available' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
  }

  // Proxy fetch for Videasy API (adds CORS so browser doesn't need preflight)
  if (path === '/videasy/fetch' && request.method === 'POST') {
    try {
      const body = await request.json() as { url?: string; headers?: Record<string, string> };
      if (!body.url) {
        return new Response(JSON.stringify({ error: 'url required' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
      // Only use simple headers (no x-app-id) to avoid CORS preflight issues upstream
      const simpleHeaders: Record<string, string> = {};
      if (body.headers) {
        for (const k of ['User-Agent', 'Origin', 'Referer', 'Accept', 'Accept-Language']) {
          if (body.headers[k]) simpleHeaders[k] = body.headers[k];
        }
      }
      const resp = await fetch(body.url, { headers: simpleHeaders, signal: AbortSignal.timeout(15000) });
      const text = await resp.text();
      return new Response(text, {
        status: resp.status,
        headers: {
          'Content-Type': resp.headers.get('content-type') || 'text/plain',
          ...CORS_HEADERS,
        },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
  }

  // Decrypt hex data → return m3u8 URLs
  if (path === '/videasy/decrypt' && request.method === 'POST') {
    try {
      const body = await request.json() as { hexData?: string; tmdbId?: string };
      if (!body.hexData) {
        return new Response(JSON.stringify({ error: 'hexData required' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }

      const { decryptVideasyPayload, getWasm } = await import('./videasy-crypto');
      await getWasm({ wasmUrls: ['https://tv.vynx.cc/videasy.bin'] });

      const tmdbIdFloat = parseFloat(body.tmdbId || '533535');
      const decrypted = await decryptVideasyPayload(body.hexData, tmdbIdFloat);
      if (!decrypted) {
        return new Response(JSON.stringify({ error: 'Decryption failed' }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }

      const sources = Array.isArray(decrypted) ? decrypted : (decrypted.sources || decrypted.data || []);
      const m3u8Url = Array.isArray(sources) && sources.length > 0
        ? (sources[0]?.url || sources[0]?.stream || sources[0]?.file)
        : null;

      return new Response(JSON.stringify({
        success: true,
        m3u8Url,
        sources: Array.isArray(sources) ? sources.slice(0, 3).map((s: any) => ({
          quality: s.quality || s.label,
          url: s.url || s.stream,
          type: s.type || 'hls',
        })) : [],
      }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
  }

  // Extract m3u8 from Videasy — accepts hex data directly (POST) or returns API URL (GET)
  if (path === '/videasy/extract') {
    // POST with hexData → decrypt and return m3u8 directly
    if (request.method === 'POST') {
      try {
        const body = await request.json() as { hexData?: string; tmdbId?: string };
        if (!body.hexData) {
          return new Response(JSON.stringify({ error: 'hexData required for POST' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        }

        const { decryptVideasyPayload, getWasm } = await import('./videasy-crypto');
        await getWasm({ wasmUrls: ['https://tv.vynx.cc/videasy.bin'] });

        const tmdbIdFloat = parseFloat(body.tmdbId || '0');
        const decrypted = await decryptVideasyPayload(body.hexData, tmdbIdFloat);
        const sources = Array.isArray(decrypted) ? decrypted : (decrypted?.sources || decrypted?.data || []);
        const m3u8Url = sources[0]?.url || sources[0]?.stream || sources[0]?.file || null;

        return new Response(JSON.stringify({
          success: true, m3u8Url, sources: sources.slice(0, 5).map((s: any) => ({
            quality: s.quality || s.label, url: s.url || s.stream || s.file
          }))
        }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
    }

    // GET → return API URL for browser to fetch hex
    const tmdbId = url.searchParams.get('tmdbId');
    const title = url.searchParams.get('title');
    const type = url.searchParams.get('type') || 'movie';

    if (!tmdbId || !title) {
      return new Response(JSON.stringify({
        success: false, error: 'Missing required parameters: tmdbId, title',
      }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
    }

    const extractParams: VideasyExtractParams = {
      tmdbId, title, type,
      year: url.searchParams.get('year') || undefined,
      season: url.searchParams.get('season') || undefined,
      episode: url.searchParams.get('episode') || undefined,
      imdbId: url.searchParams.get('imdbId') || undefined,
      totalSeasons: url.searchParams.get('totalSeasons') || undefined,
    };

    if (Date.now() - poolLastCleanup > 300_000) cleanPool();

    // ── PRIMARY PATH: Session pool (extension-contributed cf_clearance) ──
    // Extension users solve Turnstile in real browsers → contribute tokens → pool.
    // CF Workers cannot reach challenges.cloudflare.com directly (403 from own infra).
    console.log('[Videasy] Trying session pool...');
    const maxAttempts = Math.min(sessionPool.length, 3);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const session = getFromPool();
      if (!session) break;

      try {
        const { hexData, endpoint } = await fetchVideasyApi(extractParams, session);
        // Session worked — put it back for reuse
        session.addedAt = Date.now();
        addToPool(session);
        logger.info('Videasy extract OK (pooled session)', { endpoint, hexLen: hexData.length, poolSize: sessionPool.length });
        // Decrypt and return proxied sources (CDN URLs are Worker-IP-bound)
        const { proxiedSources } = await decryptAndProxySources(hexData, tmdbId, new URL(request.url).origin);
        return new Response(JSON.stringify({
          success: true,
          hexData,
          provider: 'videasy',
          endpoint,
          sessionSource: 'pool',
          sources: proxiedSources.length > 0 ? proxiedSources : undefined,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      } catch (err) {
        if (err instanceof SessionInvalidError) {
          // Session expired — remove it from pool
          logger.info('Videasy session expired, removing from pool');
          removeFromPool(session);
          continue;
        }
        // Non-session error (network, etc.) — don't burn sessions
        addToPool(session);
        logger.error('Videasy extract error with session', err as Error);
        // Only try one session for non-auth errors
        break;
      }
    }

    // ── SECONDARY PATH: VPS Turnstile solver (cf_clearance from OVH VPS) ──
    // The VPS solves Cloudflare Turnstile challenges from a non-Cloudflare IP.
    // We get the cf_clearance cookie and use it to call api.videasy.to.
    console.log('[Videasy] Trying VPS Turnstile solver...');
    try {
      const turnstileResult = await fetchWithTurnstile(extractParams);
      if (turnstileResult) {
        logger.info('Videasy extract OK (turnstile)', { endpoint: turnstileResult.endpoint, hexLen: turnstileResult.hexData.length });
        const { proxiedSources } = await decryptAndProxySources(turnstileResult.hexData, tmdbId, new URL(request.url).origin);
        return new Response(JSON.stringify({
          success: true,
          hexData: turnstileResult.hexData,
          provider: 'videasy',
          endpoint: turnstileResult.endpoint,
          sessionSource: 'turnstile',
          sources: proxiedSources.length > 0 ? proxiedSources : undefined,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
    } catch (tsErr) {
      logger.error('Videasy turnstile error', tsErr as Error);
    }

    // ── FALLBACK 1: Direct fetch from Worker (no session, no Turnstile) ──
    // Some endpoints don't require auth at all. Try raw API access.
    const apiParams = buildApiParams(extractParams);
    // TV shows use /mb-flix, movies use /cdn
    const apiPath = type === 'tv' ? '/mb-flix/sources-with-title' : '/cdn/sources-with-title';
    const apiUrl = `${VIDEOASY_API}${apiPath}?${apiParams.toString()}`;

    // Try direct fetch from Worker
    try {
      const directResp = await fetch(apiUrl, {
        headers: API_HEADERS,
        signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
      });
      if (directResp.ok) {
        const text = await directResp.text();
        if (/^[0-9a-fA-F]+$/.test(text.trim())) {
          // Worker got hex directly — decrypt and return proxied m3u8 sources
          try {
            const workerOrigin = new URL(request.url).origin;
            const { proxiedSources } = await decryptAndProxySources(text, tmdbId, workerOrigin);
            return new Response(JSON.stringify({
              success: true, hexData: text,
              provider: 'videasy', source: 'worker-direct',
              sources: proxiedSources.length > 0 ? proxiedSources : undefined,
            }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
          } catch { /* decrypt failed, return hex */ }
        }
        return new Response(JSON.stringify({ success: true, hexData: text, provider: 'videasy', source: 'worker-direct' }), {
          status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
    } catch { /* Worker can't reach API — fall through */ }

    // ── FALLBACK 2: /downloader2 endpoint (simpler params, no auth) ──
    // Uses: tmdbId, type, title, season, episode (different from standard params)
    try {
      const dl2Params = new URLSearchParams({
        tmdbId: extractParams.tmdbId,
        type: extractParams.type,
        title: extractParams.title,
        season: extractParams.season || '0',
        episode: extractParams.episode || '0',
      });
      const dl2Url = `${VIDEOASY_API}${DOWNLOADER2_PATH}?${dl2Params.toString()}`;
      const dl2Resp = await fetch(dl2Url, {
        headers: API_HEADERS,
        signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
      });
      if (dl2Resp.ok) {
        const text = await dl2Resp.text();
        if (/^[0-9a-fA-F]+$/.test(text.trim())) {
          try {
            const workerOrigin = new URL(request.url).origin;
            const { proxiedSources } = await decryptAndProxySources(text, tmdbId, workerOrigin);
            return new Response(JSON.stringify({
              success: true, hexData: text,
              provider: 'videasy', source: 'downloader2',
              sources: proxiedSources.length > 0 ? proxiedSources : undefined,
            }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
          } catch { /* decrypt failed, return hex */ }
        }
        return new Response(JSON.stringify({ success: true, hexData: text, provider: 'videasy', source: 'downloader2' }), {
          status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
    } catch { /* downloader2 also unavailable */ }

    // Worker blocked — return URL for browser to fetch (simple headers only for CORS)
    return new Response(JSON.stringify({
      success: true, provider: 'videasy', source: 'browser-fetch',
      directUrl: apiUrl,
      apiHeaders: {
        'User-Agent': API_HEADERS['User-Agent'],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }

  return new Response(JSON.stringify({ error: 'Unknown Videasy endpoint' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
