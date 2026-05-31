/**
 * Flyx Bypass v7 — Extension SW
 *
 * On install: adds dynamic DNR rules to inject Origin+Referer headers
 * into all CDN requests. inject.js handles everything else directly.
 */

// ── Dynamic DNR rules — add Origin+Referer to CDN requests ─────────────

var RULES = [
  // Flixer
  { id: 1010, domain: 'hexa.su', referer: 'https://hexa.su/' },
  { id: 1011, domain: 'flixer.su', referer: 'https://hexa.su/' },
  // Videasy
  { id: 1020, domain: 'player.videasy.net', referer: 'https://player.videasy.net/' },
  // VidSrc
  { id: 1030, domain: '2embed.cc', referer: 'https://www.2embed.cc/' },
  // Others
  { id: 1040, domain: 'bingebox.to', referer: 'https://bingebox.to/' },
  { id: 1041, domain: 'themoviebox.org', referer: 'https://themoviebox.org/' },
  { id: 1042, domain: 'miruro.to', referer: 'https://miruro.to/' },
  { id: 1043, domain: 'aniwatchtv.to', referer: 'https://aniwatchtv.to/' },
  { id: 1044, domain: 'globetv.app', referer: 'https://globetv.app/' },
  { id: 1045, domain: 'ufreetv.com', referer: 'https://ufreetv.com/' },
  { id: 1046, domain: 'cdn-live.tv', referer: 'https://cdn-live.tv/' },
];

function buildRules() {
  return RULES.map(function (r) {
    var headers = [];
    if (r.origin) headers.push({ header: 'Origin', operation: 'set', value: r.origin });
    if (r.referer) headers.push({ header: 'Referer', operation: 'set', value: r.referer });
    return {
      id: r.id,
      priority: 10,
      action: { type: 'modifyHeaders', requestHeaders: headers },
      condition: { urlFilter: '*://' + r.domain + '/*', resourceTypes: ['xmlhttprequest', 'script', 'image', 'media', 'other'] }
    };
  });
}

// DLHD requires Referer: https://dlhd.pk/ on the stream page AND on daddy.php
// (403 without it). The extension SW cannot set Referer via fetch() (forbidden
// header), so DNR injects it. daddy.php lives on a rotating player domain, so we
// match by path, not host.
var DLHD_REFERER = 'https://dlhd.pk/';
function dlhdRefererRules() {
  function hdr() { return [{ header: 'Referer', operation: 'set', value: DLHD_REFERER }]; }
  return [
    { id: 1100, priority: 20, action: { type: 'modifyHeaders', requestHeaders: hdr() },
      condition: { urlFilter: '/stream/stream-', resourceTypes: ['xmlhttprequest', 'other'] } },
    { id: 1101, priority: 20, action: { type: 'modifyHeaders', requestHeaders: hdr() },
      condition: { urlFilter: '/premiumtv/daddy', resourceTypes: ['xmlhttprequest', 'other'] } },
  ];
}

async function installRules() {
  try {
    var oldRules = await chrome.declarativeNetRequest.getDynamicRules();
    var oldIds = oldRules.map(function (r) { return r.id; });
    var rules = buildRules().concat(dlhdRefererRules());
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: oldIds,
      addRules: rules
    });
    console.log('[Flyx SW] DNR rules installed:', rules.length);
  } catch (e) {
    console.error('[Flyx SW] DNR install failed:', e.message);
  }
}

// ── DLHD extraction (runs from the browser's residential IP) ────────────────
//
// stream-{id}.php → daddy{N}.php iframe → base64 signed master URL → master
// playlist with media line resolved to an absolute (CORS-open) CDN URL.
// The signed media token is IP-bound to THIS browser's IP, so hls.js can then
// fetch the media playlist + segments directly. See dlhd-extractor-worker/
// src/direct/dlhd-v8.ts for the canonical reference.

var DLHD_STREAM_DOMAINS = ['dlhd.pk', 'dlhd.sx', 'dlstreams.com'];

async function dlhdExtract(channel) {
  var id = String(channel).replace(/^premium/i, '').trim();
  if (!/^\d+$/.test(id)) throw new Error('bad channel id: ' + channel);

  // 1. stream page → daddy{N}.php iframe (DNR injects the required Referer)
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

  // 2. daddy.php → base64 signed master URL (DNR injects Referer)
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

  // 3. master playlist → resolve the relative media line to absolute
  var mresp = await fetch(master, { credentials: 'omit' });
  if (!mresp.ok) throw new Error('master HTTP ' + mresp.status);
  var body = await mresp.text();
  if (body.indexOf('#EXTM3U') === -1 && body.indexOf('#EXT-X-') === -1) throw new Error('master not m3u8');

  var playlist = body.split('\n').map(function (line) {
    var t = line.trim();
    if (!t || t.charAt(0) === '#') return line;
    try { return new URL(t, master).toString(); } catch (e) { return line; }
  }).join('\n');

  return { playlist: playlist, master: master };
}

chrome.runtime.onInstalled.addListener(installRules);
chrome.runtime.onStartup.addListener(installRules);

// ── Message handlers for popup ──────────────────────────────────────────

var stats = { ok: 0, err: 0 };
var providerState = {};

chrome.storage.local.get(['stats', 'providerState'], function (r) {
  if (r.stats) stats = r.stats;
  if (r.providerState) providerState = r.providerState;
});

chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
  if (msg.type === 'extractDLHD') {
    dlhdExtract(msg.channel).then(function (r) {
      stats.ok = (stats.ok || 0) + 1;
      console.log('[Flyx SW] DLHD ch' + msg.channel + ' → ' + r.master);
      respond({ ok: true, playlist: r.playlist });
    }).catch(function (e) {
      stats.err = (stats.err || 0) + 1;
      console.error('[Flyx SW] DLHD ch' + msg.channel + ' failed:', e.message);
      respond({ ok: false, error: e.message });
    });
    return true; // async
  }
  if (msg.type === 'getStatus') { respond({ stats: stats, providerState: providerState }); return true; }
  if (msg.type === 'toggle') { providerState[msg.id] = msg.on; chrome.storage.local.set({ providerState: providerState }); respond({ ok: 1 }); return true; }
  if (msg.type === 'resetStats') { stats = { ok: 0, err: 0 }; respond({ ok: 1 }); return true; }
  if (msg.type === 'stat') { stats[msg.key] = (stats[msg.key] || 0) + 1; return false; }
  return false;
});

console.log('[Flyx Bypass v7] SW ready — DNR rules active');
