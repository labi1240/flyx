/**
 * Flixer + Videasy CDN Proxy Service Worker v5
 *
 * Intercepts requests to CDN domains that block Cloudflare Worker IPs and
 * require specific Referer headers. Proxies them through the browser's
 * residential IP with spoofed Referer + CORS headers.
 *
 * Flixer CDN:  *.workers.dev, frostcomet.*, etc.  → Referer: flixer.su
 * Videasy CDN: mooncarpet.site, etc.              → Referer: player.videasy.to
 */
var SW_VERSION = 'v5';

// ── Own domains (never intercept) ──────────────────────────────────────
var OWN_DOMAINS = [
  /vynx-3b3\.workers\.dev/,
  /vynx\.cc/,
  /media-proxy\./,
  /flyx-main/,
  /dlhd\./,
  /flyx-sync/,
  /cdn-live-extractor/,
];

// ── Flixer CDN patterns ─────────────────────────────────────────────────
var FLIXER_CDN_PATTERNS = [
  /frostcomet\./,
  /thunderleaf\./,
  /skyember\./,
  /nightbreeze\./,
];

// ── Videasy CDN patterns ────────────────────────────────────────────────
var VIDEASY_CDN_PATTERNS = [
  /mooncarpet\.site/,
  /mooncarpet\./,
];

// ── Install / Activate ──────────────────────────────────────────────────
self.addEventListener('install', function () {
  console.log('[FlixerSW] ' + SW_VERSION + ' Install — skipWaiting');
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  console.log('[FlixerSW] ' + SW_VERSION + ' Activate — claiming clients');
  event.waitUntil(
    self.clients.claim().then(function () {
      console.log('[FlixerSW] ' + SW_VERSION + ' Active — clients claimed');
    })
  );
});

// ── URL Classification ──────────────────────────────────────────────────
function isOwnDomain(url) {
  return OWN_DOMAINS.some(function (p) { return p.test(url); });
}

function isFlixerCdn(url) {
  if (FLIXER_CDN_PATTERNS.some(function (p) { return p.test(url); })) return true;
  if (/\.workers\.dev\//.test(url)) return true;
  return false;
}

function isVideasyCdn(url) {
  return VIDEASY_CDN_PATTERNS.some(function (p) { return p.test(url); });
}

function getRefererForUrl(url) {
  if (isFlixerCdn(url)) return 'https://flixer.su/';
  if (isVideasyCdn(url)) return 'https://player.videasy.to/';
  return null;
}

// ── Fetch Handler ───────────────────────────────────────────────────────
self.addEventListener('fetch', function (event) {
  var url = event.request.url;
  if (isOwnDomain(url)) return;
  if (event.request.method !== 'GET') return;

  var referer = getRefererForUrl(url);
  if (!referer) return;

  event.respondWith(proxyCdnRequest(event.request, referer));
});

// ── CDN Proxy ───────────────────────────────────────────────────────────
async function proxyCdnRequest(request, referer) {
  var url = request.url;
  console.log('[FlixerSW] Proxying:', url.substring(0, 100), 'referer:', referer);

  try {
    // Use fetch() referrer option to set the Referer header.
    // The browser sends this from its own residential IP — bypasses
    // Cloudflare's infra block on Worker-to-Cloudflare-proxied-domain requests.
    var fetchOpts = { referrer: referer };
    var range = request.headers.get('Range');
    if (range) {
      fetchOpts.headers = { 'Range': range };
    }

    var cdnResponse = await fetch(url, fetchOpts);

    console.log('[FlixerSW] CDN response:', cdnResponse.status, url.substring(0, 80));

    var headers = new Headers(cdnResponse.headers);
    var status = cdnResponse.status;

    // Inject CORS headers so HLS.js can read the response
    if (!headers.has('Access-Control-Allow-Origin')) {
      headers.set('Access-Control-Allow-Origin', '*');
    }
    headers.set('Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Accept-Ranges, Content-Type');

    if (status !== 206 && !headers.has('Cache-Control')) {
      var ct = headers.get('Content-Type') || '';
      var isPlaylist = url.indexOf('.m3u8') !== -1 ||
        ct.indexOf('mpegurl') !== -1 ||
        ct.indexOf('vnd.apple.mpegurl') !== -1;
      headers.set('Cache-Control', isPlaylist ? 'public, max-age=5' : 'public, max-age=3600');
    }

    return new Response(cdnResponse.body, {
      status: status,
      statusText: cdnResponse.statusText,
      headers: headers,
    });
  } catch (err) {
    console.warn('[FlixerSW] Fetch FAILED:', (err.message || err), url.substring(0, 80));
    return fetch(request);
  }
}
