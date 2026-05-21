/**
 * NTV Proxy — Live TV & Sports Aggregator
 *
 * NTV (ntv.cx) aggregates streams from 4 upstream providers:
 *   embedsports.top (Kobra), dlhd.pk (Phoenix), cdnlivetv.tv (Titan), hesgoales.com (Falcon)
 *
 * No Cloudflare, no CAPTCHA, no rate limiting on NTV APIs.
 * Stream access uses base64-encoded embed tokens: /embed?t={token}
 *
 * Routes:
 *   GET /ntv/channels              - Proxy all 2052 24/7 channels
 *   GET /ntv/matches?server=kobra  - Proxy sports match listings
 *   GET /ntv/search?q=...          - Proxy search
 *   GET /ntv/stream?t={token}      - Resolve embed token → upstream stream URL
 *   GET /ntv/embed?t={token}       - Proxy embed page content
 *   GET /ntv/health                - Health check
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
const NTV_BASE = 'https://ntv.cx';
const NTV_API = `${NTV_BASE}/api`;

// Upstream provider domains
const UPSTREAM_DOMAINS = {
  kobra: 'embedsports.top',
  phoenix: 'dlhd.pk',
  titan: 'cdnlivetv.tv',
  falcon: 'hesgoales.com',
};

/**
 * Main NTV request handler — dispatches to sub-routes based on URL path
 */
export async function handleNTVRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/ntv\/?/, '');
  const logLevel = (env.LOG_LEVEL || 'info') as LogLevel;
  const logger = createLogger(request, logLevel);

  logger.info('NTV proxy request', { path, search: url.search });

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(request) });
  }

  try {
    switch (true) {
      case path === 'health' || path === '':
        return handleHealth();
      case path === 'channels':
        return await handleChannels(logger);
      case path === 'matches':
        return await handleMatches(url.searchParams, logger);
      case path === 'search':
        return await handleSearch(url.searchParams, logger);
      case path === 'stream':
        return await handleStream(url.searchParams, logger);
      case path === 'embed':
        return await handleEmbed(url.searchParams, logger);
      default:
        return jsonResponse({ error: 'Unknown NTV route', path }, 404);
    }
  } catch (error) {
    const err = error as Error;
    logger.error('NTV proxy error', err);
    return jsonResponse({ error: 'NTV proxy error', details: err.message }, 502);
  }
}

/**
 * Health check
 */
function handleHealth(): Response {
  return jsonResponse({
    status: 'ok',
    provider: 'ntv',
    baseUrl: NTV_BASE,
  });
}

/**
 * Proxy /api/get-channels — all 2052 channels
 */
async function handleChannels(logger: ReturnType<typeof createLogger>): Promise<Response> {
  const apiUrl = `${NTV_API}/get-channels`;
  logger.info('Fetching NTV channels', { apiUrl });

  const res = await fetch(apiUrl, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  });

  if (!res.ok) {
    return jsonResponse({ error: `NTV channels fetch failed: ${res.status}` }, 502);
  }

  const data: Record<string, unknown> = await res.json();
  return jsonResponse(data);
}

/**
 * Proxy /api/get-matches?server={id}&type=both
 */
async function handleMatches(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const server = params.get('server') || 'kobra';
  const type = params.get('type') || 'both';

  const apiUrl = `${NTV_API}/get-matches?server=${encodeURIComponent(server)}&type=${encodeURIComponent(type)}`;
  logger.info('Fetching NTV matches', { apiUrl });

  const res = await fetch(apiUrl, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  });

  if (!res.ok) {
    return jsonResponse({ error: `NTV matches fetch failed: ${res.status}` }, 502);
  }

  const data: Record<string, unknown> = await res.json();
  return jsonResponse(data);
}

/**
 * Proxy /api/search?q={query}&server={id}
 */
async function handleSearch(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const q = params.get('q');
  if (!q) {
    return jsonResponse({ error: 'Missing required parameter: q' }, 400);
  }

  const server = params.get('server') || 'kobra';
  const apiUrl = `${NTV_API}/search?q=${encodeURIComponent(q)}&server=${encodeURIComponent(server)}`;
  logger.info('Searching NTV', { apiUrl });

  const res = await fetch(apiUrl, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  });

  if (!res.ok) {
    return jsonResponse({ error: `NTV search failed: ${res.status}` }, 502);
  }

  const data: Record<string, unknown> = await res.json();
  return jsonResponse(data);
}

/**
 * Decode NTV embed token and resolve the upstream stream URL.
 * The token is base64-encoded with "~" padding characters.
 * Server-side PHP decodes the token and renders the embed page with
 * an iframe to the upstream provider's stream.
 */
async function handleStream(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const token = params.get('t');
  if (!token) {
    return jsonResponse({ error: 'Missing required parameter: t (embed token)' }, 400);
  }

  // Fetch the NTV embed page using the token
  const embedUrl = `${NTV_BASE}/embed?t=${encodeURIComponent(token)}`;
  logger.info('Resolving NTV stream', { embedUrl });

  const res = await fetch(embedUrl, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
    },
  });

  if (!res.ok) {
    return jsonResponse({ error: `NTV embed fetch failed: ${res.status}` }, 502);
  }

  const html = await res.text();

  // Extract iframe src from the embed page
  // Pattern: <iframe ... src="https://upstream-provider/embed/..." ...>
  const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["'][^>]*>/i);

  if (!iframeMatch) {
    // Try alternate pattern: window.location or meta redirect
    const redirectMatch = html.match(/window\.location\s*=\s*["']([^"']+)["']/);
    if (redirectMatch) {
      return jsonResponse({ streamUrl: redirectMatch[1], upstream: 'redirect' });
    }

    logger.warn('No iframe found in NTV embed page');
    return jsonResponse({ error: 'No stream source found in embed page' }, 404);
  }

  const upstreamUrl = iframeMatch[1];

  // Determine which upstream provider based on domain
  let upstream = 'unknown';
  for (const [key, domain] of Object.entries(UPSTREAM_DOMAINS)) {
    if (upstreamUrl.includes(domain)) {
      upstream = key;
      break;
    }
  }

  return jsonResponse({
    streamUrl: upstreamUrl,
    upstream,
    embedPageUrl: embedUrl,
  });
}

/**
 * Proxy the raw embed page — returns HTML with iframe src extracted.
 * Useful when the frontend wants to handle the embed content directly.
 */
async function handleEmbed(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const token = params.get('t');
  if (!token) {
    return jsonResponse({ error: 'Missing required parameter: t' }, 400);
  }

  const embedUrl = `${NTV_BASE}/embed?t=${encodeURIComponent(token)}`;
  logger.info('Fetching NTV embed page', { embedUrl });

  const res = await fetch(embedUrl, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
    },
  });

  if (!res.ok) {
    return jsonResponse({ error: `Embed fetch failed: ${res.status}` }, 502);
  }

  const html = await res.text();

  // Extract and return just the iframe URL for clean response
  const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["'][^>]*>/i);

  return jsonResponse({
    embedUrl,
    iframeUrl: iframeMatch?.[1] || null,
    htmlLength: html.length,
  });
}
