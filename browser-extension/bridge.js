/**
 * Flyx Bypass v3 — Isolated-World Bridge
 *
 * Relays messages between inject.js (MAIN world) and extension SW.
 * Handles:
 *   - __FB_REQ__  → chrome.runtime.sendMessage (generic proxy — legacy fallback)
 *   - __FB_CAP_REQ__ → chrome.runtime.sendMessage (reCAPTCHA solve)
 */
(function () {
  'use strict';
  if (!chrome.runtime?.id) return;

  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data) return;

    var d = e.data;

    // Legacy proxy request (still used as fallback)
    if (d.type === '__FB_REQ__') {
      chrome.runtime.sendMessage({
        type: 'proxy', id: d.id, url: d.url,
        method: d.method, headers: d.headers, body: d.body
      }).then(function (res) {
        window.postMessage({ type: '__FB_RESP__', id: d.id, res: res }, '*');
      }).catch(function (err) {
        window.postMessage({ type: '__FB_RESP__', id: d.id, err: err.message }, '*');
      });
    }

    // reCAPTCHA solve request
    if (d.type === '__FB_CAP_REQ__') {
      chrome.runtime.sendMessage({
        type: 'whitelist', ch: d.channel
      }).then(function (res) {
        window.postMessage({ type: '__FB_CAP_RESP__', id: d.id, token: res.token, err: res.error || res.err }, '*');
      }).catch(function (err) {
        window.postMessage({ type: '__FB_CAP_RESP__', id: d.id, err: err.message }, '*');
      });
    }
  });

  console.log('[Flyx Bypass v3] Bridge loaded');
})();
