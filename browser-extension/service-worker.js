/**
 * Flyx Bypass v7 — Extension SW
 *
 * On install: adds dynamic DNR rules to inject Origin+Referer headers
 * into all CDN requests. inject.js handles everything else directly.
 */

// ── Dynamic DNR rules — add Origin+Referer to CDN requests ─────────────

var RULES = [
  // DLHD
  { id: 1001, domain: 'chevy.newkso.ru', origin: 'https://www.newkso.ru', referer: 'https://www.newkso.ru/' },
  { id: 1002, domain: 'chevy.soyspace.cyou', origin: 'https://www.newkso.ru', referer: 'https://www.newkso.ru/' },
  { id: 1003, domain: 'chevy.enviromentalanimal.horse', origin: 'https://www.newkso.ru', referer: 'https://www.newkso.ru/' },
  { id: 1004, domain: 'newkso.ru', origin: 'https://www.newkso.ru', referer: 'https://www.newkso.ru/' },
  { id: 1005, domain: 'key.keylocking.ru', origin: 'https://www.newkso.ru', referer: 'https://www.newkso.ru/' },
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

async function installRules() {
  try {
    var oldRules = await chrome.declarativeNetRequest.getDynamicRules();
    var oldIds = oldRules.map(function (r) { return r.id; });
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: oldIds,
      addRules: buildRules()
    });
    console.log('[Flyx SW] DNR rules installed:', RULES.length);
  } catch (e) {
    console.error('[Flyx SW] DNR install failed:', e.message);
  }
}

chrome.runtime.onInstalled.addListener(installRules);
chrome.runtime.onStartup.addListener(installRules);

// Install immediately on SW start
installRules();

// ── Message handlers for popup ──────────────────────────────────────────

var stats = { ok: 0, err: 0 };
var providerState = {};

chrome.storage.local.get(['stats', 'providerState'], function (r) {
  if (r.stats) stats = r.stats;
  if (r.providerState) providerState = r.providerState;
});

chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
  if (msg.type === 'getStatus') { respond({ stats: stats, providerState: providerState }); return true; }
  if (msg.type === 'toggle') { providerState[msg.id] = msg.on; chrome.storage.local.set({ providerState: providerState }); respond({ ok: 1 }); return true; }
  if (msg.type === 'resetStats') { stats = { ok: 0, err: 0 }; respond({ ok: 1 }); return true; }
  if (msg.type === 'stat') { stats[msg.key] = (stats[msg.key] || 0) + 1; return false; }
  return false;
});

console.log('[Flyx Bypass v7] SW ready — DNR rules active');
