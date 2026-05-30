/**
 * Flyx Bypass v2 — Service Worker
 *
 * Intercepts requests to CF Worker proxy URLs and fetches directly from CDNs
 * using the browser's residential IP. Works alongside residential-ip-sw.js
 * (which handles direct CDN segment requests with header injection).
 *
 * This SW handles the INITIAL M3U8/playlist fetch that normally goes through
 * the CF Worker (which has a datacenter IP and gets blocked by CDNs).
 */
import { solveRecaptchaV3 } from './lib/recaptcha.js';

// ── Constants ────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const DLHD_DOMAIN = 'newkso.ru';
const DLHD_PLAYER = 'www.newkso.ru';
const LOOKUP_DOMAINS = ['newkso.ru', 'enviromentalanimal.horse', 'vovlacosa.sbs', 'soyspace.cyou'];
const RECAPTCHA_KEY = '6LfJv4AsAAAAALTLEHKaQ7LN_VYfFqhLPrB2Tvgj';

// ── State ────────────────────────────────────────────────────────────────

let stats = { intercepted: 0, success: 0, error: 0, m3u8: 0, recaptcha: 0 };
let providerState = {};
let serverKeyCache = { key: null, channel: null, ts: 0 };

chrome.storage.local.get(['stats', 'providerState'], function(r) {
  if (r.stats) Object.assign(stats, r.stats);
  if (r.providerState) providerState = r.providerState;
});
setInterval(function() { chrome.storage.local.set({ stats: stats }); }, 30000);

// ── Message Handler ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function(msg, sender, respond) {
  if (msg.type === 'proxy') {
    handleProxy(msg).then(respond).catch(function(e) { respond({ err: e.message }); });
    return true;
  }
  if (msg.type === 'stat') { stats[msg.key] = (stats[msg.key]||0) + (msg.val||1); respond({ok:1}); return true; }
  if (msg.type === 'getStatus') { respond({ stats: stats, providerState: providerState }); return true; }
  if (msg.type === 'toggle') { providerState[msg.id] = msg.on; chrome.storage.local.set({providerState:providerState}); respond({ok:1}); return true; }
  if (msg.type === 'whitelist') { handleWhitelist(msg.ch).then(respond).catch(function(e){respond({err:e.message})}); return true; }
  if (msg.type === 'resetStats') { stats = {intercepted:0,success:0,error:0,m3u8:0,recaptcha:0}; respond({ok:1}); return true; }
  return false;
});

// ── Main Proxy Handler ──────────────────────────────────────────────────

async function handleProxy(msg) {
  stats.intercepted++;
  var url = msg.url;
  var pu;
  try { pu = new URL(url); } catch(e) { stats.error++; return { err: 'Invalid URL: ' + url }; }

  var host = pu.hostname;
  var path = pu.pathname;

  // ── DLHD: dlhd.vynx-3b3.workers.dev/play/{channelId} ─────────────────
  if (host.startsWith('dlhd.') || path.startsWith('/play/')) {
    return await handleDLHD(pu);
  }

  // ── Generic proxy: /stream?url=..., /flixer/stream?url=..., etc. ─────
  var targetUrl = extractUrl(pu);
  if (!targetUrl) { stats.error++; return { err: 'Cannot extract CDN URL from ' + url }; }

  var headers = getProviderHeaders(pu, targetUrl);
  var resp = await fetchCdn(targetUrl, msg.method || 'GET', headers, msg.body);
  var buf = await resp.arrayBuffer();
  var ct = resp.headers.get('content-type') || '';

  // Rewrite M3U8 playlist
  if (ct.includes('mpegurl') || targetUrl.includes('.m3u8')) {
    var text = new TextDecoder().decode(buf);
    var rewritten = rewriteM3U8(text, targetUrl);
    stats.m3u8++;
    stats.success++;
    return {
      status: 200,
      headers: { 'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*' },
      body: btoa(String.fromCharCode.apply(null, new TextEncoder().encode(rewritten)))
    };
  }

  stats.success++;
  return {
    status: resp.status,
    statusText: resp.statusText,
    headers: headersToObj(resp.headers),
    body: bufToB64(buf)
  };
}

// ── DLHD Handler ─────────────────────────────────────────────────────────

async function handleDLHD(pu) {
  var channelId = pu.searchParams.get('channel') || pu.pathname.split('/').pop() || '';
  if (channelId.startsWith('play/')) channelId = channelId.replace('play/', '');
  var channelKey = channelId.startsWith('premium') ? channelId : 'premium' + channelId;

  // Server lookup
  var serverKey = await getServerKey(channelKey);
  var m3u8Url = 'https://chevy.' + DLHD_DOMAIN + '/proxy/' + serverKey + '/' + channelKey + '/mono.css';

  // Add DNR rule for this domain
  addDlhdRule('chevy.' + DLHD_DOMAIN);

  // Fetch M3U8 directly from CDN
  var resp = await fetchCdn(m3u8Url, 'GET', {
    Origin: 'https://' + DLHD_PLAYER,
    Referer: 'https://' + DLHD_PLAYER + '/'
  });

  if (!resp.ok) {
    stats.error++;
    return { err: 'DLHD M3U8 fetch failed: HTTP ' + resp.status + ' from ' + m3u8Url };
  }

  var text = await resp.text();
  var rewritten = rewriteDLHDM3U8(text, resp.url || m3u8Url);
  stats.m3u8++;
  stats.success++;
  return {
    status: 200,
    headers: { 'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=5' },
    body: btoa(String.fromCharCode.apply(null, new TextEncoder().encode(rewritten)))
  };
}

// ── DLHD Server Lookup ───────────────────────────────────────────────────

async function getServerKey(channelKey) {
  var now = Date.now();
  if (serverKeyCache.key && serverKeyCache.channel === channelKey && (now - serverKeyCache.ts) < 60000) {
    return serverKeyCache.key;
  }
  for (var i = 0; i < LOOKUP_DOMAINS.length; i++) {
    try {
      var url = 'https://chevy.' + LOOKUP_DOMAINS[i] + '/server_lookup?channel_id=' + channelKey;
      var resp = await fetchCdn(url, 'GET', { Origin: 'https://' + DLHD_PLAYER, Referer: 'https://' + DLHD_PLAYER + '/' });
      if (resp.ok) {
        var t = await resp.text();
        if (t.startsWith('{')) {
          var d = JSON.parse(t);
          if (d.server_key) {
            serverKeyCache = { key: d.server_key, channel: channelKey, ts: now };
            return d.server_key;
          }
        }
      }
    } catch(e) {}
  }
  return 'ddy6'; // fallback
}

// ── CDN Fetch ────────────────────────────────────────────────────────────

async function fetchCdn(url, method, extraHeaders, bodyB64) {
  var h = new Headers();
  h.set('User-Agent', UA);
  h.set('Accept', '*/*');

  if (extraHeaders) {
    Object.keys(extraHeaders).forEach(function(k) {
      if (extraHeaders[k]) h.set(k, extraHeaders[k]);
    });
  }

  // DLHD domains always need Origin + Referer
  if (url.includes('newkso.ru') || url.includes('keylocking.ru')) {
    h.set('Origin', 'https://' + DLHD_PLAYER);
    h.set('Referer', 'https://' + DLHD_PLAYER + '/');
  }

  // MegaUp CDN: STRIP Origin/Referer
  if (isMegaUp(url)) {
    h.delete('Origin');
    h.delete('Referer');
  }

  var init = { method: method || 'GET', headers: h, redirect: 'follow' };
  if (bodyB64 && method && method !== 'GET' && method !== 'HEAD') {
    init.body = b64ToBytes(bodyB64);
  }

  var ctrl = new AbortController();
  var t = setTimeout(function() { ctrl.abort(); }, 20000);
  init.signal = ctrl.signal;
  try {
    var resp = await fetch(url, init);
    clearTimeout(t);
    return resp;
  } catch(e) {
    clearTimeout(t);
    throw e;
  }
}

// ── URL Extraction ───────────────────────────────────────────────────────

function extractUrl(pu) {
  var params = ['url', 'target', 'src', 'stream'];
  for (var i = 0; i < params.length; i++) {
    var v = pu.searchParams.get(params[i]);
    if (v) {
      try { new URL(v); return v; } catch(e) {
        try { var d = decodeURIComponent(v); new URL(d); return d; } catch(e2) {}
      }
    }
  }
  return null;
}

// ── Provider Header Detection ────────────────────────────────────────────

function getProviderHeaders(pu, targetUrl) {
  var h = {};
  var path = pu.pathname;
  var ref = pu.searchParams.get('referer');

  if (path.includes('/flixer')) h.Referer = 'https://hexa.su/';
  else if (path.includes('/videasy')) h.Referer = 'https://player.videasy.net/';
  else if (path.includes('/vidsrc')) h.Referer = ref || 'https://www.2embed.cc/';
  else if (path.includes('/bingebox')) h.Referer = 'https://bingebox.to/';
  else if (path.includes('/moviebox')) h.Referer = 'https://themoviebox.org/';
  else if (path.includes('/miruro')) h.Referer = 'https://miruro.to/';
  else if (path.includes('/hianime')) h.Referer = 'https://aniwatchtv.to/';
  else if (path.includes('/animekai') || isMegaUp(targetUrl)) { /* strip all */ }
  else if (path.includes('/ntv')) { /* CORS-open, no headers needed */ }
  else if (path.includes('/ufreetv')) h.Referer = 'https://ufreetv.com/';
  else if (path.includes('/globetv')) h.Referer = 'https://globetv.app/';
  else if (path.includes('/cdn-live')) { h.Referer = 'https://cdn-live.tv/'; h.Origin = 'https://cdn-live.tv'; }
  else if (ref) h.Referer = ref;
  else h.Referer = 'https://tv.vynx.cc/';

  return h;
}

// ── MegaUp Detection ─────────────────────────────────────────────────────

function isMegaUp(url) {
  var frags = ['megaup','hub26link','app28base','dev23app','net22lab','pro25zone','tech20hub','code29wave','4spromax'];
  for (var i = 0; i < frags.length; i++) { if (url.indexOf(frags[i]) !== -1) return true; }
  return false;
}

// ── M3U8 Rewriting (generic) ─────────────────────────────────────────────

function rewriteM3U8(playlist, baseUrl) {
  var basePath = '/';
  try {
    var pu = new URL(baseUrl);
    basePath = pu.pathname.substring(0, pu.pathname.lastIndexOf('/') + 1);
  } catch(e) {}

  function resolve(u) {
    if (u.indexOf('http://')===0 || u.indexOf('https://')===0) return u;
    try { return new URL(u, baseUrl).toString(); } catch(e) { return u; }
  }

  var lines = playlist.split('\n');
  var out = [];
  var uriTags = ['#EXT-X-KEY:', '#EXT-X-SESSION-KEY:', '#EXT-X-MEDIA:', '#EXT-X-I-FRAME-STREAM-INF:', '#EXT-X-MAP:'];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();
    if (!trimmed) { out.push(line); continue; }

    var handled = false;
    for (var j = 0; j < uriTags.length; j++) {
      if (trimmed.startsWith(uriTags[j])) {
        var m = trimmed.match(/URI="([^"]+)"/);
        if (m) { out.push(trimmed.replace('URI="'+m[1]+'"', 'URI="'+resolve(m[1])+'"')); handled = true; break; }
        m = trimmed.match(/URI=([^\s,]+)/);
        if (m && m[1].charAt(0)!=='"') { out.push(trimmed.replace('URI='+m[1], 'URI="'+resolve(m[1])+'"')); handled = true; break; }
        out.push(line); handled = true; break;
      }
    }
    if (handled) continue;

    if (trimmed.startsWith('#')) { out.push(line); continue; }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) { out.push(trimmed); continue; }
    out.push(resolve(trimmed));
  }
  return out.join('\n');
}

// ── DLHD M3U8 Rewriting ──────────────────────────────────────────────────

function rewriteDLHDM3U8(playlist, baseUrl) {
  // Fix split-line URLs
  var lines = playlist.split('\n');
  var joined = [];
  var carry = '';
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (!t || t.startsWith('#')) { if(carry){joined.push(carry);carry='';} joined.push(lines[i]); }
    else if (t.startsWith('http')) { if(carry)joined.push(carry); carry=t; }
    else { carry += t; }
  }
  if (carry) joined.push(carry);

  // Rewrite keys to absolute
  var keyOrigin = '';
  try { keyOrigin = new URL(baseUrl).origin; } catch(e) {}
  var basePath = '/';
  try { var pu = new URL(baseUrl); basePath = pu.pathname.substring(0, pu.pathname.lastIndexOf('/')+1); } catch(e) {}

  var out = [];
  for (var i = 0; i < joined.length; i++) {
    var line = joined[i];
    var trimmed = line.trim();

    // Rewrite key URIs
    if (trimmed.startsWith('#EXT-X-KEY:')) {
      var m = trimmed.match(/URI="([^"]+)"/);
      if (m && !m[1].startsWith('http')) {
        try {
          var abs = new URL(m[1], keyOrigin + basePath).toString();
          out.push(trimmed.replace('URI="'+m[1]+'"', 'URI="'+abs+'"'));
          continue;
        } catch(e) {}
      }
      out.push(line); continue;
    }

    // Skip ENDLIST for live
    if (trimmed.startsWith('#EXT-X-ENDLIST')) continue;

    // Comments
    if (!trimmed || trimmed.startsWith('#')) { out.push(line); continue; }

    // Resolve segment URL to absolute CDN URL
    if (trimmed.startsWith('http')) { out.push(trimmed); continue; }
    try { out.push(new URL(trimmed, keyOrigin + basePath).toString()); } catch(e) { out.push(line); }
  }
  return out.join('\n');
}

// ── reCAPTCHA Whitelist ──────────────────────────────────────────────────

async function handleWhitelist(channel) {
  if (!channel || !/^premium\d+$/.test(channel)) return { err: 'Invalid channel format (e.g. premium51)' };
  var num = channel.replace('premium', '');
  var pageUrl = 'https://' + DLHD_PLAYER + '/premiumtv/daddyhd.php?id=' + num;
  try {
    var token = await solveRecaptchaV3(pageUrl, 'player_access');
    stats.recaptcha++;
    return {
      success: true, token: token, channel_id: channel,
      verify_url: 'https://chevy.' + DLHD_DOMAIN + '/verify'
    };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ── Dynamic DNR Rules ────────────────────────────────────────────────────

var _dnrRules = {};
function addDlhdRule(domain) {
  var id = hashDomain(domain);
  if (_dnrRules[id]) return;
  _dnrRules[id] = true;

  chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [{
      id: id, priority: 10,
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'Origin', operation: 'set', value: 'https://' + DLHD_PLAYER },
        { header: 'Referer', operation: 'set', value: 'https://' + DLHD_PLAYER + '/' }
      ]},
      condition: { urlFilter: '*://' + domain + '/*', resourceTypes: ['xmlhttprequest','script','image','media','other'] }
    }],
    removeRuleIds: [id]
  }).catch(function(){});
}

function hashDomain(d) {
  var h = 0;
  for (var i = 0; i < d.length; i++) h = ((h<<5)-h + d.charCodeAt(i)) | 0;
  return Math.abs(h % 90000) + 1001;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function headersToObj(h) {
  var o = {};
  if (h && h.forEach) h.forEach(function(v,k){o[k]=v;});
  return o;
}

function bufToB64(buf) {
  var bytes = new Uint8Array(buf);
  var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToBytes(b64) {
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ── Init ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(function() {
  console.log('[Flyx Bypass v2] Installed');
  chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ['static_rules'] }).catch(function(){});
  chrome.storage.local.get('providerState', function(r) {
    if (!r.providerState) {
      var def = {};
      ['dlhd','flixer','videasy','animekai','hianime','miruro','vidsrc','ntv','bingebox','moviebox','primesrc','ufreetv','globetv','cdnlive','viprow','ppv','stream'].forEach(function(k){def[k]=true;});
      chrome.storage.local.set({ providerState: def });
    }
  });
});

console.log('[Flyx Bypass v2] Service worker ready');
