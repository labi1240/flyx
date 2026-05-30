/**
 * Flyx Bypass v2 — Isolated-World Bridge
 *
 * Runs in ISOLATED world with chrome.runtime access.
 * Bridges postMessage (from inject.js in MAIN world) ↔ chrome.runtime.sendMessage (to service worker).
 */
(function () {
  'use strict';
  if (!chrome.runtime?.id) return;

  // inject.js → service worker
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.type !== '__FB_REQ__') return;
    var d = e.data;
    chrome.runtime.sendMessage({
      type: 'proxy', id: d.id, url: d.url,
      method: d.method, headers: d.headers, body: d.body
    }).then(function (res) {
      window.postMessage({ type: '__FB_RESP__', id: d.id, res: res }, '*');
    }).catch(function (err) {
      window.postMessage({ type: '__FB_RESP__', id: d.id, err: err.message || 'Bridge error' }, '*');
    });
  });

  // Stats relay
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.type !== '__FB_STAT__') return;
    chrome.runtime.sendMessage({ type: 'stat', key: e.data.key, val: e.data.val }).catch(function(){});
  });

  console.log('[Flyx Bypass v2] Bridge loaded');
})();
