/**
 * Flyx Bypass v3 — Page Interceptor (MAIN world, document_start)
 *
 * Intercepts XHR/fetch to *.workers.dev and fetches content directly
 * from CDNs. DNR rules (installed by service-worker.js) handle
 * Origin+Referer header injection transparently.
 *
 * DLHD extraction is delegated to the SW (via bridge.js) because the
 * signed media token is IP-BOUND to the browser's residential IP.
 *
 * Stats are reported back to the SW via bridge.js for persistence.
 *
 * VERSION: 3.0.0
 */
(function () {
  'use strict';

  // Extension detection flag — web app checks this to gate Live TV access
  window.__FLYX_EXTENSION__ = { version: '3.0.0', installed: true };

  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36';

  // ── Provider Detection ────────────────────────────────────────────────

  function detectProvider(url) {
    try {
      var h = new URL(url).hostname;
      if (/hexa\.su|flixer\.su/.test(h)) return 'flixer';
      if (/player\.videasy\.net/.test(h)) return 'videasy';
      if (/2embed\.cc/.test(h)) return 'vidsrc';
      if (/bingebox\.to/.test(h)) return 'bingebox';
      if (/themoviebox\.org|movieboxonline\.net|123movie\.app/.test(h)) return 'moviebox';
      if (/uwucdn\.top|miruro\.(to|tv|bz|ru)/.test(h)) return 'miruro';
      if (/megaup/i.test(h)) return 'animekai';
      if (/aniwatchtv\.to/.test(h)) return 'hianime';
      if (/ntv\.cx|ntvs\.cx|ntv\.direct/.test(h)) return 'ntv';
      if (/ufreetv\.com/.test(h)) return 'ufreetv';
      if (/globetv\.app/.test(h)) return 'globetv';
      if (/cdn-live\.tv/.test(h)) return 'cdnlive';
      if (/poocloud\.in/.test(h)) return 'viprow';
      return 'stream';
    } catch (e) {
      return 'stream';
    }
  }

  // ── Stats Reporting ──────────────────────────────────────────────────

  function reportStat(provider, key, detail) {
    try {
      window.postMessage({
        __flyx: 'stat',
        provider: provider,
        key: key,
        detail: detail || ''
      }, '*');
    } catch (e) { /* ignore */ }
  }

  // ── URL Detection ────────────────────────────────────────────────────

  function isWorker(url) {
    try { return new URL(url, location.origin).hostname.endsWith('.workers.dev'); } catch (e) { return false; }
  }
  function isDLHD(url) {
    try { return new URL(url, location.origin).hostname === 'dlhd.vynx-3b3.workers.dev'; } catch (e) { return false; }
  }

  // ── DLHD Handler (v8 — May 30 2026) ──────────────────────────────────

  function handleDLHD(url) {
    return new Promise(function (resolve, reject) {
      var pu = new URL(url, location.origin);
      var ch = pu.searchParams.get('channel') || pu.pathname.split('/').pop() || '';
      var reqId = 'flyx_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      console.log('[Flyx] DLHD ch=' + ch + ' → SW (' + reqId + ')');

      var timer = setTimeout(function () { cleanup(); reject(new Error('SW extract timeout')); }, 25000);
      function cleanup() { clearTimeout(timer); window.removeEventListener('message', onMsg); }
      function onMsg(e) {
        if (e.source !== window || !e.data || e.data.__flyx !== 'res' || e.data.id !== reqId) return;
        cleanup();
        if (e.data.ok && e.data.playlist) {
          console.log('[Flyx] DLHD OK (' + e.data.playlist.length + 'b)');
          resolve(e.data.playlist);
        } else {
          reject(new Error(e.data.error || 'SW extract failed'));
        }
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ __flyx: 'req', id: reqId, channel: String(ch) }, '*');
    });
  }

  // ── M3U8 Rewriter ────────────────────────────────────────────────────

  function rewrite(list, base) {
    var bo = '', bp = '';
    try { var bu = new URL(base); bo = bu.origin; bp = bu.pathname; bp = bp.substring(0, bp.lastIndexOf('/') + 1); } catch (e) {}

    var lines = list.split('\n'), joined = [], carry = '';
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t || t.charAt(0) === '#') { if (carry) { joined.push(carry); carry = ''; } joined.push(lines[i]); }
      else if (t.indexOf('http') === 0) { if (carry) joined.push(carry); carry = t; }
      else { carry += t; }
    }
    if (carry) joined.push(carry);

    function resolve(u) {
      if (u.indexOf('http') === 0) return u;
      try { return new URL(u, bo + bp).toString(); } catch (e) { return u; }
    }

    var out = [];
    for (var i = 0; i < joined.length; i++) {
      var line = joined[i], tr = line.trim();
      if (tr.indexOf('#EXT-X-KEY:') === 0) {
        var m = tr.match(/URI="([^"]+)"/);
        if (m && m[1].indexOf('http') !== 0) { out.push(tr.replace('URI="' + m[1] + '"', 'URI="' + resolve(m[1]) + '"')); continue; }
        out.push(line); continue;
      }
      if (tr.indexOf('#EXT-X-ENDLIST') === 0) continue;
      if (!tr || tr.charAt(0) === '#') { out.push(line); continue; }
      if (tr.indexOf('http') === 0) { out.push(tr); continue; }
      out.push(resolve(tr));
    }
    return out.join('\n');
  }

  // ── Generic handler ──────────────────────────────────────────────────

  async function handleGeneric(url) {
    var pu = new URL(url);
    var tgt = pu.searchParams.get('url');
    if (!tgt) throw new Error('No URL param');

    var provider = detectProvider(tgt);
    reportStat(provider, 'intercepted', tgt.substring(0, 80));

    console.log('[Flyx] ' + provider + ': ' + tgt.substring(0, 100));
    var r = await fetch(tgt, { headers: { 'User-Agent': UA, 'Accept': '*/*' } });
    var ct = r.headers.get('content-type') || '';
    if (ct.indexOf('mpegurl') !== -1 || tgt.indexOf('.m3u8') !== -1) {
      var t = await r.text();
      var rewritten = rewrite(t, tgt);
      reportStat(provider, 'success', tgt.substring(0, 60));
      reportStat(provider, 'm3u8');
      return rewritten;
    }
    reportStat(provider, 'success', tgt.substring(0, 60));
    return r;
  }

  // ── XHR Override ─────────────────────────────────────────────────────

  var XHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    var x = new XHR();
    var _url = '', _method = 'GET', _intercept = false, _aborted = false;
    var _rs = 0, _status = 0, _st = '', _rbody = null, _events = null;

    function fire(n) { var a = _events[n]; if (!a) return; if (a._on) try { a._on.call(x); } catch (e) {} for (var i = 0; i < a.length; i++) try { a[i].call(x); } catch (e) {} }
    function setRS(rs) { _rs = rs; fire('readystatechange'); if (rs === 4) { fire('load'); fire('loadend'); } }
    function fallback() { _intercept = false; XHR.prototype.open.call(x, _method, _url, true); XHR.prototype.send.call(x, null); }

    function patch() {
      if (_events) return; _events = {};
      ['readystatechange', 'load', 'error', 'abort', 'loadend', 'loadstart'].forEach(function (n) {
        _events[n] = []; Object.defineProperty(x, 'on' + n, { get: function () { return _events[n]._on || null; }, set: function (f) { _events[n]._on = f; }, configurable: true });
      });
      Object.defineProperty(x, 'readyState', { get: function () { return _rs; }, configurable: true });
      Object.defineProperty(x, 'status', { get: function () { return _status; }, configurable: true });
      Object.defineProperty(x, 'statusText', { get: function () { return _st; }, configurable: true });
      Object.defineProperty(x, 'response', { get: function () { return _rbody ? new TextDecoder().decode(_rbody) : null; }, configurable: true });
      Object.defineProperty(x, 'responseText', { get: function () { return _rbody ? new TextDecoder().decode(_rbody) : ''; }, configurable: true });
    }

    x.open = function (m, u, a) {
      _method = (m || 'GET').toUpperCase(); _url = String(u);
      _intercept = isWorker(_url);
      if (_intercept) { console.log('[Flyx] XHR: ' + _url.substring(0, 120)); patch(); }
      else XHR.prototype.open.call(x, m, u, a !== false, arguments[3], arguments[4]);
    };
    x.send = function (b) {
      if (_aborted) return;
      if (!_intercept) return XHR.prototype.send.call(x, b);
      fire('loadstart'); setRS(1);
      var h = isDLHD(_url) ? handleDLHD : handleGeneric;
      h(_url).then(function (result) {
        if (_aborted) return;
        var text;
        if (typeof result === 'string') text = result;
        else return result.text().then(function (t) { done(t); });
        done(text);
        function done(t) {
          _status = 200; _st = 'OK';
          _rbody = new TextEncoder().encode(t);
          setRS(2); setRS(3); setRS(4);
        }
      }).catch(function (err) {
        if (_aborted) return;
        console.error('[Flyx] FAIL: ' + err.message + ' — fallback');
        // Report error for non-DLHD handlers (DLHD reports its own)
        if (!isDLHD(_url)) {
          var pu = new URL(_url);
          var tgt = pu.searchParams.get('url') || '';
          var provider = detectProvider(tgt);
          reportStat(provider, 'error', err.message.substring(0, 60));
        }
        fallback();
      });
    };
    x.abort = function () { _aborted = true; fire('abort'); fire('loadend'); };
    return x;
  };
  window.XMLHttpRequest.UNSENT = 0; window.XMLHttpRequest.OPENED = 1;
  window.XMLHttpRequest.HEADERS_RECEIVED = 2; window.XMLHttpRequest.LOADING = 3;
  window.XMLHttpRequest.DONE = 4;

  console.log('[Flyx Bypass v3] Ready — DLHD minted in-browser via SW (IP-bound token) + generic CDN fetch');
})();
