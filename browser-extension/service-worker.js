/**
 * Flyx Bypass v3 — Extension Service Worker
 *
 * - Dynamic DNR rule management per provider (toggleable from popup)
 * - Per-provider stats persisted to chrome.storage.local
 * - Activity log ring buffer (last 100 events)
 * - DLHD extraction (mints IP-bound token from residential IP)
 * - reCAPTCHA v3 solver for DLHD IP whitelist
 *
 * VERSION: 3.0.0
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
      { f: '*://uwucdn.top/*', h: { Referer: 'https://miruro.to/' } },
    ]
  },
  animekai: {
    name: 'AnimeKai/MegaUp',
    cat: 'anime',
    rules: [
      // MegaUp blocks Origin+Referer — remove them
      { f: '*://*.megaup.*/*', h: { Origin: '', Referer: '' }, op: 'remove' },
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
  return def.rules.map(function (r, i) {
    var headers = [];
    var h = r.h || {};
    Object.keys(h).forEach(function (name) {
      if (r.op === 'remove') {
        headers.push({ header: name, operation: 'remove' });
      } else if (h[name]) {
        headers.push({ header: name, operation: 'set', value: h[name] });
      }
      // empty value means remove
      if (!r.op && !h[name]) {
        headers.push({ header: name, operation: 'remove' });
      }
    });
    return {
      id: baseId + i,
      priority: r.pri || 10,
      action: { type: 'modifyHeaders', requestHeaders: headers },
      condition: {
        urlFilter: r.f,
        resourceTypes: ['xmlhttprequest', 'script', 'image', 'media', 'other']
      }
    };
  });
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
  var def = PROVIDERS[providerId];
  if (!def || !def.rules || !def.rules.length) return;
  var ids = def.rules.map(function (_, i) { return baseId + i; });
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
    console.log('[Flyx SW] -' + ids.length + ' rules for ' + providerId);
  } catch (e) {
    console.error('[Flyx SW] remove rules failed for ' + providerId + ':', e.message);
  }
}

async function installAllEnabledRules() {
  // Remove all existing dynamic rules first
  try {
    var existing = await chrome.declarativeNetRequest.getDynamicRules();
    if (existing.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existing.map(function (r) { return r.id; })
      });
    }
  } catch (e) { /* ignore */ }

  // Install rules for enabled providers
  for (var id in PROVIDERS) {
    if (providerState[id] !== false) {
      await installProviderRules(id);
    }
  }
  console.log('[Flyx SW] DNR rules installed for all enabled providers');
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

// ── Message Router ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
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

async function init() {
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

  // Install DNR rules for enabled providers
  await installAllEnabledRules();

  console.log('[Flyx Bypass v3] SW ready — ' +
    Object.keys(providerState).filter(function (k) { return providerState[k]; }).length +
    '/' + Object.keys(PROVIDERS).length + ' providers enabled, ' +
    activityLog.length + ' log entries');
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
init();
