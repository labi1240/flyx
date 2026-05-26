/**
 * Stream Extract API - Multi-Provider Stream Extraction
 * 
 * Rewritten to use ProviderRegistry for provider discovery and dispatch.
 * Preserves existing rate limiting, caching, deduplication, and response format.
 * 
 * Requirements: 5.1, 5.2, 5.3, 5.4, 8.1
 * 
 * GET /api/stream/extract?tmdbId=550&type=movie
 * GET /api/stream/extract?tmdbId=1396&type=tv&season=1&episode=1
 * GET /api/stream/extract?tmdbId=507089&type=movie&provider=vidlink
 */

import { NextRequest, NextResponse } from 'next/server';
import type { ExtractionRequest } from '@/app/lib/providers/types';
import { isAnimeContent } from '@/app/lib/services/animekai-extractor';
import { AllProvidersFailedError } from '@/app/lib/stream-errors';
import { performanceMonitor } from '@/app/lib/utils/performance-monitor';
import { getStreamProxyUrl, getAnimeKaiProxyUrl, getFlixerStreamProxyUrl, getVidSrcStreamProxyUrl, get1moviesStreamProxyUrl, getPrimeSrcStreamProxyUrl, getBingeBoxStreamProxyUrl, isMegaUpCdnUrl, is1moviesCdnUrl, isAnimeKaiSource } from '@/app/lib/proxy-config';

// Lazy-load registry to prevent module-load crashes on CF Pages runtime.
// If any provider import fails (e.g., Node.js APIs), the whole module would crash
// without this lazy loading pattern.
let _registry: any = null;
let _registryLoadAttempted = false;

function getRegistryInstance() {
  if (_registry) return _registry;
  if (_registryLoadAttempted) return _registry; // already tried, return null
  _registryLoadAttempted = true;
  try {
    // Dynamic require to catch import-time errors
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@/app/lib/providers');
    _registry = mod.registry;
    console.log(`[EXTRACT] Registry loaded: ${_registry.getAllEnabled().length} enabled providers: ${_registry.getAllEnabled().map((p: any) => p.name).join(', ')}`);
  } catch (err) {
    console.error(`[EXTRACT] Registry failed to load:`, err instanceof Error ? err.message : err);
    _registry = null;
  }
  return _registry;
}

// Wrapper that provides a safe registry interface — falls back to direct extractor calls
const registry = {
  get(name: string) {
    const reg = getRegistryInstance();
    return reg?.get(name) ?? null;
  },
  getAllEnabled() {
    const reg = getRegistryInstance();
    if (reg) return reg.getAllEnabled();
    // Fallback: return empty array — extractWithFallback will use directExtract
    return [];
  },
  getForContent(mediaType: string, metadata?: any) {
    const reg = getRegistryInstance();
    if (reg) return reg.getForContent(mediaType, metadata);
    return [];
  },
};

// ============================================================================
// RATE LIMITING & ANTI-ABUSE
// ============================================================================
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30; // 30 requests per minute per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function getClientIP(request: NextRequest): string {
  const cfIP = request.headers.get('cf-connecting-ip');
  if (cfIP) return cfIP;
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  const realIP = request.headers.get('x-real-ip');
  if (realIP) return realIP;
  return 'unknown';
}

function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (rateLimitMap.size > 10000) {
    for (const [key, value] of rateLimitMap.entries()) {
      if (value.resetAt < now) rateLimitMap.delete(key);
    }
  }

  if (!record || record.resetAt < now) {
    const resetAt = now + RATE_LIMIT_WINDOW;
    rateLimitMap.set(ip, { count: 1, resetAt });
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1, resetAt };
  }

  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0, resetAt: record.resetAt };
  }

  record.count++;
  return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - record.count, resetAt: record.resetAt };
}

// ============================================================================
// PROXY URL HELPER
// ============================================================================
function maybeProxyUrl(source: any, provider: string): string {
  if (!source.url) return '';
  // Only proxy if requiresSegmentProxy is true (default behavior for most sources)
  if (source.requiresSegmentProxy === false) {
    return source.url; // Return direct URL - browser will fetch directly
  }

  // Skip wrapping if URL is already proxied through our CF Worker
  if (source.url.includes('/bingebox/stream') ||
      source.url.includes('/flixer/stream') ||
      source.url.includes('/animekai') ||
      source.url.includes('/hianime/') ||
      source.url.includes('/vidsrc/') ||
      source.url.includes('/primesrc/') ||
      source.url.includes('/stream?url=') ||
      source.url.includes('media-proxy.vynx-3b3.workers.dev')) {
    return source.url;
  }

  try {
    // These providers/CDNs block datacenter IPs (Cloudflare, AWS, etc.)
    // They MUST go through /animekai route -> proxying
    const isAnimeKai = provider === 'animekai';
    const isAnimeKaiSrc = isAnimeKaiSource(source);
    const isMegaUpCdn = isMegaUpCdnUrl(source.url);
    const is1moviesCdn = is1moviesCdnUrl(source.url);
    const is1movies = provider === '1movies';
    const isPrimeSrc = provider === 'primesrc';
    const isBingeBox = provider === 'bingebox';
    const isFlixer = provider === 'flixer';
    const isUflix = provider === 'uflix';
    const isMultiEmbed = provider === 'multi-embed' || provider === 'multiembed' || provider === 'hexa';
    const isVidSrc = provider === 'vidsrc';

    // BingeBox: HLS streams proxied through /bingebox/stream on CF Worker
    if (isBingeBox) {
      return getBingeBoxStreamProxyUrl(source.url);
    }

    // PrimeSrc: streams proxied through /primesrc/stream on CF Worker (no RPI needed)
    if (isPrimeSrc) {
      return getPrimeSrcStreamProxyUrl(source.url);
    }

    // Route through provider-specific proxy for CDNs that block datacenter IPs
    if (isFlixer) {
      return getFlixerStreamProxyUrl(source.url);
    }
    if (isAnimeKai || isAnimeKaiSrc || isMegaUpCdn) {
      return getAnimeKaiProxyUrl(source.url);
    }
    if (isUflix) {
      // Uflix returns embed URLs — no proxying needed
      return source.url;
    }
    if (isVidSrc) {
      return getVidSrcStreamProxyUrl(source.url, source.referer);
    }
    if (is1moviesCdn || is1movies) {
      return get1moviesStreamProxyUrl(source.url);
    }
    if (isMultiEmbed) {
      return getAnimeKaiProxyUrl(source.url);
    }

    // Other sources use the standard /stream route
    return getStreamProxyUrl(source.url, provider, source.referer, source.skipOrigin || false);
  } catch (err) {
    console.error(`[EXTRACT] maybeProxyUrl error for ${provider}:`, err instanceof Error ? err.message : err);
    // Fallback: use getAnimeKaiProxyUrl which has hardcoded fallback
    return getAnimeKaiProxyUrl(source.url);
  }
}

// ============================================================================
// CACHE & DEDUPLICATION
// ============================================================================
const cache = new Map<string, { sources: any[]; timestamp: number; hits: number }>();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const MAX_CACHE_SIZE = 500;
const pendingRequests = new Map<string, Promise<any>>();

function evictOldestCacheEntry() {
  if (cache.size < MAX_CACHE_SIZE) return;
  let oldestKey = '';
  let oldestTime = Date.now();
  let lowestHits = Infinity;
  for (const [key, value] of cache.entries()) {
    if (value.timestamp < oldestTime || (value.timestamp === oldestTime && value.hits < lowestHits)) {
      oldestTime = value.timestamp;
      lowestHits = value.hits;
      oldestKey = key;
    }
  }
  if (oldestKey) cache.delete(oldestKey);
}

// ============================================================================
// RESPONSE HELPERS
// ============================================================================
function formatSources(sources: any[], provider: string) {
  return sources.map((source: any) => ({
    quality: source.quality,
    title: source.title || source.quality,
    url: maybeProxyUrl(source, provider),
    directUrl: source.url || '',
    referer: source.referer,
    type: source.type,
    requiresSegmentProxy: source.requiresSegmentProxy,
    status: source.status || 'working',
    language: source.language || 'en',
    skipIntro: source.skipIntro,
    skipOutro: source.skipOutro,
  }));
}

function buildSuccessResponse(sources: any[], provider: string, opts: {
  cached?: boolean;
  cacheHits?: number;
  deduplicated?: boolean;
  executionTime: number;
}) {
  const proxiedSources = formatSources(sources, provider);
  return NextResponse.json({
    success: true,
    sources: proxiedSources,
    streamUrl: proxiedSources[0]?.url || '',
    url: proxiedSources[0]?.url || '',
    provider,
    requiresProxy: true,
    requiresSegmentProxy: true,
    cached: opts.cached || false,
    ...(opts.cacheHits !== undefined && { cacheHits: opts.cacheHits }),
    ...(opts.deduplicated && { deduplicated: true }),
    executionTime: opts.executionTime,
  }, {
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    },
  });
}


// ============================================================================
// PROVIDER NAME MAPPING (backward compat: 'hexa' → 'multi-embed', etc.)
// ============================================================================
const PROVIDER_ALIASES: Record<string, string> = {
  'hexa': 'flixer',
  'multiembed': 'multi-embed',
};

function resolveProviderName(name: string): string {
  return PROVIDER_ALIASES[name] || name;
}

/**
 * Get the list of valid provider names for validation.
 * Includes all registered providers plus known aliases.
 */
function getValidProviderNames(): string[] {
  const registeredNames = Array.from(
    new Set([
      ...registry.getAllEnabled().map((p: any) => p.name),
      // Include disabled providers too — they can be explicitly requested
      'flixer', 'animekai', 'hianime', 'vidsrc', 'primesrc',
      'dlhd', 'viprow', 'ppv', 'cdn-live', 'iptv', 'ntv', 'miruro', 'moviebox', 'bingebox', 'ufreetv', 'globetv',
    ])
  );
  return ['auto', ...registeredNames, ...Object.keys(PROVIDER_ALIASES)];
}

// ============================================================================
// MAIN HANDLER
// ============================================================================
export async function GET(request: NextRequest) {
  const startTime = Date.now();

  try {
    // Rate limiting
    const clientIP = getClientIP(request);
    const rateLimit = checkRateLimit(clientIP);

    if (!rateLimit.allowed) {
      console.warn(`[EXTRACT] Rate limit exceeded for IP: ${clientIP}`);
      return NextResponse.json(
        {
          error: 'Too many requests',
          message: 'Rate limit exceeded. Please wait before making more requests.',
          retryAfter: Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
        },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': RATE_LIMIT_MAX_REQUESTS.toString(),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': rateLimit.resetAt.toString(),
            'Retry-After': Math.ceil((rateLimit.resetAt - Date.now()) / 1000).toString(),
            'Cache-Control': 'no-store',
          },
        }
      );
    }

    const searchParams = request.nextUrl.searchParams;

    // Parse parameters
    const tmdbId = searchParams.get('tmdbId') || '';
    const type = searchParams.get('type') as 'movie' | 'tv';
    const title = searchParams.get('title') || '';
    const season = searchParams.get('season') ? parseInt(searchParams.get('season')!) : undefined;
    let episode = searchParams.get('episode') ? parseInt(searchParams.get('episode')!) : undefined;
    const originalEpisode = episode;
    const providerParam = searchParams.get('provider') || 'auto';
    const sourceName = searchParams.get('source');
    // Cap.js PoW token solved by the browser — forwarded to CF Worker.
    // Prefer header over query param (query params leak into logs/history).
    // Cap tokens are JWTs (~200-500 chars); reject anything oversized or with suspicious chars.
    const rawCapToken = request.headers.get('x-cap-token') || searchParams.get('capToken') || undefined;
    const capToken = rawCapToken && rawCapToken.length <= 2048 && /^[A-Za-z0-9._\-]+$/.test(rawCapToken)
      ? rawCapToken
      : undefined;

    // MAL info for anime
    let malId = searchParams.get('malId') ? parseInt(searchParams.get('malId')!) : undefined;
    let malTitle = searchParams.get('malTitle') || undefined;

    // ========================================================================
    // INPUT VALIDATION
    // ========================================================================
    if (!tmdbId || !/^\d+$/.test(tmdbId)) {
      return NextResponse.json(
        { error: 'Invalid tmdbId format. Must be a positive integer.' },
        { status: 400 }
      );
    }

    if (tmdbId === '0' && !malId) {
      return NextResponse.json(
        { error: 'malId is required when tmdbId is 0 (MAL-direct anime streaming)' },
        { status: 400 }
      );
    }

    if (!type || !['movie', 'tv'].includes(type)) {
      return NextResponse.json(
        { error: 'Invalid or missing type (must be "movie" or "tv")' },
        { status: 400 }
      );
    }

    const isMalDirectMovie = tmdbId === '0' && malId && type === 'movie';
    if (type === 'tv' && !isMalDirectMovie) {
      if (!season || season < 0 || season > 100) {
        return NextResponse.json(
          { error: 'Invalid season number (must be between 1-100)' },
          { status: 400 }
        );
      }
      if (!episode || episode < 0 || episode > 1000) {
        return NextResponse.json(
          { error: 'Invalid episode number (must be between 1-1000)' },
          { status: 400 }
        );
      }
    }

    const validProviders = getValidProviderNames();
    if (!validProviders.includes(providerParam)) {
      return NextResponse.json(
        { error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` },
        { status: 400 }
      );
    }

    if (sourceName && (sourceName.length > 100 || /[<>\"']/.test(sourceName))) {
      return NextResponse.json(
        { error: 'Invalid source name format' },
        { status: 400 }
      );
    }

    // ========================================================================
    // ABSOLUTE EPISODE NUMBERING (JJK, etc.)
    // ========================================================================
    if (type === 'tv' && episode && !malId) {
      const { malService } = await import('@/lib/services/mal');
      const tmdbIdNum = parseInt(tmdbId);

      if (malService.usesAbsoluteEpisodeNumbering(tmdbIdNum)) {
        const malEntry = malService.getMALEntryForAbsoluteEpisode(tmdbIdNum, episode);
        if (malEntry) {
          const isJJK = tmdbIdNum === 95479;
          if (isJJK || process.env.NODE_ENV === 'development' || process.env.DEBUG_MAL === 'true') {
            console.log('[EXTRACT] *** MAL ABSOLUTE EPISODE CONVERSION ***', {
              tmdbId, originalEpisode: episode,
              converted: { malId: malEntry.malId, malTitle: malEntry.malTitle, relativeEpisode: malEntry.relativeEpisode },
            });
          }
          malId = malEntry.malId;
          malTitle = malEntry.malTitle;
          episode = malEntry.relativeEpisode;
        }
      }
    }

    console.log('[EXTRACT] Request:', { tmdbId, type, season, episode, provider: providerParam, sourceName, malId, malTitle });

    // GUARD: Reject TMDB-dependent providers when tmdbId=0 (MAL-direct anime)
    // These providers (flixer, vidlink, vidsrc, etc.) need a real TMDB ID to work
    const tmdbDependentProviders = ['flixer', 'vidsrc', '1movies', 'primesrc', 'moviebox', 'bingebox'];
    if (tmdbId === '0' && tmdbDependentProviders.includes(providerParam)) {
      return NextResponse.json(
        { error: `${providerParam} requires a real TMDB ID (tmdbId=0 is MAL-direct anime)`, success: false },
        { status: 400 }
      );
    }

    performanceMonitor.start('stream-extraction');

    // Resolve provider alias
    const resolvedProvider = providerParam === 'auto' ? 'auto' : resolveProviderName(providerParam);

    // Build ExtractionRequest
    const extractionRequest: ExtractionRequest = {
      tmdbId,
      mediaType: type,
      title: title || malTitle || '',
      season,
      episode,
      malId,
      malTitle: malTitle || title,
      capToken,
    };

    // ========================================================================
    // FETCH SPECIFIC SOURCE BY NAME (no cache)
    // ========================================================================
    if (sourceName) {
      return await handleSourceByName(sourceName, resolvedProvider, extractionRequest, startTime);
    }

    // ========================================================================
    // CACHE CHECK
    // ========================================================================
    const cacheKey = malId
      ? `mal-${malId}-${type}-${originalEpisode || ''}-${providerParam}`
      : `${tmdbId}-${type}-${season || ''}-${originalEpisode || ''}-${providerParam}`;

    let cached_entry = cache.get(cacheKey);

    // Temporary cache clears for specific providers
    if ((providerParam === 'animekai' || providerParam === '1movies' || tmdbId === '95479') && cached_entry) {
      cache.delete(cacheKey);
      cached_entry = undefined;
    }

    if (cached_entry && Date.now() - cached_entry.timestamp < CACHE_TTL && cached_entry.sources.length > 0 && cached_entry.sources[0]?.url) {
      cached_entry.hits++;
      cached_entry.timestamp = Date.now();
      return buildSuccessResponse(cached_entry.sources, providerParam, {
        cached: true,
        cacheHits: cached_entry.hits,
        executionTime: Date.now() - startTime,
      });
    }

    // ========================================================================
    // DEDUPLICATION
    // ========================================================================
    if (pendingRequests.has(cacheKey)) {
      console.log('[EXTRACT] Waiting for existing request to complete...');
      const sources = await pendingRequests.get(cacheKey)!;
      return buildSuccessResponse(sources, providerParam, {
        deduplicated: true,
        executionTime: Date.now() - startTime,
      });
    }

    // ========================================================================
    // ANIME DETECTION
    // ========================================================================
    let isAnime = tmdbId === '0' && malId ? true : false;
    if (!isAnime && providerParam !== 'animekai') {
      isAnime = await isAnimeContent(tmdbId, type);
      if (isAnime) console.log('[EXTRACT] Detected ANIME content');
    }

    // ========================================================================
    // EXTRACTION via ProviderRegistry
    // ========================================================================
    const extractionPromise = (async () => {
      // Explicit provider request → delegate directly
      if (resolvedProvider !== 'auto') {
        return await extractFromSpecificProvider(resolvedProvider, extractionRequest);
      }

      // Auto mode: iterate providers in priority order
      return await extractWithFallback(extractionRequest, type, isAnime);
    })();

    // Store in pending requests for deduplication — add .catch to prevent unhandled rejection
    const sourcesPromise = extractionPromise.then(r => r.sources);
    sourcesPromise.catch(() => {}); // Prevent unhandled rejection warning
    pendingRequests.set(cacheKey, sourcesPromise);

    try {
      const result = await extractionPromise;
      pendingRequests.delete(cacheKey);

      evictOldestCacheEntry();
      if (result.sources.length > 0 && result.sources[0]?.url) {
        cache.set(cacheKey, { sources: result.sources, timestamp: Date.now(), hits: 1 });
      }

      const executionTime = Date.now() - startTime;
      performanceMonitor.end('stream-extraction', {
        tmdbId, type, sources: result.sources.length, cached: false, provider: result.provider,
      });
      console.log(`[EXTRACT] Success in ${executionTime}ms - ${result.sources.length} qualities via ${result.provider}`);

      return buildSuccessResponse(result.sources, result.provider, { executionTime });
    } catch (error) {
      pendingRequests.delete(cacheKey);
      throw error;
    }

  } catch (error) {
    const executionTime = Date.now() - startTime;
    console.error('[EXTRACT] ERROR:', error);

    const errorMessage = error instanceof Error ? error.message : String(error);
    const isCloudflareBlock = errorMessage.includes('Cloudflare') || errorMessage.includes('anti-bot') || errorMessage.includes('unavailable');
    const isDecoderFailed = errorMessage.includes('decoder') || errorMessage.includes('decoding');
    const isAllProvidersFailed = errorMessage.includes('All providers failed');

    // Build error response — include attempts if available
    const errorBody: any = {
      error: isDecoderFailed ? 'Stream extraction temporarily unavailable'
        : isAllProvidersFailed ? 'No streams available'
        : isCloudflareBlock ? 'Stream source temporarily unavailable'
        : 'Failed to extract stream',
      details: errorMessage,
      suggestion: isDecoderFailed ? 'The stream provider has updated their protection. This will be fixed soon.'
        : isAllProvidersFailed ? 'This content may not be available from any provider at the moment.'
        : isCloudflareBlock ? 'The stream provider is currently blocking automated requests. Please try again in a few minutes.'
        : 'Please try again or select a different title.',
      executionTime,
      isTemporary: true,
    };

    // Attach aggregated attempts if this is an AllProvidersFailed error
    if (error instanceof AllProvidersFailedError) {
      errorBody.attempts = error.attempts;
    }

    return NextResponse.json(errorBody, {
      status: 503,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  }
}


// ============================================================================
// EXTRACTION HELPERS
// ============================================================================

/**
 * Extract from a specific provider by name via the registry.
 * Falls back to direct extractor calls if registry is unavailable.
 * Requirement 5.2: delegate directly to that provider's extract method.
 */
async function extractFromSpecificProvider(
  providerName: string,
  request: ExtractionRequest,
): Promise<{ sources: any[]; provider: string }> {
  const provider = registry.get(providerName);
  if (!provider) {
    // Fallback: try direct extractor call
    console.log(`[EXTRACT] Provider "${providerName}" not in registry, trying direct extractor...`);
    return await directExtract(providerName, request);
  }
  if (!provider.enabled) {
    throw new Error(`Provider "${providerName}" is disabled`);
  }

  console.log(`[EXTRACT] Using ${provider.name} (explicit request)...`);
  
  let result;
  try {
    result = await provider.extract(request);
  } catch (extractError) {
    const msg = extractError instanceof Error ? extractError.message : String(extractError);
    console.error(`[EXTRACT] ${provider.name} extract() threw:`, msg);
    throw new Error(`${provider.name} extraction threw: ${msg}`);
  }

  console.log(`[EXTRACT] ${provider.name} result: success=${result.success}, sources=${result.sources.length}, error=${result.error || 'none'}`);

  if (result.success && result.sources.length > 0) {
    console.log(`[EXTRACT] ✓ ${provider.name}: ${result.sources.length} sources`);
    return { sources: result.sources, provider: provider.name };
  }

  throw new Error(result.error || `${provider.name} returned no sources`);
}

/**
 * Extract with fallback: iterate providers in priority order.
 * Requirements 5.3, 5.5: iterate in priority order, aggregate errors on total failure.
 */
async function extractWithFallback(
  request: ExtractionRequest,
  mediaType: 'movie' | 'tv',
  isAnime: boolean,
): Promise<{ sources: any[]; provider: string }> {
  const metadata = { isAnime };
  const providers = registry.getForContent(mediaType, metadata);

  console.log(`[EXTRACT] getForContent('${mediaType}', isAnime=${isAnime}): ${providers.map((p: any) => `${p.name}(${p.priority})`).join(', ') || 'NONE'}`);

  // For anime, also include general movie/tv providers as fallback
  let allProviders = [...providers];
  if (isAnime) {
    const generalProviders = registry.getForContent(mediaType);
    for (const gp of generalProviders) {
      if (!allProviders.some(p => p.name === gp.name)) {
        allProviders.push(gp);
      }
    }
    console.log(`[EXTRACT] With anime fallbacks: ${allProviders.map(p => p.name).join(', ')}`);
  }

  if (allProviders.length === 0) {
    // Registry empty or failed to load — fall back to direct extractor calls
    console.log(`[EXTRACT] No registry providers, falling back to direct extractors...`);
    return await directExtractWithFallback(request, mediaType, isAnime);
  }

  const attempts: { provider: string; error: string }[] = [];

  for (const provider of allProviders) {
    try {
      console.log(`[EXTRACT] Trying ${provider.name} (priority ${provider.priority})...`);
      const result = await provider.extract(request);

      console.log(`[EXTRACT] ${provider.name} result: success=${result.success}, sources=${result.sources.length}, error=${result.error || 'none'}`);

      if (result.success && result.sources.length > 0) {
        const workingSources = result.sources.filter((s: any) => !s.status || s.status === 'working');
        if (workingSources.length > 0) {
          console.log(`[EXTRACT] ✓ ${provider.name}: ${workingSources.length} working sources`);
          return { sources: result.sources, provider: provider.name };
        }
        // Sources exist but none are "working" yet (all unknown/down) — still return them
        // so the player can show them in the server menu for lazy-fetching on click
        console.log(`[EXTRACT] ${provider.name}: ${result.sources.length} sources (0 working, returning for lazy-fetch)`);
        return { sources: result.sources, provider: provider.name };
      }

      const errorMsg = result.error || 'No working sources';
      console.log(`[EXTRACT] ${provider.name}: ${errorMsg}`);
      attempts.push({ provider: provider.name, error: errorMsg });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[EXTRACT] ${provider.name} error: ${errorMsg}`);
      attempts.push({ provider: provider.name, error: errorMsg });
    }
  }

  console.log('[EXTRACT] All providers failed:', JSON.stringify(attempts));
  throw new AllProvidersFailedError(attempts);
}

/**
 * Direct extractor fallback — bypasses registry entirely.
 * Used when the registry fails to load on CF Pages runtime.
 */
async function directExtract(
  providerName: string,
  request: ExtractionRequest,
): Promise<{ sources: any[]; provider: string }> {
  console.log(`[EXTRACT] Direct extract: ${providerName}`);
  try {
    switch (providerName) {
      case 'flixer': {
        const { extractFlixerStreams } = await import('@/app/lib/services/flixer-extractor');
        const result = await extractFlixerStreams(request.tmdbId, request.mediaType, request.season, request.episode, request.capToken);
        if (result.success && result.sources.length > 0) {
          return { sources: result.sources.map(s => ({ ...s, requiresSegmentProxy: s.requiresSegmentProxy ?? true })), provider: 'flixer' };
        }
        throw new Error(result.error || 'Hexa returned no sources');
      }
      case 'uflix': {
        const { extractUflixStreams } = await import('@/app/lib/services/uflix-extractor');
        const result = await extractUflixStreams(request.tmdbId, request.mediaType, request.season, request.episode);
        if (result.success && result.sources.length > 0) {
          return { sources: result.sources.map(s => ({ ...s, requiresSegmentProxy: s.requiresSegmentProxy ?? false })), provider: 'uflix' };
        }
        throw new Error(result.error || 'Uflix returned no sources');
      }
      case 'vidsrc': {
        const { extractVidSrcStreams } = await import('@/app/lib/services/vidsrc-extractor');
        const result = await extractVidSrcStreams(request.tmdbId, request.mediaType, request.season, request.episode);
        if (result.success && result.sources.length > 0) {
          return { sources: result.sources.map(s => ({ ...s, requiresSegmentProxy: s.requiresSegmentProxy ?? true })), provider: 'vidsrc' };
        }
        throw new Error(result.error || 'VidSrc returned no sources');
      }
      case 'animekai': {
        const { extractAnimeKaiStreams } = await import('@/app/lib/services/animekai-extractor');
        const result = await extractAnimeKaiStreams(request.tmdbId, request.mediaType, request.season, request.episode, request.malId, request.malTitle);
        if (result.success && result.sources.length > 0) {
          return { sources: result.sources.map(s => ({ ...s, requiresSegmentProxy: s.requiresSegmentProxy ?? true })), provider: 'animekai' };
        }
        throw new Error(result.error || 'AnimeKai returned no sources');
      }
      case 'hianime': {
        const { extractHiAnimeStreams } = await import('@/app/lib/services/hianime-extractor');
        if (!request.malId || !request.title) throw new Error('HiAnime requires malId and title');
        const result = await extractHiAnimeStreams(request.malId, request.title, request.episode);
        if (result.success && result.sources.length > 0) {
          return { sources: result.sources.map(s => ({ ...s, requiresSegmentProxy: s.requiresSegmentProxy ?? true })), provider: 'hianime' };
        }
        throw new Error(result.error || 'HiAnime returned no sources');
      }
      case 'miruro': {
        const { extractMiruroStreams } = await import('@/app/lib/services/miruro-extractor');
        if (!request.malId && !request.malTitle) throw new Error('Miruro requires malId or malTitle');
        const result = await extractMiruroStreams(
          request.malId || 0,
          request.malTitle || request.title || '',
          request.episode,
        );
        if (result.success && result.sources.length > 0) {
          return { sources: result.sources.map(s => ({ ...s, requiresSegmentProxy: s.requiresSegmentProxy ?? true })), provider: 'miruro' };
        }
        throw new Error(result.error || 'Miruro returned no sources');
      }
      case 'moviebox': {
        const { extractMovieBoxStreams } = await import('@/app/lib/services/moviebox-extractor');
        const result = await extractMovieBoxStreams(request.tmdbId, request.mediaType, request.season, request.episode, request.title || request.malTitle);
        if (result.success && result.sources.length > 0) {
          return { sources: result.sources.map(s => ({ ...s, requiresSegmentProxy: s.requiresSegmentProxy ?? false })), provider: 'moviebox' };
        }
        throw new Error(result.error || 'MovieBox returned no sources');
      }
      case 'bingebox': {
        const { extractBingeBoxStreams } = await import('@/app/lib/services/bingebox-extractor');
        const result = await extractBingeBoxStreams(
          request.tmdbId,
          request.mediaType,
          request.title || request.malTitle || '',
          undefined,
          request.season,
          request.episode,
        );
        if (result.success && result.sources.length > 0) {
          return { sources: result.sources, provider: 'bingebox' };
        }
        throw new Error(result.error || 'BingeBox returned no sources');
      }
      case 'multi-embed': {
        const { extractMultiEmbedStreams } = await import('@/app/lib/services/multi-embed-extractor');
        const result = await extractMultiEmbedStreams(request.tmdbId, request.mediaType, request.season, request.episode);
        if (result.success && result.sources.length > 0) {
          return { sources: result.sources.map(s => ({ ...s, requiresSegmentProxy: s.requiresSegmentProxy ?? true })), provider: 'multi-embed' };
        }
        throw new Error(result.error || 'MultiEmbed returned no sources');
      }
      case 'primesrc': {
        const { extractPrimeSrcStreams } = await import('@/app/lib/services/primesrc-extractor');
        const result = await extractPrimeSrcStreams(request.tmdbId, request.mediaType, request.season, request.episode);
        if (result.success && result.sources.length > 0) {
          return { sources: result.sources.map(s => ({ ...s, requiresSegmentProxy: s.requiresSegmentProxy ?? true })), provider: 'primesrc' };
        }
        throw new Error(result.error || 'PrimeSrc returned no sources');
      }
      case 'videasy': {
        if (!request.title) throw new Error('Videasy requires title');
        const { extractVideasyStreams } = await import('@/app/lib/services/videasy-extractor');
        const result = await extractVideasyStreams(request.tmdbId, request.mediaType, request.title, request.season, request.episode);
        if (result.success && result.sources.length > 0) {
          return { sources: result.sources.map(s => ({ ...s, requiresSegmentProxy: s.requiresSegmentProxy ?? false })), provider: 'videasy' };
        }
        throw new Error(result.error || 'Videasy returned no sources');
      }
      default:
        throw new Error(`Unknown provider: ${providerName}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[EXTRACT] Direct ${providerName} failed: ${msg}`);
    throw err;
  }
}

/**
 * Direct extractor fallback with priority-ordered iteration.
 * Used when registry is empty/broken.
 */
async function directExtractWithFallback(
  request: ExtractionRequest,
  _mediaType: 'movie' | 'tv',
  isAnime: boolean,
): Promise<{ sources: any[]; provider: string }> {
  // Priority order for anime vs movie/tv
  // Only Flixer is active for movies/TV until new sources are added
  const providerOrder = isAnime
    ? ['videasy', 'flixer', 'bingebox', 'primesrc', 'vidsrc', 'moviebox']
    : ['videasy', 'flixer', 'bingebox', 'primesrc', 'vidsrc', 'moviebox'];

  console.log(`[EXTRACT] Direct fallback order: ${providerOrder.join(', ')}`);

  const attempts: { provider: string; error: string }[] = [];

  for (const name of providerOrder) {
    try {
      const result = await directExtract(name, request);
      if (result.sources.length > 0) {
        console.log(`[EXTRACT] ✓ Direct ${name}: ${result.sources.length} sources`);
        return result;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attempts.push({ provider: name, error: msg });
    }
  }

  throw new AllProvidersFailedError(attempts);
}

/**
 * Handle fetching a specific source by name.
 * Tries to determine the right provider from the source name or explicit provider param.
 */
async function handleSourceByName(
  sourceName: string,
  providerName: string,
  request: ExtractionRequest,
  startTime: number,
): Promise<NextResponse> {
  console.log(`[EXTRACT] Fetching specific source: ${sourceName} (provider: ${providerName})`);

  // Try to infer provider from source name if not explicitly set
  let targetProvider = providerName !== 'auto' ? providerName : inferProviderFromSourceName(sourceName);

  const provider = targetProvider ? registry.get(targetProvider) : undefined;
  if (provider) {
    const source = await provider.fetchSourceByName(sourceName, request);
    if (source) {
      const executionTime = Date.now() - startTime;
      const proxiedSource = {
        quality: source.quality,
        title: source.title,
        url: maybeProxyUrl(source, provider.name),
        directUrl: source.url,
        referer: source.referer,
        type: source.type,
        requiresSegmentProxy: source.requiresSegmentProxy,
        status: 'working',
        language: source.language || 'ja',
      };

      return NextResponse.json({
        success: true,
        sources: [proxiedSource],
        streamUrl: proxiedSource.url,
        url: proxiedSource.url,
        provider: provider.name,
        requiresProxy: true,
        requiresSegmentProxy: true,
        cached: false,
        executionTime,
      });
    }
  }

  return NextResponse.json(
    { error: `Source "${sourceName}" not available`, success: false },
    { status: 404 }
  );
}

/**
 * Infer provider name from source name string.
 */
function inferProviderFromSourceName(sourceName: string): string | undefined {
  if (sourceName.includes('AnimeKai')) return 'animekai';
  if (sourceName.includes('Flixer') || sourceName.includes('Hexa')) return 'flixer';
  if (sourceName.includes('Videasy') || sourceName.includes('videasy')) return 'videasy';
  if (sourceName.includes('Miruro') || sourceName.includes('miruro')) return 'miruro';
  if (sourceName.includes('MovieBox') || sourceName.includes('moviebox')) return 'moviebox';
  if (sourceName.includes('BingeBox') || sourceName.includes('bingebox')) return 'bingebox';
  if (sourceName.includes('GlobeTV') || sourceName.includes('globetv')) return 'globetv';
  if (sourceName.includes('MultiEmbed')) return 'multi-embed';
  if (sourceName.includes('NTV') || sourceName.includes('ntv')) return 'ntv';
  if (sourceName.includes('Uflix')) return 'uflix';
  return undefined;
}

// ============================================================================
// CORS OPTIONS HANDLER
// ============================================================================
export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin');
  const allowedOrigins = [
    'https://tv.vynx.cc',
    'https://flyx.tv',
    'https://www.flyx.tv',
    process.env.NEXT_PUBLIC_APP_URL,
    'http://localhost:3000',
    'http://localhost:3001',
  ].filter(Boolean);

  const isAllowed = origin && (
    allowedOrigins.includes(origin) ||
    origin.endsWith('.pages.dev') ||
    origin.includes('localhost')
  );

  if (!isAllowed) {
    return new NextResponse(null, { status: 403 });
  }

  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}
