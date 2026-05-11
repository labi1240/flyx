/**
 * Flixer CDN Proxy Service Worker
 *
 * Intercepts requests to Flixer CDN domains and proxies them through the
 * browser's own IP. The browser's residential IP is NOT blocked by the
 * Flixer CDN (only CF Worker egress IPs are blocked).
 *
 * Adds Access-Control-Allow-Origin: * to responses that lack CORS headers,
 * fixing cross-origin issues for m3u8, segments, and keys.
 *
 * Zero external infrastructure — the user's browser IS the proxy.
 */

// Domains that are Flixer CDNs (need proxying + CORS fix)
const FLIXER_CDN_PATTERNS = [
  /frostcomet\./,
  /thunderleaf\./,
  /skyember\./,
  /nightbreeze\./,
];

// Our own infrastructure — NEVER intercept
const OWN_DOMAINS = [
  /vynx-3b3\.workers\.dev/,
  /vynx\.cc/,
  /media-proxy\./,
  /flyx-main/,
  /dlhd\./,
  /flyx-sync/,
  /cdn-live-extractor/,
];

function isFlixerCdn(url: string): boolean {
  // Never intercept our own services
  if (OWN_DOMAINS.some(p => p.test(url))) return false;
  // Flixer-specific CDN patterns
  if (FLIXER_CDN_PATTERNS.some(p => p.test(url))) return true;
  // Catch-all: any *.workers.dev NOT matching our domains is likely a Flixer CDN
  if (/\.workers\.dev\//.test(url)) return true;
  return false;
}

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = event.request.url;
  if (!isFlixerCdn(url)) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(proxyFlixerCdn(url));
});

async function proxyFlixerCdn(url: string): Promise<Response> {
  const cdnHeaders: Record<string, string> = {
    'User-Agent': navigator.userAgent,
    'Accept': '*/*',
    'Referer': 'https://flixer.su/',
  };

  try {
    const cdnResponse = await fetch(url, { headers: cdnHeaders });

    const headers = new Headers(cdnResponse.headers);
    if (!headers.has('Access-Control-Allow-Origin')) {
      headers.set('Access-Control-Allow-Origin', '*');
    }
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');

    const isPlaylist = url.includes('.m3u8') ||
      (headers.get('Content-Type') || '').includes('mpegurl');
    if (!headers.has('Cache-Control')) {
      headers.set('Cache-Control', isPlaylist ? 'public, max-age=5' : 'public, max-age=3600');
    }

    return new Response(cdnResponse.body, {
      status: cdnResponse.status,
      statusText: cdnResponse.statusText,
      headers,
    });
  } catch (err) {
    console.warn('[Flixer SW] CDN fetch failed, passing through:', err);
    // Let the browser try directly as fallback
    return fetch(url, { headers: cdnHeaders });
  }
}
