/**
 * Videasy Source Proxy
 *
 * CORS proxy for api.videasy.net. Fetches the raw hex-encrypted API response
 * and returns it to the caller. All WASM decryption and AES decryption happen
 * client-side (Web Crypto API + public WASM).
 *
 * Multi-endpoint fallback: tries 5 known API endpoints in priority order.
 * Different endpoints may have different source availability for the same
 * content, so falling back increases the chance of finding working sources.
 *
 * Routes:
 *   GET /videasy/extract?tmdbId=X&type=movie|tv&title=Y&...
 *   GET /videasy/health
 */

import { createLogger } from './logger';
import { CORS_HEADERS } from './cors';

const VIDEOASY_API = 'https://api.videasy.net';

const API_HEADERS: Record<string, string> = {
  'Origin': 'https://player.videasy.net',
  'Referer': 'https://player.videasy.net/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

/**
 * All known Videasy API endpoints, ordered by reliability.
 * The proxy tries each in sequence until one returns hex data.
 *
 * Recon May 29, 2026: Only 'cdn' and 'mb-flix' return hex.
 * All other endpoints (1movies, moviebox, m4uhd, myflixerzupcloud, etc.)
 * return JSON errors or 404-like route-not-found responses.
 *   - cdn:    works for movies + TV (primary)
 *   - mb-flix: works for TV only (fallback)
 */
const API_ENDPOINTS = [
  '/cdn/sources-with-title',
  '/mb-flix/sources-with-title',
];

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
 * Try all known endpoints in priority order.
 * Returns the hex response from the first successful endpoint.
 * Throws if all endpoints fail.
 */
async function fetchVideasyApi(params: VideasyExtractParams): Promise<{ hexData: string; endpoint: string }> {
  const apiParams = buildApiParams(params);
  const errors: string[] = [];

  for (const endpoint of API_ENDPOINTS) {
    try {
      const url = `${VIDEOASY_API}${endpoint}?${apiParams.toString()}`;
      const res = await fetch(url, {
        headers: API_HEADERS,
        signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
      });

      if (!res.ok) {
        errors.push(`${endpoint}: HTTP ${res.status}`);
        continue;
      }

      const text = await res.text();

      // JSON response = API error for this endpoint, try next
      if (text.startsWith('{')) {
        try {
          const err = JSON.parse(text);
          errors.push(`${endpoint}: ${err.message || err.error || 'API error'}`);
        } catch {
          errors.push(`${endpoint}: JSON error response`);
        }
        continue;
      }

      // Got hex data — success!
      return { hexData: text, endpoint };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${endpoint}: ${msg}`);
      // Continue to next endpoint
    }
  }

  // All endpoints failed
  throw new Error(
    `All ${API_ENDPOINTS.length} Videasy endpoints failed: ${errors.join('; ')}`,
  );
}

// ============================================================================
// Route Handler
// ============================================================================
export async function handleVideasyRequest(
  request: Request,
  _env: unknown,
  _ctx: ExecutionContext,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Serve patched WASM module — needed by CF Pages Functions which can't
  // fetch from their own zone (tv.vynx.cc). The media-proxy worker is on a
  // different zone (workers.dev), so this cross-zone fetch works.
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

  // Health check
  if (path === '/videasy/health') {
    return new Response(JSON.stringify({ status: 'ok', endpoints: API_ENDPOINTS.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  // Extract endpoint — proxies raw hex from Videasy API to client
  if (path === '/videasy/extract') {
    const tmdbId = url.searchParams.get('tmdbId');
    const title = url.searchParams.get('title');
    const type = url.searchParams.get('type') || 'movie';

    if (!tmdbId || !title) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required parameters: tmdbId, title',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    try {
      const { hexData, endpoint } = await fetchVideasyApi({
        tmdbId,
        title,
        type,
        year: url.searchParams.get('year') || undefined,
        season: url.searchParams.get('season') || undefined,
        episode: url.searchParams.get('episode') || undefined,
        imdbId: url.searchParams.get('imdbId') || undefined,
        totalSeasons: url.searchParams.get('totalSeasons') || undefined,
      });

      logger.info('Videasy extract OK', { endpoint, hexLen: hexData.length });

      return new Response(JSON.stringify({
        success: true,
        hexData,
        provider: 'videasy',
        endpoint,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('Videasy extract error', error as Error);
      return new Response(JSON.stringify({
        success: false,
        error: errMsg,
        retryable: true,
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
  }

  return new Response(JSON.stringify({ error: 'Unknown Videasy endpoint' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
