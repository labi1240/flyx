/**
 * Flyx Bypass v5 — Main-World DLHD Stream Unblocker
 *
 * Runs in page MAIN world (manifest "world":"MAIN", document_start).
 * Intercepts XHR to dlhd.vynx-3b3.workers.dev/play/* and fetches the
 * M3U8 directly from chevy.newkso.ru (HTTPS) with the browser's
 * residential IP. DNR rules handle Origin+Referer headers on CDN requests.
 */
(function () {
  'use strict';

  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36';

  function isDLHDWorker(url) {
    try { var h = new URL(url, location.origin).hostname; return h === 'dlhd.vynx-3b3.workers.dev'; }
    catch { return false; }
  }

  function isWorkerProxy(url) {
    try { return new URL(url, location.origin).hostname.endsWith('.workers.dev'); }
    catch { return false; }
  }

  // ── DLHD: server lookup + M3U8 fetch + rewrite ───────────────────────

  var _dlhdCache = {};

  async function handleDLHD(url) {
    var pu = new URL(url);
    var channelId = pu.searchParams.get('channel') || pu.pathname.split('/').pop();
    var channelKey = channelId.indexOf('premium') === 0 ? channelId : 'premium' + channelId;

    console.log('[Flyx Bypass] DLHD channel=' + channelKey);

    // Server lookup (cached 60s)
    var serverKey;
    var cacheKey = channelKey;
    if (_dlhdCache[cacheKey] && _dlhdCache[cacheKey].ts > Date.now() - 60000) {
      serverKey = _dlhdCache[cacheKey].key;
    } else {
      serverKey = await lookupServer(channelKey);
      _dlhdCache[cacheKey] = { key: serverKey, ts: Date.now() };
    }

    console.log('[Flyx Bypass] DLHD server=' + serverKey);

    // Fetch M3U8
    var m3u8Url = 'https://chevy.newkso.ru/proxy/' + serverKey + '/' + channelKey + '/mono.css';
    console.log('[Flyx Bypass] DLHD M3U8: ' + m3u8Url);

    var resp = await fetch(m3u8Url, {
      headers: { 'User-Agent': UA, 'Accept': '*/*' },
      referrer: 'https://www.newkso.ru/',
      referrerPolicy: 'unsafe-url'
    });

    if (!resp.ok) throw new Error('M3U8 fetch: HTTP ' + resp.status);

    var text = await resp.text();
    if (text.indexOf('#EXT') === -1) throw new Error('Not an M3U8: ' + text.substring(0, 200));

    console.log('[Flyx Bypass] DLHD M3U8 OK, length=' + text.length);

    // Rewrite M3U8: resolve relative URLs → absolute HTTPS chevy.newkso.ru
    var base = 'https://chevy.newkso.ru/proxy/' + serverKey + '/' + channelKey + '/';
    var rewritten = rewriteDLHD(text, base);
    console.log('[Flyx Bypass] DLHD M3U8 rewritten');

    return rewritten;
  }

  async function lookupServer(channelKey) {
    var domains = ['newkso.ru', 'enviromentalanimal.horse', 'soyspace.cyou'];
    for (var i = 0; i < domains.length; i++) {
      try {
        var url = 'https://chevy.' + domains[i] + '/server_lookup?channel_id=' + channelKey;
        console.log('[Flyx Bypass] Lookup: ' + url);
        var resp = await fetch(url, {
          headers: { 'User-Agent': UA, 'Accept': '*/*' },
          referrer: 'https://www.newkso.ru/',
          referrerPolicy: 'unsafe-url'
        });
        if (resp.ok) {
          var t = await resp.text();
          console.log('[Flyx Bypass] Lookup response: ' + t.substring(0, 100));
          if (t.charAt(0) === '{') {
            try { var d = JSON.parse(t); if (d.server_key) return d.server_key; } catch(e) {}
          }
          if (t.trim().length < 20 && t.trim().length > 1 && t.indexOf('<') === -1) return t.trim();
        }
      } catch(e) { console.warn('[Flyx Bypass] Lookup error: ' + e.message); }
    }
    return 'ddy6';
  }

  function rewriteDLHD(playlist, baseUrl) {
    // Fix split URLs
    var lines = playlist.split('\n'), joined = [], carry = '';
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t || t.charAt(0) === '#') { if (carry) { joined.push(carry); carry = ''; } joined.push(lines[i]); }
      else if (t.indexOf('http') === 0) { if (carry) joined.push(carry); carry = t; }
      else { carry += t; }
    }
    if (carry) joined.push(carry);

    var bo = '', bp = '';
    try { var bu = new URL(baseUrl); bo = bu.origin; bp = bu.pathname; bp = bp.substring(0, bp.lastIndexOf('/') + 1); } catch(e) {}
    function resolve(u) {
      if (u.indexOf('http') === 0) return u;
      try { return new URL(u, bo + bp).toString(); } catch(e) { return u; }
    }

    var out = [];
    for (var i = 0; i < joined.length; i++) {
      var line = joined[i], trimmed = line.trim();
      if (trimmed.indexOf('#EXT-X-KEY:') === 0) {
        var m = trimmed.match(/URI="([^"]+)"/);
        if (m && m[1].indexOf('http') !== 0) { out.push(trimmed.replace('URI="' + m[1] + '"', 'URI="' + resolve(m[1]) + '"')); continue; }
        out.push(line); continue;
      }
      if (trimmed.indexOf('#EXT-X-ENDLIST') === 0) continue;
      if (!trimmed || trimmed.charAt(0) === '#') { out.push(line); continue; }
      if (trimmed.indexOf('http') === 0) { out.push(trimmed); continue; }
      out.push(resolve(trimmed));
    }
    return out.join('\n');
  }

  // ── Generic handler for other providers ──────────────────────────────

  async function handleGeneric(url) {
    var pu = new URL(url);
    var targetUrl = pu.searchParams.get('url');
    if (!targetUrl) throw new Error('No URL param');

    var ref = pu.searchParams.get('referer') || pu.searchParams.get('referrer');
    var opts = { headers: { 'User-Agent': UA, 'Accept': '*/*' } };
    if (ref) { opts.referrer = ref; opts.referrerPolicy = 'unsafe-url'; }

    var resp = await fetch(targetUrl, opts);
    var ct = resp.headers.get('content-type') || '';
    if (ct.indexOf('mpegurl') !== -1 || targetUrl.indexOf('.m3u8') !== -1) {
      var text = await resp.text();
      return rewriteM3U8(text, targetUrl);
    }
    // For binary (segments): return Response so HLS.js can consume it
    return resp;
  }

  function rewriteM3U8(playlist, baseUrl) {
    var bp = '';
    try { var pu = new URL(baseUrl); bp = pu.pathname; bp = bp.substring(0, bp.lastIndexOf('/') + 1); } catch(e) {}
    var bo = '';
    try { bo = new URL(baseUrl).origin; } catch(e) {}

    function resolve(u) {
      if (u.indexOf('http') === 0) return u;
      try { return new URL(u, bo + bp).toString(); } catch(e) { return u; }
    }

    var lines = playlist.split('\n'), out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], trimmed = line.trim();
      if (!trimmed) { out.push(line); continue; }
      if (trimmed.charAt(0) === '#') {
        var m = trimmed.match(/URI="([^"]+)"/);
        if (m) { out.push(trimmed.replace('URI="' + m[1] + '"', 'URI="' + resolve(m[1]) + '"')); continue; }
        out.push(line); continue;
      }
      out.push(resolve(trimmed));
    }
    return out.join('\n');
  }

  // ── XHR Override ─────────────────────────────────────────────────────

  var XHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    var xhr = new XHR();
    var _url = '', _method = 'GET', _intercept = false;
    var _aborted = false, _rs = 0, _status = 0, _st = '';
    var _rbody = null, _rt = '', _rh = {};
    var _events = null;

    function fireMock(name) {
      var arr = _events[name];
      if (!arr) return;
      if (arr._on) try { arr._on.call(xhr); } catch (e) {}
      for (var i = 0; i < arr.length; i++) { try { arr[i].call(xhr); } catch (e) {} }
    }
    function setRS(rs) { _rs = rs; fireMock('readystatechange'); if (rs === 4) { fireMock('load'); fireMock('loadend'); } }

    function fallbackToNative(body) {
      _intercept = false;
      XHR.prototype.open.call(xhr, _method, _url, true);
      XHR.prototype.send.call(xhr, body);
    }

    function applyPatches() {
      if (_events) return;
      _events = {};
      ['readystatechange', 'load', 'error', 'abort', 'timeout', 'loadend', 'loadstart', 'progress'].forEach(function (n) {
        _events[n] = [];
        var prop = 'on' + n;
        Object.defineProperty(xhr, prop, {
          get: function () { return _events[n]._on || null; },
          set: function (fn) { _events[n]._on = fn; },
          configurable: true
        });
      });
      Object.defineProperty(xhr, 'readyState', { get: function () { return _rs; }, configurable: true });
      Object.defineProperty(xhr, 'status', { get: function () { return _status; }, configurable: true });
      Object.defineProperty(xhr, 'statusText', { get: function () { return _st; }, configurable: true });
      Object.defineProperty(xhr, 'responseURL', { get: function () { return _url; }, configurable: true });
      Object.defineProperty(xhr, 'responseType', { get: function () { return _rt; }, set: function (v) { _rt = v; }, configurable: true });
      Object.defineProperty(xhr, 'response', { get: function () {
        if (!_rbody) return null;
        if (_rt === 'arraybuffer') return _rbody.buffer;
        return new TextDecoder().decode(_rbody);
      }, configurable: true });
      Object.defineProperty(xhr, 'responseText', { get: function () { return _rbody ? new TextDecoder().decode(_rbody) : ''; }, configurable: true });
      xhr.getResponseHeader = function (n) {
        var k = Object.keys(_rh).find(function (kk) { return kk.toLowerCase() === n.toLowerCase(); });
        return k ? _rh[k] : null;
      };
      xhr.getAllResponseHeaders = function () { return Object.keys(_rh).map(function (k) { return k + ': ' + _rh[k]; }).join('\r\n'); };
    }

    var _headers = {};

    xhr.open = function (method, url, async) {
      _method = (method || 'GET').toUpperCase();
      _url = String(url);
      _intercept = isWorkerProxy(_url);
      if (_intercept) {
        console.log('[Flyx Bypass] XHR INTERCEPT: ' + _url.substring(0, 120));
        applyPatches();
      } else {
        XHR.prototype.open.call(xhr, method, url, async !== false, arguments[3], arguments[4]);
      }
    };
    xhr.setRequestHeader = function (name, value) {
      if (_intercept) { _headers[name] = value; return; }
      XHR.prototype.setRequestHeader.call(xhr, name, value);
    };
    xhr.send = function (body) {
      if (_aborted) return;
      if (!_intercept) return XHR.prototype.send.call(xhr, body);

      fireMock('loadstart'); setRS(1);

      var handler = isDLHDWorker(_url) ? handleDLHD : handleGeneric;

      handler(_url).then(function (result) {
        if (_aborted) return;
        var text;
        if (typeof result === 'string') {
          text = result;
        } else {
          // Response object from handleGeneric for binary data
          return result.text().then(function (t) { text = t; proceed(); });
        }
        proceed();

        function proceed() {
          _status = 200; _st = 'OK';
          _rh = { 'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*' };
          setRS(2);
          _rbody = new TextEncoder().encode(text);
          setRS(3); setRS(4);
        }
      }).catch(function (err) {
        if (_aborted) return;
        console.warn('[Flyx Bypass] Intercept failed: ' + err.message + ' — falling back');
        fallbackToNative(body);
      });
    };
    xhr.abort = function () {
      _aborted = true;
      if (!_intercept) { XHR.prototype.abort.call(xhr); return; }
      fireMock('abort'); fireMock('loadend');
    };
    return xhr;
  };
  window.XMLHttpRequest.UNSENT = 0;
  window.XMLHttpRequest.OPENED = 1;
  window.XMLHttpRequest.HEADERS_RECEIVED = 2;
  window.XMLHttpRequest.LOADING = 3;
  window.XMLHttpRequest.DONE = 4;

  // ── fetch() Override ──────────────────────────────────────────────────

  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
    if (!isWorkerProxy(url)) return _fetch.call(window, input, init);

    console.log('[Flyx Bypass] FETCH INTERCEPT: ' + url.substring(0, 150));

    var handler = isDLHDWorker(url) ? handleDLHD : handleGeneric;

    return handler(url).then(function (result) {
      if (typeof result === 'string') {
        return new Response(result, {
          status: 200,
          headers: { 'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*' }
        });
      }
      return result; // Response from handleGeneric
    }).catch(function (err) {
      console.warn('[Flyx Bypass] fetch failed: ' + err.message + ' — falling back');
      return _fetch.call(window, input, init);
    });
  };

  console.log('[Flyx Bypass v5] Injected — direct HTTPS CDN fetch + DNR headers');
})();
