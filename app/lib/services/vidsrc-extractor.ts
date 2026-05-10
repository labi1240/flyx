/**
 * VidSrc Extractor
 * Extracts streams from multiple sources:
 * 1. Cloudflare Worker /vidsrc endpoint (PRIMARY - NO TURNSTILE!)
 * 2. v1.2embed.stream API direct (FALLBACK)
 * 3. vidsrc-embed.ru → cloudnestra.com (LAST RESORT - has Turnstile)
 *
 * ✅ STATUS: WORKING - February 2026
 * BREAKTHROUGH: Found v1.2embed.stream API that returns m3u8 URLs directly!
 * No Turnstile, no captcha, just a simple JSON API.
 * 
 * The Cloudflare Worker at media-proxy.vynx-3b3.workers.dev/vidsrc handles:
 * - API calls to 2embed.stream
 * - URL rewriting for browser playback
 * - Segment proxying
 *
 * API ENDPOINTS DISCOVERED:
 * - /api/m3u8/movie/{tmdbId} - Returns m3u8_url for movies
 * - /api/m3u8/tv/{tmdbId}/{season}/{episode} - Returns m3u8_url for TV
 */

interface StreamSource {
  quality: string;
  title: string;
  url: string;
  type: 'hls';
  referer: string;
  requiresSegmentProxy: boolean;
  status?: 'working' | 'down';
}

interface ExtractionResult {
  success: boolean;
  sources: StreamSource[];
  error?: string;
}

// ✅ VidSrc is now ENABLED by default - no security risk as we don't execute remote code
export const VIDSRC_ENABLED = process.env.ENABLE_VIDSRC_PROVIDER !== 'false';

// Optional: Captcha solving service API key for Turnstile bypass (fallback only)
const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY;

// Cloudflare Worker VidSrc endpoint (PRIMARY - handles everything)
// Uses NEXT_PUBLIC_CF_STREAM_PROXY_URL (strip /stream suffix) or falls back to hardcoded URL
const CF_VIDSRC_PROXY = (() => {
  const streamUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL;
  if (streamUrl) {
    return streamUrl.replace(/\/stream\/?$/, '') + '/vidsrc';
  }
  return 'https://media-proxy.vynx-3b3.workers.dev/vidsrc';
})();

// 2embed.stream API base URL (FALLBACK - direct access)
const EMBED_API_BASE = 'https://v1.2embed.stream';

// Rate limiting configuration - reduced for faster response
const VIDSRC_MIN_DELAY_MS = 300;  // Minimum delay between requests (reduced from 500)
const VIDSRC_MAX_DELAY_MS = 2000; // Maximum delay for backoff (reduced from 3000)
const VIDSRC_BACKOFF_MULTIPLIER = 1.3; // Reduced from 1.5

// Multiple embed domains to try (in order of preference)
// Only try the first 2 to avoid wasting time on dead domains
const EMBED_DOMAINS = [
  'vidsrc-embed.ru',
  'vidsrc.cc',
] as const;

// Expanded CDN domains (January 2026 - updated list)
// Used in URL resolution when extracting stream URLs
const CDN_DOMAINS = [
  'shadowlandschronicles.com',
  'shadowlandschronicles.net',
  'shadowlandschronicles.org',
  'cloudnestra.com',
  'cloudnestra.net',
  'neonhorizonworkshops.com',
  'wanderlynest.com',
  'orchidpixelgardens.com',
  'vidsrc.stream',
  'vidsrc.xyz',
  'embedsito.com',
] as const;

// Track rate limit state
let vidsrcLastRequestTime = 0;
let vidsrcConsecutiveFailures = 0;

/**
 * Delay with exponential backoff based on consecutive failures
 */
async function vidsrcRateLimitDelay(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - vidsrcLastRequestTime;
  
  // Calculate delay with exponential backoff
  const backoffDelay = Math.min(
    VIDSRC_MIN_DELAY_MS * Math.pow(VIDSRC_BACKOFF_MULTIPLIER, vidsrcConsecutiveFailures),
    VIDSRC_MAX_DELAY_MS
  );
  
  // Ensure minimum time between requests
  const requiredDelay = Math.max(0, backoffDelay - timeSinceLastRequest);
  
  if (requiredDelay > 0) {
    console.log(`[VidSrc] Rate limit delay: ${Math.round(requiredDelay)}ms (failures: ${vidsrcConsecutiveFailures})`);
    await new Promise(resolve => setTimeout(resolve, requiredDelay));
  }
  
  vidsrcLastRequestTime = Date.now();
}

/**
 * Fetch with proper headers, timeout, and rate limiting
 * Uses browser-like headers to avoid Cloudflare detection
 * Routes through RPI proxy when running on Cloudflare Workers
 */
async function fetchWithHeaders(url: string, referer?: string, timeoutMs: number = 15000, retryCount: number = 0): Promise<Response> {
  const MAX_RETRIES = 2;
  
  // Apply rate limiting delay before each request
  await vidsrcRateLimitDelay();
  
  const headers: HeadersInit = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'cross-site' : 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
  };

  if (referer) {
    headers['Referer'] = referer;
    // Add Origin header for cross-origin requests
    try {
      const refererUrl = new URL(referer);
      headers['Origin'] = refererUrl.origin;
    } catch {
      // Invalid referer URL, skip Origin
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Use cfFetch to route through RPI when on Cloudflare Workers
    const { cfFetch } = await import('@/app/lib/utils/cf-fetch');
    const response = await cfFetch(url, {
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeoutId);
    
    // Handle rate limiting (429)
    if (response.status === 429) {
      vidsrcConsecutiveFailures++;
      console.log(`[VidSrc] HTTP 429 (rate limited), failures: ${vidsrcConsecutiveFailures}`);
      
      // Check for Retry-After header
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) {
        const waitTime = parseInt(retryAfter) * 1000 || 5000;
        console.log(`[VidSrc] Retry-After header: waiting ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      
      // Retry with exponential backoff
      if (retryCount < MAX_RETRIES) {
        const backoffWait = VIDSRC_MIN_DELAY_MS * Math.pow(2, retryCount + 1);
        console.log(`[VidSrc] Retrying after ${backoffWait}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, backoffWait));
        return fetchWithHeaders(url, referer, timeoutMs, retryCount + 1);
      }
    }
    
    // Success - reduce failure counter
    if (response.ok) {
      vidsrcConsecutiveFailures = Math.max(0, vidsrcConsecutiveFailures - 1);
    } else {
      vidsrcConsecutiveFailures++;
    }
    
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    vidsrcConsecutiveFailures++;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  }
}

/**
 * Solve Cloudflare Turnstile using CapSolver API
 * Requires CAPSOLVER_API_KEY environment variable
 * @returns The Turnstile token or null if solving fails/not configured
 */
async function solveTurnstile(
  siteKey: string,
  pageUrl: string
): Promise<string | null> {
  if (!CAPSOLVER_API_KEY) {
    console.log('[VidSrc] No CAPSOLVER_API_KEY configured - cannot solve Turnstile');
    return null;
  }

  console.log('[VidSrc] Attempting to solve Turnstile via CapSolver...');

  try {
    // Create task
    const createResponse = await fetch('https://api.capsolver.com/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: CAPSOLVER_API_KEY,
        task: {
          type: 'AntiTurnstileTaskProxyLess',
          websiteURL: pageUrl,
          websiteKey: siteKey,
        },
      }),
    });

    const createData = (await createResponse.json()) as {
      taskId?: string;
      errorId?: number;
    };
    if (!createData.taskId) {
      console.error('[VidSrc] CapSolver task creation failed');
      return null;
    }

    // Poll for result (max 60 seconds)
    const maxAttempts = 20;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 3000));

      const resultResponse = await fetch(
        'https://api.capsolver.com/getTaskResult',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientKey: CAPSOLVER_API_KEY,
            taskId: createData.taskId,
          }),
        }
      );

      const resultData = (await resultResponse.json()) as {
        status?: string;
        solution?: { token?: string };
      };

      if (resultData.status === 'ready' && resultData.solution?.token) {
        console.log('[VidSrc] Turnstile solved successfully!');
        return resultData.solution.token;
      }

      if (resultData.status === 'failed') {
        console.error('[VidSrc] CapSolver task failed');
        return null;
      }
    }

    console.error('[VidSrc] CapSolver timeout');
    return null;
  } catch (error) {
    console.error('[VidSrc] CapSolver error:', error);
    return null;
  }
}

/**
 * Submit Turnstile token to verify endpoint
 */
async function submitTurnstileToken(
  verifyUrl: string,
  token: string,
  referer: string
): Promise<string | null> {
  try {
    const response = await fetch(verifyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: referer,
        Origin: new URL(referer).origin,
      },
      body: `token=${encodeURIComponent(token)}`,
    });

    if (response.ok) {
      return await response.text();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Small delay to avoid rate limiting - now uses the rate limit system
 */
async function randomDelay(): Promise<void> {
  await vidsrcRateLimitDelay();
}

/**
 * Check if a stream URL is accessible - with reduced timeout for faster response
 */
async function checkStreamAvailability(url: string): Promise<'working' | 'down'> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // Reduced from 5000
    
    const response = await fetch(url, {
      method: 'HEAD', // Use HEAD for faster check
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://cloudnestra.com/',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    
    // Accept 200, 206 (partial content), or 302 (redirect) as working
    if (response.ok || response.status === 206 || response.status === 302) {
      return 'working';
    }
    
    // If HEAD fails, try GET with range header
    const getController = new AbortController();
    const getTimeoutId = setTimeout(() => getController.abort(), 3000);
    
    const getResponse = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://cloudnestra.com/',
        'Range': 'bytes=0-1000',
      },
      signal: getController.signal,
    });
    clearTimeout(getTimeoutId);
    
    const text = await getResponse.text();
    return (getResponse.ok || getResponse.status === 206) && 
           (text.includes('#EXTM3U') || text.includes('#EXT-X') || text.length > 0) 
           ? 'working' : 'down';
  } catch {
    return 'down';
  }
}

/**
 * Main extraction function
 * 
 * ✅ ENABLED BY DEFAULT - No security risk as we extract URLs directly from page
 * 
 * Improvements:
 * - PRIMARY: Uses v1.2embed.stream API (no Turnstile!)
 * - FALLBACK: Tries cloudnestra extraction if API fails
 * - Multiple regex patterns for file URL extraction
 * - Parallel URL testing for faster results
 * - Better error messages for debugging
 */
export async function extractVidSrcStreams(
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number
): Promise<ExtractionResult> {
  if (!VIDSRC_ENABLED) {
    console.warn('[VidSrc] Provider is disabled. Set ENABLE_VIDSRC_PROVIDER=true to enable.');
    return {
      success: false,
      sources: [],
      error: 'VidSrc provider is disabled.'
    };
  }

  console.log(`[VidSrc] Extracting streams for ${type} ID ${tmdbId}...`);

  // PRIMARY: Try v1.2embed.stream API first (no Turnstile!)
  try {
    const apiResult = await extractFrom2EmbedApi(tmdbId, type, season, episode);
    if (apiResult.success && apiResult.sources.length > 0) {
      const workingSources = apiResult.sources.filter(s => s.status === 'working');
      if (workingSources.length > 0) {
        console.log(`[VidSrc] ✓ Success with 2embed.stream API: ${workingSources.length} working sources`);
        return apiResult;
      }
    }
    console.log(`[VidSrc] 2embed.stream API: ${apiResult.error || 'No working sources'}, trying fallback...`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(`[VidSrc] 2embed.stream API failed: ${errorMsg}, trying fallback...`);
  }

  // FALLBACK: Try cloudnestra extraction (may have Turnstile)
  let lastError = '';
  
  for (const embedDomain of EMBED_DOMAINS) {
    try {
      const result = await extractFromDomain(embedDomain, tmdbId, type, season, episode);
      if (result.success && result.sources.length > 0) {
        const workingSources = result.sources.filter(s => s.status === 'working');
        if (workingSources.length > 0) {
          console.log(`[VidSrc] ✓ Success with ${embedDomain}: ${workingSources.length} working sources`);
          return result;
        }
      }
      lastError = result.error || 'No working sources';
      console.log(`[VidSrc] ${embedDomain}: ${lastError}, trying next domain...`);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.log(`[VidSrc] ${embedDomain} failed: ${lastError}, trying next domain...`);
    }
  }

  return {
    success: false,
    sources: [],
    error: `All extraction methods failed. Last error: ${lastError}`
  };
}

/**
 * Extract from v1.2embed.stream API via Cloudflare Worker (PRIMARY METHOD - NO TURNSTILE!)
 * 
 * The CF Worker at /vidsrc handles:
 * - API calls to 2embed.stream
 * - URL rewriting for browser playback
 * - Segment proxying
 */
async function extractFrom2EmbedApi(
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number
): Promise<ExtractionResult> {
  try {
    // Build CF Worker URL
    const params = new URLSearchParams({
      tmdbId,
      type,
    });
    if (type === 'tv' && season && episode) {
      params.set('season', season.toString());
      params.set('episode', episode.toString());
    }
    
    const cfUrl = `${CF_VIDSRC_PROXY}/extract?${params}`;
    console.log('[VidSrc] Fetching via CF Worker:', cfUrl);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    // Use cfFetch to route through RPI when on CF Pages — CF Pages can't directly
    // fetch other CF Workers on the same account (silent failure)
    const { cfFetch } = await import('@/app/lib/utils/cf-fetch');
    const response = await cfFetch(cfUrl, {
      headers: {
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`CF Worker returned ${response.status}`);
    }
    
    const data = await response.json() as {
      success?: boolean;
      m3u8_url?: string;
      proxied_url?: string;
      source?: string;
      error?: string;
    };
    
    if (!data.success || !data.m3u8_url) {
      throw new Error(data.error || 'No m3u8_url in response');
    }
    
    console.log('[VidSrc] Got m3u8 URL from CF Worker, source:', data.source);
    
    // Use the proxied URL from CF Worker (already rewritten for browser playback)
    // The proxied_url is relative to the CF Worker, so we need to make it absolute
    const cfProxyBase = CF_VIDSRC_PROXY.replace('/vidsrc', '');
    const m3u8Url = data.proxied_url 
      ? `${cfProxyBase}${data.proxied_url}`
      : data.m3u8_url;
    
    const sources: StreamSource[] = [{
      quality: 'auto',
      title: '2Embed Stream',
      url: m3u8Url,
      type: 'hls',
      referer: EMBED_API_BASE + '/',
      requiresSegmentProxy: false, // CF Worker handles proxying
      status: 'working' // CF Worker already verified it works
    }];
    
    console.log('[VidSrc] ✓ CF Worker returned working stream');
    
    return {
      success: true,
      sources,
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[VidSrc] CF Worker error:', errorMessage);
    
    return {
      success: false,
      sources: [],
      error: errorMessage
    };
  }
}

/**
 * Extract from a specific embed domain
 */
async function extractFromDomain(
  embedDomain: string,
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number
): Promise<ExtractionResult> {
  try {
    // Step 1: Fetch embed page
    const embedUrl = type === 'tv' && season && episode
      ? `https://${embedDomain}/embed/tv/${tmdbId}/${season}/${episode}`
      : `https://${embedDomain}/embed/movie/${tmdbId}`;
    
    console.log('[VidSrc] Fetching embed page:', embedUrl);
    const embedResponse = await fetchWithHeaders(embedUrl, undefined, 10000);
    
    if (!embedResponse.ok) {
      throw new Error(`Embed page returned ${embedResponse.status}`);
    }
    
    const embedHtml = await embedResponse.text();

    // Step 2: Extract RCP iframe URL - try multiple patterns
    const iframePatterns = [
      /<iframe[^>]*src=["']([^"']+cloudnestra\.com\/rcp\/([^"']+))["']/i,
      /<iframe[^>]*src=["']([^"']+\/rcp\/([^"']+))["']/i,
      /src=["'](https?:\/\/[^"']+\/rcp\/([^"']+))["']/i,
    ];
    
    let rcpPath: string | null = null;
    let rcpDomain = 'cloudnestra.com';
    
    for (const pattern of iframePatterns) {
      const match = embedHtml.match(pattern);
      if (match) {
        rcpPath = match[2];
        // Extract domain from full URL if present
        try {
          const fullUrl = new URL(match[1]);
          rcpDomain = fullUrl.hostname;
        } catch {
          // Use default domain
        }
        break;
      }
    }
    
    if (!rcpPath) {
      // Try to find any iframe src
      const anyIframe = embedHtml.match(/<iframe[^>]*src=["']([^"']+)["']/i);
      if (anyIframe) {
        console.log('[VidSrc] Found iframe but not RCP format:', anyIframe[1].substring(0, 100));
      }
      throw new Error('Could not find RCP iframe in embed page');
    }
    
    console.log('[VidSrc] Found RCP hash on', rcpDomain);

    // Small delay to avoid rate limiting
    await randomDelay();

    // Step 3: Fetch RCP page to get prorcp URL
    const rcpUrl = `https://${rcpDomain}/rcp/${rcpPath}`;
    console.log('[VidSrc] Fetching RCP page');
    const rcpResponse = await fetchWithHeaders(rcpUrl, `https://${embedDomain}/`, 10000);
    
    if (!rcpResponse.ok) {
      throw new Error(`RCP page returned ${rcpResponse.status}`);
    }
    
    let rcpHtml = await rcpResponse.text();

    // Step 4: Check for Cloudflare Turnstile
    if (rcpHtml.includes('cf-turnstile') || rcpHtml.includes('turnstile')) {
      console.log('[VidSrc] Cloudflare Turnstile detected');

      const siteKeyMatch = rcpHtml.match(
        /data-sitekey=["']([^"']+)["']|sitekey:\s*["']([^"']+)["']/i
      );
      const siteKey = siteKeyMatch?.[1] || siteKeyMatch?.[2];

      if (siteKey && CAPSOLVER_API_KEY) {
        console.log('[VidSrc] Attempting Turnstile solve via CapSolver...');
        const token = await solveTurnstile(siteKey, rcpUrl);

        if (token) {
          const verifyMatch = rcpHtml.match(
            /\$\.post\s*\(\s*["']([^"']+)["']\s*,\s*\{\s*token/i
          );
          const verifyUrl = verifyMatch
            ? `https://${rcpDomain}${verifyMatch[1]}`
            : `https://${rcpDomain}/verify`;

          const verifyResult = await submitTurnstileToken(
            verifyUrl,
            token,
            rcpUrl
          );

          if (verifyResult) {
            console.log('[VidSrc] Turnstile verified, re-fetching RCP page...');
            const newRcpResponse = await fetchWithHeaders(
              rcpUrl,
              `https://${embedDomain}/`
            );
            rcpHtml = await newRcpResponse.text();

            if (
              !rcpHtml.includes('cf-turnstile') &&
              !rcpHtml.includes('turnstile')
            ) {
              console.log('[VidSrc] Turnstile bypass successful!');
            } else {
              console.warn(
                '[VidSrc] Turnstile still present after verification'
              );
              throw new Error(
                'Turnstile verification failed - page still protected'
              );
            }
          } else {
            throw new Error('Turnstile token verification failed');
          }
        } else {
          throw new Error(
            'Failed to solve Turnstile - check CAPSOLVER_API_KEY'
          );
        }
      } else {
        console.warn(
          '[VidSrc] ⚠️ Turnstile detected but no CAPSOLVER_API_KEY configured'
        );
        return {
          success: false,
          sources: [],
          error: 'VidSrc is protected by Cloudflare Turnstile. Configure CAPSOLVER_API_KEY or use alternative providers.'
        };
      }
    }
    
    // Step 5: Extract prorcp/srcrcp path - expanded patterns
    let rcpEndpointPath: string | null = null;
    let rcpEndpointType: 'prorcp' | 'srcrcp' = 'prorcp';
    
    const patterns = [
      { regex: /src:\s*['"]\/prorcp\/([^'"]+)['"]/i, type: 'prorcp' as const },
      { regex: /src:\s*['"]\/srcrcp\/([^'"]+)['"]/i, type: 'srcrcp' as const },
      { regex: /['"]\/prorcp\/([A-Za-z0-9+\/=\-_]+)['"]/i, type: 'prorcp' as const },
      { regex: /['"]\/srcrcp\/([A-Za-z0-9+\/=\-_]+)['"]/i, type: 'srcrcp' as const },
      { regex: /prorcp\/([A-Za-z0-9+\/=\-_]+)/i, type: 'prorcp' as const },
      { regex: /srcrcp\/([A-Za-z0-9+\/=\-_]+)/i, type: 'srcrcp' as const },
    ];
    
    for (const { regex, type: endpointType } of patterns) {
      const match = rcpHtml.match(regex);
      if (match) {
        rcpEndpointPath = match[1];
        rcpEndpointType = endpointType;
        break;
      }
    }
    
    if (!rcpEndpointPath) {
      throw new Error('Could not find prorcp/srcrcp URL in RCP page');
    }

    // Small delay before next request
    await randomDelay();

    // Step 6: Fetch PRORCP/SRCRCP page
    const endpointUrl = `https://${rcpDomain}/${rcpEndpointType}/${rcpEndpointPath}`;
    console.log(`[VidSrc] Fetching ${rcpEndpointType.toUpperCase()} page`);
    const prorcpResponse = await fetchWithHeaders(endpointUrl, `https://${rcpDomain}/`, 10000);
    
    if (!prorcpResponse.ok) {
      throw new Error(`PRORCP page returned ${prorcpResponse.status}`);
    }
    
    const prorcpHtml = await prorcpResponse.text();

    // Step 7: Extract file URL - multiple patterns for robustness
    console.log('[VidSrc] Extracting file URL from PlayerJS...');
    
    const filePatterns = [
      /file:\s*["']([^"']+)["']/,
      /file\s*=\s*["']([^"']+)["']/,
      /"file"\s*:\s*"([^"]+)"/,
      /sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/,
      /src\s*:\s*["']([^"']+\.m3u8[^"']*)["']/,
      /source\s*:\s*["']([^"']+\.m3u8[^"']*)["']/,
    ];
    
    let fileUrl: string | null = null;
    for (const pattern of filePatterns) {
      const match = prorcpHtml.match(pattern);
      if (match && match[1]) {
        fileUrl = match[1];
        break;
      }
    }
    
    if (!fileUrl) {
      // Try to find any m3u8 URL in the page
      const m3u8Match = prorcpHtml.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
      if (m3u8Match) {
        fileUrl = m3u8Match[0];
        console.log('[VidSrc] Found m3u8 URL via fallback pattern');
      }
    }
    
    if (!fileUrl) {
      throw new Error('Could not find file URL in PlayerJS initialization');
    }
    
    console.log('[VidSrc] Found file URL, length:', fileUrl.length);
    
    // Step 8: Parse URL alternatives and resolve CDN domains
    const urlAlternatives = fileUrl.split(' or ');
    console.log(`[VidSrc] Found ${urlAlternatives.length} URL alternatives`);
    
    // Resolve URLs by replacing {v1}, {v2}, etc. with actual domains
    const resolvedUrls = new Set<string>();
    for (const url of urlAlternatives) {
      // Skip app2/app3 URLs as they often don't work
      if (url.includes('app2.') || url.includes('app3.')) {
        continue;
      }
      
      // Check if URL has domain placeholders
      if (url.includes('{v')) {
        for (const domain of CDN_DOMAINS) {
          const resolved = url.replace(/\{v\d+\}/g, domain);
          if (resolved.includes('.m3u8')) {
            resolvedUrls.add(resolved);
          }
        }
      } else if (url.includes('.m3u8')) {
        resolvedUrls.add(url);
      }
    }
    
    console.log(`[VidSrc] Resolved ${resolvedUrls.size} unique URLs`);
    
    if (resolvedUrls.size === 0) {
      throw new Error('No valid stream URLs found');
    }

    // Step 9: Test URLs in parallel for faster results
    const urlArray = Array.from(resolvedUrls);
    const sources: StreamSource[] = [];
    
    // Test up to 6 URLs in parallel
    const testUrls = urlArray.slice(0, 6);
    const statusResults = await Promise.allSettled(
      testUrls.map(async (url) => {
        const status = await checkStreamAvailability(url);
        return { url, status };
      })
    );
    
    for (let i = 0; i < statusResults.length; i++) {
      const result = statusResults[i];
      if (result.status === 'fulfilled') {
        sources.push({
          quality: 'auto',
          title: `VidSrc ${i + 1}`,
          url: result.value.url,
          type: 'hls',
          referer: `https://${rcpDomain}/`,
          requiresSegmentProxy: true,
          status: result.value.status
        });
      }
    }

    const workingSources = sources.filter(s => s.status === 'working');
    console.log(`[VidSrc] ${workingSources.length}/${sources.length} sources working`);

    if (workingSources.length === 0 && sources.length > 0) {
      return {
        success: false,
        sources,
        error: 'All VidSrc sources currently unavailable'
      };
    }

    if (sources.length === 0) {
      throw new Error('No valid stream sources found');
    }

    return {
      success: true,
      sources
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[VidSrc] Extraction failed:', errorMessage);
    
    return {
      success: false,
      sources: [],
      error: errorMessage
    };
  }
}
