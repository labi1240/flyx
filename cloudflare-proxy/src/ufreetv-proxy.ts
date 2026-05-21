/**
 * uFreeTV Proxy — Live TV Streaming
 *
 * ufreetv.com — WordPress site with 3 streaming systems:
 *   A. WordPress posts with Clappr.js player (~107 channels)
 *   B. nosslstreams.ufreetv.com (199 channels, HTTP subdomain)
 *   C. all_channels.json (thousands of worldwide IPTV channels)
 *
 * Zero auth, zero rate limiting, zero anti-scraping.
 *
 * Routes:
 *   GET /ufreetv/channels              - List all channels (System A + B + C)
 *   GET /ufreetv/stream?url=X          - Proxy HLS stream
 *   GET /ufreetv/health                - Health check
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
const UFREE_BASE = 'https://ufreetv.com';
const WP_API = `${UFREE_BASE}/wp-json/wp/v2`;

interface UFreeTVChannel {
  id: string;
  name: string;
  slug: string;
  url: string;
  category: string;
  source: 'wordpress' | 'all_channels_json';
}

export async function handleUFreeTVRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/ufreetv\/?/, '');
  const logLevel = (env.LOG_LEVEL || 'info') as LogLevel;
  const logger = createLogger(request, logLevel);

  logger.info('uFreeTV proxy request', { path, search: url.search });

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  try {
    switch (true) {
      case path === 'health' || path === '':
        return jsonResponse({ status: 'ok', provider: 'ufreetv', baseUrl: UFREE_BASE });
      case path === 'channels':
        return await handleChannels(url.searchParams, logger);
      case path === 'stream':
        return await handleStream(url.searchParams, logger, request.url);
      default:
        return jsonResponse({ error: 'Unknown uFreeTV route', path }, 404);
    }
  } catch (error) {
    const err = error as Error;
    logger.error('uFreeTV proxy error', err);
    return jsonResponse({ error: 'uFreeTV proxy error', details: err.message }, 502);
  }
}

async function handleChannels(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const source = params.get('source') || 'all';
  const channels: UFreeTVChannel[] = [];

  if (source === 'all' || source === 'wordpress') {
    try {
      // Fetch WordPress posts (live category = 6, usa category = 10)
      const [liveRes, usaRes] = await Promise.all([
        fetch(`${WP_API}/posts?categories=6&per_page=100&_fields=id,title,slug,content,link`, {
          headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        }),
        fetch(`${WP_API}/posts?categories=10&per_page=100&_fields=id,title,slug,content,link`, {
          headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        }),
      ]);

      const extractStreamFromContent = (content: string): string | null => {
        const match = content.match(/source:\s*"([^"]+\.m3u8[^"]*)"/);
        return match ? match[1].replace(/\\\//g, '/') : null;
      };

      for (const res of [liveRes, usaRes]) {
        if (!res.ok) continue;
        const posts: any[] = await res.json();
        for (const post of posts) {
          const streamUrl = extractStreamFromContent(post.content?.rendered || '');
          if (streamUrl) {
            channels.push({
              id: `wp-${post.id}`,
              name: post.title?.rendered || post.slug,
              slug: post.slug,
              url: streamUrl,
              category: 'live',
              source: 'wordpress',
            });
          }
        }
      }
    } catch (e) {
      logger.warn('WordPress channel fetch failed', { error: (e as Error).message });
    }
  }

  if (source === 'all' || source === 'json') {
    try {
      const jsonRes = await fetch(`${UFREE_BASE}/wp-content/uploads/all_channels.json`, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      });
      if (jsonRes.ok) {
        const allChannels: Array<{ name: string; url: string }> = await jsonRes.json();
        for (const ch of allChannels) {
          if (ch.url && ch.url.includes('m3u8')) {
            channels.push({
              id: `json-${Buffer.from(ch.name).toString('base64').substring(0, 12)}`,
              name: ch.name,
              slug: ch.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
              url: ch.url,
              category: 'iptv',
              source: 'all_channels_json',
            });
          }
        }
      }
    } catch (e) {
      logger.warn('all_channels.json fetch failed', { error: (e as Error).message });
    }
  }

  logger.info(`Returning ${channels.length} uFreeTV channels`);
  return jsonResponse({ channels, total: channels.length });
}

async function handleStream(
  params: URLSearchParams,
  logger: ReturnType<typeof createLogger>,
  requestUrl: string,
): Promise<Response> {
  const encodedUrl = params.get('url');
  if (!encodedUrl) return jsonResponse({ error: 'Missing url' }, 400);

  const streamUrl = decodeURIComponent(encodedUrl);
  logger.info('Proxying uFreeTV stream', { url: streamUrl.substring(0, 120) });

  const res = await fetch(streamUrl, {
    headers: {
      'User-Agent': UA,
      'Referer': `${UFREE_BASE}/`,
      'Accept': '*/*',
    },
  });

  if (!res.ok) {
    return jsonResponse({ error: `Stream fetch failed: ${res.status}` }, 502);
  }

  const proxyOrigin = new URL(requestUrl).origin;
  return await buildStreamResponseFromFetch(res, streamUrl, proxyOrigin, '/ufreetv/stream', 'ufreetv');
}
