/**
 * Flyx Bypass v2 — Main-World Interceptor
 *
 * Runs in the page's MAIN JavaScript world (manifest "world": "MAIN").
 * document_start ensures we override fetch/XHR before any page code runs.
 * Intercepts *.workers.dev proxy URLs and redirects through the extension SW
 * which fetches directly from CDNs using the browser's residential IP.
 */
(function () {
  'use strict';

  // ── URL Detection ──────────────────────────────────────────────────────

  function isWorkerProxy(url) {
    try { return new URL(url, location.origin).hostname.endsWith('.workers.dev'); }
    catch { return false; }
  }

  // ── Extension Bridge (postMessage ↔ chrome.runtime) ────────────────────

  var _reqId = 0;
  var _pending = {};

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (d && d.type === '__FB_RESP__') {
      var p = _pending[d.id];
      if (p) { clearTimeout(p.t); delete _pending[d.id]; if (d.err) p.rej(new Error(d.err)); else p.res(d.res); }
    }
  });

  function sendToExt(url, method, headers, bodyB64) {
    return new Promise(function (resolve, reject) {
      var id = ++_reqId;
      var t = setTimeout(function () { delete _pending[id]; reject(new Error('Flyx Bypass timeout: ' + url)); }, 25000);
      _pending[id] = { res: resolve, rej: reject, t: t };
      window.postMessage({ type: '__FB_REQ__', id: id, url: url, method: method || 'GET', headers: headers || {}, body: bodyB64 || null }, '*');
    });
  }

  // ── Response Reconstruction ────────────────────────────────────────────

  function reconstructResponse(data) {
    var body = null;
    if (data.body) {
      var bin = atob(data.body), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      body = bytes;
    }
    return new Response(body, {
      status: data.status || 200,
      statusText: data.statusText || 'OK',
      headers: new Headers(data.headers || {})
    });
  }

  // ── fetch() Override ───────────────────────────────────────────────────

  var _fetch = window.fetch;
  var _diagEnd = Date.now() + 10000; // 10s diagnostic window
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
    // Diagnostic: log all requests for first 10s
    if (Date.now() < _diagEnd) {
      try { console.log('[Flyx Bypass] DIAG fetch:', new URL(url, location.origin).hostname, url.substring(0, 100)); }
      catch(e) { console.log('[Flyx Bypass] DIAG fetch:', url.substring(0, 100)); }
    }
    if (!isWorkerProxy(url)) return _fetch.call(window, input, init);

    console.log('[Flyx Bypass] FETCH INTERCEPT:', url.substring(0, 150));

    var method = (init && init.method) || (input instanceof Request && input.method) || 'GET';
    var headers = {};
    if (init && init.headers) {
      if (init.headers.forEach) init.headers.forEach(function (v, k) { headers[k] = v; });
      else if (Array.isArray(init.headers)) init.headers.forEach(function (p) { headers[p[0]] = p[1]; });
      else Object.assign(headers, init.headers);
    } else if (input instanceof Request) {
      input.headers.forEach(function (v, k) { headers[k] = v; });
    }
    var bodyB64 = null;
    if (init && init.body && typeof init.body === 'string') {
      bodyB64 = btoa(unescape(encodeURIComponent(init.body)));
    }

    return sendToExt(url, method, headers, bodyB64)
      .then(reconstructResponse)
      .catch(function (err) {
        console.warn('[Flyx Bypass] fetch bypass failed, using proxy:', err.message);
        return _fetch.call(window, input, init);
      });
  };

  // ── XMLHttpRequest Override ────────────────────────────────────────────

  var XHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    var xhr = new XHR();
    var _url = '', _method = 'GET', _headers = {}, _intercept = false;
    var _aborted = false, _rs = 0, _status = 0, _st = '';
    var _rbody = null, _rt = '', _rh = {};
    var _events = null;  // initialized by applyPatches(), null when not intercepting

    // Called for intercepted requests only — _events is guaranteed non-null
    function fireMock(name) {
      var arr = _events[name];
      if (!arr) return;
      if (arr._on) try { arr._on.call(xhr); } catch (e) {}
      for (var i = 0; i < arr.length; i++) { try { arr[i].call(xhr); } catch (e) {} }
    }
    function setRS(rs) { _rs = rs; fireMock('readystatechange'); if (rs === 4) { fireMock('load'); fireMock('loadend'); } }

    // Apply property patches when we detect a worker URL. Never called for
    // non-worker XHRs — they use the native implementation untouched.
    function applyPatches() {
      if (_events) return; // already patched
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
      Object.defineProperty(xhr, 'responseType', {
        get: function () { return _rt; },
        set: function (v) { _rt = v; },
        configurable: true
      });
      Object.defineProperty(xhr, 'response', {
        get: function () {
          if (!_rbody) return null;
          if (_rt === 'arraybuffer') return _rbody.buffer;
          if (_rt === 'json') try { return JSON.parse(new TextDecoder().decode(_rbody)); } catch (e) { return null; }
          if (_rt === 'blob') return new Blob([_rbody]);
          return new TextDecoder().decode(_rbody);
        }, configurable: true
      });
      Object.defineProperty(xhr, 'responseText', {
        get: function () { return _rbody ? new TextDecoder().decode(_rbody) : ''; }, configurable: true
      });

      var _add = XHR.prototype.addEventListener;
      var _rem = XHR.prototype.removeEventListener;
      xhr.addEventListener = function (n, fn) {
        if (_events[n]) _events[n].push(fn); else _add.call(xhr, n, fn);
      };
      xhr.removeEventListener = function (n, fn) {
        if (_events[n]) { var i = _events[n].indexOf(fn); if (i >= 0) _events[n].splice(i, 1); return; }
        _rem.call(xhr, n, fn);
      };
      xhr.getResponseHeader = function (n) {
        var k = Object.keys(_rh).find(function (kk) { return kk.toLowerCase() === n.toLowerCase(); });
        return k ? _rh[k] : null;
      };
      xhr.getAllResponseHeaders = function () {
        return Object.keys(_rh).map(function (k) { return k + ': ' + _rh[k]; }).join('\r\n');
      };
    }

    xhr.open = function (method, url, async) {
      _method = (method || 'GET').toUpperCase();
      _url = String(url);
      _intercept = isWorkerProxy(_url);
      if (_intercept) {
        console.log('[Flyx Bypass] XHR intercept:', _url.substring(0, 120));
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
      var b64 = null;
      if (body && typeof body === 'string') b64 = btoa(unescape(encodeURIComponent(body)));
      sendToExt(_url, _method, _headers, b64).then(function (d) {
        if (_aborted) return;
        _status = d.status || 200; _st = d.statusText || 'OK'; _rh = d.headers || {};
        setRS(2);
        if (d.body) { var bin = atob(d.body); _rbody = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++)_rbody[i] = bin.charCodeAt(i); }
        setRS(3); setRS(4);
      }).catch(function (err) {
        if (_aborted) return;
        console.warn('[Flyx Bypass] XHR bypass failed, using proxy:', err.message);
        _intercept = false;
        XHR.prototype.open.call(xhr, _method, _url, true);
        Object.keys(_headers).forEach(function (k) { XHR.prototype.setRequestHeader.call(xhr, k, _headers[k]); });
        XHR.prototype.send.call(xhr, body);
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

  console.log('[Flyx Bypass v2] Injected — intercepting *.workers.dev requests');
})();
