/**
 * Flyx Bypass v3 — Extension Service Worker
 *
 * - Dynamic DNR rule management per provider (toggleable from popup)
 * - Per-provider stats persisted to chrome.storage.local
 * - Activity log ring buffer (last 100 events)
 * - DLHD extraction (mints IP-bound token from residential IP)
 * - reCAPTCHA v3 solver for DLHD IP whitelist
 *
 * VERSION: 3.1.0
 */
import { solveRecaptchaV3, verifyToken } from './lib/recaptcha.js';

// ── Provider Definitions ────────────────────────────────────────────────

const PROVIDERS = {
  dlhd: {
    name: 'DLHD Live TV',
    cat: 'live',
    rules: [
      { f: '*://chevy.newkso.ru/*', h: { Origin: 'https://www.newkso.ru', Referer: 'https://www.newkso.ru/' } },
      { f: '*://chevy.soyspace.cyou/*', h: { Origin: 'https://www.newkso.ru', Referer: 'https://www.newkso.ru/' } },
      { f: '*://*.newkso.ru/*', h: { Origin: 'https://www.newkso.ru', Referer: 'https://www.newkso.ru/' } },
      { f: '*://key.keylocking.ru/*', h: { Origin: 'https://www.newkso.ru', Referer: 'https://www.newkso.ru/' } },
      { f: '/stream/stream-', h: { Referer: 'https://dlhd.pk/' }, pri: 20 },
      { f: '/premiumtv/daddy', h: { Referer: 'https://dlhd.pk/' }, pri: 20 },
    ]
  },
  flixer: {
    name: 'Flixer/Hexa',
    cat: 'movies',
    rules: [
      { f: '*://hexa.su/*', h: { Referer: 'https://hexa.su/' } },
      { f: '*://*.hexa.su/*', h: { Referer: 'https://hexa.su/' } },
      { f: '*://flixer.su/*', h: { Referer: 'https://hexa.su/' } },
    ]
  },
  videasy: {
    name: 'Videasy',
    cat: 'movies',
    rules: [
      { f: '*://player.videasy.net/*', h: { Referer: 'https://player.videasy.net/' } },
    ]
  },
  vidsrc: {
    name: 'VidSrc/2embed',
    cat: 'movies',
    rules: [
      { f: '*://*.2embed.cc/*', h: { Referer: 'https://www.2embed.cc/' } },
    ]
  },
  bingebox: {
    name: 'BingeBox',
    cat: 'movies',
    rules: [
      { f: '*://bingebox.to/*', h: { Referer: 'https://bingebox.to/' } },
    ]
  },
  moviebox: {
    name: 'MovieBox',
    cat: 'movies',
    rules: [
      { f: '*://themoviebox.org/*', h: { Referer: 'https://themoviebox.org/' } },
    ]
  },
  primesrc: {
    name: 'PrimeSrc',
    cat: 'movies',
    rules: []
  },
  miruro: {
    name: 'Miruro',
    cat: 'anime',
    rules: [
      { f: '*://miruro.to/*', h: { Referer: 'https://miruro.to/' } },
      { f: '*://*.uwucdn.top/*', h: { Referer: 'https://kwik.cx/' }, cors: true },
    ]
  },
  animekai: {
    name: 'AnimeKai/MegaUp',
    cat: 'anime',
    rules: [
      // MegaUp blocks Origin+Referer — remove them; add CORS for direct fetch
      { f: '*://*.megaup.*/*', h: { Origin: '', Referer: '' }, op: 'remove', cors: true },
      // AnimeKai API domains — no CORS headers, inject them
      { f: '*://animekai.to/*', h: {}, cors: true },
      { f: '*://anikai.to/*', h: {}, cors: true },
      { f: '*://*.animekai.to/*', h: {}, cors: true },
      { f: '*://*.anikai.to/*', h: {}, cors: true },
    ]
  },
  allanime: {
    name: 'AllAnime',
    cat: 'anime',
    rules: [
      // api.allanime.day checks Referer; fetch() can't set it but DNR can.
      // Referer only (no Origin) — mirrors the known-working ani-cli client.
      { f: '*://api.allanime.day/*', h: { Referer: 'https://allmanga.to/' }, cors: true },
      // AllAnime CDN hosts that serve the actual H.264 segments.
      { f: '*://*.allanime.day/*', h: { Referer: 'https://allmanga.to/' }, cors: true },
    ]
  },
  hianime: {
    name: 'HiAnime',
    cat: 'anime',
    rules: [
      { f: '*://aniwatchtv.to/*', h: { Referer: 'https://aniwatchtv.to/' } },
    ]
  },
  ntv: {
    name: 'NTV',
    cat: 'live',
    rules: [
      { f: '*://*.ntv.cx/*', h: { Referer: 'https://ntv.cx/' } },
    ]
  },
  ufreetv: {
    name: 'uFreeTV',
    cat: 'live',
    rules: [
      { f: '*://*.ufreetv.com/*', h: { Referer: 'https://ufreetv.com/' } },
    ]
  },
  globetv: {
    name: 'GlobeTV',
    cat: 'live',
    rules: [
      { f: '*://*.globetv.app/*', h: { Referer: 'https://globetv.app/' } },
    ]
  },
  cdnlive: {
    name: 'CDN-Live',
    cat: 'live',
    rules: [
      { f: '*://*.cdn-live.tv/*', h: { Referer: 'https://cdn-live.tv/' } },
    ]
  },
  viprow: {
    name: 'VIPRow',
    cat: 'live',
    rules: [
      { f: '*://*.poocloud.in/*', h: { Referer: 'https://poocloud.in/' } },
    ]
  },
  ppv: {
    name: 'PPV',
    cat: 'live',
    rules: []
  },
  stream: {
    name: 'Generic Stream',
    cat: 'other',
    rules: []
  }
};

const CATEGORIES = {
  live: { name: 'Live TV', icon: '\u{1F4FA}' },
  movies: { name: 'Movies & TV', icon: '\u{1F3AC}' },
  anime: { name: 'Anime', icon: '\u{1F338}' },
  other: { name: 'Other', icon: '\u{1F310}' }
};

// Provider ID offsets for DNR rule IDs
const PID = {};
Object.keys(PROVIDERS).forEach(function (k, i) { PID[k] = (i + 1) * 100; });

// ── Stats Engine ────────────────────────────────────────────────────────

let stats = {};       // { providerId: { intercepted, success, error, m3u8 } }
let statsDirty = false;
let statsFlushTimer = null;

function initStats() {
  var s = {};
  s.global = { intercepted: 0, success: 0, error: 0, m3u8: 0 };
  Object.keys(PROVIDERS).forEach(function (id) {
    s[id] = { intercepted: 0, success: 0, error: 0, m3u8: 0 };
  });
  return s;
}

function incStat(provider, key, n) {
  n = n || 1;
  if (!stats[provider]) stats[provider] = { intercepted: 0, success: 0, error: 0, m3u8: 0 };
  stats[provider][key] = (stats[provider][key] || 0) + n;
  stats.global[key] = (stats.global[key] || 0) + n;
  statsDirty = true;
  scheduleFlush();
}

function scheduleFlush() {
  if (statsFlushTimer) return;
  statsFlushTimer = setTimeout(function () {
    statsFlushTimer = null;
    if (statsDirty) flushStats();
  }, 1000);
}

function flushStats() {
  statsDirty = false;
  chrome.storage.local.set({ stats: stats });
}

function resetStats() {
  stats = initStats();
  statsDirty = true;
  flushStats();
  return stats;
}

// ── Activity Log ────────────────────────────────────────────────────────

const MAX_LOG = 100;
let activityLog = [];
let logDirty = false;
let logFlushTimer = null;

function addLog(provider, type, detail) {
  var entry = {
    ts: Date.now(),
    provider: provider,
    type: type,       // 'intercept' | 'success' | 'error'
    detail: detail    // short description
  };
  activityLog.unshift(entry);
  if (activityLog.length > MAX_LOG) activityLog.length = MAX_LOG;
  logDirty = true;
  scheduleLogFlush();
}

function scheduleLogFlush() {
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(function () {
    logFlushTimer = null;
    if (logDirty) flushLog();
  }, 2000);
}

function flushLog() {
  logDirty = false;
  chrome.storage.local.set({ activityLog: activityLog });
}

// ── DNR Rule Management ────────────────────────────────────────────────

function buildProviderRules(providerId) {
  var def = PROVIDERS[providerId];
  if (!def || !def.rules) return [];
  var baseId = PID[providerId];
  var allRules = [];
  var ruleIdx = 0;

  def.rules.forEach(function (r) {
    var reqHeaders = [];
    var h = r.h || {};
    Object.keys(h).forEach(function (name) {
      if (r.op === 'remove') {
        reqHeaders.push({ header: name, operation: 'remove' });
      } else if (h[name]) {
        reqHeaders.push({ header: name, operation: 'set', value: h[name] });
      }
      if (!r.op && !h[name]) {
        reqHeaders.push({ header: name, operation: 'remove' });
      }
    });

    // Request header rule
    if (reqHeaders.length > 0) {
      allRules.push({
        id: baseId + ruleIdx,
        priority: r.pri || 10,
        action: { type: 'modifyHeaders', requestHeaders: reqHeaders },
        condition: {
          urlFilter: r.f,
          resourceTypes: ['xmlhttprequest', 'script', 'image', 'media', 'other']
        }
      });
      ruleIdx++;
    }

    // CORS response header rule — injects Access-Control-Allow-Origin
    // so the browser allows cross-origin fetch to CDN resources
    if (r.cors) {
      allRules.push({
        id: baseId + ruleIdx,
        priority: r.pri || 10,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
            { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
            { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' },
          ]
        },
        condition: {
          urlFilter: r.f,
          resourceTypes: ['xmlhttprequest', 'script', 'image', 'media', 'other']
        }
      });
      ruleIdx++;
    }
  });

  return allRules;
}

async function installProviderRules(providerId) {
  var rules = buildProviderRules(providerId);
  if (!rules.length) return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules });
    console.log('[Flyx SW] +' + rules.length + ' rules for ' + providerId);
  } catch (e) {
    console.error('[Flyx SW] install rules failed for ' + providerId + ':', e.message);
  }
}

async function removeProviderRules(providerId) {
  var baseId = PID[providerId];
  var nextBaseId = baseId + 100; // Provider ID range: baseId to baseId+99
  try {
    var existing = await chrome.declarativeNetRequest.getDynamicRules();
    var ids = existing
      .filter(function (r) { return r.id >= baseId && r.id < nextBaseId; })
      .map(function (r) { return r.id; });
    if (ids.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
      console.log('[Flyx SW] -' + ids.length + ' rules for ' + providerId);
    }
  } catch (e) {
    console.error('[Flyx SW] remove rules failed for ' + providerId + ':', e.message);
  }
}

async function installAllEnabledRules() {
  // Build all rules in one pass, then install atomically
  var allRules = [];
  for (var id in PROVIDERS) {
    if (providerState[id] !== false) {
      var rules = buildProviderRules(id);
      for (var i = 0; i < rules.length; i++) allRules.push(rules[i]);
    }
  }

  // Single atomic update: remove all old + add all new
  try {
    var existing = await chrome.declarativeNetRequest.getDynamicRules();
    var removeIds = existing.length ? existing.map(function (r) { return r.id; }) : [];
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeIds,
      addRules: allRules
    });
    console.log('[Flyx SW] DNR: -' + removeIds.length + ' old +' + allRules.length + ' new rules installed');
  } catch (e) {
    console.error('[Flyx SW] DNR install failed:', e.message);
  }
}

// ── Provider State ──────────────────────────────────────────────────────

let providerState = {};

function getDefaultProviderState() {
  var s = {};
  Object.keys(PROVIDERS).forEach(function (id) { s[id] = true; });
  return s;
}

async function toggleProvider(id, on) {
  providerState[id] = on;
  await chrome.storage.local.set({ providerState: providerState });
  if (on) {
    await installProviderRules(id);
  } else {
    await removeProviderRules(id);
  }
  return providerState;
}

// ── DLHD Extraction ────────────────────────────────────────────────────

const DLHD_STREAM_DOMAINS = ['dlhd.pk', 'dlhd.sx', 'dlstreams.com'];

async function dlhdExtract(channel) {
  var id = String(channel).replace(/^premium/i, '').trim();
  if (!/^\d+$/.test(id)) throw new Error('bad channel id: ' + channel);

  incStat('dlhd', 'intercepted');
  addLog('dlhd', 'intercept', 'ch' + id + ' extracting');

  // 1. stream page → daddy{N}.php iframe
  var playerUrl = null;
  for (var i = 0; i < DLHD_STREAM_DOMAINS.length; i++) {
    try {
      var sresp = await fetch('https://' + DLHD_STREAM_DOMAINS[i] + '/stream/stream-' + id + '.php', { credentials: 'omit' });
      if (!sresp.ok) continue;
      var shtml = await sresp.text();
      var im = shtml.match(/<iframe[^>]+src=["']([^"']*\/premiumtv\/daddy\d*\.php\?id=[^"']+)["']/i);
      if (im) { playerUrl = im[1]; break; }
    } catch (e) { /* next domain */ }
  }
  if (!playerUrl) throw new Error('no daddy iframe found');

  // 2. daddy.php → base64 signed master URL
  var presp = await fetch(playerUrl, { credentials: 'omit' });
  if (!presp.ok) throw new Error('daddy.php HTTP ' + presp.status);
  var phtml = await presp.text();
  var master = null;
  var re = /atob\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/g, mm;
  while ((mm = re.exec(phtml)) !== null) {
    try {
      var dec = atob(mm[1]);
      if (/^https?:\/\/\S+\.m3u8/i.test(dec)) { master = dec.trim(); break; }
    } catch (e) {}
  }
  if (!master) throw new Error('no signed master in daddy.php');

  // 3. master playlist → resolve relative media line to absolute
  var mresp = await fetch(master, { credentials: 'omit' });
  if (!mresp.ok) throw new Error('master HTTP ' + mresp.status);
  var body = await mresp.text();
  if (body.indexOf('#EXTM3U') === -1 && body.indexOf('#EXT-X-') === -1) throw new Error('master not m3u8');

  var playlist = body.split('\n').map(function (line) {
    var t = line.trim();
    if (!t || t.charAt(0) === '#') return line;
    try { return new URL(t, master).toString(); } catch (e) { return line; }
  }).join('\n');

  incStat('dlhd', 'success');
  incStat('dlhd', 'm3u8');
  addLog('dlhd', 'success', 'ch' + id + ' OK (' + playlist.length + 'b)');
  console.log('[Flyx SW] DLHD ch' + id + ' → ' + master);
  return { playlist: playlist, master: master };
}

// ── reCAPTCHA Whitelist ────────────────────────────────────────────────

const RECAPTCHA_VERIFY_URLS = [
  'https://chevy.newkso.ru/premiumtv/verify_recaptcha_token.php',
];

async function whitelistIP(channel) {
  // Try each verify URL
  for (var i = 0; i < RECAPTCHA_VERIFY_URLS.length; i++) {
    try {
      var verifyUrl = RECAPTCHA_VERIFY_URLS[i];
      var pageUrl = verifyUrl.replace(/\/premiumtv\/.*/, '/');
      var token = await solveRecaptchaV3(pageUrl);
      console.log('[Flyx SW] reCAPTCHA solved for ch' + channel + ': ' + token.substring(0, 20) + '...');
      var result = await verifyToken(channel, token, verifyUrl);
      if (result.success) return { success: true };
    } catch (e) {
      console.error('[Flyx SW] reCAPTCHA attempt ' + (i + 1) + ' failed:', e.message);
    }
  }
  throw new Error('all verify URLs exhausted');
}

// ── Miruro Extraction (browser-residential IP — NO CF Worker) ──────────
//
// Ported from cloudflare-proxy/src/miruro-proxy.ts. The extension SW runs
// in the browser and fetches directly from Miruro's API. The pipe crypto
// (XOR+gzip) is handled natively via Web APIs. No datacenter intermediary.

const MIRURO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36';
const MIRURO_BASE = 'https://miruro.to';
const PIPE_KEY = '71951034f8fbcf53d89db52ceb3dc22c';
const MIRURO_PROVIDER_PRIORITY = ['kiwi', 'bee', 'ally', 'dune', 'hop'];

// Parse pipe key as hex bytes (16 bytes)
var PIPE_KEY_BYTES = [];
for (var i = 0; i < PIPE_KEY.length; i += 2) {
  PIPE_KEY_BYTES.push(parseInt(PIPE_KEY.substring(i, i + 2), 16));
}

function base64urlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  var b = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return atob(b);
}

function encodePipeEnvelope(envelope) {
  var json = JSON.stringify(envelope);
  var encoded = encodeURIComponent(json).replace(
    /%([0-9A-F]{2})/g,
    function (_, hex) { return String.fromCharCode(parseInt(hex, 16)); }
  );
  return base64urlEncode(encoded);
}

async function decodePipeResponse(data) {
  // base64url decode → Uint8Array
  var b64 = base64urlDecode(data);
  var bytes = new Uint8Array(b64.length);
  for (var i = 0; i < b64.length; i++) bytes[i] = b64.charCodeAt(i);

  // XOR with hex key bytes
  var xored = new Uint8Array(bytes.length);
  for (var i = 0; i < bytes.length; i++) xored[i] = bytes[i] ^ PIPE_KEY_BYTES[i % PIPE_KEY_BYTES.length];

  // gunzip decompress
  var stream = new Blob([xored]).stream();
  var decompressed = stream.pipeThrough(new DecompressionStream('gzip'));
  var blob = await new Response(decompressed).blob();
  var arr = new Uint8Array(await blob.arrayBuffer());

  // decode → JSON
  return JSON.parse(new TextDecoder().decode(arr));
}

async function miruroApiGet(path, params) {
  var envelope = { path: path, method: 'GET', query: params, body: null, version: '0.2.0' };
  var encrypted = encodePipeEnvelope(envelope);
  var apiUrl = MIRURO_BASE + '/api/secure/pipe?e=' + encodeURIComponent(encrypted);
  var res = await fetch(apiUrl, {
    headers: { 'User-Agent': MIRURO_UA, 'Accept': '*/*', 'Origin': MIRURO_BASE, 'Referer': MIRURO_BASE + '/' }
  });
  if (!res.ok) throw new Error('Miruro ' + path + ' HTTP ' + res.status);
  var text = await res.text();
  return decodePipeResponse(text);
}

async function getAnilistIdSW(malId) {
  var query = 'query($idMal:Int){Media(idMal:$idMal,type:ANIME){id}}';
  var res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: query, variables: { idMal: malId } })
  });
  if (!res.ok) return null;
  var json = await res.json();
  return json?.data?.Media?.id || null;
}

async function miruroExtract(malId, episode, audioPref) {
  var ep = episode || 1;
  var pref = audioPref || 'sub';
  console.log('[Flyx SW] Miruro extract: malId=' + malId + ' ep=' + ep + ' pref=' + pref);

  incStat('miruro', 'intercepted');
  addLog('miruro', 'intercept', 'malId=' + malId + ' ep=' + ep);

  // 1. MAL → AniList
  var anilistId = await getAnilistIdSW(malId);
  if (!anilistId) throw new Error('Could not resolve AniList ID for MAL ' + malId);

  // 2. Get episodes via encrypted pipe
  var epData = await miruroApiGet('episodes', { anilistId: String(anilistId) });
  if (!epData || !epData.providers) throw new Error('No providers in Miruro episodes');

  // 3. Try each provider in priority order
  var sources = [];
  for (var pi = 0; pi < MIRURO_PROVIDER_PRIORITY.length; pi++) {
    var providerId = MIRURO_PROVIDER_PRIORITY[pi];
    var provider = epData.providers[providerId];
    if (!provider) continue;

    var cat = (pref === 'dub' && provider.episodes.dub && provider.episodes.dub.length > 0) ? 'dub' : 'sub';
    var eps = cat === 'dub' ? provider.episodes.dub : provider.episodes.sub;
    var match = null;
    for (var ei = 0; ei < eps.length; ei++) { if (eps[ei].number === ep) { match = eps[ei]; break; } }
    if (!match) continue;

    console.log('[Flyx SW] Miruro ep ' + ep + ' on ' + providerId + '/' + cat + ': ' + match.id);

    try {
      var srcData = await miruroApiGet('sources', { episodeId: match.id, provider: providerId, category: cat });
      var streams = srcData && srcData.streams ? srcData.streams : [];
      for (var si = 0; si < streams.length; si++) {
        var s = streams[si];
        if (!s.url || !s.isActive || s.type === 'embed') continue;
        sources.push({
          title: 'Miruro ' + providerId + ' (' + cat + ')' + (s.quality ? ' ' + s.quality : ''),
          url: s.url,
          quality: s.quality || 'auto',
          provider: 'miruro',
          language: cat === 'dub' ? 'en' : 'ja',
          type: 'hls'
        });
      }
      if (sources.length > 0) {
        console.log('[Flyx SW] Miruro: ' + sources.length + ' sources from ' + providerId);
        break;
      }
    } catch (e) {
      console.warn('[Flyx SW] Miruro ' + providerId + ' sources failed:', e.message);
    }
  }

  if (sources.length === 0) throw new Error('No Miruro sources found');

  incStat('miruro', 'success');
  incStat('miruro', 'm3u8');
  addLog('miruro', 'success', sources.length + ' sources for malId=' + malId);
  return sources;
}

// ── Generic CORS-free Fetch Relay ───────────────────────────────────────
//
// The SW runs in the extension background with <all_urls> host permission,
// so its fetch() can READ cross-origin responses that a page fetch() cannot
// (page fetches are blocked by CORS when the server sends no
// Access-Control-Allow-Origin header). Used by the AnimeKai/MegaUp page
// extractor, whose API servers send no CORS headers. DNR rules still inject
// any required Origin/Referer request headers transparently; megaup rules
// strip them. Requests go out from the same residential IP as the page.

async function corsFetch(url, headers, timeoutMs) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 15000);
  try {
    var res = await fetch(url, {
      headers: headers || {},
      credentials: 'omit',
      signal: ctrl.signal
    });
    var body = await res.text();
    return { status: res.status, body: body };
  } finally {
    clearTimeout(timer);
  }
}

// ── Message Router ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
  // Generic CORS-free fetch (AnimeKai/MegaUp page extractor)
  if (msg.type === 'corsFetch') {
    corsFetch(msg.url, msg.headers, msg.timeoutMs).then(function (r) {
      respond({ ok: true, status: r.status, body: r.body });
    }).catch(function (e) {
      respond({ ok: false, error: e.message });
    });
    return true; // async
  }

  // DLHD extraction
  if (msg.type === 'extractDLHD') {
    if (providerState.dlhd === false) {
      respond({ ok: false, error: 'DLHD provider is disabled' });
      return false;
    }
    dlhdExtract(msg.channel).then(function (r) {
      respond({ ok: true, playlist: r.playlist });
    }).catch(function (e) {
      incStat('dlhd', 'error');
      addLog('dlhd', 'error', e.message);
      console.error('[Flyx SW] DLHD ch' + msg.channel + ' failed:', e.message);
      respond({ ok: false, error: e.message });
    });
    return true; // async
  }

  // Miruro anime extraction (browser-residential IP — no CF Worker)
  if (msg.type === 'extractMiruro') {
    if (providerState.miruro === false) {
      respond({ ok: false, error: 'Miruro provider is disabled' });
      return false;
    }
    miruroExtract(msg.malId, msg.episode, msg.audioPref).then(function (sources) {
      respond({ ok: true, sources: sources });
    }).catch(function (e) {
      incStat('miruro', 'error');
      addLog('miruro', 'error', e.message);
      console.error('[Flyx SW] Miruro malId=' + msg.malId + ' failed:', e.message);
      respond({ ok: false, error: e.message });
    });
    return true; // async
  }

  // Full status (stats + providerState + activityLog)
  if (msg.type === 'getStatus') {
    respond({
      stats: stats,
      providerState: providerState,
      activityLog: activityLog,
      providers: Object.keys(PROVIDERS).reduce(function (acc, id) {
        acc[id] = { name: PROVIDERS[id].name, cat: PROVIDERS[id].cat };
        return acc;
      }, {}),
      categories: CATEGORIES
    });
    return true;
  }

  // Toggle provider on/off
  if (msg.type === 'toggle') {
    toggleProvider(msg.id, msg.on).then(function () {
      respond({ ok: true, state: providerState });
    }).catch(function (e) {
      respond({ ok: false, error: e.message });
    });
    return true;
  }

  // Per-provider stat increment (from bridge/inject.js)
  if (msg.type === 'stat') {
    incStat(msg.provider || 'stream', msg.key);
    if (msg.detail) addLog(msg.provider || 'stream', msg.key, msg.detail);
    return false; // sync, no response needed
  }

  // Reset all stats
  if (msg.type === 'resetStats') {
    var s = resetStats();
    activityLog = [];
    flushLog();
    respond({ ok: true, stats: s });
    return true;
  }

  // reCAPTCHA whitelist
  if (msg.type === 'whitelist') {
    whitelistIP(msg.ch).then(function (r) {
      respond({ success: true });
    }).catch(function (e) {
      respond({ success: false, error: e.message });
    });
    return true;
  }

  return false;
});

// ── Init ────────────────────────────────────────────────────────────────

let initDone = false;

async function init() {
  if (initDone) return;
  initDone = true;

  // Load persisted state
  var stored = await chrome.storage.local.get(['stats', 'providerState', 'activityLog']);
  stats = stored.stats || initStats();
  providerState = stored.providerState || getDefaultProviderState();
  activityLog = stored.activityLog || [];

  // Ensure all provider keys exist in stats and providerState
  var defStats = initStats();
  for (var id in defStats) {
    if (!stats[id]) stats[id] = Object.assign({}, defStats[id]);
    if (providerState[id] === undefined) providerState[id] = true;
  }
  if (!stats.global) stats.global = defStats.global;

  // Flush initial stats to storage so popup can read them on fresh install
  statsDirty = true;
  flushStats();

  // Install DNR rules for enabled providers (single atomic update)
  await installAllEnabledRules();

  console.log('[Flyx Bypass v3] SW ready — ' +
    Object.keys(providerState).filter(function (k) { return providerState[k]; }).length +
    '/' + Object.keys(PROVIDERS).length + ' providers enabled, ' +
    activityLog.length + ' log entries');
}

// onStartup ensures SW loads at browser start (before any messages arrive).
// The direct init() call covers SW wake-up from idle (top-level re-executes).
// Guard flag prevents double-init when both fire on browser start.
chrome.runtime.onStartup.addListener(init);
init();
