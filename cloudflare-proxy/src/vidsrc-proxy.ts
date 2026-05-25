/**
 * VidSrc Proxy Handler
 * Proxies requests to v1.2embed.stream API for VidSrc extraction.
 */

import { createLogger, type LogLevel } from './logger';

export interface Env {
  LOG_LEVEL?: string;
}

const EMBED_API_BASE = 'https://v1.2embed.stream';

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data: object, status: number): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function fetchWithHeaders(url: string, referer?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/html, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (referer) headers['Referer'] = referer;
  return fetch(url, { headers });
}

async function extractFromApi(
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: string,
  episode?: string
): Promise<{ success: boolean; m3u8_url?: string; source?: string; error?: string }> {
  const apiPath = type === 'tv' && season && episode
    ? `/api/m3u8/tv/${tmdbId}/${season}/${episode}`
    : `/api/m3u8/movie/${tmdbId}`;
  
  const apiUrl = `${EMBED_API_BASE}${apiPath}`;
  console.log('[VidSrc] Fetching API:', apiUrl);
  
  const response = await fetchWithHeaders(apiUrl, EMBED_API_BASE + '/');
  
  if (!response.ok) {
    return { success: false, error: `API returned ${response.status}: ${response.statusText}` };
  }
  
  const data = await response.json() as {
    success?: boolean;
    fallback?: boolean;
    m3u8_url?: string;
    source?: string;
    error?: string;
    message?: string;
  };
  
  // The API returns success:true with fallback:true when it doesn't have the content
  // In that case m3u8_url is missing and it provides an iframe_url instead
  if (!data.success || !data.m3u8_url || data.fallback) {
    return { success: false, error: data.message || data.error || 'No m3u8_url in response' };
  }
  
  return { success: true, m3u8_url: data.m3u8_url, source: data.source };
}

/**
 * Rewrite m3u8 playlist URLs to route through /vidsrc/stream
 */
function rewriteVidSrcPlaylist(manifest: string, originalUrl: string): string {
  // Rewrite absolute URLs from 2embed.stream and cloudnestra CDN domains
  manifest = manifest.replace(
    /https:\/\/(?:v1\.2embed\.stream|[^\/\s]*cloudnestra\.[a-z]+|[^\/\s]*shadowlandschronicles\.[a-z]+|[^\/\s]*embedsito\.com)\/[^\s\n]+/g,
    (match) => `/vidsrc/stream?url=${encodeURIComponent(match)}`
  );
  
  // Rewrite #EXT-X-KEY URI values (encryption keys need proxying too)
  manifest = manifest.replace(
    /URI="(https?:\/\/[^"]+)"/g,
    (_match, keyUrl) => `URI="/vidsrc/stream?url=${encodeURIComponent(keyUrl)}"`
  );
  
  // Rewrite relative URLs (lines that don't start with # and aren't already proxied)
  const baseUrl = originalUrl.substring(0, originalUrl.lastIndexOf('/') + 1);
  const lines = manifest.split('\n');
  manifest = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('/vidsrc/')) return line;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      if (trimmed.includes('.ts') || trimmed.includes('.m3u8') || trimmed.includes('/key') || trimmed.includes('.key')) {
        return `/vidsrc/stream?url=${encodeURIComponent(trimmed)}`;
      }
      return line;
    }
    const absoluteUrl = new URL(trimmed, baseUrl).toString();
    return `/vidsrc/stream?url=${encodeURIComponent(absoluteUrl)}`;
  }).join('\n');
  
  return manifest;
}

/**
 * Handle a successful VidSrc CDN response — rewrite m3u8 playlists, pass through segments.
 */
function handleVidSrcStreamResponse(
  body: ArrayBuffer,
  contentType: string,
  originalUrl: string,
  via: string,
): Response {
  if (contentType.includes('mpegurl') || originalUrl.includes('.m3u8')) {
    let manifest = new TextDecoder().decode(body);
    manifest = rewriteVidSrcPlaylist(manifest, originalUrl);
    return new Response(manifest, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'X-Proxied-Via': via,
        ...corsHeaders(),
      },
    });
  }

  // Segment — detect content type from bytes
  const firstBytes = new Uint8Array(body.slice(0, 4));
  const isMpegTs = firstBytes[0] === 0x47;
  const isFmp4 = firstBytes[0] === 0x00 && firstBytes[1] === 0x00 && firstBytes[2] === 0x00;
  let actualContentType = contentType;
  if (isMpegTs) actualContentType = 'video/mp2t';
  else if (isFmp4) actualContentType = 'video/mp4';
  else if (!actualContentType) actualContentType = 'application/octet-stream';

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': actualContentType,
      'Content-Length': body.byteLength.toString(),
      'Cache-Control': 'public, max-age=3600',
      'X-Proxied-Via': via,
      ...corsHeaders(),
    },
  });
}

async function proxyStream(url: string): Promise<Response> {
  console.log('[VidSrc] Proxying stream:', url.substring(0, 80) + '...');

  // Determine correct referer based on the stream domain
  let referer = EMBED_API_BASE + '/';
  try {
    const streamHost = new URL(url).hostname;
    if (streamHost.includes('cloudnestra') || streamHost.includes('shadowlandschronicles') || streamHost.includes('embedsito')) {
      referer = `https://${streamHost}/`;
    }
  } catch {}

  const cdnHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/html, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': referer,
  };

  // CF direct fetch (intra-Cloudflare network)
  try {
    const response = await fetch(url, {
      headers: cdnHeaders,
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const body = await response.arrayBuffer();
      return handleVidSrcStreamResponse(body, contentType, url, 'cf-direct');
    }
    console.log(`[VidSrc] CF direct failed: ${response.status}`);
  } catch (e) {
    console.log(`[VidSrc] CF direct error: ${e instanceof Error ? e.message : String(e)}`);
  }

  return new Response(JSON.stringify({ error: 'All proxy strategies failed for VidSrc CDN' }), {
    status: 502,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

export async function handleVidSrcRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const logLevel = (env.LOG_LEVEL || 'info') as LogLevel;
  const logger = createLogger(request, logLevel);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (path === '/vidsrc/health' || path.endsWith('/health')) {
    let apiReachable = false;
    let apiError = '';
    try {
      const testResp = await fetchWithHeaders(
        `${EMBED_API_BASE}/api/m3u8/movie/550`, 
        EMBED_API_BASE + '/'
      );
      apiReachable = testResp.ok;
      if (!testResp.ok) apiError = `${testResp.status} ${testResp.statusText}`;
    } catch (e) {
      apiError = e instanceof Error ? e.message : String(e);
    }
    return jsonResponse({ 
      status: apiReachable ? 'ok' : 'degraded', 
      apiBase: EMBED_API_BASE, 
      apiReachable, 
      apiError: apiError || undefined, 
      timestamp: new Date().toISOString() 
    }, 200);
  }

  if (path === '/vidsrc/extract' || path === '/vidsrc') {
    const tmdbId = url.searchParams.get('tmdbId');
    const type = (url.searchParams.get('type') || 'movie') as 'movie' | 'tv';
    const season = url.searchParams.get('season') || undefined;
    const episode = url.searchParams.get('episode') || undefined;

    if (!tmdbId) {
      return jsonResponse({ error: 'Missing tmdbId parameter' }, 400);
    }
    if (type === 'tv' && (!season || !episode)) {
      return jsonResponse({ error: 'Season and episode required for TV shows' }, 400);
    }

    logger.info('VidSrc extract request', { tmdbId, type, season, episode });

    try {
      const startTime = Date.now();
      const result = await extractFromApi(tmdbId, type, season, episode);
      const duration = Date.now() - startTime;

      if (result.success && result.m3u8_url) {
        const proxiedUrl = `/vidsrc/stream?url=${encodeURIComponent(result.m3u8_url)}`;
        return jsonResponse({
          success: true,
          m3u8_url: result.m3u8_url,
          proxied_url: proxiedUrl,
          source: result.source,
          duration_ms: duration,
          timestamp: new Date().toISOString()
        }, 200);
      }

      return jsonResponse({
        success: false,
        error: result.error || 'No m3u8 URL from VidSrc API',
        duration_ms: duration,
        timestamp: new Date().toISOString()
      }, 404);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('VidSrc extraction error', error as Error);
      return jsonResponse({
        success: false,
        error: errorMsg,
        timestamp: new Date().toISOString()
      }, 500);
    }
  }

  if (path === '/vidsrc/stream') {
    const streamUrl = url.searchParams.get('url');
    if (!streamUrl) {
      return jsonResponse({ error: 'Missing url parameter' }, 400);
    }
    logger.info('VidSrc stream proxy', { url: streamUrl.substring(0, 60) + '...' });
    try {
      return await proxyStream(streamUrl);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('VidSrc stream proxy error', error as Error);
      return jsonResponse({ error: errorMsg, timestamp: new Date().toISOString() }, 500);
    }
  }

  return jsonResponse({ 
    error: 'Unknown VidSrc route', 
    availableRoutes: ['/vidsrc/extract', '/vidsrc/stream', '/vidsrc/health'] 
  }, 404);
}
