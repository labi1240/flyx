/**
 * Flyx Bypass v8 — Bridge (ISOLATED world, document_start)
 *
 * inject.js runs in the MAIN world (to override XMLHttpRequest) and therefore
 * has no access to chrome.* APIs. This bridge runs in the ISOLATED world of the
 * same page, so it can relay DLHD extraction requests from inject.js to the
 * extension service worker (which fetches from the browser's residential IP).
 *
 *   inject.js  --window.postMessage-->  bridge.js  --chrome.runtime-->  SW
 *   inject.js  <--window.postMessage--  bridge.js  <--sendResponse---   SW
 */
(function () {
  'use strict';

  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data) return;

    // Ping/pong for extension detection — web app polls this to gate Live TV
    if (e.data.__flyx === 'ping') {
      window.postMessage({ __flyx: 'pong', version: '2.1.0' }, '*');
      return;
    }

    if (e.data.__flyx !== 'req') return;
    var id = e.data.id;
    var channel = e.data.channel;

    try {
      chrome.runtime.sendMessage({ type: 'extractDLHD', channel: channel }, function (resp) {
        var err = chrome.runtime.lastError;
        if (err || !resp) {
          window.postMessage({ __flyx: 'res', id: id, ok: false, error: (err && err.message) || 'no response from SW' }, '*');
          return;
        }
        window.postMessage({ __flyx: 'res', id: id, ok: !!resp.ok, playlist: resp.playlist, error: resp.error }, '*');
      });
    } catch (ex) {
      window.postMessage({ __flyx: 'res', id: id, ok: false, error: 'bridge error: ' + ex.message }, '*');
    }
  });

  console.log('[Flyx Bypass v8] Bridge ready (ISOLATED world)');
})();
