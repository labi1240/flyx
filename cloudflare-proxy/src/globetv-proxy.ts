/**
 * GlobeTV Proxy — Live TV via iptv-org API
 *
 * GlobeTV (globetv.app) is a client wrapper around the public
 * iptv-org API (iptv-org.github.io/api). Channels come from
 * static JSON files; streams are .m3u8 URLs from public broadcasters.
 *
 * Routes:
 *   GET /globetv/health               - Health check
 *   GET /globetv/channels             - Proxy channel listing
 *   GET /globetv/streams?channelId=X  - Proxy stream URLs for a channel
 *   GET /globetv/stream?url=X         - Proxy HLS .m3u8 stream
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
const IPTV_API_BASE = 'https://iptv-org.github.io/api';

export async function handleGlobeTVRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/globetv\/?/, '');
  const logLevel = (env.LOG_LEVEL || 'info') as LogLevel;
  const logger = createLogger(request, logLevel);

  logger.info('GlobeTV proxy request', { path, search: url.search });

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  try {
    switch (true) {
      case path === 'health' || path === '':
        return jsonResponse({ status: 'ok', provider: 'globetv', baseUrl: IPTV_API_BASE });
      case path === 'channels':
        return await handleChannels(url.searchParams, logger);
      case path === 'streams':
        return await handleStreams(url.searchParams, logger);
      case path === 'stream':
        return await handleStream(url.searchParams, logger, request.url);
      default:
        return jsonResponse({ error: 'Unknown GlobeTV route', path }, 404);
    }
  } catch (error) {
    const err = error as Error;
    logger.error('GlobeTV proxy error', err);
    return jsonResponse({ error: 'GlobeTV proxy error', details: err.message }, 502);
  }
}

async function handleChannels(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const country = params.get('country');
  const category = params.get('category');
  const language = params.get('language');

  const apiUrl = `${IPTV_API_BASE}/channels.json`;
  logger.info('Fetching GlobeTV channels', { apiUrl, country, category, language });

  const res = await fetch(apiUrl, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  });

  if (!res.ok) {
    return jsonResponse({ error: `iptv-org channels fetch failed: ${res.status}` }, 502);
  }

  let channels: any[] = await res.json();

  // Filter by country if requested
  if (country) {
    const code = country.toUpperCase();
    channels = channels.filter(c => c.country === code);
  }

  // Filter by category if requested
  if (category) {
    channels = channels.filter(c =>
      c.categories && c.categories.some((cat: string) =>
        cat.toLowerCase() === category.toLowerCase()
      )
    );
  }

  // Filter by language if requested
  if (language) {
    channels = channels.filter(c =>
      c.languages && c.languages.some((lang: string) =>
        lang.toLowerCase() === language.toLowerCase()
      )
    );
  }

  // Limit results to prevent huge responses
  const total = channels.length;
  const limited = channels.slice(0, 500);

  return jsonResponse({
    channels: limited,
    total,
    returned: limited.length,
  });
}

async function handleStreams(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const channelId = params.get('channelId');
  if (!channelId) {
    return jsonResponse({ error: 'Missing required param: channelId' }, 400);
  }

  const apiUrl = `${IPTV_API_BASE}/streams.json`;
  logger.info('Fetching GlobeTV streams', { channelId });

  const res = await fetch(apiUrl, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  });

  if (!res.ok) {
    return jsonResponse({ error: `iptv-org streams fetch failed: ${res.status}` }, 502);
  }

  const allStreams: any[] = await res.json();

  // Filter streams for this channel
  const channelStreams = allStreams.filter(s => s.channel === channelId);

  if (channelStreams.length === 0) {
    return jsonResponse({ streams: [], message: 'No streams found for this channel' });
  }

  return jsonResponse({
    channelId,
    streams: channelStreams.map(s => ({
      url: s.url,
      status: s.status,
      source: s.source,
      quality: s.quality || 'SD',
      frame_rate: s.frame_rate,
    })),
  });
}

async function handleStream(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
  requestUrl: string,
): Promise<Response> {
  const encodedUrl = params.get('url');
  if (!encodedUrl) return jsonResponse({ error: 'Missing url' }, 400);

  const streamUrl = decodeURIComponent(encodedUrl);
  logger.info('Proxying GlobeTV stream', { url: streamUrl.substring(0, 120) });

  const res = await fetch(streamUrl, {
    headers: {
      'User-Agent': UA,
      'Accept': '*/*',
    },
  });

  if (!res.ok) {
    return jsonResponse({ error: `Stream fetch failed: ${res.status}` }, 502);
  }

  const proxyOrigin = new URL(requestUrl).origin;
  return await buildStreamResponseFromFetch(res, streamUrl, proxyOrigin, '/globetv/stream', 'globetv');
}
