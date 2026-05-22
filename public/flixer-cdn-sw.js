/**
 * Flixer CDN Proxy Service Worker v3
 *
 * Intercepts requests to Flixer CDN domains (*.workers.dev) and proxies them
 * through the browser's residential IP. Strips Referer (CDN blocks non-flixer
 * referrers) and adds CORS headers to responses.
 */
const SW_VERSION = 'v4';

console.log('[Flixer SW] Loading ' + SW_VERSION);

// Take control immediately
self.addEventListener('install', () => {
  console.log('[Flixer SW] Install — skipWaiting');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[Flixer SW] Activate — claiming clients');
  event.waitUntil(
    self.clients.claim().then(() => {
      console.log('[Flixer SW] Clients claimed — SW now in control');
    })
  );
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
  const url = request.url;
  console.log('[Flixer SW] Proxying:', url.substring(0, 100));

  // CDN blocks on non-flixer Referer. Also blocks datacenter IPs.
  // Browser's residential IP passes. Spoof Referer as flixer.su so the
  // CDN thinks the request originated from the flixer site itself.
  // An empty Referer (previous approach) started returning 403.
  const fetchOpts = { referrer: 'https://flixer.su/' };
  const range = request.headers.get('Range');
  if (range) {
    fetchOpts.headers = { 'Range': range };
  }

  try {
    const cdnResponse = await fetch(url, fetchOpts);

    console.log('[Flixer SW] CDN response:', cdnResponse.status, url.substring(0, 80));

    const headers = new Headers(cdnResponse.headers);
    const status = cdnResponse.status;

    if (!headers.has('Access-Control-Allow-Origin')) {
      headers.set('Access-Control-Allow-Origin', '*');
    }

    headers.set('Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Accept-Ranges, Content-Type');

    if (status !== 206 && !headers.has('Cache-Control')) {
      const ct = headers.get('Content-Type') || '';
      const isPlaylist = url.includes('.m3u8') ||
        ct.includes('mpegurl') ||
        ct.includes('vnd.apple.mpegurl');
      headers.set('Cache-Control', isPlaylist ? 'public, max-age=5' : 'public, max-age=3600');
    }

    return new Response(cdnResponse.body, {
      status,
      statusText: cdnResponse.statusText,
      headers,
    });
  } catch (err) {
    console.warn('[Flixer SW] Fetch FAILED:', err.message || err, url.substring(0, 80));
    return fetch(request);
  }
}
