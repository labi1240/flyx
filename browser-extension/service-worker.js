/**
 * Flyx Bypass v6 — Extension SW (minimal HTTP proxy)
 *
 * Fetches URLs from the extension context (no mixed content, no CORS).
 * Used by inject.js to access the DLHD origin IP (HTTP) and other CDNs.
 */
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36';
var OIP = '213.21.239.30';
var VHOST = 'chevy.newkso.ru';

chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
  if (msg.type === 'fetch') {
    doFetch(msg.url).then(respond).catch(function (e) { respond({ err: e.message }); });
    return true;
  }
  if (msg.type === 'getStatus') {
    respond({ stats: stats, providerState: providerState });
    return true;
  }
  if (msg.type === 'toggle') {
    providerState[msg.id] = msg.on;
    chrome.storage.local.set({ providerState: providerState });
    respond({ ok: 1 });
    return true;
  }
  if (msg.type === 'resetStats') {
    stats = { ok: 0, err: 0 };
    respond({ ok: 1 });
    return true;
  }
  return false;
});

async function doFetch(url) {
  console.log('[Flyx SW] fetch: ' + url.substring(0, 120));
  var h = {
    'User-Agent': UA,
    'Accept': '*/*'
  };
  // Origin IP requests need Host header for nginx vhost routing
  if (url.indexOf(OIP) !== -1) {
    h['Host'] = VHOST;
    h['Origin'] = 'https://www.newkso.ru';
    h['Referer'] = 'https://www.newkso.ru/';
  }
  var ctrl = new AbortController();
  var t = setTimeout(function () { ctrl.abort(); }, 15000);
  try {
    var resp = await fetch(url, { headers: h, signal: ctrl.signal });
    clearTimeout(t);
    var buf = await resp.arrayBuffer();
    var bytes = new Uint8Array(buf), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    console.log('[Flyx SW] OK ' + resp.status + ' ' + bytes.length + ' bytes');
    stats.ok++;
    return { status: resp.status, body: btoa(bin) };
  } catch (e) {
    clearTimeout(t);
    console.error('[Flyx SW] FAIL: ' + e.message);
    stats.err++;
    return { err: e.message };
  }
}

var stats = { ok: 0, err: 0 };
var providerState = {};

chrome.storage.local.get(['stats', 'providerState'], function (r) {
  if (r.stats) stats = r.stats;
  if (r.providerState) providerState = r.providerState;
});

chrome.runtime.onInstalled.addListener(function () {
  chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ['static_rules'] }).catch(function () {});
});

console.log('[Flyx Bypass v6] SW ready');
