/**
 * Shared utilities for Cloudflare Worker proxy modules
 *
 * Centralizes duplicated logic across hianime-proxy, animekai-proxy, and stream-proxy:
 * - MegaUp/AnimeKai CDN domain detection
 * - CORS helpers
 * - JSON response builder
 * - HLS playlist URL rewriting
 * - Stream response building (content-type detection, CORS, caching)
 */

// ============================================================================
// MegaUp / AnimeKai CDN Domain Detection
// ============================================================================

/**
 * Known MegaUp and AnimeKai CDN domain fragments.
 * These CDNs block datacenter IPs and/or Origin headers.
 * Domains rotate frequently — update this single list when new ones appear.
 */
const MEGAUP_CDN_FRAGMENTS = [
  'megaup',
  'hub26link',
  'app28base',
  'dev23app',
  'net22lab',
  'pro25zone',
  'tech20hub',
  'code29wave',
  '4spromax',
];

/**
 * Check if a URL belongs to MegaUp or AnimeKai CDN.
 * These CDNs block requests with Origin headers and/or datacenter IPs.
 */
export function isMegaUpCdn(url: string): boolean {
  return MEGAUP_CDN_FRAGMENTS.some(frag => url.includes(frag));
}

// ============================================================================
// CORS + JSON Helpers
// ============================================================================

/**
 * Convert Headers object to a plain key-value object.
 * CF Workers Headers class doesn't implement iterable in TS types,
 * so we iterate manually.
 */
export function headersToObject(headers: Headers): Record<string, string> {
  const obj: Record<string, string> = {};
  headers.forEach((value, key) => { obj[key] = value; });
  return obj;
}

export function corsHeaders(_request?: Request): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
  };
}

export function jsonResponse(data: object, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

// ============================================================================
// HLS Playlist Rewriting
// ============================================================================

/**
 * Rewrite HLS playlist URLs to route segments through a proxy endpoint.
 *
 * @param playlist - Raw M3U8 playlist text
 * @param baseUrl - Original URL the playlist was fetched from (for resolving relative URLs)
 * @param proxyOrigin - The proxy worker's origin (e.g., https://media-proxy.vynx-3b3.workers.dev)
 * @param proxyPath - The proxy route path (e.g., '/hianime/stream' or '/animekai')
 */
export function rewritePlaylistUrls(
  playlist: string,
  baseUrl: string,
  proxyOrigin: string,
  proxyPath: string,
): string {
  const lines = playlist.split('\n');
  const rewritten: string[] = [];
  const base = new URL(baseUrl);
  const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);

  const proxyUrl = (url: string): string => {
    let absoluteUrl: string;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      absoluteUrl = url;
    } else if (url.startsWith('/')) {
      absoluteUrl = `${base.origin}${url}`;
    } else {
      absoluteUrl = `${base.origin}${basePath}${url}`;
    }
    return `${proxyOrigin}${proxyPath}?url=${encodeURIComponent(absoluteUrl)}`;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Handle HLS tags with URIs — includes #EXT-X-KEY so decryption keys
    // are proxied through the worker instead of fetched directly by the browser.
    if (line.startsWith('#EXT-X-MEDIA:') || line.startsWith('#EXT-X-I-FRAME-STREAM-INF:') || line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      // Try quoted URI first: URI="https://..."
      const quotedMatch = line.match(/URI="([^"]+)"/);
      if (quotedMatch) {
        rewritten.push(line.replace(`URI="${quotedMatch[1]}"`, `URI="${proxyUrl(quotedMatch[1])}"`));
      } else {
        // Try unquoted URI: URI=https://... (valid per HLS spec, common on some CDNs)
        const unquotedMatch = line.match(/URI=([^\s,]+)/);
        if (unquotedMatch) {
          rewritten.push(line.replace(`URI=${unquotedMatch[1]}`, `URI="${proxyUrl(unquotedMatch[1])}"`));
        } else {
          rewritten.push(line);
        }
      }
      continue;
    }

    // Keep comments and empty lines
    if (line.startsWith('#') || trimmed === '') {
      rewritten.push(line);
      continue;
    }

    try {
      rewritten.push(proxyUrl(trimmed));
    } catch {
      rewritten.push(line);
    }
  }

  return rewritten.join('\n');
}

// ============================================================================
// Stream Response Building
// ============================================================================

/**
 * Detect the actual content type from response body magic bytes.
 */
export function detectContentType(body: ArrayBuffer, headerContentType: string): string {
  const firstBytes = new Uint8Array(body.slice(0, 4));
  const isMpegTs = firstBytes[0] === 0x47;
  const isFmp4 = firstBytes[0] === 0x00 && firstBytes[1] === 0x00 && firstBytes[2] === 0x00;

  if (isMpegTs) return 'video/mp2t';
  if (isFmp4) return 'video/mp4';
  return headerContentType || 'application/octet-stream';
}

/**
 * Build a proxied stream response — handles both HLS playlists and binary segments.
 *
 * For playlists: rewrites URLs and returns text with short cache.
 * For segments: detects content type from magic bytes and returns binary with long cache.
 */
export function buildStreamResponse(
  body: ArrayBuffer,
  contentType: string,
  originalUrl: string,
  proxyOrigin: string,
  proxyPath: string,
  via: string,
): Response {
  // Check if this is a playlist that needs URL rewriting
  if (contentType.includes('mpegurl') || originalUrl.includes('.m3u8')) {
    const text = new TextDecoder().decode(body);
    const rewritten = rewritePlaylistUrls(text, originalUrl, proxyOrigin, proxyPath);

    return new Response(rewritten, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'public, max-age=5',
        'X-Proxied-Via': via,
        ...corsHeaders(),
      },
    });
  }

  // Binary segment — detect actual content type
  const actualContentType = detectContentType(body, contentType);

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': actualContentType,
      'Content-Length': body.byteLength.toString(),
      'Cache-Control': 'public, max-age=3600',
      'X-Proxied-Via': via,
      ...corsHeaders(),
    },
  });
}

/**
 * Build a proxied stream response from a fetch Response object.
 * Reads the body and delegates to buildStreamResponse.
 */
export async function buildStreamResponseFromFetch(
  response: Response,
  originalUrl: string,
  proxyOrigin: string,
  proxyPath: string,
  via: string,
): Promise<Response> {
  const contentType = response.headers.get('content-type') || '';
  const body = await response.arrayBuffer();
  return buildStreamResponse(body, contentType, originalUrl, proxyOrigin, proxyPath, via);
}
