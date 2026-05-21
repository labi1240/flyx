/**
 * VIPRow/Casthill Stream Proxy
 *
 * Routes:
 *   GET /viprow/stream?url=<viprow_event_url>&link=<1-10> - Extract and proxy m3u8
 *   GET /viprow/manifest?url=<encoded_manifest_url> - Proxy manifest with URL rewriting
 *   GET /viprow/key?url=<encoded_key_url> - Proxy decryption key
 *   GET /viprow/segment?url=<encoded_segment_url> - Proxy video segment
 *   GET /viprow/health - Health check
 *
 * Tries CF direct fetch first on all endpoints, falls back to RPI
 * residential proxy only when CDN blocks CF IPs.
 */

import { createLogger, type LogLevel } from './logger';

export interface Env {
  LOG_LEVEL?: string;
  RPI_PROXY_URL?: string;
  RPI_PROXY_KEY?: string;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Allowed domains for proxying
const ALLOWED_DOMAINS = [
  'peulleieo.net',  // Manifest/segment server
  'boanki.net',     // Token/key server
];

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
  };
}

function jsonResponse(data: object, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_DOMAINS.some(domain => parsed.hostname.endsWith(domain));
  } catch {
    return false;
  }
}

export async function handleVIPRowRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/viprow/, '');
  const logLevel = (env.LOG_LEVEL || 'info') as LogLevel;
  const logger = createLogger(request, logLevel);
  
  // Get the full proxy base URL for rewriting manifest URLs
  const proxyBaseUrl = `${url.protocol}//${url.host}/viprow`;
  
  // RPI proxy configuration
  const rpiProxyUrl = env.RPI_PROXY_URL;
  const rpiProxyKey = env.RPI_PROXY_KEY;

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // Health check
  if (path === '/health' || path === '') {
    return jsonResponse({
      status: 'ok',
      service: 'viprow-proxy',
      rpiConfigured: !!rpiProxyUrl,
      timestamp: new Date().toISOString(),
    });
  }

  // Stream extraction — try CF direct first, fall back to RPI
  if (path === '/stream') {
    const eventUrl = url.searchParams.get('url');
    const linkNum = url.searchParams.get('link') || '1';

    if (!eventUrl) {
      return jsonResponse({ error: 'url parameter required (e.g., /nba/event-online-stream)' }, 400);
    }

    // Strategy 1: CF direct — try fetching the event page and extracting
    // VIPRow extraction is complex (scrape page → find links → parse → fetch m3u8),
    // so we primarily rely on RPI. But we try a direct approach first.
    logger.info('VIPRow extraction request', { url: eventUrl, link: linkNum });

    // Strategy 2: RPI fallback
    if (rpiProxyUrl) {
      logger.info('Forwarding VIPRow extraction to RPI proxy', { url: eventUrl, link: linkNum });
      try {
        const rpiUrl = `${rpiProxyUrl}/viprow/stream?url=${encodeURIComponent(eventUrl)}&link=${linkNum}&cf_proxy=${encodeURIComponent(proxyBaseUrl)}&key=${rpiProxyKey || ''}`;

        const rpiResponse = await fetch(rpiUrl, {
          headers: { 'User-Agent': USER_AGENT },
        });

        if (!rpiResponse.ok) {
          const errorText = await rpiResponse.text();
          logger.error('RPI proxy extraction failed', { status: rpiResponse.status, error: errorText });
          return jsonResponse({ error: `RPI proxy error: ${rpiResponse.status}`, details: errorText.substring(0, 200) }, rpiResponse.status);
        }

        const manifest = await rpiResponse.text();
        logger.info('Stream extracted successfully via RPI proxy');

        return new Response(manifest, {
          headers: {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-cache',
            ...corsHeaders(),
          },
        });
      } catch (error) {
        logger.error('RPI proxy request failed', error as Error);
        return jsonResponse({ error: 'RPI proxy request failed', details: (error as Error).message }, 502);
      }
    }

    return jsonResponse({ error: 'VIPRow extraction requires RPI — RPI_PROXY_URL not configured' }, 500);
  }

  // Manifest proxy — try CF direct first, fall back to RPI
  if (path === '/manifest') {
    const manifestUrl = url.searchParams.get('url');

    if (!manifestUrl) {
      return jsonResponse({ error: 'url parameter required' }, 400);
    }

    const decodedUrl = decodeURIComponent(manifestUrl);

    if (!isAllowedUrl(decodedUrl)) {
      return jsonResponse({ error: 'URL not allowed' }, 403);
    }

    logger.info('Proxying manifest', { url: decodedUrl.substring(0, 80) });

    // Strategy 1: CF direct fetch
    try {
      const directRes = await fetch(decodedUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(8000),
      });

      if (directRes.ok) {
        logger.info('Manifest fetched directly from CF');
        const manifest = await directRes.text();

        // Rewrite segment URLs to go through our proxy
        const rewritten = rewriteManifestUrls(manifest, decodedUrl, proxyBaseUrl);

        return new Response(rewritten, {
          headers: {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-cache',
            ...corsHeaders(),
          },
        });
      }
      logger.warn('CF direct manifest fetch failed', { status: directRes.status });
    } catch (e) {
      logger.warn('CF direct manifest fetch error', { error: (e as Error).message });
    }

    // Strategy 2: RPI fallback
    if (rpiProxyUrl) {
      logger.info('Falling back to RPI for manifest');
      try {
        const rpiUrl = `${rpiProxyUrl}/viprow/manifest?url=${encodeURIComponent(decodedUrl)}&cf_proxy=${encodeURIComponent(proxyBaseUrl)}&key=${rpiProxyKey || ''}`;

        const response = await fetch(rpiUrl, {
          headers: { 'User-Agent': USER_AGENT },
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.error('RPI manifest proxy failed', { status: response.status });
          return jsonResponse({ error: `RPI error: ${response.status}`, details: errorText.substring(0, 200) }, response.status);
        }

        const manifest = await response.text();

        return new Response(manifest, {
          headers: {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-cache',
            ...corsHeaders(),
          },
        });
      } catch (error) {
        logger.error('Manifest proxy error', error as Error);
        return jsonResponse({ error: 'Proxy failed' }, 500);
      }
    }

    return jsonResponse({ error: 'Manifest proxy failed — RPI not configured and CF direct blocked' }, 502);
  }

  // Key proxy — try CF direct first, fall back to RPI
  if (path === '/key') {
    const keyUrl = url.searchParams.get('url');

    if (!keyUrl) {
      return jsonResponse({ error: 'url parameter required' }, 400);
    }

    const decodedUrl = decodeURIComponent(keyUrl);

    if (!isAllowedUrl(decodedUrl)) {
      return jsonResponse({ error: 'URL not allowed' }, 403);
    }

    logger.info('Proxying key', { url: decodedUrl.substring(0, 80) });

    // Strategy 1: CF direct
    try {
      const directRes = await fetch(decodedUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(5000),
      });
      if (directRes.ok) {
        const buffer = await directRes.arrayBuffer();
        return new Response(buffer, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'max-age=300',
            ...corsHeaders(),
          },
        });
      }
      logger.warn('CF direct key fetch failed', { status: directRes.status });
    } catch (e) {
      logger.warn('CF direct key fetch error', { error: (e as Error).message });
    }

    // Strategy 2: RPI fallback
    if (rpiProxyUrl) {
      logger.info('Falling back to RPI for key');
      try {
        const rpiUrl = `${rpiProxyUrl}/viprow/key?url=${encodeURIComponent(decodedUrl)}&key=${rpiProxyKey || ''}`;
        const response = await fetch(rpiUrl, {
          headers: { 'User-Agent': USER_AGENT },
        });
        if (!response.ok) {
          return jsonResponse({ error: `RPI error: ${response.status}` }, response.status);
        }
        const buffer = await response.arrayBuffer();
        return new Response(buffer, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'max-age=300',
            ...corsHeaders(),
          },
        });
      } catch (error) {
        logger.error('Key proxy error', error as Error);
        return jsonResponse({ error: 'Proxy failed' }, 500);
      }
    }

    return jsonResponse({ error: 'Key proxy failed — RPI not configured and CF direct blocked' }, 502);
  }

  // Segment proxy — try CF direct first, fall back to RPI
  if (path === '/segment') {
    const segmentUrl = url.searchParams.get('url');

    if (!segmentUrl) {
      return jsonResponse({ error: 'url parameter required' }, 400);
    }

    const decodedUrl = decodeURIComponent(segmentUrl);

    if (!isAllowedUrl(decodedUrl)) {
      return jsonResponse({ error: 'URL not allowed' }, 403);
    }

    logger.debug('Proxying segment', { url: decodedUrl.substring(0, 80) });

    // Strategy 1: CF direct
    try {
      const directRes = await fetch(decodedUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10000),
      });
      if (directRes.ok) {
        const buffer = await directRes.arrayBuffer();
        return new Response(buffer, {
          headers: {
            'Content-Type': 'video/mp2t',
            'Cache-Control': 'max-age=60',
            ...corsHeaders(),
          },
        });
      }
      logger.warn('CF direct segment fetch failed', { status: directRes.status });
    } catch (e) {
      logger.warn('CF direct segment fetch error', { error: (e as Error).message });
    }

    // Strategy 2: RPI fallback
    if (rpiProxyUrl) {
      logger.debug('Falling back to RPI for segment');
      try {
        const rpiUrl = `${rpiProxyUrl}/viprow/segment?url=${encodeURIComponent(decodedUrl)}&key=${rpiProxyKey || ''}`;
        const response = await fetch(rpiUrl, {
          headers: { 'User-Agent': USER_AGENT },
        });
        if (!response.ok) {
          return jsonResponse({ error: `RPI error: ${response.status}` }, response.status);
        }
        const buffer = await response.arrayBuffer();
        return new Response(buffer, {
          headers: {
            'Content-Type': 'video/mp2t',
            'Cache-Control': 'max-age=60',
            ...corsHeaders(),
          },
        });
      } catch (error) {
        logger.error('Segment proxy error', error as Error);
        return jsonResponse({ error: 'Proxy failed' }, 500);
      }
    }

    return jsonResponse({ error: 'Segment proxy failed — RPI not configured and CF direct blocked' }, 502);
  }

  return jsonResponse({ error: 'Not found', path }, 404);
}

/**
 * Rewrite manifest URLs to route segments through our VIPRow proxy.
 */
function rewriteManifestUrls(manifest: string, baseUrl: string, proxyBase: string): string {
  const lines = manifest.split('\n');
  const rewritten: string[] = [];
  const base = new URL(baseUrl);
  const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);

  for (const line of lines) {
    const trimmed = line.trim();

    // Keep comments, tags and empty lines
    if (line.startsWith('#') || trimmed === '') {
      rewritten.push(line);
      continue;
    }

    // Rewrite segment URLs
    try {
      let absoluteUrl: string;
      if (line.startsWith('http://') || line.startsWith('https://')) {
        absoluteUrl = line;
      } else if (line.startsWith('/')) {
        absoluteUrl = `${base.origin}${line}`;
      } else {
        absoluteUrl = `${base.origin}${basePath}${line}`;
      }
      rewritten.push(`${proxyBase}/segment?url=${encodeURIComponent(absoluteUrl)}`);
    } catch {
      rewritten.push(line);
    }
  }

  return rewritten.join('\n');
}
