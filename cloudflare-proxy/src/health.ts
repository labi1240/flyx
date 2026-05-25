/**
 * Health check and root info response builders
 * Extracted from index.ts to keep routing layer thin
 */

import { metrics, getUptimeSeconds } from './metrics';
import type { Env } from './env';
import type { LogLevel } from './logger';

/** Build the /health endpoint JSON response */
export function buildHealthResponse(): Response {
  const uptime = getUptimeSeconds();

  return new Response(JSON.stringify({
    status: 'healthy',
    uptime: `${uptime}s`,
    metrics: {
      totalRequests: metrics.requests,
      errors: metrics.errors,
      streamRequests: metrics.streamRequests,
      tvRequests: metrics.tvRequests,
      dlhdRequests: metrics.dlhdRequests,
      decodeRequests: metrics.decodeRequests,
      animekaiRequests: metrics.animekaiRequests,
      flixerRequests: metrics.flixerRequests,
      analyticsRequests: metrics.analyticsRequests,
      tmdbRequests: metrics.tmdbRequests,
      viprowRequests: metrics.viprowRequests,
      vidsrcRequests: metrics.vidsrcRequests,
      hianimeRequests: metrics.hianimeRequests,
    },
    timestamp: new Date().toISOString(),
  }, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/** Build the root (/) endpoint JSON response with route documentation */
export function buildRootResponse(env: Env, logLevel: LogLevel): Response {
  const antiLeechEnabled = env.ENABLE_ANTI_LEECH === 'true';

  return new Response(JSON.stringify({
    name: 'Cloudflare Stream & TV Proxy',
    version: '3.0.0',
    status: 'operational',
    uptime: `${getUptimeSeconds()}s`,
    antiLeech: {
      enabled: antiLeechEnabled,
      description: antiLeechEnabled
        ? 'Requests require cryptographic tokens bound to browser fingerprint'
        : 'Legacy mode - no protection (set ENABLE_ANTI_LEECH=true to enable)',
    },
    routes: {
      stream: {
        path: '/stream/',
        description: antiLeechEnabled
          ? 'Anti-leech HLS stream proxy (requires token)'
          : 'HLS stream proxy for 2embed',
        usage: antiLeechEnabled
          ? '/stream/?url=<url>&t=<token>&f=<fingerprint>&s=<session>'
          : '/stream/?url=<encoded_url>&source=2embed&referer=<encoded_referer>',
        tokenEndpoint: antiLeechEnabled ? '/stream/token' : undefined,
      },
      tv: {
        path: '/tv/',
        description: 'DLHD live TV proxy',
        usage: '/tv/?channel=<id>',
        subRoutes: {
          key: '/tv/key?url=<encoded_url>',
          segment: '/tv/segment?url=<encoded_url>',
        },
      },
      dlhd: {
        path: '/dlhd/',
        description: 'DLHD proxy with Oxylabs residential IP rotation',
        usage: '/dlhd?channel=<id>',
        subRoutes: {
          key: '/dlhd/key?url=<encoded_url>',
          segment: '/dlhd/segment?url=<encoded_url>',
          health: '/dlhd/health',
        },
        config: {
          oxylabs: !!(env.OXYLABS_USERNAME && env.OXYLABS_PASSWORD) ? 'configured' : 'not configured',
          country: env.OXYLABS_COUNTRY || 'auto',
        },
      },
      iptv: {
        path: '/iptv/',
        description: 'IPTV Stalker portal proxy',
        subRoutes: {
          api: '/iptv/api?url=<encoded_url>&mac=<mac>&token=<token>',
          stream: '/iptv/stream?url=<encoded_url>&mac=<mac>&token=<token>',
        },
      },
      animekai: {
        path: '/animekai/',
        description: 'AnimeKai stream proxy (MegaUp CDN)',
        usage: '/animekai?url=<encoded_url>',
        subRoutes: { health: '/animekai/health' },
      },
      flixer: {
        path: '/flixer/',
        description: 'Flixer stream extraction via WASM-based decryption',
        usage: '/flixer/extract?tmdbId=<id>&type=<movie|tv>&season=<n>&episode=<n>&server=<name>',
        subRoutes: {
          extract: '/flixer/extract - Extract m3u8 URL from Flixer',
          health: '/flixer/health - Health check',
        },
        servers: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'],
      },
      ppv: {
        path: '/ppv/',
        description: 'PPV.to stream proxy (modistreams.org/poocloud.in)',
        usage: '/ppv/stream?url=<encoded_url>',
        subRoutes: {
          stream: '/ppv/stream?url=<encoded_url> - Proxy m3u8/ts with proper Referer',
          health: '/ppv/health - Health check',
          test: '/ppv/test - Test upstream connectivity',
        },
        validDomains: ['poocloud.in', 'modistreams.org', 'pooembed.top'],
        requiredHeaders: {
          Referer: 'https://modistreams.org/',
          Origin: 'https://modistreams.org',
        },
      },
      cdnLive: {
        path: '/cdn-live/',
        description: 'CDN-Live.tv stream proxy',
        usage: '/cdn-live/stream?url=<encoded_url>',
        subRoutes: {
          stream: '/cdn-live/stream?url=<encoded_url> - Proxy m3u8/ts',
          health: '/cdn-live/health - Health check',
        },
      },
      viprow: {
        path: '/viprow/',
        description: 'VIPRow/Casthill live sports stream proxy',
        usage: '/viprow/stream?url=<viprow_event_url>&link=<1-10>',
        subRoutes: {
          stream: '/viprow/stream?url=/nba/event-online-stream&link=1 - Extract and proxy m3u8',
          manifest: '/viprow/manifest?url=<encoded_url> - Proxy manifest with URL rewriting',
          key: '/viprow/key?url=<encoded_url> - Proxy decryption key',
          segment: '/viprow/segment?url=<encoded_url> - Proxy video segment',
          health: '/viprow/health - Health check',
        },
        features: [
          'Direct m3u8 extraction (no iframe)',
          'Automatic token refresh via boanki.net',
          'URL rewriting for browser playback',
          'AES-128 key proxying',
        ],
      },
      vidsrc: {
        path: '/vidsrc/',
        description: 'VidSrc stream extraction via 2embed.stream API (NO TURNSTILE!)',
        usage: '/vidsrc/extract?tmdbId=<id>&type=<movie|tv>&season=<n>&episode=<n>',
        subRoutes: {
          extract: '/vidsrc/extract - Extract m3u8 URL from 2embed.stream API',
          stream: '/vidsrc/stream?url=<encoded_url> - Proxy m3u8/ts segments',
          health: '/vidsrc/health - Health check (tests API reachability)',
        },
        features: [
          'Direct API access - NO Turnstile/captcha',
          'Multiple quality streams (480p, 720p, 1080p)',
          'URL rewriting for browser playback',
          'Source: lk21_database',
        ],
      },
      hianime: {
        path: '/hianime/',
        description: 'HiAnime extraction + MegaCloud stream proxy (full server-side pipeline)',
        usage: '/hianime/extract?malId=<mal_id>&title=<anime_title>&episode=<number>',
        subRoutes: {
          extract: '/hianime/extract - Full extraction: search → episodes → servers → MegaCloud decrypt',
          stream: '/hianime/stream?url=<encoded_url> - Proxy HLS m3u8/ts segments',
          health: '/hianime/health - Health check',
        },
        features: [
          'Full server-side extraction (no frontend decryption)',
          'MegaCloud v3 decryption with client key + megacloud key',
          'Sub + Dub extraction in parallel',
          'Subtitle extraction',
          'Skip intro/outro markers',
          'HLS URL rewriting for browser playback',
        ],
      },
      analytics: {
        path: '/analytics/',
        description: 'Analytics proxy - forwards events to Analytics Worker (D1)',
        subRoutes: {
          presence: 'POST /analytics/presence - User presence heartbeat',
          pageview: 'POST /analytics/pageview - Page view tracking',
          event: 'POST /analytics/event - Generic analytics event',
          health: 'GET /analytics/health - Health check',
        },
        benefits: [
          'Cloudflare free tier: 100k requests/day',
          'Lower latency (edge closer to users)',
          'No cold starts',
        ],
      },
      decode: {
        path: '/decode',
        description: 'Isolated decoder sandbox for untrusted scripts',
        method: 'POST',
        body: '{ script: string, divId: string, encodedContent: string }',
      },
      health: {
        path: '/health',
        description: 'Health check and metrics',
      },
    },
    observability: {
      logs: 'View in Cloudflare Dashboard > Workers > Logs',
      tailCommand: 'npx wrangler tail media-proxy',
      logLevel: logLevel,
    },
  }, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
