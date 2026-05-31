/**
 * Flyx Residential IP Service Worker v14
 *
 * Handles DLHD stream requests that fail through CF Workers (datacenter IP
 * blocked by Cloudflare WAF). Uses the browser's residential IP for CDN access.
 *
 * Two jobs:
 *   1. Intercept dlhd.vynx-3b3.workers.dev/play/* → fetch M3U8 from CDN directly
 *   2. Add Origin+Referer headers to CDN segment/key requests
 */
var SW_VERSION = 'v14';
console.log('[ResiSW] ' + SW_VERSION);

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim().then(function () {
    console.log('[ResiSW] Active — ' + SW_VERSION);
  }));
});

// ── DLHD Config ─────────────────────────────────────────────────────────

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36';
var ORIGIN_IP = '213.21.239.30';
var VHOST = 'chevy.newkso.ru';
var PLAYER_ORIGIN = 'https://www.newkso.ru';
var PLAYER_REFERER = 'https://www.newkso.ru/';
var DLHD_CACHE = {};

// ── CDN domains that need Origin+Referer injection ──────────────────────

var DLHD_CDN_PATTERNS = [
  'chevy.newkso.ru', 'chevy.soyspace.cyou', 'chevy.enviromentalanimal.horse',
  'newkso.ru', 'key.keylocking.ru', 'keylocking.ru'
];

function isDLHDCdn(url) {
  for (var i = 0; i < DLHD_CDN_PATTERNS.length; i++) {
    if (url.indexOf(DLHD_CDN_PATTERNS[i]) !== -1) return true;
  }
  return false;
}

// ── Fetch Event ─────────────────────────────────────────────────────────

self.addEventListener('fetch', function (event) {
  var url = event.request.url;
  if (url.indexOf('http') !== 0) return;

  var hostname;
  try { hostname = new URL(url).hostname; } catch (e) { return; }

  // ═══ JOB 1: Intercept DLHD worker URL ═══════════════════════════════
  if (hostname === 'dlhd.vynx-3b3.workers.dev' && url.indexOf('/play/') !== -1) {
    event.respondWith(handleDLHD(event.request));
    return;
  }

  // ═══ JOB 2: Add Origin+Referer to DLHD CDN requests ═════════════════
  if (isDLHDCdn(url)) {
    event.respondWith(proxyDLHD(event.request));
    return;
  }
});

// ── JOB 1: DLHD Worker URL Handler ─────────────────────────────────────

async function handleDLHD(request) {
  var channelId = '';
  try {
    var pu = new URL(request.url);
    channelId = pu.searchParams.get('channel') || pu.pathname.split('/').pop();
  } catch (e) { return errorResponse('Invalid URL', 400); }

  var channelKey = channelId.indexOf('premium') === 0 ? channelId : 'premium' + channelId;
  console.log('[ResiSW] DLHD: ' + channelKey);

  try {
    var serverKey = await getServerKey(channelKey);
    var m3u8Url = 'http://' + ORIGIN_IP + '/proxy/' + serverKey + '/' + channelKey + '/mono.css';
    console.log('[ResiSW] M3U8: ' + m3u8Url);

    var resp = await fetch(m3u8Url, {
      headers: { 'User-Agent': UA, 'Host': VHOST, 'Origin': PLAYER_ORIGIN, 'Referer': PLAYER_REFERER, 'Accept': '*/*' }
    });

    if (!resp.ok) {
      console.error('[ResiSW] M3U8 HTTP ' + resp.status);
      return errorResponse('Upstream ' + resp.status, 502);
    }

    var text = await resp.text();
    if (text.indexOf('#EXT') === -1) {
      console.error('[ResiSW] Not M3U8: ' + text.substring(0, 200));
      return errorResponse('Invalid response', 502);
    }

    // Rewrite: relative URLs → HTTPS chevy.newkso.ru
    var httpsBase = 'https://chevy.newkso.ru/proxy/' + serverKey + '/' + channelKey + '/';
    var rewritten = rewriteM3U8(text, httpsBase);
    console.log('[ResiSW] DLHD M3U8 OK, ' + text.length + ' → ' + rewritten.length + ' bytes');

    return new Response(rewritten, {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=5', 'X-ResiSW': SW_VERSION }
    });
  } catch (err) {
    console.error('[ResiSW] DLHD error: ' + (err.message || err));
    return errorResponse('Fetch error', 502);
  }
}

function errorResponse(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

async function getServerKey(channelKey) {
  var now = Date.now();
  if (DLHD_CACHE[channelKey] && DLHD_CACHE[channelKey].ts > now - 60000) {
    return DLHD_CACHE[channelKey].key;
  }
  try {
    var lu = 'http://' + ORIGIN_IP + '/server_lookup?channel_id=' + channelKey;
    var resp = await fetch(lu, {
      headers: { 'User-Agent': UA, 'Host': VHOST, 'Origin': PLAYER_ORIGIN, 'Referer': PLAYER_REFERER, 'Accept': '*/*' }
    });
    if (resp.ok) {
      var t = await resp.text();
      if (t.charAt(0) === '{') {
        try { var d = JSON.parse(t); if (d.server_key) { DLHD_CACHE[channelKey] = { key: d.server_key, ts: now }; return d.server_key; } } catch (e) {}
      }
      t = t.trim();
      if (t.length > 1 && t.length < 20 && t.indexOf('<') === -1) {
        DLHD_CACHE[channelKey] = { key: t, ts: now };
        return t;
      }
    }
  } catch (e) { console.warn('[ResiSW] Lookup error: ' + e.message); }
  return 'ddy6';
}

function rewriteM3U8(playlist, baseUrl) {
  var lines = playlist.split('\n'), joined = [], carry = '';
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (!t || t.charAt(0) === '#') { if (carry) { joined.push(carry); carry = ''; } joined.push(lines[i]); }
    else if (t.indexOf('http') === 0) { if (carry) joined.push(carry); carry = t; }
    else { carry += t; }
  }
  if (carry) joined.push(carry);

  var bo = '', bp = '';
  try { var bu = new URL(baseUrl); bo = bu.origin; bp = bu.pathname; bp = bp.substring(0, bp.lastIndexOf('/') + 1); } catch (e) {}
  function resolve(u) {
    if (u.indexOf('http') === 0) return u;
    try { return new URL(u, bo + bp).toString(); } catch (e) { return u; }
  }

  var out = [];
  for (var i = 0; i < joined.length; i++) {
    var line = joined[i], trimmed = line.trim();
    if (trimmed.indexOf('#EXT-X-KEY:') === 0) {
      var m = trimmed.match(/URI="([^"]+)"/);
      if (m && m[1].indexOf('http') !== 0) { out.push(trimmed.replace('URI="' + m[1] + '"', 'URI="' + resolve(m[1]) + '"')); continue; }
      out.push(line); continue;
    }
    if (trimmed.indexOf('#EXT-X-ENDLIST') === 0) continue;
    if (!trimmed || trimmed.charAt(0) === '#') { out.push(line); continue; }
    if (trimmed.indexOf('http') === 0) { out.push(trimmed); continue; }
    out.push(resolve(trimmed));
  }
  return out.join('\n');
}

// ── JOB 2: CDN Proxy (adds Origin+Referer) ─────────────────────────────

async function proxyDLHD(request) {
  var url = request.url;
  console.log('[ResiSW] CDN: ' + url.substring(0, 100));

  var headers = new Headers(request.headers);
  headers.set('Origin', PLAYER_ORIGIN);
  headers.set('Referer', PLAYER_REFERER);
  // Remove headers that reveal the page origin
  headers.delete('Sec-Fetch-Site');
  headers.delete('Sec-Fetch-Mode');
  headers.delete('Sec-Fetch-Dest');

  try {
    var resp = await fetch(url, { headers: headers });
    if (!resp.ok && resp.status !== 206) {
      console.warn('[ResiSW] CDN HTTP ' + resp.status);
      return fetch(request);
    }

    var rh = new Headers(resp.headers);
    if (!rh.has('Access-Control-Allow-Origin')) rh.set('Access-Control-Allow-Origin', '*');
    rh.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');
    rh.set('X-ResiSW', SW_VERSION);

    // For M3U8 playlists: rewrite relative URLs
    var ct = rh.get('Content-Type') || '';
    if (ct.indexOf('mpegurl') !== -1 || url.indexOf('.m3u8') !== -1) {
      var text = await resp.text();
      var rewritten = rewriteM3U8(text, url);
      return new Response(rewritten, { status: resp.status, headers: rh });
    }

    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: rh });
  } catch (err) {
    console.warn('[ResiSW] CDN error: ' + (err.message || err));
    return fetch(request);
  }
}
