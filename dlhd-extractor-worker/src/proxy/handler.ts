/**
 * Proxy Request Handler
 * 
 * Requirements: 5.1, 5.3, 5.4, 5.7, 7.1
 * - THE Stream_Proxy component SHALL proxy the M3U8 master playlist with all required upstream headers
 * - THE Stream_Proxy component SHALL proxy media playlists (variant streams) with proper header injection
 * - THE Stream_Proxy component SHALL proxy all .ts video segments with streaming response (no buffering)
 * - WHEN the upstream requires specific headers (Origin, Referer, User-Agent, Cookies), 
 *   THE Stream_Proxy component SHALL inject them automatically
 * - WHEN a network request fails, THE Worker SHALL retry with exponential backoff up to 3 times
 * 
 * IMPORTANT: Key requests and DLHD domain requests MUST go through the RPI proxy
 * to handle WASM-based PoW authentication and bypass Cloudflare protection.
 * 
 * DECRYPTION: Client-side decryption - segments are passed through as-is.
 * For dvalna.ru segments with custom encryption, we strip the 32-byte header
 * and return the real IV in a response header (X-Real-IV) for the client.
 */

import { decodeProxyParams, DecodedProxyParams } from './url-encoder';
import { rewriteM3U8, isValidM3U8, getPlaylistBaseUrl } from './m3u8-rewriter';
import { withRetry, RetryConfig, DEFAULT_RETRY_CONFIG } from '../utils/retry';
import { getProxyConfig } from '../discovery/fetcher';

/**
 * Default headers for upstream requests
 */
const DEFAULT_UPSTREAM_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.5',
};

/**
 * Headers to copy from upstream response
 */
const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
];

/**
 * Domains that require RPI proxy routing
 * These domains have Cloudflare protection or require special authentication
 * 
 * NOTE: dvalna.ru IS included because it blocks Cloudflare Worker IPs
 * We route through RPI proxy which has a residential IP
 */
const RPI_PROXY_DOMAINS = [
  'dlhd.link',
  'dlhd.dad',
  'thedaddy.top',
  'dlstreams.top',
  'soyspace.cyou',
  'newkso.ru',
  'dvalna.ru',
  'adffdafdsafds.sbs',
  'newkso.ru',
  'topembed.pw',
  'arbitrageai.cc',
  'vovlacosa.sbs',
  'the-sunmoon.site',
  'vmvmv.shop',
  'daddylivestream.com',
  'ai-hls.site',
  'newkso.ru',
];

/**
 * Check if a URL should be routed through the RPI proxy
 */
function shouldUseRpiProxy(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return RPI_PROXY_DOMAINS.some(domain => 
      hostname === domain || hostname.endsWith('.' + domain)
    );
  } catch {
    return false;
  }
}

/**
 * Proxy error types
 */
export type ProxyErrorCode = 
  | 'MISSING_URL_PARAM'
  | 'INVALID_URL'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'REWRITE_ERROR';

/**
 * Proxy error
 */
export class ProxyError extends Error {
  code: ProxyErrorCode;
  statusCode: number;
  details?: Record<string, unknown>;

  constructor(
    message: string,
    code: ProxyErrorCode,
    statusCode: number = 502,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ProxyError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * Options for proxy requests
 */
export interface ProxyOptions {
  /** Worker base URL for rewriting M3U8 URLs */
  workerBaseUrl: string;
  /** Timeout for upstream requests in ms */
  timeout?: number;
  /** Whether to rewrite M3U8 content */
  rewriteM3U8?: boolean;
  /** Retry configuration */
  retryConfig?: Partial<RetryConfig>;
  /** API key to include in rewritten URLs for VLC/media player compatibility */
  apiKey?: string;
}

/**
 * Result of a proxy request
 */
export interface ProxyResult {
  response: Response;
  upstreamUrl: string;
  contentType: string;
  wasRewritten: boolean;
  /** Retry information */
  retryInfo?: {
    attempts: number;
    totalDurationMs: number;
  };
}

/**
 * Build upstream request headers
 * Merges default headers with decoded headers and adds required headers
 */
export function buildUpstreamHeaders(
  decodedParams: DecodedProxyParams
): Record<string, string> {
  const headers: Record<string, string> = {
    ...DEFAULT_UPSTREAM_HEADERS,
    ...decodedParams.headers,
  };
  
  // Add referer if provided
  if (decodedParams.referer) {
    headers['Referer'] = decodedParams.referer;
  }
  
  // Add origin if provided
  if (decodedParams.origin) {
    headers['Origin'] = decodedParams.origin;
  }
  
  return headers;
}

/**
 * Build response headers for proxy response
 * Copies relevant headers from upstream and adds CORS
 */
export function buildResponseHeaders(
  upstreamResponse: Response,
  additionalHeaders?: Record<string, string>
): Headers {
  const headers = new Headers();
  
  // Copy passthrough headers from upstream
  for (const header of PASSTHROUGH_HEADERS) {
    const value = upstreamResponse.headers.get(header);
    if (value) {
      headers.set(header, value);
    }
  }
  
  // Add additional headers
  if (additionalHeaders) {
    for (const [key, value] of Object.entries(additionalHeaders)) {
      headers.set(key, value);
    }
  }
  
  return headers;
}

/**
 * Fetch upstream resource with headers and retry logic
 * 
 * Requirements: 7.1
 * - WHEN a network request fails, THE Worker SHALL retry with exponential backoff up to 3 times
 * 
 * IMPORTANT: Routes requests through RPI proxy for DLHD domains and key servers
 * to handle WASM-based PoW authentication and bypass Cloudflare protection.
 */
async function fetchUpstream(
  url: string,
  headers: Record<string, string>,
  timeout?: number,
  retryConfig?: Partial<RetryConfig>
): Promise<{ response: Response; retryInfo: { attempts: number; totalDurationMs: number } }> {
  const config: Partial<RetryConfig> = {
    ...DEFAULT_RETRY_CONFIG,
    ...retryConfig,
  };
  
  const proxyConfig = getProxyConfig();
  const shouldProxy = shouldUseRpiProxy(url);
  const useProxy = proxyConfig.url && proxyConfig.apiKey && shouldProxy;
  
  console.log(`[fetchUpstream] URL: ${url.substring(0, 80)}...`);
  console.log(`[fetchUpstream] proxyConfig.url: ${proxyConfig.url || 'NOT SET'}`);
  console.log(`[fetchUpstream] proxyConfig.apiKey: ${proxyConfig.apiKey ? 'SET' : 'NOT SET'}`);
  console.log(`[fetchUpstream] shouldUseRpiProxy: ${shouldProxy}`);
  console.log(`[fetchUpstream] useProxy: ${useProxy}`);
  
  const result = await withRetry(async () => {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    
    if (timeout) {
      timeoutId = setTimeout(() => controller.abort(), timeout);
    }
    
    try {
      let response: Response;
      
      if (useProxy) {
        // Check if this is a dvalna.ru domain - use /dlhdprivate endpoint
        const hostname = new URL(url).hostname;
        const isDlhd = hostname.includes('dvalna.ru') || hostname.includes('soyspace.cyou') || hostname.includes('key.keylocking.ru');
        
        console.log(`[fetchUpstream] Using RPI proxy, isDlhd: ${isDlhd}`);
        
        if (isDlhd) {
          // Use /dlhdprivate - simple passthrough with headers as JSON
          const proxyUrl = new URL('/dlhdprivate', proxyConfig.url!);
          proxyUrl.searchParams.set('url', url);
          proxyUrl.searchParams.set('headers', JSON.stringify(headers));
          
          console.log(`[fetchUpstream] Proxy URL: ${proxyUrl.toString().substring(0, 100)}...`);
          
          response = await fetch(proxyUrl.toString(), {
            headers: {
              'X-API-Key': proxyConfig.apiKey!,
            },
            signal: controller.signal,
          });
        } else {
          // Route through RPI proxy for other DLHD domains
          const proxyUrl = new URL('/proxy', proxyConfig.url!);
          proxyUrl.searchParams.set('url', url);
          
          // Pass headers to proxy
          if (headers['Referer']) {
            proxyUrl.searchParams.set('referer', headers['Referer']);
          }
          if (headers['Origin']) {
            proxyUrl.searchParams.set('origin', headers['Origin']);
          }
          if (headers['Authorization']) {
            proxyUrl.searchParams.set('auth', headers['Authorization']);
          }
          
          response = await fetch(proxyUrl.toString(), {
            headers: {
              'X-API-Key': proxyConfig.apiKey!,
              'Accept': '*/*',
            },
            signal: controller.signal,
          });
        }
      } else {
        // Direct fetch for non-DLHD domains
        response = await fetch(url, {
          headers,
          signal: controller.signal,
        });
      }
      
      // Check for retryable status codes
      if (!response.ok && config.retryableStatusCodes?.includes(response.status)) {
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`) as Error & { 
          status: number; 
          retryable: boolean;
          code: string;
        };
        error.status = response.status;
        error.retryable = true;
        error.code = 'UPSTREAM_ERROR';
        throw error;
      }
      
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const timeoutError = new Error('Upstream request timed out') as Error & {
          code: string;
          retryable: boolean;
        };
        timeoutError.code = 'UPSTREAM_TIMEOUT';
        timeoutError.retryable = true;
        throw timeoutError;
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }, config);
  
  if (!result.success || !result.value) {
    const error = result.error;
    if (error && 'code' in error && error.code === 'UPSTREAM_TIMEOUT') {
      throw new ProxyError(
        'Upstream request timed out',
        'UPSTREAM_TIMEOUT',
        504,
        { url, timeout, attempts: result.attempts }
      );
    }
    throw new ProxyError(
      `Upstream request failed: ${error?.message || 'Unknown error'}`,
      'UPSTREAM_ERROR',
      502,
      { url, attempts: result.attempts }
    );
  }
  
  return {
    response: result.value,
    retryInfo: {
      attempts: result.attempts,
      totalDurationMs: result.totalDurationMs,
    },
  };
}

/**
 * Handle M3U8 playlist proxy request
 * Fetches the playlist and rewrites all URLs to route through proxy
 */
export async function handleM3U8Proxy(
  searchParams: URLSearchParams,
  options: ProxyOptions
): Promise<ProxyResult> {
  console.log('[handleM3U8Proxy] STARTING M3U8 PROXY HANDLER');
  
  // Decode proxy parameters
  let decodedParams: DecodedProxyParams;
  try {
    decodedParams = decodeProxyParams(searchParams);
  } catch (error) {
    throw new ProxyError(
      error instanceof Error ? error.message : 'Invalid proxy parameters',
      'MISSING_URL_PARAM',
      400
    );
  }
  
  // Validate URL
  try {
    new URL(decodedParams.url);
  } catch {
    throw new ProxyError(
      'Invalid upstream URL',
      'INVALID_URL',
      400,
      { url: decodedParams.url }
    );
  }
  
  // Build upstream headers
  const upstreamHeaders = buildUpstreamHeaders(decodedParams);
  
  // Fetch upstream playlist with retry logic
  const { response: upstreamResponse, retryInfo } = await fetchUpstream(
    decodedParams.url,
    upstreamHeaders,
    options.timeout,
    options.retryConfig
  );
  
  if (!upstreamResponse.ok) {
    throw new ProxyError(
      `Upstream returned ${upstreamResponse.status}`,
      'UPSTREAM_ERROR',
      upstreamResponse.status,
      { url: decodedParams.url, attempts: retryInfo.attempts }
    );
  }
  
  // Get playlist content
  const content = await upstreamResponse.text();
  
  // Validate M3U8 content
  if (!isValidM3U8(content)) {
    throw new ProxyError(
      'Upstream did not return valid M3U8 content',
      'REWRITE_ERROR',
      502,
      { url: decodedParams.url }
    );
  }
  
  // Rewrite M3U8 URLs
  const baseUrl = getPlaylistBaseUrl(decodedParams.url);
  console.log(`[M3U8 Rewrite] Base URL: ${baseUrl}`);
  console.log(`[M3U8 Rewrite] Worker Base URL: ${options.workerBaseUrl}`);
  console.log(`[M3U8 Rewrite] Headers: ${JSON.stringify(decodedParams.headers)}`);
  console.log(`[M3U8 Rewrite] API Key: ${options.apiKey ? 'present' : 'none'}`);
  
  const rewriteResult = rewriteM3U8(content, {
    workerBaseUrl: options.workerBaseUrl,
    headers: decodedParams.headers,
    baseUrl,
    apiKey: options.apiKey,
  });
  
  console.log(`[M3U8 Rewrite] URLs rewritten: ${rewriteResult.urlsRewritten}`);
  if (rewriteResult.urlsRewritten > 0) {
    console.log(`[M3U8 Rewrite] Sample original: ${rewriteResult.originalUrls[0]}`);
    console.log(`[M3U8 Rewrite] Sample rewritten: ${rewriteResult.rewrittenUrls[0]}`);
  }
  
  // Build response headers
  const responseHeaders = buildResponseHeaders(upstreamResponse, {
    'Content-Type': 'application/vnd.apple.mpegurl',
  });
  
  return {
    response: new Response(rewriteResult.content, {
      status: 200,
      headers: responseHeaders,
    }),
    upstreamUrl: decodedParams.url,
    contentType: 'application/vnd.apple.mpegurl',
    wasRewritten: true,
    retryInfo,
  };
}

/**
 * Check if a URL is from DLHD CDN (has custom encryption format)
 */
function isDlhdSegment(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname.includes('dvalna.ru') || 
           hostname.includes('soyspace.cyou') || 
           hostname.includes('key.keylocking.ru') ||
           hostname.includes('r2.cloudflarestorage.com');
  } catch {
    return false;
  }
}

/**
 * Handle segment (.ts) proxy request
 * 
 * Client-side decryption: For dvalna.ru segments with strip=1 flag,
 * we strip the 32-byte header and return the encrypted data.
 * The M3U8 has been rewritten with the correct IV, so HLS.js can decrypt natively.
 */
export async function handleSegmentProxy(
  searchParams: URLSearchParams,
  options: ProxyOptions
): Promise<ProxyResult> {
  // Decode proxy parameters
  let decodedParams: DecodedProxyParams;
  try {
    decodedParams = decodeProxyParams(searchParams);
  } catch (error) {
    throw new ProxyError(
      error instanceof Error ? error.message : 'Invalid proxy parameters',
      'MISSING_URL_PARAM',
      400
    );
  }
  
  // SECURITY: Validate the URL is from an expected domain
  // This prevents the proxy from being used to fetch arbitrary URLs
  const allowedSegmentDomains = [
    'dvalna.ru',
    'soyspace.cyou',
    'key.keylocking.ru',
    'allaivideo.fun',
    'cdnlive.fun',
    'r2.cloudflarestorage.com', // New segment CDN (Cloudflare R2)
    'arbitrageai.cc',
  ];
  
  try {
    const hostname = new URL(decodedParams.url).hostname;
    const isAllowedDomain = allowedSegmentDomains.some(domain => 
      hostname === domain || hostname.endsWith('.' + domain)
    );
    
    if (!isAllowedDomain) {
      console.log(`[handleSegmentProxy] Blocked request to unauthorized domain: ${hostname}`);
      throw new ProxyError(
        'Unauthorized upstream domain',
        'INVALID_URL',
        403,
        { hostname }
      );
    }
  } catch (error) {
    if (error instanceof ProxyError) throw error;
    throw new ProxyError(
      'Invalid upstream URL',
      'INVALID_URL',
      400,
      { url: decodedParams.url }
    );
  }
  
  // Build upstream headers
  const upstreamHeaders = buildUpstreamHeaders(decodedParams);
  
  // Check if we need to strip the 32-byte header (dvalna.ru custom format)
  const shouldStripHeader = searchParams.get('strip') === '1';
  
  // For DLHD segments, remove Authorization header (URLs are pre-signed)
  if (shouldStripHeader || isDlhdSegment(decodedParams.url)) {
    delete upstreamHeaders['Authorization'];
    console.log('[handleSegmentProxy] Removed Authorization header for dvalna.ru segment');
  }
  
  // Fetch upstream segment with retry logic
  const { response: upstreamResponse, retryInfo } = await fetchUpstream(
    decodedParams.url,
    upstreamHeaders,
    options.timeout,
    options.retryConfig
  );
  
  if (!upstreamResponse.ok) {
    throw new ProxyError(
      `Upstream returned ${upstreamResponse.status}`,
      'UPSTREAM_ERROR',
      upstreamResponse.status,
      { url: decodedParams.url, attempts: retryInfo.attempts }
    );
  }
  
  // If strip flag is set, remove the 32-byte header from the segment
  // This allows HLS.js to decrypt natively using the IV we put in the M3U8
  if (shouldStripHeader) {
    console.log('[handleSegmentProxy] Stripping 32-byte header for native HLS.js decryption');
    
    // Read the full segment into a buffer
    const segmentBuffer = await upstreamResponse.arrayBuffer();
    const segmentData = new Uint8Array(segmentBuffer);
    
    console.log(`[handleSegmentProxy] Original segment size: ${segmentData.length} bytes`);
    
    // Strip the 32-byte header, return only the encrypted data
    const encryptedData = segmentData.slice(32);
    
    console.log(`[handleSegmentProxy] Stripped segment size: ${encryptedData.length} bytes`);
    
    // Build response headers
    const responseHeaders = buildResponseHeaders(upstreamResponse, {
      'Content-Type': 'video/mp2t',
      'Content-Length': encryptedData.length.toString(),
    });
    
    return {
      response: new Response(encryptedData, {
        status: 200,
        headers: responseHeaders,
      }),
      upstreamUrl: decodedParams.url,
      contentType: 'video/mp2t',
      wasRewritten: false,
      retryInfo,
    };
  }
  
  // No header stripping needed - stream the response body directly (no buffering)
  const responseHeaders = buildResponseHeaders(upstreamResponse, {
    'Content-Type': 'video/mp2t',
  });
  
  return {
    response: new Response(upstreamResponse.body, {
      status: 200,
      headers: responseHeaders,
    }),
    upstreamUrl: decodedParams.url,
    contentType: 'video/mp2t',
    wasRewritten: false,
    retryInfo,
  };
}

/**
 * Handle encryption key proxy request
 * 
 * SECURITY: Keys are sensitive - validate domain and log access
 */
export async function handleKeyProxy(
  searchParams: URLSearchParams,
  options: ProxyOptions
): Promise<ProxyResult> {
  // Decode proxy parameters
  let decodedParams: DecodedProxyParams;
  try {
    decodedParams = decodeProxyParams(searchParams);
  } catch (error) {
    throw new ProxyError(
      error instanceof Error ? error.message : 'Invalid proxy parameters',
      'MISSING_URL_PARAM',
      400
    );
  }
  
  // SECURITY: Validate the key URL is from an expected domain
  const allowedKeyDomains = [
    'dvalna.ru',
    'soyspace.cyou',
    'key.keylocking.ru',
  ];
  
  try {
    const hostname = new URL(decodedParams.url).hostname;
    const isAllowedDomain = allowedKeyDomains.some(domain => 
      hostname === domain || hostname.endsWith('.' + domain)
    );
    
    if (!isAllowedDomain) {
      console.log(`[handleKeyProxy] Blocked key request to unauthorized domain: ${hostname}`);
      throw new ProxyError(
        'Unauthorized key domain',
        'INVALID_URL',
        403,
        { hostname }
      );
    }
  } catch (error) {
    if (error instanceof ProxyError) throw error;
    throw new ProxyError(
      'Invalid key URL',
      'INVALID_URL',
      400,
      { url: decodedParams.url }
    );
  }
  
  // Build upstream headers
  const upstreamHeaders = buildUpstreamHeaders(decodedParams);
  
  // Fetch upstream key with retry logic
  const { response: upstreamResponse, retryInfo } = await fetchUpstream(
    decodedParams.url,
    upstreamHeaders,
    options.timeout,
    options.retryConfig
  );
  
  if (!upstreamResponse.ok) {
    throw new ProxyError(
      `Upstream returned ${upstreamResponse.status}`,
      'UPSTREAM_ERROR',
      upstreamResponse.status,
      { url: decodedParams.url, attempts: retryInfo.attempts }
    );
  }
  
  // Build response headers
  const responseHeaders = buildResponseHeaders(upstreamResponse, {
    'Content-Type': 'application/octet-stream',
  });
  
  // Return the key data
  return {
    response: new Response(upstreamResponse.body, {
      status: 200,
      headers: responseHeaders,
    }),
    upstreamUrl: decodedParams.url,
    contentType: 'application/octet-stream',
    wasRewritten: false,
    retryInfo,
  };
}

/**
 * Generic proxy handler that determines resource type from path
 */
export async function handleProxyRequest(
  path: string,
  searchParams: URLSearchParams,
  options: ProxyOptions
): Promise<ProxyResult> {
  // Determine resource type from path
  // Path can be "m3u8", "/m3u8", "live/m3u8", etc.
  const normalizedPath = path.toLowerCase();
  
  if (normalizedPath === 'm3u8' || normalizedPath.includes('/m3u8') || normalizedPath.endsWith('.m3u8')) {
    return handleM3U8Proxy(searchParams, options);
  }
  
  if (normalizedPath === 'key' || normalizedPath.includes('/key') || normalizedPath.endsWith('.key')) {
    return handleKeyProxy(searchParams, options);
  }
  
  if (normalizedPath === 'ts' || normalizedPath.includes('/ts') || normalizedPath.endsWith('.ts')) {
    return handleSegmentProxy(searchParams, options);
  }
  
  // Default to segment proxy for unknown types
  return handleSegmentProxy(searchParams, options);
}

/**
 * Check if headers contain required upstream headers
 */
export function hasRequiredHeaders(
  headers: Record<string, string>,
  required: string[]
): boolean {
  const headerKeys = Object.keys(headers).map(k => k.toLowerCase());
  return required.every(r => headerKeys.includes(r.toLowerCase()));
}

/**
 * Get missing required headers
 */
export function getMissingHeaders(
  headers: Record<string, string>,
  required: string[]
): string[] {
  const headerKeys = Object.keys(headers).map(k => k.toLowerCase());
  return required.filter(r => !headerKeys.includes(r.toLowerCase()));
}
