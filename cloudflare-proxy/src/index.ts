/**
 * Combined Stream & TV Proxy Cloudflare Worker
 * 
 * PURE ROUTING LAYER — matches request paths to handler modules and
 * handles CORS preflight. All business logic, metrics, and error
 * formatting live in dedicated modules.
 * 
 * Routes:
 *   /stream/*    - Anti-leech stream proxy (requires token)
 *   /tv/*        - TV proxy for DLHD live streams
 *   /analytics/* - Analytics proxy (presence, events, pageviews)
 *   /decode      - Isolated decoder sandbox for untrusted scripts
 *   /health      - Health check endpoint
 * 
 * Deploy: wrangler deploy
 * Tail logs: npx wrangler tail media-proxy
 */

import streamProxy from './stream-proxy';
import antiLeechProxy from './anti-leech-proxy';
import fortressProxy from './fortress-proxy';
import quantumShield from './quantum-shield';
import quantumShieldV2 from './quantum-shield-v2';
import quantumShieldV3 from './quantum-shield-v3';
import tvProxy from './tv-proxy';
import decoderSandbox from './decoder-sandbox';
import { handleIPTVRequest } from './iptv-proxy';
import { handleDLHDRequest } from './dlhd-proxy';
import { handleAnimeKaiRequest } from './animekai-proxy';
import { handleFlixerRequest } from './flixer-proxy';
import { handleVideasyRequest } from './videasy-proxy';
import { handleAnalyticsRequest } from './analytics-proxy';
import { handleTMDBRequest } from './tmdb-proxy';
import { handleCDNLiveRequest } from './cdn-live-proxy';
import { handlePPVRequest } from './ppv-proxy';
import { handleVIPRowRequest } from './viprow-proxy';
import { handleVidSrcRequest } from './vidsrc-proxy';
import { handleHiAnimeRequest } from './hianime-proxy';
import { handlePrimeSrcRequest } from './primesrc-proxy';
import { handleNTVRequest } from './ntv-proxy';
import { handleMiruroRequest } from './miruro-proxy';
import { handleMovieBoxRequest } from './moviebox-proxy';
import { handleBingeBoxRequest } from './bingebox-proxy';
import { handleUFreeTVRequest } from './ufreetv-proxy';
import { handleGlobeTVRequest } from './globetv-proxy';
import { runHealthChecks } from './hexa-monitor';
import { createLogger, type LogLevel } from './logger';
import { incrementMetric } from './metrics';
import { corsPreflightResponse } from './cors';
import { errorResponse, detailedErrorResponse } from './errors';
import { buildHealthResponse, buildRootResponse } from './health';

export type { Env } from './env';
import type { Env } from './env';


/**
 * Route table: maps path prefixes to their handler + metric key.
 * Order matters — more specific prefixes must come before less specific ones.
 * This is the single source of truth for all CF Worker routing.
 */
export interface RouteEntry {
  /** Path prefix to match (startsWith) or exact path (exact match) */
  prefix: string;
  /** Whether this is an exact match (not prefix) */
  exact?: boolean;
  /** The handler function */
  handler: (request: Request, env: Env, ctx: ExecutionContext, logger: ReturnType<typeof createLogger>) => Promise<Response>;
}

/** Resolve the stream protection mode from env */
function resolveProtectionMode(env: Env): string {
  return env.PROTECTION_MODE || (env.ENABLE_ANTI_LEECH === 'true' ? 'basic' : 'none');
}

/** Build the route table. Defined as a function so it's testable. */
export function buildRouteTable(): RouteEntry[] {
  return [
    // Health check
    {
      prefix: '/health',
      exact: true,
      handler: async () => buildHealthResponse(),
    },

    // Stream proxy (with protection mode routing)
    {
      prefix: '/stream',
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('streamRequests');
        const path = new URL(request.url).pathname;
        const protectionMode = resolveProtectionMode(env);
        const newUrl = new URL(request.url);
        newUrl.pathname = path.replace(/^\/stream/, '') || '/';
        const newRequest = new Request(newUrl.toString(), request);

        switch (protectionMode) {
          case 'quantum-v3':
          case 'paranoid':
            logger.info('Routing to QUANTUM SHIELD V3 (PARANOID)', { path });
            return await quantumShieldV3.fetch(newRequest, env as any);
          case 'quantum-v2':
            logger.info('Routing to QUANTUM SHIELD V2', { path });
            return await quantumShieldV2.fetch(newRequest, env as any);
          case 'quantum':
            logger.info('Routing to QUANTUM SHIELD', { path });
            return await quantumShield.fetch(newRequest, env as any);
          case 'fortress':
            logger.info('Routing to FORTRESS proxy', { path });
            return await fortressProxy.fetch(newRequest, env as any);
          case 'basic':
            logger.info('Routing to anti-leech proxy', { path });
            return await antiLeechProxy.fetch(newRequest, env as any);
          default:
            logger.info('Routing to stream proxy (NO PROTECTION)', { path });
            return await streamProxy.fetch(newRequest, env);
        }
      },
    },

    // Fortress/Quantum init and challenge endpoints
    {
      prefix: '/init',
      exact: true,
      handler: async (request, env, _ctx, logger) => {
        const mode = env.PROTECTION_MODE || 'fortress';
        if (mode === 'quantum') {
          logger.info('Routing to quantum endpoint', { path: '/init' });
          return await quantumShield.fetch(request, env as any);
        }
        logger.info('Routing to fortress endpoint', { path: '/init' });
        return await fortressProxy.fetch(request, env as any);
      },
    },
    {
      prefix: '/challenge',
      exact: true,
      handler: async (request, env, _ctx, logger) => {
        const mode = env.PROTECTION_MODE || 'fortress';
        if (mode === 'quantum') {
          logger.info('Routing to quantum endpoint', { path: '/challenge' });
          return await quantumShield.fetch(request, env as any);
        }
        logger.info('Routing to fortress endpoint', { path: '/challenge' });
        return await fortressProxy.fetch(request, env as any);
      },
    },

    // Quantum Shield versioned endpoints
    {
      prefix: '/v3/',
      handler: async (request, env, _ctx, logger) => {
        logger.info('Routing to quantum shield v3 (PARANOID)', { path: new URL(request.url).pathname });
        return await quantumShieldV3.fetch(request, env as any);
      },
    },
    {
      prefix: '/v2/',
      handler: async (request, env, _ctx, logger) => {
        logger.info('Routing to quantum shield v2', { path: new URL(request.url).pathname });
        return await quantumShieldV2.fetch(request, env as any);
      },
    },
    {
      prefix: '/quantum/',
      handler: async (request, env, _ctx, logger) => {
        logger.info('Routing to quantum shield', { path: new URL(request.url).pathname });
        return await quantumShield.fetch(request, env as any);
      },
    },

    // Provider-specific routes
    {
      prefix: '/dlhd',
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('dlhdRequests');
        logger.info('Routing to DLHD proxy (Oxylabs)', { path: new URL(request.url).pathname });
        return await handleDLHDRequest(request, env);
      },
    },
    {
      prefix: '/animekai',
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('animekaiRequests');
        logger.info('Routing to AnimeKai proxy', { path: new URL(request.url).pathname });
        return await handleAnimeKaiRequest(request, env);
      },
    },
    // Flixer monitor endpoint (must come before general /flixer route)
    {
      prefix: '/flixer/monitor',
      exact: true,
      handler: async (_request, env, _ctx, logger) => {
        logger.info('Routing to Flixer monitor endpoint');
        if (!env.HEXA_CONFIG) {
          return new Response(JSON.stringify({ error: 'HEXA_CONFIG KV not bound' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const raw = await env.HEXA_CONFIG.get('monitor_state');
        if (!raw) {
          return new Response(JSON.stringify({ status: 'no_data', message: 'No monitor state available yet' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(raw, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
    {
      prefix: '/flixer',
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('flixerRequests');
        logger.info('Routing to Flixer proxy', { path: new URL(request.url).pathname });
        return await handleFlixerRequest(request, env);
      },
    },
    {
      prefix: '/videasy',
      handler: async (request, env, _ctx, logger) => {
        logger.info('Routing to Videasy proxy', { path: new URL(request.url).pathname });
        return await handleVideasyRequest(request, env, _ctx, logger);
      },
    },
    {
      prefix: '/analytics',
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('analyticsRequests');
        logger.info('Routing to Analytics proxy', { path: new URL(request.url).pathname });
        return await handleAnalyticsRequest(request, env as any);
      },
    },
    {
      prefix: '/tmdb',
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('tmdbRequests');
        logger.info('Routing to TMDB proxy', { path: new URL(request.url).pathname });
        return await handleTMDBRequest(request, env as any);
      },
    },
    {
      prefix: '/cdn-live',
      handler: async (request, env, _ctx, logger) => {
        logger.info('Routing to CDN-Live proxy', { path: new URL(request.url).pathname });
        return await handleCDNLiveRequest(request, env);
      },
    },
    {
      prefix: '/ppv',
      handler: async (request, env, _ctx, logger) => {
        logger.info('Routing to PPV proxy', { path: new URL(request.url).pathname });
        return await handlePPVRequest(request, env);
      },
    },
    {
      prefix: '/viprow',
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('viprowRequests');
        logger.info('Routing to VIPRow proxy', { path: new URL(request.url).pathname });
        return await handleVIPRowRequest(request, env);
      },
    },
    {
      prefix: '/vidsrc',
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('vidsrcRequests');
        logger.info('Routing to VidSrc proxy', { path: new URL(request.url).pathname });
        return await handleVidSrcRequest(request, env);
      },
    },
    {
      prefix: '/hianime',
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('hianimeRequests');
        logger.info('Routing to HiAnime proxy', { path: new URL(request.url).pathname });
        return await handleHiAnimeRequest(request, env);
      },
    },
    {
      prefix: '/miruro',
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('miruroRequests');
        logger.info('Routing to Miruro proxy', { path: new URL(request.url).pathname });
        return await handleMiruroRequest(request, env);
      },
    },
    {
      prefix: '/moviebox',
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('movieboxRequests');
        logger.info('Routing to MovieBox proxy', { path: new URL(request.url).pathname });
        return await handleMovieBoxRequest(request, env);
      },
    },
    {
      prefix: '/ntv',
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('ntvRequests');
        logger.info('Routing to NTV proxy', { path: new URL(request.url).pathname });
        return await handleNTVRequest(request, env);
      },
    },
    {
      prefix: '/primesrc',
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('primesrcRequests');
        logger.info('Routing to PrimeSrc proxy', { path: new URL(request.url).pathname });
        return await handlePrimeSrcRequest(request, env);
      },
    },
    {
      prefix: '/bingebox',
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('bingeboxRequests');
        logger.info('Routing to BingeBox proxy', { path: new URL(request.url).pathname });
        return await handleBingeBoxRequest(request, env);
      },
    },
    {
      prefix: '/ufreetv',
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('ufreetvRequests');
        logger.info('Routing to uFreeTV proxy', { path: new URL(request.url).pathname });
        return await handleUFreeTVRequest(request, env);
      },
    },
    {
      prefix: '/globetv',
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('globetvRequests');
        logger.info('Routing to GlobeTV proxy', { path: new URL(request.url).pathname });
        return await handleGlobeTVRequest(request, env);
      },
    },

    // IPTV — handles both /iptv/* and legacy /tv/iptv/*
    {
      prefix: '/tv/iptv',
      handler: async (request, env, _ctx, logger) => {
        logger.info('Routing to IPTV proxy (legacy /tv/iptv path)', { path: new URL(request.url).pathname });
        const newUrl = new URL(request.url);
        newUrl.pathname = newUrl.pathname.replace(/^\/tv/, '');
        const newRequest = new Request(newUrl.toString(), request);
        return await handleIPTVRequest(newRequest, env);
      },
    },
    {
      prefix: '/iptv',
      handler: async (request, env, _ctx, logger) => {
        logger.info('Routing to IPTV proxy', { path: new URL(request.url).pathname });
        return await handleIPTVRequest(request, env);
      },
    },

    // Direct /segment route for cdn-live-tv.ru segments (bypasses /tv)
    {
      prefix: '/segment',
      exact: true,
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('tvRequests');
        logger.info('Routing to direct segment proxy (bypassing /tv)', { path: '/segment' });
        return await tvProxy.fetch(request, env);
      },
    },

    // TV proxy (DLHD streams — NOT IPTV, must come after /tv/iptv)
    {
      prefix: '/tv',
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('tvRequests');
        const url = new URL(request.url);
        const path = url.pathname;
        const originalSearch = url.search;
        const newUrl = new URL(request.url);
        newUrl.pathname = path.replace(/^\/tv/, '') || '/';
        if (!newUrl.search && originalSearch) {
          newUrl.search = originalSearch;
        }
        const newRequest = new Request(newUrl.toString(), request);
        logger.info('Routing to TV proxy', { path, newPathname: newUrl.pathname });
        return await tvProxy.fetch(newRequest, env);
      },
    },

    // Decoder sandbox
    {
      prefix: '/decode',
      exact: true,
      handler: async (request, env, _ctx, logger) => {
        incrementMetric('decodeRequests');
        logger.info('Routing to decoder sandbox');
        return await decoderSandbox.fetch(request, env);
      },
    },

    // Recon fetch proxy — routes requests through CF IPs to bypass anti-DDoS
    {
      prefix: '/recon/fetch',
      handler: async (request, _env, _ctx, logger) => {
        const url = new URL(request.url);
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
          return new Response(JSON.stringify({ error: 'url param required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        try {
          const decoded = decodeURIComponent(targetUrl);
          const targetHost = new URL(decoded).hostname;

          // Restrict to known recon targets
          const allowed = ['195.128.25.19', '195.128.27.233', '213.21.239.30', '176.97.122.56',
            'cdn-live-tv.ru', 'cdn-live-tv.cfd', 'cdn-live.tv', 'cdn-live.is', 'cdnlivetv.tv',
            'dlhd.pk', 'daddylive.pk', 'dlstreams.com', 'dlhd.sx',
            'localhost', '127.0.0.1'];
          if (!allowed.some(h => targetHost.includes(h) || h.includes(targetHost))) {
            return new Response(JSON.stringify({ error: 'target not allowed', host: targetHost }), { status: 403, headers: { 'Content-Type': 'application/json' } });
          }

          const method = url.searchParams.get('method') || 'GET';
          const hdrsStr = url.searchParams.get('headers');
          const body = url.searchParams.get('body');
          const fetchHeaders = hdrsStr ? JSON.parse(hdrsStr) : {};

          logger.info('Recon fetch', { method, url: decoded.substring(0, 80) });

          const fetchOpts: RequestInit = { method, headers: fetchHeaders };
          if (body && method !== 'GET') fetchOpts.body = body;

          const resp = await fetch(decoded, fetchOpts);
          const respBody = await resp.text();

          return new Response(JSON.stringify({
            status: resp.status,
            headers: Object.fromEntries(resp.headers.entries()),
            body: respBody.substring(0, 50000),
          }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
      },
    },
  ];
}

/**
 * Match a request path against the route table.
 * Returns the first matching route entry, or undefined.
 */
export function matchRoute(path: string, routes: RouteEntry[]): RouteEntry | undefined {
  for (const route of routes) {
    if (route.exact) {
      if (path === route.prefix || path === route.prefix + '/') {
        return route;
      }
    } else {
      if (path.startsWith(route.prefix)) {
        return route;
      }
    }
  }
  return undefined;
}

// Build the route table once at module level
const routeTable = buildRouteTable();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const logLevel = (env.LOG_LEVEL || 'debug') as LogLevel;
    const logger = createLogger(request, logLevel);

    incrementMetric('requests');

    // Handle CORS preflight for ALL routes
    if (request.method === 'OPTIONS') {
      logger.info('CORS preflight request', { path, origin: request.headers.get('origin') });
      return corsPreflightResponse();
    }

    // Match route
    const route = matchRoute(path, routeTable);

    if (route) {
      try {
        return await route.handler(request, env, ctx, logger);
      } catch (error) {
        incrementMetric('errors');
        const err = error as Error;
        logger.error('Route handler error', err);
        // DLHD and TV routes historically return detailed errors
        if (path.startsWith('/dlhd') || path.startsWith('/tv') || path === '/segment') {
          return detailedErrorResponse(`${path.split('/')[1] || 'Unknown'} proxy error`, err);
        }
        return errorResponse(`${path.split('/')[1] || 'Unknown'} proxy error`, 500);
      }
    }

    // No route matched — return root info
    logger.info('Root endpoint accessed');
    return buildRootResponse(env, logLevel);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runHealthChecks(env, ctx).catch(() => { /* best-effort */ }));
  },
};
