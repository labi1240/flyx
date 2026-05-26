/**
 * Residential IP Service Worker v1
 *
 * Intercepts CDN stream requests and fetches them DIRECTLY from the user's
 * browser (residential IP), bypassing Cloudflare Worker datacenter IP blocks.
 *
 * Many pirate CDNs block datacenter IP ranges (Cloudflare, AWS, GCP). Our
 * Cloudflare Worker at media-proxy.vynx-3b3.workers.dev has a datacenter IP,
 * so CDN segment/playlist requests through it get 403'd. The RPI residential
 * proxy (rpi-proxy.vynx.cc) was the fallback, but it's dead (DNS NXDOMAIN).
 *
 * A Service Worker can set arbitrary Referer/Origin headers that the page's
 * JavaScript cannot — and the browser's own residential IP passes CDN checks.
 *
 * Replaces and extends: public/flixer-cdn-sw.js (v4)
 */

const SW_VERSION = 'v3';

console.log('[ResiSW] Loading ' + SW_VERSION);

// ── Lifecycle ────────────────────────────────────────────────────────────────

self.addEventListener('install', () => {
  console.log('[ResiSW] Install — skipWaiting');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[ResiSW] Activate — claiming clients');
  event.waitUntil(
    self.clients.claim().then(() => {
      console.log('[ResiSW] Clients claimed — ' + SW_VERSION + ' in control');
    })
  );
});

// ── Own infrastructure (never intercept) ────────────────────────────────────

const OWN_HOSTNAMES = [
  'vynx-3b3.workers.dev',
  'dlhd.vynx-3b3.workers.dev',
  'cdn-live-extractor.vynx-3b3.workers.dev',
  'flyx-sync.vynx-3b3.workers.dev',
  'vynx.cc',
  'tv.vynx.cc',
  'rpi-proxy.vynx.cc',
  'localhost',
  '127.0.0.1',
];

function isOwnHostname(hostname) {
  if (OWN_HOSTNAMES.includes(hostname)) return true;
  // Catch any subdomain of our CF workers
  if (hostname.endsWith('.vynx-3b3.workers.dev')) return true;
  if (hostname.endsWith('.vynx.cc')) return true;
  return false;
}

// ── CDN Provider Configurations ─────────────────────────────────────────────
//
// Each entry maps CDN domain patterns ➔ required Referer / Origin headers.
// Order matters — more specific patterns must come before broader ones.
// Flixer's p.10020.workers.dev must be checked before 1Movies' p.\d+.workers.dev
//

var CDN_PROVIDERS = [
  // ── 1. Flixer / Hexa ─────────────────────────────────────────
  {
    label: 'Flixer',
    patterns: [
      'frostcomet.',
      'thunderleaf.',
      'skyember.',
      'nightbreeze.',
      'hexa.su',
      'plsdontscrapemelove',
      'themoviedb.hexa',
      'theemoviedb.hexa',
      'p.10020.workers.dev',
      'afc7d47f',
      'flixer.su',
    ],
    referer: 'https://flixer.su/',
    // NO origin — Flixer CDN blocks Origin header with 403
  },

  // ── 2. MegaUp CDN (AnimeKai) ─────────────────────────────────
  {
    label: 'MegaUp',
    patterns: [
      'megaup',
      'hub26link',
      'app28base',
      'dev23app',
      'net22lab',
      'pro25zone',
      'tech20hub',
      'code29wave',
      '4spromax',
      'megaup.live',
    ],
    // NO referer, NO origin — both cause 403 on MegaUp CDN
  },

  // ── 3. MegaCloud CDN (HiAnime) ───────────────────────────────
  {
    label: 'MegaCloud',
    patterns: [
      'megacloud',
      'stormshade',
      'windytrail',
      'netmagcdn',
    ],
    referer: 'https://megacloud.blog/',
    origin: 'https://megacloud.blog',
  },

  // ── 4. BingeBox CDN ──────────────────────────────────────────
  {
    label: 'BingeBox',
    patterns: ['api.dlproxy.com'],
    referer: 'https://bingebox.to/',
  },

  // ── 5. uFreeTV CDN ───────────────────────────────────────────
  {
    label: 'uFreeTV',
    patterns: ['moveonjoy.com', 'bozztv.com'],
    referer: 'https://ufreetv.com/',
  },

  // ── 6. VidLink CDN ───────────────────────────────────────────
  {
    label: 'VidLink',
    patterns: ['vodvidl.site', 'videostr.net'],
    referer: 'https://videostr.net/',
    origin: 'https://videostr.net',
  },

  // ── 7. VidSrc CDN ────────────────────────────────────────────
  {
    label: 'VidSrc',
    patterns: [
      'cloudnestra',
      'shadowlandschronicles',
      'embedsito',
      'v1.2embed.stream',
    ],
    // referer is dynamic — set from URL hostname at fetch time
    dynamicReferer: true,
  },

  // ── 8. VIPRow CDN ────────────────────────────────────────────
  {
    label: 'VIPRow',
    patterns: ['peulleieo.net', 'boanki.net'],
    // NO headers — blocks with referer
  },

  // ── 9. PPV CDN ───────────────────────────────────────────────
  {
    label: 'PPV',
    patterns: [
      'poocloud.in',
      'modistreams',
      'pooembed',
      'dzine.ai',
      'vidsaver.io',
    ],
    referer: 'https://modistreams.org/',
    origin: 'https://modistreams.org',
  },

  // ── 10. CDN-Live ──────────────────────────────────────────────
  {
    label: 'CDN-Live',
    patterns: [
      'cdn-live-tv',
      'cdnlivetv',
      'cdn-live.tv',
      'edge.cdn-live',
      'cinephage',
      'api.cdnlivetv.tv',
    ],
    referer: 'https://cdn-live.tv/',
    origin: 'https://cdn-live.tv',
  },

  // ── 11. 1Movies (generic workers.dev CDNs) ────────────────────
  {
    label: '1Movies',
    patterns: ['dewshine'],
    referer: 'https://111movies.com/',
    // NO origin — causes 403
  },

  // ── 12. RapidVideo / RapidCloud (Miruro CDN) ──
  {
    label: 'RapidCloud',
    patterns: [
      'rapid-cloud',
      'rapidshare',
      'rabbitstream',
      'vidcloud',
      'dokicloud',
    ],
    referer: 'https://kwik.cx/',
    origin: 'https://miruro.to',
  },

  // ── 13. Generic workers.dev CDN (catch-all for unknown providers) ──
  {
    label: 'WorkersDev',
    patterns: ['.workers.dev/'],
    referer: 'https://flixer.su/',
    // NO origin — safe default
  },
];

// ── Detection ────────────────────────────────────────────────────────────────

function findProvider(cdnUrl) {
  for (var i = 0; i < CDN_PROVIDERS.length; i++) {
    var provider = CDN_PROVIDERS[i];
    for (var j = 0; j < provider.patterns.length; j++) {
      if (cdnUrl.indexOf(provider.patterns[j]) !== -1) {
        return provider;
      }
    }
  }
  return null;
}

// ── HLS Playlist URL Rewriting ───────────────────────────────────────────────
// When the SW fetches an m3u8 directly from a CDN, relative segment URLs
// must be resolved to absolute CDN URLs. Otherwise HLS.js resolves them
// against the CF Worker proxy domain (media-proxy.vynx-3b3.workers.dev)
// producing broken paths that neither the SW nor the CF Worker can handle.

function resolveUrl(url, baseUrl, basePath) {
  if (url.indexOf('http://') === 0 || url.indexOf('https://') === 0) {
    return url; // Already absolute
  }
  var origin = '';
  try { origin = new URL(baseUrl).origin; } catch (e) { return url; }
  if (url.charAt(0) === '/') {
    return origin + url; // Absolute path on CDN domain
  }
  return origin + basePath + url; // Relative path
}

function rewritePlaylistUrls(playlist, cdnBaseUrl) {
  var lines = playlist.split('\n');
  var rewritten = [];
  var basePath = '/';
  try {
    var parsed = new URL(cdnBaseUrl);
    basePath = parsed.pathname.substring(0, parsed.pathname.lastIndexOf('/') + 1);
  } catch (e) {}

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\r$/, '');
    var trimmed = line.trim();

    // Handle EXT-X-MEDIA and EXT-X-I-FRAME-STREAM-INF tags with URI= attribute
    if (line.indexOf('#EXT-X-MEDIA:') === 0 || line.indexOf('#EXT-X-I-FRAME-STREAM-INF:') === 0) {
      var uriMatch = line.match(/URI="([^"]+)"/);
      if (uriMatch) {
        var resolved = resolveUrl(uriMatch[1], cdnBaseUrl, basePath);
        rewritten.push(line.replace('URI="' + uriMatch[1] + '"', 'URI="' + resolved + '"'));
      } else {
        rewritten.push(line);
      }
      continue;
    }

    // Handle EXT-X-KEY tags with URI= attribute (decryption keys)
    if (line.indexOf('#EXT-X-KEY:') === 0) {
      var keyUriMatch = line.match(/URI="([^"]+)"/);
      if (keyUriMatch) {
        var resolvedKey = resolveUrl(keyUriMatch[1], cdnBaseUrl, basePath);
        rewritten.push(line.replace('URI="' + keyUriMatch[1] + '"', 'URI="' + resolvedKey + '"'));
      } else {
        rewritten.push(line);
      }
      continue;
    }

    // Handle EXT-X-MAP tags with URI= attribute (fMP4 init segments)
    if (line.indexOf('#EXT-X-MAP:') === 0) {
      var mapUriMatch = line.match(/URI="([^"]+)"/);
      if (mapUriMatch) {
        var resolvedMap = resolveUrl(mapUriMatch[1], cdnBaseUrl, basePath);
        rewritten.push(line.replace('URI="' + mapUriMatch[1] + '"', 'URI="' + resolvedMap + '"'));
      } else {
        rewritten.push(line);
      }
      continue;
    }

    // Keep comments and empty lines
    if (trimmed === '' || line.charAt(0) === '#') {
      rewritten.push(line);
      continue;
    }

    // Segment URL — resolve to absolute CDN URL
    rewritten.push(resolveUrl(trimmed, cdnBaseUrl, basePath));
  }

  return rewritten.join('\n');
}

// ── Proxying ─────────────────────────────────────────────────────────────────

async function proxyWithResidentialIp(request) {
  var requestUrl = request.url;
  var cdnUrl = null;
  var hostname;

  try {
    hostname = new URL(requestUrl).hostname;
  } catch (e) {
    return null;
  }

  // Never intercept our own infrastructure (including CF Worker proxy URLs)
  // The CF Worker handles its own proxy routes — the SW only intercepts
  // direct CDN requests from the browser's residential IP.
  if (isOwnHostname(hostname)) return null;

  // Only intercept direct CDN URLs
  cdnUrl = requestUrl;

  // Find matching provider
  var provider = findProvider(cdnUrl);
  if (!provider) return null;

  console.log('[ResiSW] ' + provider.label + ' ← ' + cdnUrl.substring(0, 100));

  // ── Build fetch headers ────────────────────────────────────
  var fetchHeaders = {};

  // User-Agent: use the browser's default (don't override)
  // The SW can't access navigator.userAgent directly in all browsers,
  // so we let the browser set its default User-Agent by not setting it.

  // Accept-Encoding: identity prevents the CDN from sending compressed
  // content that the SW would need to decompress
  fetchHeaders['Accept'] = '*/*';

  // Referer
  if (provider.referer) {
    fetchHeaders['Referer'] = provider.referer;
  } else if (provider.dynamicReferer) {
    try {
      var targetHost = new URL(cdnUrl).hostname;
      fetchHeaders['Referer'] = 'https://' + targetHost + '/';
    } catch (e) {}
  }

  // Origin
  if (provider.origin) {
    fetchHeaders['Origin'] = provider.origin;
  }

  // Range header (video segments)
  var range = request.headers.get('Range');
  if (range) {
    fetchHeaders['Range'] = range;
  }

  var fetchOptions = {
    method: 'GET',
    headers: fetchHeaders,
    credentials: 'omit',
    // redirect: 'follow' is default — follow CDN redirects
  };

  try {
    var cdnResponse = await fetch(cdnUrl, fetchOptions);

    if (!cdnResponse.ok && cdnResponse.status !== 206) {
      console.warn('[ResiSW] ' + provider.label + ' returned ' + cdnResponse.status +
        ' — ' + cdnUrl.substring(0, 80));
      return null; // fall through to original request
    }

    console.log('[ResiSW] ' + provider.label + ' ✓ ' + cdnResponse.status +
      ' ' + cdnUrl.substring(0, 60));

    // ── Build response with CORS headers ──────────────────────
    var responseHeaders = new Headers(cdnResponse.headers);

    // Ensure CORS so the page can read the response
    if (!responseHeaders.has('Access-Control-Allow-Origin')) {
      responseHeaders.set('Access-Control-Allow-Origin', '*');
    }
    responseHeaders.set('Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Accept-Ranges, Content-Type');

    // Detect playlist vs segment
    var contentType = responseHeaders.get('Content-Type') || '';
    var isPlaylist =
      cdnUrl.indexOf('.m3u8') !== -1 ||
      contentType.indexOf('mpegurl') !== -1 ||
      contentType.indexOf('vnd.apple.mpegurl') !== -1;

    // Smart cache: short for playlists, long for segments
    if (!responseHeaders.has('Cache-Control')) {
      responseHeaders.set('Cache-Control',
        isPlaylist ? 'public, max-age=5' : 'public, max-age=3600');
    }

    responseHeaders.set('X-ResiSW', provider.label);

    // ── Rewrite playlist segment URLs to absolute CDN URLs ──
    // When the SW fetches an m3u8 directly from the CDN, any relative
    // segment URLs in the playlist must be resolved to absolute CDN URLs.
    // Otherwise HLS.js resolves them against the CF Worker proxy domain
    // (media-proxy.vynx-3b3.workers.dev) producing broken paths.
    if (isPlaylist) {
      var rawText = await cdnResponse.text();
      var rewritten = rewritePlaylistUrls(rawText, cdnUrl);
      return new Response(rewritten, {
        status: cdnResponse.status,
        statusText: cdnResponse.statusText,
        headers: responseHeaders,
      });
    }

    return new Response(cdnResponse.body, {
      status: cdnResponse.status,
      statusText: cdnResponse.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    console.warn('[ResiSW] ' + provider.label + ' ✗ ' +
      (err.message || err) + ' — ' + cdnUrl.substring(0, 80));
    return null; // fall through
  }
}

// ── Fetch Event Listener ─────────────────────────────────────────────────────

self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // Only GET requests
  if (event.request.method !== 'GET') return;

  // Only http/https
  if (url.indexOf('http') !== 0) return;

  // Quick skip: our own page assets and API calls
  // These never need residential IP proxying
  if (url.indexOf('/api/') !== -1 && url.indexOf('media-proxy') === -1) return;
  if (url.indexOf('/_next/') !== -1) return;
  if (url.indexOf('image.tmdb.org') !== -1) return;
  if (url.indexOf('api.themoviedb.org') !== -1) return;
  if (url.indexOf('graphql.anilist.co') !== -1) return;

  // Hostname quick check: does this URL look like it could be a CDN?
  var hostname;
  try { hostname = new URL(url).hostname; } catch (e) { return; }

  // Skip ALL our own domains — the CF Worker handles its own proxy routes.
  // The SW only intercepts direct CDN requests from the browser.
  if (isOwnHostname(hostname)) return;

  // Only intercept URLs matching known CDN patterns
  var matchesProvider = false;
  for (var i = 0; i < CDN_PROVIDERS.length; i++) {
    for (var j = 0; j < CDN_PROVIDERS[i].patterns.length; j++) {
      if (url.indexOf(CDN_PROVIDERS[i].patterns[j]) !== -1) {
        matchesProvider = true;
        break;
      }
    }
    if (matchesProvider) break;
  }
  if (!matchesProvider) return;

  // Intercept!
  event.respondWith(
    proxyWithResidentialIp(event.request).then(function(response) {
      if (response) return response;
      // Fall through: let the original request proceed unmodified
      return fetch(event.request);
    })
  );
});
