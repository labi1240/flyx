/**
 * MovieBox Proxy — Movies/TV/Anime Streaming
 *
 * themoviebox.org / moviebox.ph — Nuxt 3 SSR, ArtPlayer + dash.js
 * Backend: h5-api.aoneroom.com (47.254.159.19 Alibaba Cloud EU)
 * API prefix: /wefeed-h5api-bff/
 * Response envelope: {code: 0, message: "ok", data: {...}}
 *
 * CRITICAL: /subject/play endpoint requires session/cookie context.
 * The worker maintains a session cookie jar for authenticated requests.
 *
 * Routes:
 *   GET /moviebox/home              - Home page content
 *   GET /moviebox/search?q=X        - Search movies/TV
 *   GET /moviebox/trending          - Trending content
 *   GET /moviebox/detail?id=X       - Movie/TV detail
 *   GET /moviebox/play?id=X&s=X&e=X - Stream sources (session-gated)
 *   GET /moviebox/stream?url=X      - Proxy video stream
 *   GET /moviebox/health            - Health check
 */

import { createLogger, type LogLevel } from './logger';
import {
  corsHeaders,
  jsonResponse,
  buildStreamResponse,
  buildStreamResponseFromFetch,
} from './shared';

export interface Env {
  LOG_LEVEL?: string;
  RPI_PROXY_URL?: string;
  RPI_PROXY_KEY?: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const MOVIEBOX_BASE = 'https://moviebox.ph';
const API_BASE = 'https://h5-api.aoneroom.com';
const API_PREFIX = '/wefeed-h5api-bff';
const SITE_REFERER = 'https://moviebox.ph/';

// Session state for /subject/play endpoint
let sessionCookies: string | null = null;
let sessionExpiry = 0;

/**
 * Fetch and maintain a session from MovieBox homepage
 */
async function ensureSession(logger: ReturnType<typeof createLogger>): Promise<string> {
  if (sessionCookies && Date.now() < sessionExpiry) {
    return sessionCookies;
  }

  logger.info('Establishing MovieBox session...');

  const res = await fetch(MOVIEBOX_BASE, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
  });

  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    sessionCookies = setCookie;
    sessionExpiry = Date.now() + 30 * 60 * 1000; // 30 min
    logger.info('MovieBox session established');
  }

  return sessionCookies || '';
}

/**
 * Call the MovieBox API with proper response envelope handling
 */
async function movieboxApi(
  path: string,
  params: Record<string, string>,
  logger: ReturnType<typeof createLogger>,
  method: string = 'GET',
): Promise<any> {
  const url = new URL(`${API_BASE}${API_PREFIX}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  logger.info(`MovieBox API: ${path}`, { params });

  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Accept': 'application/json',
    'Origin': MOVIEBOX_BASE,
    'Referer': MOVIEBOX_BASE + '/',
    'x-platform': 'web',
    'x-language': 'en',
  };

  // Add session cookies for gated endpoints
  if (path.includes('/subject/play')) {
    const cookies = await ensureSession(logger);
    if (cookies) headers['Cookie'] = cookies;
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
  });

  if (!res.ok) {
    throw new Error(`MovieBox API ${path} returned ${res.status}`);
  }

  const json: Record<string, any> = await res.json();

  // MovieBox envelope: {code: 0, message: "ok", data: {...}}
  if (json.code !== undefined && json.code !== 0) {
    throw new Error(`MovieBox API error: ${json.message || 'Unknown error'} (code: ${json.code})`);
  }

  return json.data || json;
}

// ============================================================================
// ROUTE HANDLER
// ============================================================================

export async function handleMovieBoxRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/moviebox\/?/, '');
  const logLevel = (env.LOG_LEVEL || 'info') as LogLevel;
  const logger = createLogger(request, logLevel);

  logger.info('MovieBox proxy request', { path, search: url.search });

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  try {
    switch (true) {
      case path === 'health' || path === '':
        return jsonResponse({ status: 'ok', provider: 'moviebox', baseUrl: MOVIEBOX_BASE });
      case path === 'home':
        return await handleHome(url.searchParams, logger);
      case path === 'search':
        return await handleSearch(url.searchParams, logger);
      case path === 'trending':
        return await handleTrending(url.searchParams, logger);
      case path === 'detail':
        return await handleDetail(url.searchParams, logger);
      case path === 'play':
        return await handlePlay(url.searchParams, logger);
      case path === 'stream':
        return await handleStreamProxy(url.searchParams, logger, request.url);
      default:
        return jsonResponse({ error: 'Unknown MovieBox route', path }, 404);
    }
  } catch (error) {
    const err = error as Error;
    logger.error('MovieBox proxy error', err);
    return jsonResponse({ error: 'MovieBox proxy error', details: err.message }, 502);
  }
}

async function handleHome(params: URLSearchParams, logger: ReturnType<typeof createLogger>): Promise<Response> {
  const data = await movieboxApi('/home', {
    page: params.get('page') || '1',
    pageSize: params.get('pageSize') || '20',
  }, logger);
  return jsonResponse(data);
}

async function handleSearch(params: URLSearchParams, logger: ReturnType<typeof createLogger>): Promise<Response> {
  const q = params.get('q');
  if (!q) return jsonResponse({ error: 'Missing query' }, 400);

  const data = await movieboxApi('/subject/search', {
    keyword: q,
    page: params.get('page') || '1',
    pageSize: params.get('pageSize') || '20',
  }, logger);
  return jsonResponse(data);
}

async function handleTrending(params: URLSearchParams, logger: ReturnType<typeof createLogger>): Promise<Response> {
  const data = await movieboxApi('/subject/trending', {
    page: params.get('page') || '1',
    pageSize: params.get('pageSize') || '20',
  }, logger);
  return jsonResponse(data);
}

async function handleDetail(params: URLSearchParams, logger: ReturnType<typeof createLogger>): Promise<Response> {
  const id = params.get('id');
  if (!id) return jsonResponse({ error: 'Missing id' }, 400);

  const data = await movieboxApi('/subject/detail-rec', { subjectId: id }, logger);
  return jsonResponse(data);
}

/**
 * Resolve stream sources for a movie/episode.
 * This is the session-gated endpoint that requires cookie context.
 */
async function handlePlay(params: URLSearchParams, logger: ReturnType<typeof createLogger>): Promise<Response> {
  const id = params.get('id');
  if (!id) return jsonResponse({ error: 'Missing id' }, 400);

  const playParams: Record<string, string> = { subjectId: id };
  const season = params.get('s');
  const episode = params.get('e');

  if (season) playParams['season'] = season;
  if (episode) playParams['episode'] = episode;

  const data = await movieboxApi('/subject/play', playParams, logger);

  // Extract stream URLs from the response
  // The response may contain: {sources: [{url, quality, type}]}
  return jsonResponse(data);
}

/**
 * Proxy video stream with proper referer headers.
 * MovieBox streams come from macdn.aoneroom.com / fecdn.trasre.com
 */
async function handleStreamProxy(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
  requestUrl: string,
): Promise<Response> {
  const encodedUrl = params.get('url');
  if (!encodedUrl) return jsonResponse({ error: 'Missing url' }, 400);

  const streamUrl = decodeURIComponent(encodedUrl);
  logger.info('Proxying MovieBox stream', { url: streamUrl.substring(0, 120) });

  const res = await fetch(streamUrl, {
    headers: {
      'User-Agent': UA,
      'Referer': SITE_REFERER,
      'Origin': MOVIEBOX_BASE,
      'Accept': '*/*',
    },
  });

  if (!res.ok) {
    return jsonResponse({ error: `Stream fetch failed: ${res.status}` }, 502);
  }

  const proxyOrigin = new URL(requestUrl).origin;
  const contentType = res.headers.get('content-type') || '';

  // For HLS playlists, rewrite URLs through our proxy
  if (contentType.includes('mpegurl') || streamUrl.includes('.m3u8')) {
    return await buildStreamResponseFromFetch(res, streamUrl, proxyOrigin, '/moviebox/stream', 'moviebox');
  }

  // Binary segment — return directly
  const body = await res.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType || 'video/mp2t',
      'Content-Length': body.byteLength.toString(),
      'Cache-Control': 'public, max-age=3600',
      ...corsHeaders(),
    },
  });
}
