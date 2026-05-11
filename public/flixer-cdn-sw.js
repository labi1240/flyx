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

// Take control immediately — don't wait for next navigation
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

const FLIXER_CDN_PATTERNS = [
  /frostcomet\./,
  /thunderleaf\./,
  /skyember\./,
  /nightbreeze\./,
];

const OWN_DOMAINS = [
  /vynx-3b3\.workers\.dev/,
  /vynx\.cc/,
  /media-proxy\./,
  /flyx-main/,
  /dlhd\./,
  /flyx-sync/,
  /cdn-live-extractor/,
];

function isFlixerCdn(url) {
  if (OWN_DOMAINS.some(p => p.test(url))) return false;
  if (FLIXER_CDN_PATTERNS.some(p => p.test(url))) return true;
  if (/\.workers\.dev\//.test(url)) return true;
  return false;
}

self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  if (!isFlixerCdn(url)) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(proxyFlixerCdn(event.request));
});

async function proxyFlixerCdn(request) {
  // Build forwarded headers from the original request.
  // Only forward headers that the CDN needs — do NOT set forbidden
  // headers (Referer, Origin, etc.) as browsers silently drop them.
  const fwdHeaders = {};

  // Forward Range header for seeking (critical for HLS.js)
  const range = request.headers.get('Range');
  if (range) fwdHeaders['Range'] = range;

  // Forward the original Accept header
  const accept = request.headers.get('Accept');
  if (accept) fwdHeaders['Accept'] = accept;

  try {
    const cdnResponse = await fetch(request.url, { headers: fwdHeaders });

    const headers = new Headers(cdnResponse.headers);
    const status = cdnResponse.status;

    // Add CORS if missing
    if (!headers.has('Access-Control-Allow-Origin')) {
      headers.set('Access-Control-Allow-Origin', '*');
    }

    // Expose headers HLS.js needs for range requests
    headers.set('Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Accept-Ranges, Content-Type');

    // Only set Cache-Control for non-partial responses
    if (status !== 206 && !headers.has('Cache-Control')) {
      const contentType = headers.get('Content-Type') || '';
      const isPlaylist = request.url.includes('.m3u8') ||
        contentType.includes('mpegurl') ||
        contentType.includes('vnd.apple.mpegurl');
      headers.set('Cache-Control', isPlaylist ? 'public, max-age=5' : 'public, max-age=3600');
    }

    return new Response(cdnResponse.body, {
      status,
      statusText: cdnResponse.statusText,
      headers,
    });
  } catch (err) {
    console.warn('[Flixer SW] CDN fetch failed, passing through:', err);
    // Still pass through but this will likely hit CORS
    return fetch(request);
  }
}
