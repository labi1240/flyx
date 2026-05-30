/**
 * Flyx Bypass v6 — Bridge (ISOLATED world)
 * Relays HTTP fetch requests from inject.js to extension SW.
 */
(function () {
  'use strict';
  if (!chrome.runtime?.id) return;

  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.type !== '__FB_REQ__') return;
    var d = e.data;
    chrome.runtime.sendMessage({ type: 'fetch', id: d.id, url: d.url })
      .then(function (res) {
        window.postMessage({ type: '__FB_RESP__', id: d.id, res: res }, '*');
      }).catch(function (err) {
        window.postMessage({ type: '__FB_RESP__', id: d.id, err: err.message }, '*');
      });
  });

  console.log('[Flyx Bypass v6] Bridge loaded');
})();
