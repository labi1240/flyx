/**
 * PrimeSrc Proxy Handler
 *
 * Extracts streams from PrimeSrc (primesrc.me) via its underlying providers.
 *
 * Architecture (NEW — browser-side Turnstile + CF Worker):
 *   1. /primesrc/servers  — Calls /api/v1/s to get server list (no auth)
 *   2. /primesrc/resolve  — Takes key + turnstileToken from browser, calls /api/v1/l, returns embed link
 *   3. /primesrc/embed    — Extracts stream URL from embed page (Filemoon, Streamtape, Voe, etc.)
 *   4. /primesrc/extract  — Full extraction: server list + resolve + embed (requires turnstileToken)
 *   5. /primesrc/stream   — Proxies m3u8/ts segments with correct referer
 *   6. /primesrc/health   — Health check
 *
 * The browser solves Cloudflare Turnstile (sitekey 0x4AAAAAACox-LngVREu55Y4) and passes
 * the token to the CF Worker. The worker then calls /api/v1/l to get embed links for ALL
 * 14+ servers, not just PrimeVid.
 */

import { createLogger, type LogLevel } from './logger';
import { getCfClearance, invalidateCfClearance, hasCachedSession, getSessionCacheSize } from './turnstile-client';

export interface Env {
  LOG_LEVEL?: string;
}

const PRIMESRC_BASE = 'https://primesrc.me';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

interface PrimeSrcServer {
  name: string;
  key: string;
  quality: string | null;
  file_size: string | null;
  file_name: string | null;
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data: object, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function fetchText(url: string, referer?: string, timeout = 15000): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(referer ? { 'Referer': referer } : {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ============================================================================
// SERVER LIST (no auth)
// ============================================================================
async function fetchServerList(
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: string,
  episode?: string,
): Promise<PrimeSrcServer[]> {
  let url = `${PRIMESRC_BASE}/api/v1/s?type=${type}&tmdb=${tmdbId}`;
  if (type === 'tv' && season && episode) {
    url += `&season=${season}&episode=${episode}`;
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Server list API returned ${res.status}`);
  const data = await res.json() as { servers: PrimeSrcServer[] };
  return data.servers || [];
}

// ============================================================================
// LINK RESOLUTION (authenticated session or browser token)
// ============================================================================

/**
 * Resolve a PrimeSrc server key to an embed link via /api/v1/l.
 *
 * PRIMARY PATH: Uses cf_clearance cookie from HTTP Turnstile solver.
 * FALLBACK: Uses browser-provided Turnstile widget token.
 */
async function resolveLink(key: string, turnstileToken?: string): Promise<string> {
  let url: string;
  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Accept': 'application/json',
    'Referer': `${PRIMESRC_BASE}/`,
    'Origin': PRIMESRC_BASE,
  };

  // Try cf_clearance from HTTP solver first
  const cfClearance = await getCfClearance('primesrc');
  if (cfClearance) {
    url = `${PRIMESRC_BASE}/api/v1/l?key=${encodeURIComponent(key)}`;
    headers['Cookie'] = `cf_clearance=${cfClearance}`;

    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json() as { link?: string };
        if (data.link) {
          console.log(`[PrimeSrc] ✅ Resolved ${key} via cf_clearance (HTTP solver)`);
          return data.link;
        }
      }
      if (res.status === 403) {
        // cf_clearance rejected — invalidate and don't retry with it
        console.log('[PrimeSrc] cf_clearance rejected by /api/v1/l, invalidating');
        invalidateCfClearance('primesrc');
      }
    } catch (e) {
      console.log(`[PrimeSrc] cf_clearance attempt failed: ${(e as Error).message}`);
    }
  }

  // Fallback: use browser-provided Turnstile token
  if (turnstileToken) {
    url = `${PRIMESRC_BASE}/api/v1/l?key=${encodeURIComponent(key)}&token=${encodeURIComponent(turnstileToken)}`;
    delete headers['Cookie']; // Don't send cookie with token
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`/api/v1/l returned ${res.status}: ${text.substring(0, 200)}`);
    }
    const data = await res.json() as { link?: string };
    if (!data.link) throw new Error('No link in /api/v1/l response');
    return data.link;
  }

  throw new Error('No Turnstile token or cf_clearance available for /api/v1/l');
}

/**
 * Try to resolve a link using the HTTP Turnstile solver only.
 * Returns null if cf_clearance + direct /api/v1/l doesn't work.
 */
async function resolveLinkWithTurnstile(key: string): Promise<string | null> {
  try {
    return await resolveLink(key, undefined);
  } catch {
    return null;
  }
}

// ============================================================================
// EMBED EXTRACTORS — extract stream URLs from embed pages
// ============================================================================

interface ExtractedStream {
  url: string;
  quality: string;
  type: 'hls' | 'mp4';
  referer: string;
}

/**
 * Extract stream from Filemoon embed page.
 * Filemoon uses eval(function(p,a,c,k,e,d){...}) packed JS with HLS URL inside.
 */
async function extractFilemoon(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const html = await fetchText(embedUrl, 'https://primesrc.me/');
    // Filemoon packs the player JS — look for the m3u8 URL in the packed code
    const m3u8Match = html.match(/file\s*:\s*["'](https?:\/\/[^"']*\.m3u8[^"']*)["']/i)
      || html.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*["'](https?:\/\/[^"']*\.m3u8[^"']*)["']/i);
    if (m3u8Match) {
      return { url: m3u8Match[1], quality: 'auto', type: 'hls', referer: new URL(embedUrl).origin + '/' };
    }
    // Try packed JS extraction
    const packedMatch = html.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\('(.*?)',\d+,\d+,'(.*?)'\.split/s);
    if (packedMatch) {
      const dict = packedMatch[2].split('|');
      const m3u8InDict = dict.find(w => w.includes('m3u8'));
      if (m3u8InDict) {
        // Reconstruct URL from packed dict
        const urlParts = dict.filter(w => w.length > 0);
        const hlsUrl = urlParts.find(p => p.startsWith('http') && p.includes('m3u8'));
        if (hlsUrl) return { url: hlsUrl, quality: 'auto', type: 'hls', referer: new URL(embedUrl).origin + '/' };
      }
    }
    // Fallback: search for any m3u8 URL in the page
    const anyM3u8 = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
    if (anyM3u8) return { url: anyM3u8[1], quality: 'auto', type: 'hls', referer: new URL(embedUrl).origin + '/' };
    return null;
  } catch { return null; }
}

/**
 * Extract stream from Streamtape embed page.
 * Streamtape uses a split token approach: part of the URL is in a hidden div,
 * the rest is constructed via JS.
 */
async function extractStreamtape(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const html = await fetchText(embedUrl, 'https://primesrc.me/');
    // Streamtape pattern: document.getElementById('robotlink').innerHTML = '...' + token
    const linkMatch = html.match(/id\s*=\s*["']robotlink["'][^>]*>([^<]+)/i);
    const tokenMatch = html.match(/token\s*=\s*["']([^"']+)["']/i)
      || html.match(/\.substring\(\d+\)\s*\+\s*["']([^"']+)["']/i);
    if (linkMatch) {
      let streamUrl = linkMatch[1].trim();
      if (tokenMatch) streamUrl += tokenMatch[1];
      if (streamUrl.startsWith('//')) streamUrl = 'https:' + streamUrl;
      if (streamUrl.includes('/get_video')) {
        return { url: streamUrl, quality: 'auto', type: 'mp4', referer: 'https://streamtape.com/' };
      }
    }
    // Alternative pattern
    const altMatch = html.match(/document\.getElementById\('(?:norobotlink|robotlink)'\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*\('([^']+)'\)/);
    if (altMatch) {
      let url = altMatch[1] + altMatch[2];
      if (url.startsWith('//')) url = 'https:' + url;
      return { url, quality: 'auto', type: 'mp4', referer: 'https://streamtape.com/' };
    }
    return null;
  } catch { return null; }
}

/**
 * Extract stream from Voe embed page.
 * Voe typically has the m3u8 URL directly in the page source or in a JS variable.
 */
async function extractVoe(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const html = await fetchText(embedUrl, 'https://primesrc.me/');
    // Voe patterns
    const m3u8Match = html.match(/['"]hls['"]\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i)
      || html.match(/source\s*=\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i)
      || html.match(/file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
    if (m3u8Match) {
      return { url: m3u8Match[1], quality: 'auto', type: 'hls', referer: new URL(embedUrl).origin + '/' };
    }
    // MP4 fallback
    const mp4Match = html.match(/['"]mp4['"]\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i)
      || html.match(/source\s*=\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
    if (mp4Match) {
      return { url: mp4Match[1], quality: 'auto', type: 'mp4', referer: new URL(embedUrl).origin + '/' };
    }
    // Any m3u8 in page
    const anyM3u8 = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
    if (anyM3u8) return { url: anyM3u8[1], quality: 'auto', type: 'hls', referer: new URL(embedUrl).origin + '/' };
    return null;
  } catch { return null; }
}

/**
 * Extract stream from Mixdrop embed page.
 * Mixdrop uses eval-packed JS with the video URL inside.
 */
async function extractMixdrop(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const html = await fetchText(embedUrl, 'https://primesrc.me/');
    // Mixdrop pattern: MDCore.wurl = "//..."
    const wurlMatch = html.match(/MDCore\.wurl\s*=\s*["'](\/\/[^"']+)["']/i)
      || html.match(/wurl\s*=\s*["'](\/\/[^"']+)["']/i);
    if (wurlMatch) {
      return { url: 'https:' + wurlMatch[1], quality: 'auto', type: 'mp4', referer: 'https://mixdrop.ag/' };
    }
    // Alternative: look in packed JS
    const packedMatch = html.match(/eval\(function\(p,a,c,k,e,d\).*?split\('\|'\)/s);
    if (packedMatch) {
      const dictMatch = packedMatch[0].match(/'([^']+)'\s*\.split\('\|'\)/);
      if (dictMatch) {
        const dict = dictMatch[1].split('|');
        // Look for delivery URL pattern
        const deliveryParts = dict.filter(w => w.includes('delivery') || w.includes('mxdcontent'));
        if (deliveryParts.length > 0) {
          const urlCandidate = dict.find(w => w.startsWith('http') || w.startsWith('//'));
          if (urlCandidate) {
            const url = urlCandidate.startsWith('//') ? 'https:' + urlCandidate : urlCandidate;
            return { url, quality: 'auto', type: 'mp4', referer: 'https://mixdrop.ag/' };
          }
        }
      }
    }
    return null;
  } catch { return null; }
}

/**
 * Extract stream from Streamwish/Filelions/Luluvdoo embed pages.
 * These all use similar packed JS patterns with m3u8 URLs.
 */
async function extractGenericHls(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const html = await fetchText(embedUrl, 'https://primesrc.me/');
    const referer = new URL(embedUrl).origin + '/';
    // Direct m3u8 in source
    const m3u8Match = html.match(/file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i)
      || html.match(/sources\s*:\s*\[\s*\{\s*(?:file|src)\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
    if (m3u8Match) return { url: m3u8Match[1], quality: 'auto', type: 'hls', referer };
    // Any m3u8 URL
    const anyM3u8 = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
    if (anyM3u8) return { url: anyM3u8[1], quality: 'auto', type: 'hls', referer };
    // MP4 fallback
    const mp4Match = html.match(/file\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
    if (mp4Match) return { url: mp4Match[1], quality: 'auto', type: 'mp4', referer };
    return null;
  } catch { return null; }
}

/**
 * Extract stream from Dood embed page.
 * Dood uses a token-based approach with /pass_md5/ endpoint.
 */
async function extractDood(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const html = await fetchText(embedUrl, 'https://primesrc.me/');
    const origin = new URL(embedUrl).origin;
    // Find the pass_md5 path
    const passMatch = html.match(/\/pass_md5\/([^'"]+)/);
    if (!passMatch) return null;
    const passUrl = `${origin}/pass_md5/${passMatch[1]}`;
    const tokenRes = await fetch(passUrl, {
      headers: { 'User-Agent': UA, 'Referer': embedUrl },
      signal: AbortSignal.timeout(10000),
    });
    if (!tokenRes.ok) return null;
    const directUrl = await tokenRes.text();
    if (directUrl && directUrl.startsWith('http')) {
      // Dood appends a random string + expiry
      const finalUrl = directUrl + '?token=' + passMatch[1].split('/').pop() + '&expiry=' + Date.now();
      return { url: finalUrl, quality: 'auto', type: 'mp4', referer: origin + '/' };
    }
    return null;
  } catch { return null; }
}

/**
 * Extract stream from Vidmoly embed page.
 */
async function extractVidmoly(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const html = await fetchText(embedUrl, 'https://primesrc.me/');
    const referer = new URL(embedUrl).origin + '/';
    const m3u8Match = html.match(/file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i)
      || html.match(/sources\s*:\s*\[\s*\{\s*(?:file|src)\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
    if (m3u8Match) return { url: m3u8Match[1], quality: 'auto', type: 'hls', referer };
    const anyM3u8 = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
    if (anyM3u8) return { url: anyM3u8[1], quality: 'auto', type: 'hls', referer };
    return null;
  } catch { return null; }
}

/**
 * Route an embed URL to the correct extractor based on domain/server name.
 */
async function extractFromEmbed(embedUrl: string, serverName: string): Promise<ExtractedStream | null> {
  const host = new URL(embedUrl).hostname.toLowerCase();
  const name = serverName.toLowerCase();

  // Route to specific extractor
  if (name.includes('filemoon') || host.includes('filemoon')) return extractFilemoon(embedUrl);
  if (name.includes('streamtape') || host.includes('streamtape')) return extractStreamtape(embedUrl);
  if (name.includes('voe') || host.includes('voe')) return extractVoe(embedUrl);
  if (name.includes('mixdrop') || host.includes('mixdrop')) return extractMixdrop(embedUrl);
  if (name.includes('dood') || host.includes('dood') || host.includes('d0o0d') || host.includes('ds2play')) return extractDood(embedUrl);
  if (name.includes('vidmoly') || host.includes('vidmoly')) return extractVidmoly(embedUrl);
  if (name.includes('streamwish') || host.includes('streamwish') || host.includes('swish')) return extractGenericHls(embedUrl);
  if (name.includes('filelions') || host.includes('filelions')) return extractGenericHls(embedUrl);
  if (name.includes('luluvdoo') || host.includes('luluvdo')) return extractGenericHls(embedUrl);
  if (name.includes('vidnest') || host.includes('vidnest')) return extractGenericHls(embedUrl);
  if (name.includes('streamplay') || host.includes('streamplay')) return extractGenericHls(embedUrl);

  // Generic fallback: try to find any m3u8/mp4 in the page
  return extractGenericHls(embedUrl);
}

// ============================================================================
// PLAYLIST REWRITING
// ============================================================================
function rewritePlaylist(manifest: string, originalUrl: string): string {
  const baseUrl = originalUrl.substring(0, originalUrl.lastIndexOf('/') + 1);
  const lines = manifest.split('\n');

  return lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      if (trimmed.includes('URI="')) {
        return trimmed.replace(
          /URI="([^"]+)"/g,
          (_match, keyUrl) => {
            const absUrl = keyUrl.startsWith('http') ? keyUrl : new URL(keyUrl, baseUrl).toString();
            return `URI="/primesrc/stream?url=${encodeURIComponent(absUrl)}"`;
          },
        );
      }
      return line;
    }
    if (trimmed.startsWith('/primesrc/')) return line;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return `/primesrc/stream?url=${encodeURIComponent(trimmed)}`;
    }
    const absoluteUrl = new URL(trimmed, baseUrl).toString();
    return `/primesrc/stream?url=${encodeURIComponent(absoluteUrl)}`;
  }).join('\n');
}

// ============================================================================
// STREAM PROXY
// ============================================================================
async function proxyStream(url: string, refererOverride?: string): Promise<Response> {
  let referer = refererOverride || 'https://primesrc.me/';
  try {
    if (!refererOverride) {
      const host = new URL(url).hostname;
      referer = `https://${host}/`;
    }
  } catch {}

  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': referer,
  };

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.log(`[PrimeSrc] Stream proxy failed: ${res.status} for ${url.substring(0, 80)}`);
      return jsonResponse({ error: `Upstream returned ${res.status}` }, 502);
    }

    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const body = await res.arrayBuffer();

    if (contentType.includes('mpegurl') || url.includes('.m3u8')) {
      let manifest = new TextDecoder().decode(body);
      manifest = rewritePlaylist(manifest, url);
      return new Response(manifest, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'X-Proxied-Via': 'cf-direct',
          ...corsHeaders(),
        },
      });
    }

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': body.byteLength.toString(),
        'Cache-Control': 'public, max-age=3600',
        'X-Proxied-Via': 'cf-direct',
        ...corsHeaders(),
      },
    });
  } catch (e) {
    console.log(`[PrimeSrc] Stream proxy error: ${e instanceof Error ? e.message : e}`);
    return jsonResponse({ error: 'Stream proxy failed' }, 502);
  }
}

// ============================================================================
// MAIN REQUEST HANDLER
// ============================================================================
export async function handlePrimeSrcRequest(request: Request, _env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // ── Health check ──────────────────────────────────────────────
  if (path === '/primesrc/health' || path.endsWith('/health')) {
    try {
      const testRes = await fetch(`${PRIMESRC_BASE}/api/v1/s?type=movie&tmdb=550`, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      const testData = await testRes.json() as { servers: PrimeSrcServer[] };
      return jsonResponse({
        status: testRes.ok && testData.servers?.length > 0 ? 'ok' : 'degraded',
        serverCount: testData.servers?.length || 0,
        apiReachable: testRes.ok,
        turnstileSessions: getSessionCacheSize(),
        hasTurnstileSession: hasCachedSession('primesrc'),
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      return jsonResponse({
        status: 'down',
        error: e instanceof Error ? e.message : String(e),
        timestamp: new Date().toISOString(),
      }, 503);
    }
  }

  // ── Server list (no auth) ─────────────────────────────────────
  if (path === '/primesrc/servers') {
    const tmdbId = url.searchParams.get('tmdbId');
    const type = (url.searchParams.get('type') || 'movie') as 'movie' | 'tv';
    const season = url.searchParams.get('season') || undefined;
    const episode = url.searchParams.get('episode') || undefined;

    if (!tmdbId) return jsonResponse({ error: 'Missing tmdbId' }, 400);
    if (type === 'tv' && (!season || !episode)) {
      return jsonResponse({ error: 'Season and episode required for TV' }, 400);
    }

    try {
      const start = Date.now();
      const servers = await fetchServerList(tmdbId, type, season, episode);
      return jsonResponse({
        success: true,
        servers,
        count: servers.length,
        duration_ms: Date.now() - start,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      return jsonResponse({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }, 500);
    }
  }

  // ── Resolve link (HTTP solver or browser token) ─────────────
  if (path === '/primesrc/resolve') {
    const key = url.searchParams.get('key');
    const turnstileToken = url.searchParams.get('token') || undefined;
    const serverName = url.searchParams.get('server') || 'unknown';

    if (!key) {
      return jsonResponse({ error: 'Missing key' }, 400);
    }

    try {
      const start = Date.now();
      const embedLink = await resolveLink(key, turnstileToken);
      const source = turnstileToken ? 'browser-token' : 'turnstile-http';
      console.log(`[PrimeSrc] Resolved ${serverName} (${key}) via ${source}: ${embedLink.substring(0, 80)}`);
      return jsonResponse({
        success: true,
        link: embedLink,
        server: serverName,
        source,
        duration_ms: Date.now() - start,
      });
    } catch (e) {
      return jsonResponse({
        success: false,
        error: e instanceof Error ? e.message : String(e),
        server: serverName,
      }, 500);
    }
  }

  // ── Extract stream from embed URL ─────────────────────────────
  if (path === '/primesrc/embed') {
    const embedUrl = url.searchParams.get('url');
    const serverName = url.searchParams.get('server') || 'unknown';

    if (!embedUrl) return jsonResponse({ error: 'Missing url' }, 400);

    try {
      const start = Date.now();
      const stream = await extractFromEmbed(embedUrl, serverName);
      if (!stream) {
        return jsonResponse({ success: false, error: `No stream found in ${serverName} embed` }, 404);
      }
      const proxiedUrl = stream.type === 'hls'
        ? `/primesrc/stream?url=${encodeURIComponent(stream.url)}`
        : stream.url; // MP4s can be played directly or proxied
      return jsonResponse({
        success: true,
        stream: { ...stream, proxied_url: proxiedUrl },
        server: serverName,
        duration_ms: Date.now() - start,
      });
    } catch (e) {
      return jsonResponse({
        success: false,
        error: e instanceof Error ? e.message : String(e),
        server: serverName,
      }, 500);
    }
  }

  // ── Full extraction (servers + resolve + embed) ───────────────
  if (path === '/primesrc/extract' || path === '/primesrc') {
    const tmdbId = url.searchParams.get('tmdbId');
    const type = (url.searchParams.get('type') || 'movie') as 'movie' | 'tv';
    const season = url.searchParams.get('season') || undefined;
    const episode = url.searchParams.get('episode') || undefined;
    const turnstileToken = url.searchParams.get('token') || undefined;

    if (!tmdbId) return jsonResponse({ error: 'Missing tmdbId' }, 400);
    if (type === 'tv' && (!season || !episode)) {
      return jsonResponse({ error: 'Season and episode required for TV' }, 400);
    }

    const start = Date.now();

    try {
      // Step 1: Get server list
      const servers = await fetchServerList(tmdbId, type, season, episode).catch(() => [] as PrimeSrcServer[]);

      if (servers.length === 0) {
        return jsonResponse({ success: false, sources: [], error: 'No servers found' }, 200);
      }

      // Step 2: If we have a Turnstile token, resolve ALL servers in parallel
      const sources: Array<{
        server: string;
        quality: string;
        url?: string;
        proxied_url?: string;
        type?: string;
        referer?: string;
        file_name?: string;
        file_size?: string;
        error?: string;
      }> = [];

      if (turnstileToken) {
        // Resolve all servers in parallel (max 6 concurrent to avoid rate limits)
        const BATCH_SIZE = 6;
        for (let i = 0; i < servers.length; i += BATCH_SIZE) {
          const batch = servers.slice(i, i + BATCH_SIZE);
          const results = await Promise.allSettled(
            batch.map(async (server) => {
              try {
                // Resolve embed link
                const embedLink = await resolveLink(server.key, turnstileToken);
                // Extract stream from embed
                const stream = await extractFromEmbed(embedLink, server.name);
                if (stream) {
                  const proxiedUrl = stream.type === 'hls'
                    ? `/primesrc/stream?url=${encodeURIComponent(stream.url)}`
                    : stream.url;
                  return {
                    server: server.name,
                    quality: server.quality || stream.quality || 'auto',
                    url: stream.url,
                    proxied_url: proxiedUrl,
                    type: stream.type,
                    referer: stream.referer,
                    file_name: server.file_name || undefined,
                    file_size: server.file_size || undefined,
                  };
                }
                return {
                  server: server.name,
                  quality: server.quality || 'auto',
                  error: 'No stream in embed page',
                };
              } catch (e) {
                return {
                  server: server.name,
                  quality: server.quality || 'auto',
                  error: e instanceof Error ? e.message : String(e),
                };
              }
            })
          );

          for (const r of results) {
            if (r.status === 'fulfilled') sources.push(r.value);
          }
        }
      } else {
        // No browser Turnstile token — try HTTP solver cf_clearance for hosts
        // that need /api/v1/l, and direct extraction for known hosts.
        //
        // Known direct-key hosts (verified working WITHOUT /api/v1/l):
        //   Filemoon, Dood, Streamwish, Filelions, Mixdrop, Vidmoly,
        //   Luluvdoo, Streamplay, Vidara, VidsST, Savefiles, Vinovo
        // Hosts that need /api/v1/l (try cf_clearance from HTTP solver):
        //   Streamtape, Voe
        const DIRECT_HOSTS: Record<string, string> = {
          filemoon: 'https://filemoon.sx/e/{key}',
          dood: 'https://dood.wf/e/{key}',
          streamwish: 'https://streamwish.com/e/{key}',
          filelions: 'https://filelions.sx/e/{key}',
          mixdrop: 'https://mixdrop.ag/e/{key}',
          vidmoly: 'https://vidmoly.to/e/{key}',
          luluvdoo: 'https://luluvdoo.com/e/{key}',
          streamplay: 'https://streamplay.cc/e/{key}',
          vidara: 'https://vidara.online/e/{key}',
          vidsst: 'https://vidsst.com/e/{key}',
          savefiles: 'https://savefiles.com/e/{key}',
          vinovo: 'https://vinovo.si/e/{key}',
        };

        // Try direct extraction for hosts we know (max 8 concurrent)
        const directResults = await Promise.allSettled(
          servers.map(async (s) => {
            const name = s.name.toLowerCase();

            // Try HTTP Turnstile solver for hosts that need /api/v1/l
            if (name.includes('streamtape') || name.includes('voe')) {
              try {
                const embedLink = await resolveLinkWithTurnstile(s.key);
                if (embedLink) {
                  const stream = await extractFromEmbed(embedLink, s.name);
                  if (stream) {
                    return {
                      server: s.name, quality: s.quality || stream.quality || 'auto',
                      url: stream.url,
                      proxied_url: stream.type === 'hls'
                        ? `/primesrc/stream?url=${encodeURIComponent(stream.url)}`
                        : stream.url,
                      type: stream.type, referer: stream.referer,
                      file_name: s.file_name || undefined, file_size: s.file_size || undefined,
                    };
                  }
                  return { server: s.name, quality: s.quality || 'auto', error: 'No stream in embed page', file_name: s.file_name || undefined, file_size: s.file_size || undefined };
                }
              } catch {
                // HTTP solver failed — will return metadata only
              }
              return { server: s.name, quality: s.quality || 'auto', file_name: s.file_name || undefined, file_size: s.file_size || undefined };
            }
            // Check direct host mapping
            for (const [hostPattern, urlTemplate] of Object.entries(DIRECT_HOSTS)) {
              if (name.includes(hostPattern)) {
                try {
                  const embedUrl = urlTemplate.replace('{key}', s.key);
                  const stream = await extractFromEmbed(embedUrl, s.name);
                  if (stream) {
                    return {
                      server: s.name, quality: s.quality || stream.quality || 'auto',
                      url: stream.url,
                      proxied_url: stream.type === 'hls'
                        ? `/primesrc/stream?url=${encodeURIComponent(stream.url)}`
                        : stream.url,
                      type: stream.type, referer: stream.referer,
                      file_name: s.file_name || undefined, file_size: s.file_size || undefined,
                    };
                  }
                  return { server: s.name, quality: s.quality || 'auto', error: 'No stream found', file_name: s.file_name || undefined, file_size: s.file_size || undefined };
                } catch {
                  return { server: s.name, quality: s.quality || 'auto', error: 'Direct extraction failed', file_name: s.file_name || undefined, file_size: s.file_size || undefined };
                }
              }
            }
            // Unknown host — return metadata only
            return { server: s.name, quality: s.quality || 'auto', file_name: s.file_name || undefined, file_size: s.file_size || undefined };
          })
        );

        for (const r of directResults) {
          if (r.status === 'fulfilled') sources.push(r.value);
        }
      }

      const playable = sources.filter(s => s.url);
      return jsonResponse({
        success: playable.length > 0,
        sources,
        serverCount: servers.length,
        playableSources: playable.length,
        hasTurnstileToken: !!turnstileToken,
        hasTurnstileHttpSolver: hasCachedSession('primesrc'),
        turnstileSessions: getSessionCacheSize(),
        duration_ms: Date.now() - start,
        timestamp: new Date().toISOString(),
      }, 200); // Always 200 — caller inspects success/sources, not status code
    } catch (e) {
      return jsonResponse({
        success: false,
        error: e instanceof Error ? e.message : String(e),
        duration_ms: Date.now() - start,
      }, 500);
    }
  }

  // ── Stream proxy ──────────────────────────────────────────────
  if (path === '/primesrc/stream') {
    const streamUrl = url.searchParams.get('url');
    const referer = url.searchParams.get('referer') || undefined;
    if (!streamUrl) return jsonResponse({ error: 'Missing url parameter' }, 400);

    try {
      return await proxyStream(streamUrl, referer);
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  return jsonResponse({
    error: 'Unknown PrimeSrc route',
    routes: [
      '/primesrc/extract',
      '/primesrc/resolve',
      '/primesrc/embed',
      '/primesrc/servers',
      '/primesrc/stream',
      '/primesrc/health',
    ],
  }, 404);
}
