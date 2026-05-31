/**
 * Flyx Bypass v3 — Bridge (ISOLATED world, document_start)
 *
 * Relays between inject.js (MAIN world, no chrome.*) and the extension SW.
 * Also caches provider state for fast in-page lookups.
 *
 *   inject.js  --window.postMessage-->  bridge.js  --chrome.runtime-->  SW
 *   inject.js  <--window.postMessage--  bridge.js  <--sendResponse---   SW
 *
 * VERSION: 3.0.0
 */
(function () {
  'use strict';

  // Cached provider state (synced from SW periodically)
  var providerState = {};
  var stateLoaded = false;

  // Load initial provider state from SW
  try {
    chrome.runtime.sendMessage({ type: 'getStatus' }, function (resp) {
      if (resp && resp.providerState) {
        providerState = resp.providerState;
        stateLoaded = true;
      }
    });
  } catch (e) { /* SW may be waking up */ }

  // Listen for storage changes to keep providerState current
  chrome.storage.local.onChanged.addListener(function (changes) {
    if (changes.providerState) {
      providerState = changes.providerState.newValue || {};
      stateLoaded = true;
      // Push to inject.js
      window.postMessage({ __flyx: 'providerState', state: providerState }, '*');
    }
  });

  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data) return;

    // Extension detection ping/pong
    if (e.data.__flyx === 'ping') {
      window.postMessage({ __flyx: 'pong', version: '3.0.0' }, '*');
      return;
    }

    // Provider state query from inject.js
    if (e.data.__flyx === 'getProviderState') {
      window.postMessage({
        __flyx: 'providerState',
        state: providerState,
        loaded: stateLoaded
      }, '*');
      return;
    }

    // Stat report from inject.js → relay to SW
    if (e.data.__flyx === 'stat') {
      try {
        chrome.runtime.sendMessage({
          type: 'stat',
          provider: e.data.provider || 'stream',
          key: e.data.key,
          detail: e.data.detail || ''
        });
      } catch (ex) { /* ignore — SW may be busy */ }
      return;
    }

    // DLHD extraction request from inject.js → relay to SW
    if (e.data.__flyx !== 'req') return;
    var id = e.data.id;
    var channel = e.data.channel;

    try {
      chrome.runtime.sendMessage({ type: 'extractDLHD', channel: channel }, function (resp) {
        var err = chrome.runtime.lastError;
        if (err || !resp) {
          window.postMessage({
            __flyx: 'res', id: id, ok: false,
            error: (err && err.message) || 'no response from SW'
          }, '*');
          return;
        }
        window.postMessage({
          __flyx: 'res', id: id, ok: !!resp.ok,
          playlist: resp.playlist, error: resp.error
        }, '*');
      });
    } catch (ex) {
      window.postMessage({
        __flyx: 'res', id: id, ok: false,
        error: 'bridge error: ' + ex.message
      }, '*');
    }
  });

  console.log('[Flyx Bypass v3] Bridge ready (ISOLATED world)');
})();
