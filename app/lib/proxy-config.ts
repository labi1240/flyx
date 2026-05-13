/**
 * Proxy Configuration
 * 
 * REQUIRES Cloudflare Workers for stream proxying.
 * Set NEXT_PUBLIC_CF_STREAM_PROXY_URL and NEXT_PUBLIC_CF_TV_PROXY_URL env vars.
 * 
 * Live TV Proxy Options:
 *   - /tv/   - Direct fetch with RPI proxy fallback (faster, but may be blocked)
 *   - /dlhd/ - Oxylabs residential proxy (more reliable, uses residential IPs)
 * 
 * Set NEXT_PUBLIC_USE_DLHD_PROXY=true to use Oxylabs residential proxies for Live TV.
 * 
 * Cloudflare Workers are required for proper
 * stream proxying with correct headers and CORS handling.
 */

// Stream proxy for HLS streams (2embed, moviesapi, etc.)
export function getStreamProxyUrl(
  url: string,
  source: string = '2embed',
  referer: string = 'https://www.2embed.cc',
  skipOrigin: boolean = false
): string {
  // Try both NEXT_PUBLIC_ (available at build time) and server-side env var
  // Fallback to hardcoded URL for production if env vars aren't set
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL || 
                     process.env.CF_STREAM_PROXY_URL || 
                     'https://media-proxy.vynx-3b3.workers.dev/stream';
  
  // Strip trailing slash if present to avoid double slashes
  const baseUrl = cfProxyUrl.replace(/\/+$/, '');
  
  // Add noreferer param for sources that block requests with Origin header (like MegaUp CDN)
  const noRefParam = skipOrigin ? '&noreferer=true' : '';
  return `${baseUrl}?url=${encodeURIComponent(url)}&source=${source}&referer=${encodeURIComponent(referer)}${noRefParam}`;
}

// Check if DLHD proxy (Oxylabs residential) should be used for Live TV
export function useDlhdProxy(): boolean {
  return process.env.NEXT_PUBLIC_USE_DLHD_PROXY === 'true';
}

// TV proxy base URL for DLHD live streams
export function getTvProxyBaseUrl(): string {
  let cfProxyUrl = process.env.NEXT_PUBLIC_CF_TV_PROXY_URL;
  
  console.log('[proxy-config] NEXT_PUBLIC_CF_TV_PROXY_URL:', cfProxyUrl);
  
  if (!cfProxyUrl) {
    console.error('[proxy-config] NEXT_PUBLIC_CF_TV_PROXY_URL is not set! Cloudflare Worker is required.');
    throw new Error('TV proxy not configured. Set NEXT_PUBLIC_CF_TV_PROXY_URL environment variable.');
  }
  
  // Strip trailing /tv or /dlhd if present (for backwards compatibility)
  // The route is now determined by NEXT_PUBLIC_USE_DLHD_PROXY
  cfProxyUrl = cfProxyUrl.replace(/\/(tv|dlhd)\/?$/, '');
  
  return cfProxyUrl;
}

// Get TV playlist URL
// NEW: Uses the dedicated DLHD extractor worker at dlhd.vynx-3b3.workers.dev
// The /play/:channelId endpoint returns decrypted HLS streams directly
export function getTvPlaylistUrl(channel: string, backend?: string): string {
  // Use the new DLHD extractor worker - it handles everything:
  // JWT generation, M3U8 fetch, URL rewriting, segment decryption
  const dlhdWorkerUrl = process.env.NEXT_PUBLIC_DLHD_WORKER_URL || 'https://dlhd.vynx-3b3.workers.dev';
  const apiKey = process.env.NEXT_PUBLIC_DLHD_API_KEY || 'vynx';
  let url = `${dlhdWorkerUrl}/play/${channel}?key=${apiKey}`;
  
  // Add backend parameter if specified (for manual backend switching)
  if (backend) {
    url += `&backend=${encodeURIComponent(backend)}`;
  }
  
  console.log('[proxy-config] getTvPlaylistUrl (DLHD Worker):', url);
  return url;
}

// Get available backends for a channel
// SECURITY: Returns obfuscated backend IDs - actual server/domain names are NOT exposed to client
// The /play endpoint accepts these obfuscated IDs and resolves them server-side
export async function getAvailableBackends(channel: string): Promise<Array<{
  id: string;
  isPrimary: boolean;
  label: string;
  status?: 'online' | 'offline' | 'timeout' | 'unknown';
}>> {
  const dlhdWorkerUrl = process.env.NEXT_PUBLIC_DLHD_WORKER_URL || 'https://dlhd.vynx-3b3.workers.dev';
  const apiKey = process.env.NEXT_PUBLIC_DLHD_API_KEY || 'vynx';
  
  try {
    // Request with testing enabled to get online status
    // Include API key for authentication
    const response = await fetch(`${dlhdWorkerUrl}/backends/${channel}?test=true&key=${apiKey}`);
    if (!response.ok) {
      console.error('[proxy-config] Failed to fetch backends:', response.status);
      return [];
    }
    const data = await response.json();
    
    // SECURITY: The _m field contains base64-encoded mapping of obfuscated IDs to actual server.domain
    // Store this mapping for use when switching backends - resolution happens via resolveBackendId()
    if (data._m && typeof window !== 'undefined') {
      try {
        const mapping = JSON.parse(atob(data._m));
        (window as any).__dlhdBackendMapping = mapping;
      } catch (e) {
        console.error('[proxy-config] Failed to decode backend mapping:', e);
      }
    }
    
    return data.backends || [];
  } catch (error) {
    console.error('[proxy-config] Error fetching backends:', error);
    return [];
  }
}

// Resolve an obfuscated backend ID to the actual server.domain for the /play endpoint
// SECURITY: This mapping is only available after calling getAvailableBackends
// The actual server names are never exposed in the UI - only used internally for API calls
export function resolveBackendId(obfuscatedId: string): string | null {
  if (typeof window === 'undefined') return null;
  
  const mapping = (window as any).__dlhdBackendMapping;
  if (!mapping) return null;
  
  return mapping[obfuscatedId] || null;
}

// Get TV key proxy URL
// NOTE: No longer needed - DLHD worker decrypts segments server-side
// Kept for backwards compatibility but returns empty string
export function getTvKeyProxyUrl(_keyUrl: string): string {
  console.log('[proxy-config] getTvKeyProxyUrl called but not needed - DLHD worker handles decryption');
  return ''; // Not needed - server-side decryption
}

// Get TV segment proxy URL
// NOTE: No longer needed - segments go through DLHD worker's /dlhdprivate endpoint
// which is embedded in the M3U8 URLs returned by /play/:channelId
export function getTvSegmentProxyUrl(segmentUrl: string): string {
  console.log('[proxy-config] getTvSegmentProxyUrl called but not needed - DLHD worker handles segments');
  return segmentUrl; // Return as-is - M3U8 already has proxied URLs
}

// CDN-Live stream proxy URL - uses dedicated /cdn-live/stream route
// This route has proper Referer handling and URL rewriting for CDN-Live streams
export function getCdnLiveStreamProxyUrl(url: string): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL;
  
  if (!cfProxyUrl) {
    throw new Error('CDN-Live proxy not configured. Set NEXT_PUBLIC_CF_STREAM_PROXY_URL environment variable.');
  }
  
  // Strip trailing /stream suffix if present to get base URL
  const baseUrl = cfProxyUrl.replace(/\/stream\/?$/, '').replace(/\/+$/, '');
  // Use dedicated /cdn-live/stream route which has proper referer handling and URL rewriting
  return `${baseUrl}/cdn-live/stream?url=${encodeURIComponent(url)}`;
}

// Check if Cloudflare Workers are configured (required)
export function isCloudflareProxyConfigured(): {
  stream: boolean;
  tv: boolean;
  dlhd: boolean;
} {
  return {
    stream: !!process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL,
    tv: !!process.env.NEXT_PUBLIC_CF_TV_PROXY_URL,
    dlhd: useDlhdProxy(),
  };
}

// IPTV Stalker Portal proxy configuration
// Uses RPi residential proxy to bypass datacenter IP blocking
export function getIPTVProxyUrl(): string | null {
  // Client-side: use public env var
  if (typeof window !== 'undefined') {
    return process.env.NEXT_PUBLIC_RPI_PROXY_URL || null;
  }
  // Server-side: use server env var
  return process.env.RPI_PROXY_URL || null;
}

export function getIPTVProxyKey(): string | null {
  // Client-side: use public env var
  if (typeof window !== 'undefined') {
    return process.env.NEXT_PUBLIC_RPI_PROXY_KEY || null;
  }
  // Server-side: use server env var
  return process.env.RPI_PROXY_KEY || null;
}

// Get IPTV stream URL through RPi proxy
export function getIPTVStreamProxyUrl(
  streamUrl: string,
  mac?: string,
  token?: string
): string | null {
  const proxyUrl = getIPTVProxyUrl();
  if (!proxyUrl) return null;
  
  const params = new URLSearchParams({ url: streamUrl });
  if (mac) params.set('mac', mac);
  if (token) params.set('token', token);
  
  return `${proxyUrl}/iptv/stream?${params.toString()}`;
}

// ============================================================================
// AnimeKai Proxy Configuration
// ============================================================================
// AnimeKai uses MegaUp CDN which blocks:
//   1. Datacenter IPs (Cloudflare, AWS, etc.)
//   2. Requests with Origin header
// 
// The /animekai route on Cloudflare Worker forwards to RPI residential proxy
// which fetches without Origin/Referer headers from a residential IP.
// ============================================================================

/**
 * Check if AnimeKai proxy is configured
 * Requires NEXT_PUBLIC_CF_STREAM_PROXY_URL to be set
 */
export function isAnimeKaiProxyConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL;
}

/**
 * Get AnimeKai stream proxy URL
 * Routes through Cloudflare Worker -> RPI Proxy -> MegaUp CDN
 * In Docker mode, routes through local Bun proxy
 * 
 * @param url - The CDN stream URL (m3u8 or segment)
 * @param referer - Optional referer to pass through to the CDN
 * @returns Proxied URL through /animekai route
 */
export function getAnimeKaiProxyUrl(url: string, referer?: string): string {
  // Try both NEXT_PUBLIC_ (available at build time) and server-side env var
  // Fallback to hardcoded URL for production if env vars aren't set
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL || 
                     process.env.CF_STREAM_PROXY_URL || 
                     'https://media-proxy.vynx-3b3.workers.dev/stream';
  
  // Use /animekai route which forwards to RPI residential proxy
  // Strip /stream suffix if present (the base URL might include it)
  const baseUrl = cfProxyUrl.replace(/\/stream\/?$/, '');
  
  let proxyUrl = `${baseUrl}/animekai?url=${encodeURIComponent(url)}`;
  if (referer) {
    proxyUrl += `&referer=${encodeURIComponent(referer)}`;
  }
  return proxyUrl;
}

/**
 * Check if a URL is from AnimeKai CDN (requires RPI residential proxy)
 * 
 * AnimeKai uses multiple CDN domains that ALL block:
 *   1. Datacenter IPs (Cloudflare, AWS, etc.)
 *   2. Requests with Origin header
 * 
 * ALL these domains need to go through the /animekai route -> RPI proxy
 */
export function isMegaUpCdnUrl(url: string): boolean {
  // MegaUp CDN domains
  if (url.includes('megaup')) {
    return true;
  }
  
  // AnimeKai CDN domains - ALL block datacenter IPs
  // These rotate frequently, so check for common patterns
  const animeKaiCdnDomains = [
    'hub26link.site',
    'dev23app.site',
    'net22lab.site',
    'pro25zone.site',
    'tech20hub.site',
    'code29wave.site',
    'app28base.site',
    '4spromax.site',
    'megaup.live',
  ];
  
  for (const domain of animeKaiCdnDomains) {
    if (url.includes(domain)) {
      return true;
    }
  }
  
  // Other streaming CDN domains that also block datacenter IPs
  if (url.includes('rapidshare') ||
      url.includes('rapid-cloud') ||
      url.includes('rabbitstream') ||
      url.includes('vidcloud') ||
      url.includes('dokicloud')) {
    return true;
  }
  
  return false;
}

/**
 * Check if a URL is from 1movies CDN (requires RPI residential proxy)
 * 
 * 1movies uses Cloudflare Workers CDN domains that block:
 *   1. Datacenter IPs (Cloudflare, AWS, etc.)
 *   2. Requests from other Cloudflare Workers
 * 
 * These domains need to go through the /animekai route -> RPI proxy
 */
export function is1moviesCdnUrl(url: string): boolean {
  // 1movies CDN domains - Cloudflare Workers that block datacenter IPs
  // Pattern: p.XXXXX.workers.dev (e.g., p.10014.workers.dev)
  if (url.includes('.workers.dev')) {
    // Check for 1movies-specific patterns
    if (url.includes('p.') && url.match(/p\.\d+\.workers\.dev/)) {
      return true;
    }
    // Also check for other 1movies CDN patterns
    if (url.includes('dewshine') || url.includes('afc7d47f')) {
      return true;
    }
  }
  
  return false;
}

/**
 * Check if a source is from AnimeKai provider (all AnimeKai sources need RPI proxy)
 */
export function isAnimeKaiSource(source: { title?: string; referer?: string }): boolean {
  if (source.title?.toLowerCase().includes('animekai')) return true;
  if (source.referer?.includes('animekai.to')) return true;
  if (source.referer?.includes('anikai.to')) return true;
  return false;
}


// ============================================================================
// Flixer Proxy Configuration
// ============================================================================
// Flixer uses WASM-based encryption that runs in the Cloudflare Worker.
// The /flixer route handles key generation, API requests, and decryption.
// ============================================================================

/**
 * Check if Flixer proxy is configured
 * Requires NEXT_PUBLIC_CF_STREAM_PROXY_URL to be set
 */
export function isFlixerProxyConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL;
}

/**
 * Get Flixer extraction URL via Cloudflare Worker
 * 
 * @param tmdbId - TMDB ID of the content
 * @param type - 'movie' or 'tv'
 * @param server - Server name (alpha, bravo, charlie, delta, echo, foxtrot)
 * @param season - Season number (for TV)
 * @param episode - Episode number (for TV)
 * @returns URL to the Cloudflare /flixer/extract endpoint
 */
export function getFlixerExtractUrl(
  tmdbId: string,
  type: 'movie' | 'tv',
  server: string = 'alpha',
  season?: number,
  episode?: number
): string {
  const baseUrl = getFlixerProxyBaseUrl();
  
  const params = new URLSearchParams({
    tmdbId,
    type,
    server,
  });
  
  if (type === 'tv' && season && episode) {
    params.set('season', season.toString());
    params.set('episode', episode.toString());
  }
  
  console.log(`[Flixer] Extract URL: ${baseUrl}/flixer/extract?${params.toString()}`);
  
  return `${baseUrl}/flixer/extract?${params.toString()}`;
}

/**
 * Get Flixer batch extraction URL — fetches ALL servers in one request.
 * The CF Worker fans out to all 12 servers in parallel internally,
 * avoiding 12 separate round-trips through RPI.
 */
export function getFlixerExtractAllUrl(
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number
): string {
  const baseUrl = getFlixerProxyBaseUrl();
  
  const params = new URLSearchParams({ tmdbId, type });
  
  if (type === 'tv' && season && episode) {
    params.set('season', season.toString());
    params.set('episode', episode.toString());
  }
  
  return `${baseUrl}/flixer/extract-all?${params.toString()}`;
}

function getFlixerProxyBaseUrl(): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL || 
                     process.env.CF_STREAM_PROXY_URL || 
                     'https://media-proxy.vynx-3b3.workers.dev/stream';
  return cfProxyUrl.replace(/\/stream\/?$/, '');
}

/**
 * Get Flixer sign URL — CF Worker generates signed auth headers for browser-direct requests.
 */
export function getFlixerSignUrl(
  tmdbId: string,
  type: 'movie' | 'tv',
  opts?: { server?: string; warmup?: boolean; season?: number; episode?: number },
): string {
  const baseUrl = getFlixerProxyBaseUrl();
  const params = new URLSearchParams({ tmdbId, type });
  if (opts?.server) params.set('server', opts.server);
  if (opts?.warmup) params.set('warmup', '1');
  if (type === 'tv' && opts?.season && opts?.episode) {
    params.set('season', opts.season.toString());
    params.set('episode', opts.episode.toString());
  }
  return `${baseUrl}/flixer/sign?${params.toString()}`;
}

/**
 * Get Flixer decrypt URL — CF Worker decrypts encrypted hexa API response.
 */
export function getFlixerDecryptUrl(): string {
  const baseUrl = getFlixerProxyBaseUrl();
  return `${baseUrl}/flixer/decrypt`;
}

/**
 * Check if a URL is from Flixer/Hexa CDN
 */
export function isFlixerCdnUrl(url: string): boolean {
  return url.includes('flixer') || url.includes('plsdontscrapemelove') || url.includes('hexa.su') || url.includes('themoviedb.hexa') || url.includes('theemoviedb.hexa') || url.includes('p.10020.workers.dev') || url.includes('afc7d47f');
}

/**
 * Get Flixer stream proxy URL — dedicated /flixer/stream route.
 * Flixer CDN (p.XXXXX.workers.dev) blocks CF Worker IPs, so this route
 * handles RPI proxying with the correct Referer for Flixer CDN domains.
 * 
 * DO NOT use /animekai for Flixer streams — each provider has its own route.
 */
export function getFlixerStreamProxyUrl(url: string): string {
  const baseUrl = getFlixerProxyBaseUrl();
  return `${baseUrl}/flixer/stream?url=${encodeURIComponent(url)}`;
}

// ============================================================================
// HiAnime Proxy Configuration
// ============================================================================

/**
 * Get HiAnime/MegaCloud stream proxy URL — dedicated /hianime/stream route.
 * MegaCloud CDN uses TLS fingerprinting; this route handles RPI proxying
 * with megacloud.blog Referer/Origin.
 */
export function getHiAnimeStreamProxyUrl(url: string): string {
  const baseUrl = getFlixerProxyBaseUrl(); // same CF Worker base
  return `${baseUrl}/hianime?url=${encodeURIComponent(url)}`;
}

// ============================================================================
// VidLink Proxy Configuration
// ============================================================================

/**
 * Get VidLink stream proxy URL — routes through CF Worker /animekai route.
 * The CF Worker detects VidLink CDN domains and forwards to RPI's dedicated
 * /vidlink/stream endpoint which has the correct headers for vodvidl.site.
 */
export function getVidLinkStreamProxyUrl(url: string): string {
  const baseUrl = getFlixerProxyBaseUrl();
  return `${baseUrl}/animekai?url=${encodeURIComponent(url)}`;
}

// ============================================================================
// VidSrc Proxy Configuration
// ============================================================================

/**
 * Get VidSrc/2embed stream proxy URL — routes through CF Worker /animekai route.
 * The CF Worker detects VidSrc CDN domains and forwards to RPI's dedicated
 * /vidsrc/stream endpoint.
 */
export function getVidSrcStreamProxyUrl(url: string, referer?: string): string {
  const baseUrl = getFlixerProxyBaseUrl();
  let proxyUrl = `${baseUrl}/animekai?url=${encodeURIComponent(url)}`;
  if (referer) proxyUrl += `&referer=${encodeURIComponent(referer)}`;
  return proxyUrl;
}

// ============================================================================
// 1movies Proxy Configuration
// ============================================================================

/**
 * Get 1movies stream proxy URL — routes through CF Worker /animekai route.
 * The CF Worker detects 1movies CDN domains (p.XXXXX.workers.dev) and forwards
 * to RPI's dedicated /1movies/stream endpoint.
 */
export function get1moviesStreamProxyUrl(url: string): string {
  const baseUrl = getFlixerProxyBaseUrl();
  return `${baseUrl}/animekai?url=${encodeURIComponent(url)}`;
}

// ============================================================================
// VIPRow Proxy Configuration
// ============================================================================
// VIPRow/Casthill streams require:
//   1. Origin: https://casthill.net
//   2. Referer: https://casthill.net/
// 
// The /viprow route on Cloudflare Worker handles:
//   - Stream extraction from VIPRow event pages
//   - Token refresh via boanki.net
//   - Manifest URL rewriting
//   - Key and segment proxying
// ============================================================================

/**
 * Check if VIPRow proxy is configured
 * Requires NEXT_PUBLIC_CF_STREAM_PROXY_URL to be set
 */
export function isVIPRowProxyConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL;
}

/**
 * Get VIPRow stream URL via Cloudflare Worker
 * The CF Worker forwards extraction to RPI proxy (boanki.net blocks CF Workers)
 * and returns a proxied m3u8 that can be played directly in hls.js
 * 
 * @param eventUrl - VIPRow event URL (e.g., /nba/event-online-stream)
 * @param link - Link number (1-10, default 1)
 * @returns URL to the Cloudflare /viprow/stream endpoint
 */
export function getVIPRowStreamUrl(eventUrl: string, link: number = 1): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL;
  
  if (!cfProxyUrl) {
    throw new Error('NEXT_PUBLIC_CF_STREAM_PROXY_URL is not set');
  }
  
  // Strip /stream suffix if present
  const baseUrl = cfProxyUrl.replace(/\/stream\/?$/, '');
  
  return `${baseUrl}/viprow/stream?url=${encodeURIComponent(eventUrl)}&link=${link}`;
}

/**
 * Get VIPRow manifest proxy URL
 * For refreshing the manifest during playback
 */
export function getVIPRowManifestProxyUrl(manifestUrl: string): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL;
  
  if (!cfProxyUrl) {
    throw new Error('NEXT_PUBLIC_CF_STREAM_PROXY_URL is not set');
  }
  
  const baseUrl = cfProxyUrl.replace(/\/stream\/?$/, '');
  return `${baseUrl}/viprow/manifest?url=${encodeURIComponent(manifestUrl)}`;
}

/**
 * Get VIPRow key proxy URL
 */
export function getVIPRowKeyProxyUrl(keyUrl: string): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL;
  
  if (!cfProxyUrl) {
    throw new Error('NEXT_PUBLIC_CF_STREAM_PROXY_URL is not set');
  }
  
  const baseUrl = cfProxyUrl.replace(/\/stream\/?$/, '');
  return `${baseUrl}/viprow/key?url=${encodeURIComponent(keyUrl)}`;
}

/**
 * Get VIPRow segment proxy URL
 */
export function getVIPRowSegmentProxyUrl(segmentUrl: string): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL;
  
  if (!cfProxyUrl) {
    throw new Error('NEXT_PUBLIC_CF_STREAM_PROXY_URL is not set');
  }
  
  const baseUrl = cfProxyUrl.replace(/\/stream\/?$/, '');
  return `${baseUrl}/viprow/segment?url=${encodeURIComponent(segmentUrl)}`;
}

// ─── Videasy Proxy ─────────────────────────────────────────────

/**
 * Get Videasy stream proxy URL — routes through CF Worker /stream.
 * Videasy CDN (yoru.midwesteagle.com) requires Referer: https://player.videasy.net/
 * on every segment request. The browser cannot set this header, so all HLS traffic
 * goes through the CF Worker which adds the required Referer/Origin.
 */
export function getVideasyStreamProxyUrl(url: string): string {
  const baseUrl = getFlixerProxyBaseUrl();
  return `${baseUrl}/stream?url=${encodeURIComponent(url)}&source=videasy&referer=${encodeURIComponent('https://player.videasy.net/')}`;
}

// ─── PrimeSrc Proxy ─────────────────────────────────────────────

function getPrimeSrcProxyBaseUrl(): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL ||
                     process.env.CF_STREAM_PROXY_URL ||
                     'https://media-proxy.vynx-3b3.workers.dev/stream';
  return cfProxyUrl.replace(/\/stream\/?$/, '');
}

/**
 * Check if PrimeSrc proxy is configured
 */
export function isPrimeSrcProxyConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL;
}

/**
 * Get PrimeSrc extraction URL (calls CF Worker /primesrc/extract)
 * Optionally includes a Turnstile token for full server resolution.
 */
export function getPrimeSrcExtractUrl(
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number,
  turnstileToken?: string,
): string {
  const baseUrl = getPrimeSrcProxyBaseUrl();
  const params = new URLSearchParams({ tmdbId, type });
  if (type === 'tv' && season && episode) {
    params.set('season', season.toString());
    params.set('episode', episode.toString());
  }
  if (turnstileToken) {
    params.set('token', turnstileToken);
  }
  return `${baseUrl}/primesrc/extract?${params.toString()}`;
}

/**
 * Get PrimeSrc stream proxy URL (proxies m3u8/segments via CF Worker)
 */
export function getPrimeSrcStreamProxyUrl(url: string): string {
  const baseUrl = getPrimeSrcProxyBaseUrl();
  return `${baseUrl}/primesrc/stream?url=${encodeURIComponent(url)}`;
}
