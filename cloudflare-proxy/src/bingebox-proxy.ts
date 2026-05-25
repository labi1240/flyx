/**
 * BingeBox Proxy — Movies/TV/Anime Streaming
 *
 * bingebox.to — Next.js 14 App Router with 15 direct HLS sources
 * and 8 embed sources. The /api/stream endpoint returns stream URLs
 * from api.dlproxy.com. Only requires Origin header.
 *
 * Zero auth for most sources (FebBox source needs token).
 *
 * Routes:
 *   GET /bingebox/health              - Health check
 *   GET /bingebox/extract?tmdbId=X&type=movie|tv&source=neon&title=X&year=X&s=X&e=X
 *   GET /bingebox/stream?url=X        - Proxy HLS stream
 */

import { createLogger, type LogLevel } from './logger';
import {
  corsHeaders,
  jsonResponse,
  buildStreamResponseFromFetch,
} from './shared';

export interface Env {
  LOG_LEVEL?: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const BINGEBOX_BASE = 'https://bingebox.to';
const ORIGIN = BINGEBOX_BASE;

const DIRECT_SOURCES = [
  'neon', 'yoru', 'killjoy', 'harbor', 'chamber', 'omen',
  'gekko', 'raze', 'breach', 'sage', 'aldebaran', 'oneroom',
  'phoenix', 'fade', 'febbox',
];

export async function handleBingeBoxRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/bingebox\/?/, '');
  const logLevel = (env.LOG_LEVEL || 'info') as LogLevel;
  const logger = createLogger(request, logLevel);

  logger.info('BingeBox proxy request', { path, search: url.search });

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  try {
    switch (true) {
      case path === 'health' || path === '':
        return jsonResponse({ status: 'ok', provider: 'bingebox', baseUrl: BINGEBOX_BASE });
      case path === 'extract':
        return await handleExtract(url.searchParams, logger);
      case path === 'stream':
        return await handleStream(url.searchParams, logger, request.url);
      default:
        return jsonResponse({ error: 'Unknown BingeBox route', path }, 404);
    }
  } catch (error) {
    const err = error as Error;
    logger.error('BingeBox proxy error', err);
    return jsonResponse({ error: 'BingeBox proxy error', details: err.message }, 502);
  }
}

async function handleExtract(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const tmdbId = params.get('tmdbId');
  const type = params.get('type') || 'movie';
  const title = params.get('title') || '';
  const year = params.get('year') || '';
  const source = params.get('source') || 'neon';
  const season = params.get('s');
  const episode = params.get('e');
  const febboxToken = params.get('febboxToken');

  if (!tmdbId || !title) {
    return jsonResponse({ error: 'Missing required params: tmdbId, title' }, 400);
  }

  const apiParams = new URLSearchParams({
    tmdbId,
    mediaType: type === 'tv' ? 'show' : 'movie',
    title,
    year: year || '2024',
    source,
  });

  if (type === 'tv' && season) {
    apiParams.set('season', season);
    apiParams.set('episode', episode || '1');
  }

  if (febboxToken && source === 'febbox') {
    apiParams.set('febboxToken', febboxToken);
  }

  const apiUrl = `${BINGEBOX_BASE}/api/stream?${apiParams.toString()}`;
  logger.info('Fetching BingeBox stream', { source, tmdbId, type });

  const res = await fetch(apiUrl, {
    headers: {
      'User-Agent': UA,
      'Referer': `${BINGEBOX_BASE}/`,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    return jsonResponse({ error: `BingeBox API returned ${res.status}`, details: text.substring(0, 500) }, 502);
  }

  const data: Record<string, any> = await res.json();

  // Normalize response
  if (data.success && data.data) {
    return jsonResponse({
      success: true,
      type: data.data.type,
      url: data.data.url || data.data.playlist,
      playlist: data.data.playlist,
      qualities: data.data.qualities,
      captions: data.data.captions || [],
      audioTracks: data.data.audioTracks || [],
      source,
    });
  }

  return jsonResponse({ success: false, error: data.error || 'No streams found', source });
}

async function handleStream(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
  requestUrl: string,
): Promise<Response> {
  const encodedUrl = params.get('url');
  if (!encodedUrl) return jsonResponse({ error: 'Missing url' }, 400);

  const streamUrl = decodeURIComponent(encodedUrl);
  logger.info('Proxying BingeBox stream', { url: streamUrl.substring(0, 120) });

  const res = await fetch(streamUrl, {
    headers: {
      'User-Agent': UA,
      'Referer': `${BINGEBOX_BASE}/`,
      'Accept': '*/*',
    },
  });

  if (!res.ok) {
    return jsonResponse({ error: `Stream fetch failed: ${res.status}` }, 502);
  }

  const proxyOrigin = new URL(requestUrl).origin;
  return await buildStreamResponseFromFetch(res, streamUrl, proxyOrigin, '/bingebox/stream', 'bingebox');
}
