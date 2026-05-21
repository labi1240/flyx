/**
 * AnimeKai Stream Proxy
 *
 * Routes AnimeKai HLS streams with CF-direct priority.
 * Local AnimeKai decryption runs natively in the CF Worker.
 * MegaUp CDN fetch is attempted direct from CF first (with
 * appropriate headers), falling back to RPI only if blocked.
 *
 * Flow (extract):
 *   Client -> CF Worker (local decrypt) -> try CF direct fetch
 *                                       -> fallback RPI if blocked
 *
 * Flow (stream):
 *   Client -> CF Worker -> try CF direct -> fallback RPI
 *
 * Routes:
 *   GET /animekai?url=<encoded_url>   - Proxy HLS stream/segment
 *   GET /animekai/extract?embed=<...>  - Decrypt + extract stream URL
 *   GET /animekai/full-extract?kai_id=&episode= - Full pipeline
 *   GET /animekai/health               - Health check
 */

import { createLogger, type LogLevel } from './logger';
import {
  isMegaUpCdn,
  corsHeaders,
  jsonResponse,
  rewritePlaylistUrls as sharedRewritePlaylistUrls,
  buildStreamResponse,
  buildStreamResponseFromFetch,
} from './shared';
import { decryptAnimeKai } from './animekai-crypto';

export interface Env {
  LOG_LEVEL?: string;
  RPI_PROXY_URL?: string;
  RPI_PROXY_KEY?: string;
}

// Allowed origins for anti-leech protection
const ALLOWED_ORIGINS = [
  'https://tv.vynx.cc',
  'https://flyx.tv',
  'https://www.flyx.tv',
  'http://localhost:3000',
  'http://localhost:3001',
  '.pages.dev',      // Cloudflare Pages
  '.workers.dev',    // Cloudflare Workers
];

function isAllowedOrigin(origin: string | null, referer: string | null): boolean {
  if (!origin && !referer) return true;

  const checkOrigin = (o: string): boolean => {
    return ALLOWED_ORIGINS.some(allowed => {
      if (allowed.includes('localhost')) return o.includes('localhost');
      if (allowed.startsWith('.')) {
        try {
          const originHost = new URL(o).hostname;
          return originHost.endsWith(allowed);
        } catch { return false; }
      }
      try {
        const allowedHost = new URL(allowed).hostname;
        const originHost = new URL(o).hostname;
        return originHost === allowedHost || originHost.endsWith(`.${allowedHost}`);
      } catch { return false; }
    });
  };

  if (origin && checkOrigin(origin)) return true;
  if (referer) {
    try {
      return checkOrigin(new URL(referer).origin);
    } catch { return false; }
  }
  return false;
}

/**
 * Rewrite playlist URLs to route through this proxy
 */
function rewritePlaylistUrls(playlist: string, baseUrl: string, proxyOrigin: string): string {
  return sharedRewritePlaylistUrls(playlist, baseUrl, proxyOrigin, '/animekai');
}

export async function handleAnimeKaiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const logLevel = (env.LOG_LEVEL || 'info') as LogLevel;
  const logger = createLogger(request, logLevel);
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // Health check
  if (path === '/animekai/health' || path.endsWith('/health')) {
    const hasRpi = !!(env.RPI_PROXY_URL && env.RPI_PROXY_KEY);
    return jsonResponse({
      status: 'ok',
      rpiProxy: {
        configured: hasRpi,
        url: env.RPI_PROXY_URL ? env.RPI_PROXY_URL.substring(0, 30) + '...' : 'not set',
      },
      timestamp: new Date().toISOString(),
    }, 200);
  }

  // FULL EXTRACTION endpoint
  // Strategy 1: Local decrypt → extract URL → try CF direct fetch for MegaUp /media/
  // Strategy 2: RPI fallback (for when MegaUp blocks datacenter IPs)
  if (path === '/animekai/extract') {
    const encryptedEmbed = url.searchParams.get('embed');

    if (!encryptedEmbed) {
      return jsonResponse({
        error: 'Missing embed parameter',
        usage: '/animekai/extract?embed=<encrypted_embed_response>'
      }, 400);
    }

    logger.info('AnimeKai extraction request', { embedLength: encryptedEmbed.length });

    // Strategy 1: Try local decryption + CF direct MegaUp fetch
    const localResult = await extractStreamLocally(encryptedEmbed, env, logger, url.origin);
    if (localResult.success) {
      logger.info('Local extraction succeeded', { streamUrl: localResult.streamUrl?.substring(0, 80) });
      return jsonResponse(localResult, 200);
    }

    logger.info('Local extraction failed, trying RPI fallback', { error: localResult.error });

    // Strategy 2: RPI fallback
    const hasRpi = !!(env.RPI_PROXY_URL && env.RPI_PROXY_KEY);
    if (hasRpi) {
      try {
        let rpiBaseUrl = env.RPI_PROXY_URL!;
        if (!rpiBaseUrl.startsWith('http://') && !rpiBaseUrl.startsWith('https://')) {
          rpiBaseUrl = `https://${rpiBaseUrl}`;
        }

        const rpiUrl = `${rpiBaseUrl}/animekai/extract?key=${env.RPI_PROXY_KEY}&embed=${encodeURIComponent(encryptedEmbed)}`;

        const rpiResponse = await fetch(rpiUrl, {
          signal: AbortSignal.timeout(30000),
        });

        const responseData = await rpiResponse.json() as { success?: boolean; streamUrl?: string; error?: string };

        logger.info('RPI extraction response', {
          status: rpiResponse.status,
          success: responseData.success,
          hasStreamUrl: !!responseData.streamUrl,
        });

        return jsonResponse(responseData as object, rpiResponse.status);

      } catch (error) {
        logger.error('RPI extraction error', error as Error);
        return jsonResponse({
          error: 'All extraction strategies failed',
          localError: localResult.error,
          rpiError: error instanceof Error ? error.message : String(error),
        }, 502);
      }
    }

    return jsonResponse({
      error: 'Extraction failed — no RPI configured and local extraction did not succeed',
      localError: localResult.error,
    }, 502);
  }

  // FULL EXTRACTION V2 — kai_id + episode
  // Strategy 1: Try local extraction (fetch from AnimeKai API directly + decrypt)
  // Strategy 2: RPI fallback
  if (path === '/animekai/full-extract') {
    const kaiId = url.searchParams.get('kai_id');
    const episode = url.searchParams.get('episode');

    if (!kaiId || !episode) {
      return jsonResponse({
        error: 'Missing parameters',
        usage: '/animekai/full-extract?kai_id=<anime_id>&episode=<episode_number>'
      }, 400);
    }

    logger.info('AnimeKai full extraction V2 request', { kaiId, episode });

    // Try local extraction
    const localResult = await fullExtractLocally(kaiId, episode, env, logger, url.origin);
    if (localResult.success) {
      logger.info('Local full extraction succeeded');
      return jsonResponse(localResult, 200);
    }

    logger.info('Local full extraction failed, trying RPI fallback', { error: localResult.error });

    // RPI fallback
    const hasRpi = !!(env.RPI_PROXY_URL && env.RPI_PROXY_KEY);
    if (hasRpi) {
      try {
        let rpiBaseUrl = env.RPI_PROXY_URL!;
        if (!rpiBaseUrl.startsWith('http://') && !rpiBaseUrl.startsWith('https://')) {
          rpiBaseUrl = `https://${rpiBaseUrl}`;
        }

        const rpiUrl = `${rpiBaseUrl}/animekai/full-extract?key=${env.RPI_PROXY_KEY}&kai_id=${encodeURIComponent(kaiId)}&episode=${encodeURIComponent(episode)}`;

        const rpiResponse = await fetch(rpiUrl, {
          signal: AbortSignal.timeout(45000),
        });

        const responseData = await rpiResponse.json() as { success?: boolean; streamUrl?: string; error?: string };

        logger.info('RPI full extraction response', {
          status: rpiResponse.status,
          success: responseData.success,
          hasStreamUrl: !!responseData.streamUrl,
        });

        return jsonResponse(responseData as object, rpiResponse.status);

      } catch (error) {
        logger.error('RPI full extraction error', error as Error);
        return jsonResponse({
          error: 'All full extraction strategies failed',
          localError: localResult.error,
          rpiError: error instanceof Error ? error.message : String(error),
        }, 502);
      }
    }

    return jsonResponse({
      error: 'Full extraction failed — no RPI configured and local extraction did not succeed',
      localError: localResult.error,
    }, 502);
  }

  // Anti-leech check
  if (!isAllowedOrigin(origin, referer)) {
    logger.warn('Blocked unauthorized request', { origin, referer });
    return jsonResponse({
      error: 'Access denied',
      message: 'This proxy only serves authorized domains',
    }, 403);
  }

  // Get target URL
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return jsonResponse({ error: 'Missing url parameter' }, 400);
  }

  // searchParams.get() already decodes the URL — do NOT double-decode
  const decodedUrl = targetUrl;
  const customUserAgent = url.searchParams.get('ua');
  const customReferer = url.searchParams.get('referer');
  
  const hasRpi = !!(env.RPI_PROXY_URL && env.RPI_PROXY_KEY);
  
  logger.info('AnimeKai proxy request', { 
    url: decodedUrl.substring(0, 100), 
    ua: customUserAgent ? 'custom' : 'default', 
    referer: customReferer ? 'custom' : 'auto',
  });

  // STRATEGY 1: Try CF direct fetch first (fastest)
  logger.debug('Trying CF direct fetch...');
  const directResult = await fetchDirectFromCF(decodedUrl, customUserAgent, customReferer);
  
  if (directResult.success) {
    logger.info('CF direct fetch succeeded!');
    return handleSuccessResponse(directResult, decodedUrl, url.origin, 'cf-direct');
  }
  
  logger.debug('CF direct failed', { status: directResult.status });

  // STRATEGY 2: RPI /fetch-rust (Chrome TLS fingerprint from residential IP)
  if (hasRpi) {
    try {
      let rpiBase = env.RPI_PROXY_URL!.replace(/\/+$/, '');
      if (!rpiBase.startsWith('http')) rpiBase = `https://${rpiBase}`;

      const rustHeaders: Record<string, string> = {
        'User-Agent': customUserAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
      };
      // MegaUp CDN blocks Referer — don't include it
      const isMegaUpDomain = isMegaUpCdn(decodedUrl);
      if (!isMegaUpDomain && customReferer) {
        rustHeaders['Referer'] = customReferer;
      }

      const rustParams = new URLSearchParams({
        url: decodedUrl,
        headers: JSON.stringify(rustHeaders),
        timeout: '30',
      });
      const rustUrl = `${rpiBase}/fetch-rust?${rustParams.toString()}`;
      logger.debug('Trying RPI rust-fetch...', { url: decodedUrl.substring(0, 80) });

      const rustRes = await fetch(rustUrl, {
        headers: { 'X-API-Key': env.RPI_PROXY_KEY! },
        signal: AbortSignal.timeout(20000),
      });

      if (rustRes.ok) {
        logger.info('RPI rust-fetch succeeded!');
        const body = await rustRes.arrayBuffer();
        const contentType = rustRes.headers.get('content-type') || '';
        return handleSuccessResponse({ body, contentType }, decodedUrl, url.origin, 'rpi-rust');
      }
      logger.debug('RPI rust-fetch failed', { status: rustRes.status });
    } catch (e) {
      logger.debug('RPI rust-fetch error', { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // STRATEGY 3: RPI residential proxy (legacy Node.js https)
  if (hasRpi) {
    logger.debug('Trying RPI residential proxy...');
    return await fetchViaRpiProxy(decodedUrl, customUserAgent, customReferer, env, logger, url.origin);
  }

  // No proxies available
  logger.error('All proxy strategies failed');
  return jsonResponse({
    error: 'Proxy failed',
    message: 'CF direct failed and RPI not configured',
    cfDirectStatus: directResult.status,
  }, 502);
}


/**
 * Try direct fetch from CF Worker (fastest path)
 */
async function fetchDirectFromCF(
  url: string,
  customUserAgent: string | null,
  customReferer: string | null
): Promise<{ success: boolean; status?: number; body?: ArrayBuffer; contentType?: string; error?: string }> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': customUserAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
    };
    
    // Add referer if provided or auto-detect
    // IMPORTANT: MegaUp CDN blocks requests with Referer header, so don't add it for megaup domains
    const isMegaUpDomain = isMegaUpCdn(url);
    
    // VidLink CDN domains (storm.vodvidl.site, videostr.net) — need Referer/Origin headers
    const isVidLinkDomain = url.includes('vodvidl.site') || url.includes('videostr.net');
    
    if (isMegaUpDomain) {
      // MegaUp CDN - do NOT send Referer header (they block it)
      // Only send User-Agent
    } else if (isVidLinkDomain) {
      // VidLink CDN — extract embedded headers from URL params if present
      try {
        const parsedUrl = new URL(url);
        const headersParam = parsedUrl.searchParams.get('headers');
        if (headersParam) {
          const parsedHeaders = JSON.parse(headersParam);
          if (parsedHeaders.referer) headers['Referer'] = parsedHeaders.referer;
          if (parsedHeaders.origin) headers['Origin'] = parsedHeaders.origin;
        } else {
          headers['Referer'] = 'https://videostr.net/';
          headers['Origin'] = 'https://videostr.net';
        }
      } catch {
        headers['Referer'] = 'https://videostr.net/';
        headers['Origin'] = 'https://videostr.net';
      }
    } else if (customReferer) {
      headers['Referer'] = customReferer;
    } else if (url.includes('workers.dev')) {
      headers['Referer'] = 'https://111movies.com/';
    } else if (url.match(/\.[a-z0-9]+\.site/)) {
      headers['Referer'] = 'https://animekai.to/';
    }
    
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    
    if (!response.ok) {
      return { success: false, status: response.status, error: `HTTP ${response.status}` };
    }
    
    const body = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || '';
    
    return { success: true, status: response.status, body, contentType };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Handle successful response - rewrite playlists and return
 */
function handleSuccessResponse(
  result: { body?: ArrayBuffer; contentType?: string; [key: string]: unknown },
  originalUrl: string,
  proxyOrigin: string,
  via: string
): Response {
  return buildStreamResponse(result.body!, (result.contentType as string) || '', originalUrl, proxyOrigin, '/animekai', via);
}

/**
 * Determine the correct RPI route based on the target URL domain.
 * Each provider CDN has a dedicated RPI endpoint with the right headers.
 */
function getRpiRouteForUrl(url: string): string {
  // VidLink CDN — vodvidl.site, videostr.net
  if (url.includes('vodvidl.site') || url.includes('videostr.net')) {
    return 'vidlink/stream';
  }
  // VidSrc / 2embed / cloudnestra CDN
  if (url.includes('2embed') || url.includes('vidsrc') || url.includes('cloudnestra') || 
      url.includes('shadowlandschronicles') || url.includes('embedsito')) {
    return 'vidsrc/stream';
  }
  // 1movies CDN — p.XXXXX.workers.dev with 111movies referer
  if (url.match(/p\.\d+\.workers\.dev/) && !url.includes('flixer') && !url.includes('hexa')) {
    return '1movies/stream';
  }
  // Flixer CDN — p.XXXXX.workers.dev with flixer referer, or hexa.su
  if (url.includes('hexa.su') || url.includes('plsdontscrapemelove')) {
    return 'flixer/stream';
  }
  // Default: generic /animekai endpoint (MegaUp CDN, AnimeKai domains)
  return 'animekai';
}

/**
 * Fetch via RPI residential proxy
 */
async function fetchViaRpiProxy(
  decodedUrl: string,
  customUserAgent: string | null,
  customReferer: string | null,
  env: Env,
  logger: ReturnType<typeof createLogger>,
  proxyOrigin: string
): Promise<Response> {
  try {
    let rpiBaseUrl = env.RPI_PROXY_URL!;
    if (!rpiBaseUrl.startsWith('http://') && !rpiBaseUrl.startsWith('https://')) {
      rpiBaseUrl = `https://${rpiBaseUrl}`;
    }
    // Strip trailing slash to avoid double-slash in URL path
    rpiBaseUrl = rpiBaseUrl.replace(/\/+$/, '');

    const rpiParams = new URLSearchParams({
      url: decodedUrl,
      key: env.RPI_PROXY_KEY!,
    });
    
    if (customUserAgent) {
      rpiParams.set('ua', customUserAgent);
    }
    
    // Auto-detect referer based on target domain
    if (customReferer) {
      rpiParams.set('referer', customReferer);
    } else if (decodedUrl.includes('vodvidl.site') || decodedUrl.includes('videostr.net')) {
      // VidLink CDN — extract embedded headers from URL if present
      try {
        const parsedUrl = new URL(decodedUrl);
        const headersParam = parsedUrl.searchParams.get('headers');
        if (headersParam) {
          const parsedHeaders = JSON.parse(headersParam);
          if (parsedHeaders.referer) rpiParams.set('referer', parsedHeaders.referer);
          if (parsedHeaders.origin) rpiParams.set('origin', parsedHeaders.origin);
        } else {
          rpiParams.set('referer', 'https://videostr.net/');
          rpiParams.set('origin', 'https://videostr.net');
        }
      } catch {
        rpiParams.set('referer', 'https://videostr.net/');
        rpiParams.set('origin', 'https://videostr.net');
      }
    } else if (decodedUrl.includes('hexa.su') || decodedUrl.includes('plsdontscrapemelove')) {
      // Flixer CDN
      rpiParams.set('referer', 'https://flixer.su/');
    } else if (decodedUrl.match(/p\.\d+\.workers\.dev/)) {
      // Could be Flixer or 1movies — default to 1movies since Flixer has its own /flixer/stream route
      rpiParams.set('referer', 'https://111movies.com/');
    } else if (decodedUrl.match(/\.[a-z0-9]+\.site/)) {
      rpiParams.set('referer', 'https://animekai.to/');
    }
    
    const rpiUrl = `${rpiBaseUrl}/${getRpiRouteForUrl(decodedUrl)}?${rpiParams.toString()}`;
    logger.debug('Forwarding to RPI proxy', { rpiUrl: rpiUrl.substring(0, 80) });

    const rpiResponse = await fetch(rpiUrl, {
      signal: AbortSignal.timeout(30000),
    });

    if (!rpiResponse.ok) {
      logger.error('RPI proxy error', { status: rpiResponse.status });
      
      let errorDetails = '';
      try {
        const errorBody = await rpiResponse.text();
        errorDetails = errorBody.substring(0, 200);
      } catch {}
      
      return jsonResponse({
        error: `RPI proxy returned ${rpiResponse.status}`,
        details: errorDetails,
      }, rpiResponse.status);
    }

    return await buildStreamResponseFromFetch(rpiResponse, decodedUrl, proxyOrigin, '/animekai', 'rpi');

  } catch (error) {
    logger.error('RPI proxy error', error as Error);
    return jsonResponse({
      error: 'Proxy error',
      details: error instanceof Error ? error.message : String(error),
    }, 502);
  }
}

// ============================================================================
// Local Extraction (no RPI dependency)
// ============================================================================

/**
 * Extract stream URL from encrypted AnimeKai embed — locally in CF Worker.
 *
 * Flow:
 *   1. Decrypt embed using native AnimeKai cipher
 *   2. Decode }XX URL encoding
 *   3. Parse the result (JSON or direct URL)
 *   4. If MegaUp embed URL → try CF direct fetch of /media/ endpoint
 *   5. Return stream URL
 */
async function extractStreamLocally(
  encryptedEmbed: string,
  env: Env,
  logger: ReturnType<typeof createLogger>,
  proxyOrigin: string,
): Promise<{ success: boolean; streamUrl?: string; skip?: { intro?: [number, number]; outro?: [number, number] }; error?: string }> {
  try {
    // Step 1: Decrypt the embed
    let decrypted = decryptAnimeKai(encryptedEmbed);
    if (!decrypted) {
      return { success: false, error: 'Failed to decrypt AnimeKai embed' };
    }

    // Step 2: Decode }XX format (AnimeKai's custom URL encoding)
    decrypted = decrypted.replace(/}([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );

    logger.debug('Decrypted embed', { decrypted: decrypted.substring(0, 200) });

    // Step 3: Parse the decrypted data
    let streamUrl = '';
    let skipIntro: [number, number] | undefined;
    let skipOutro: [number, number] | undefined;

    try {
      const streamData = JSON.parse(decrypted);

      // Extract skip markers
      if (streamData.skip?.intro) skipIntro = streamData.skip.intro;
      if (streamData.skip?.outro) skipOutro = streamData.skip.outro;

      // Extract URL
      if (streamData.url) {
        streamUrl = streamData.url;
      } else if (streamData.sources?.[0]) {
        streamUrl = streamData.sources[0].url || streamData.sources[0].file || '';
      } else if (streamData.file) {
        streamUrl = streamData.file;
      }
    } catch {
      // Not JSON — might be a direct URL
      if (decrypted.startsWith('http')) {
        streamUrl = decrypted;
      } else {
        return { success: false, error: `Decrypted data is not JSON or URL: ${decrypted.substring(0, 100)}` };
      }
    }

    if (!streamUrl) {
      return { success: false, error: 'No stream URL in decrypted data' };
    }

    logger.info('Extracted URL from decrypted embed', { url: streamUrl.substring(0, 80) });

    // Step 4: If this is a MegaUp embed URL (/e/...), fetch the actual stream
    if (streamUrl.includes('megaup') && streamUrl.includes('/e/')) {
      logger.info('Detected MegaUp embed, fetching /media/ endpoint...');

      const hlsUrl = await fetchMegaUpMediaFromCF(streamUrl, env, logger);
      if (hlsUrl) {
        streamUrl = hlsUrl;
        logger.info('MegaUp extraction succeeded', { url: streamUrl.substring(0, 80) });
      } else {
        // MegaUp fetch failed — return the embed URL so the client can try
        // through the stream proxy (which also tries CF direct first)
        logger.warn('MegaUp /media/ fetch failed from CF, returning embed URL for stream proxy fallback');
        // Don't fail — let the client handle it through stream proxy
      }
    } else if (streamUrl.includes('/e/') && !streamUrl.includes('.m3u8') && !streamUrl.includes('.mp4')) {
      // Generic embed URL — try to extract
      logger.info('Detected generic embed URL, attempting extraction...');
      const hlsUrl = await fetchMegaUpMediaFromCF(streamUrl, env, logger);
      if (hlsUrl) {
        streamUrl = hlsUrl;
      }
    }

    return {
      success: true,
      streamUrl,
      skip: (skipIntro || skipOutro) ? { intro: skipIntro, outro: skipOutro } : undefined,
    };
  } catch (error) {
    logger.error('Local extraction error', error as Error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Try to fetch MegaUp /media/{videoId} directly from CF Worker.
 * MegaUp CDN blocks datacenter IPs, but we try with appropriate headers.
 * Falls back to RPI /fetch-rust if configured and direct fails.
 */
async function fetchMegaUpMediaFromCF(
  embedUrl: string,
  env: Env,
  logger: ReturnType<typeof createLogger>,
): Promise<string | null> {
  try {
    // Extract video ID from embed URL: https://megaup22.online/e/videoId
    const urlMatch = embedUrl.match(/https?:\/\/([^\/]+)\/e\/([^\/\?]+)/);
    if (!urlMatch) {
      logger.warn('Invalid MegaUp embed URL format', { url: embedUrl });
      return null;
    }

    const [, host, videoId] = urlMatch;
    const mediaUrl = `https://${host}/media/${videoId}`;

    logger.info('Fetching MegaUp /media/ from CF', { mediaUrl: mediaUrl.substring(0, 80) });

    // Try CF direct — no Referer (MegaUp blocks it), no Origin
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
    };

    let response: Response | null = null;

    // Attempt 1: Direct CF fetch
    try {
      response = await fetch(mediaUrl, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      logger.debug('CF direct MegaUp fetch failed', { error: (e as Error).message });
    }

    // Attempt 2: RPI /fetch-rust fallback
    if ((!response || !response.ok) && env.RPI_PROXY_URL && env.RPI_PROXY_KEY) {
      logger.info('CF direct failed, trying RPI rust-fetch for MegaUp /media/');
      try {
        let rpiBase = env.RPI_PROXY_URL.replace(/\/+$/, '');
        if (!rpiBase.startsWith('http')) rpiBase = `https://${rpiBase}`;

        const rustParams = new URLSearchParams({
          url: mediaUrl,
          headers: JSON.stringify(headers),
          timeout: '30',
        });
        const rustUrl = `${rpiBase}/fetch-rust?${rustParams.toString()}`;

        const rustRes = await fetch(rustUrl, {
          headers: { 'X-API-Key': env.RPI_PROXY_KEY },
          signal: AbortSignal.timeout(20000),
        });

        if (rustRes.ok) {
          response = rustRes;
          logger.info('RPI rust-fetch succeeded for MegaUp /media/');
        }
      } catch (e) {
        logger.debug('RPI rust-fetch also failed', { error: (e as Error).message });
      }
    }

    if (!response || !response.ok) {
      logger.warn('All MegaUp /media/ fetch strategies failed', {
        status: response?.status,
      });
      return null;
    }

    // Parse MegaUp /media/ response
    const mediaData = await response.json() as { status?: number; result?: string };
    if (mediaData.status !== 200 || !mediaData.result) {
      logger.warn('MegaUp /media/ returned unexpected data', { status: mediaData.status });
      return null;
    }

    // MegaUp decryption requires enc-dec.app (keystream is video-specific).
    // We can't do it natively. Return the encrypted result — the client
    // must handle MegaUp decryption via enc-dec.app or its own crypto.
    // For now, the stream URL is embedded in the decrypted result.
    // Actually: we need to call enc-dec.app for MegaUp decryption.
    // As a fallback, return null so the caller falls through to RPI.
    logger.warn('MegaUp /media/ fetched but decryption requires enc-dec.app — deferring to RPI');
    return null;

  } catch (error) {
    logger.error('MegaUp media fetch error', error as Error);
    return null;
  }
}

/**
 * Full extraction pipeline — local in CF Worker.
 * Fetches from AnimeKai API directly (AnimeKai doesn't block CF IPs).
 */
async function fullExtractLocally(
  kaiId: string,
  episode: string,
  env: Env,
  logger: ReturnType<typeof createLogger>,
  proxyOrigin: string,
): Promise<{ success: boolean; streamUrl?: string; skip?: { intro?: [number, number]; outro?: [number, number] }; error?: string }> {
  try {
    // For full extraction, we need the encrypt function too.
    // Since we only have decrypt available, we'll use RPI for the full pipeline.
    // The /extract endpoint handles individual embed decryption.
    logger.info('Full extraction requires encrypt — use /animekai/extract for individual embeds');
    return { success: false, error: 'Full extraction requires RPI for encrypt+fetch pipeline. Use /animekai/extract with the encrypted embed instead.' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export default {
  fetch: handleAnimeKaiRequest,
};
