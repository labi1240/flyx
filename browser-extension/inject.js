/**
 * Flyx Bypass v3 — Main-World Interceptor + Direct CDN Fetcher
 *
 * Runs in page MAIN world (manifest "world":"MAIN", document_start).
 * Fetches CDN content DIRECTLY from the page context (residential IP,
 * full browser headers) instead of routing through the extension SW.
 * The extension SW is only used for reCAPTCHA solving.
 */
(function () {
  'use strict';

  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36';
  var DLHD_DOMAIN = 'newkso.ru';
  var DLHD_PLAYER = 'www.newkso.ru';
  var LOOKUP_DOMAINS = ['newkso.ru', 'enviromentalanimal.horse', 'vovlacosa.sbs', 'soyspace.cyou'];
  var DLHD_KEY_CACHE = {}; // {channelKey: serverKey}

  // ── Worker URL Detection ──────────────────────────────────────────────

  function isWorkerProxy(url) {
    try { return new URL(url, location.origin).hostname.endsWith('.workers.dev'); }
    catch { return false; }
  }

  // ── CDN Fetch (direct, in page context — residential IP) ──────────────

  function cdnFetch(url, extraHeaders) {
    var h = new Headers();
    h.set('User-Agent', UA);
    h.set('Accept', '*/*');
    if (extraHeaders) {
      Object.keys(extraHeaders).forEach(function (k) { if (extraHeaders[k]) h.set(k, extraHeaders[k]); });
    }
    // Strip Origin if it's a MegaUp CDN (they block it)
    if (isMegaUp(url)) { h.delete('Origin'); h.delete('Referer'); }
    return fetch(url, { headers: h, redirect: 'follow' });
  }

  function isMegaUp(url) {
    var frags = ['megaup', 'hub26link', 'app28base', 'net22lab', 'pro25zone', 'tech20hub', 'code29wave', '4spromax'];
    for (var i = 0; i < frags.length; i++) { if (url.indexOf(frags[i]) !== -1) return true; }
    return false;
  }

  // ── M3U8 Rewriting ────────────────────────────────────────────────────

  function rewriteM3U8(playlist, baseUrl) {
    var basePath = '/';
    try { var pu = new URL(baseUrl); basePath = pu.pathname.substring(0, pu.pathname.lastIndexOf('/') + 1); } catch(e) {}

    function resolve(u) {
      if (u.indexOf('http://') === 0 || u.indexOf('https://') === 0) return u;
      try { return new URL(u, baseUrl).toString(); } catch(e) { return u; }
    }

    var lines = playlist.split('\n');
    var out = [];
    var uriTags = ['#EXT-X-KEY:', '#EXT-X-SESSION-KEY:', '#EXT-X-MEDIA:', '#EXT-X-I-FRAME-STREAM-INF:', '#EXT-X-MAP:'];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], trimmed = line.trim();
      if (!trimmed) { out.push(line); continue; }
      var handled = false;
      for (var j = 0; j < uriTags.length; j++) {
        if (trimmed.indexOf(uriTags[j]) === 0) {
          var m = trimmed.match(/URI="([^"]+)"/);
          if (m) { out.push(trimmed.replace('URI="' + m[1] + '"', 'URI="' + resolve(m[1]) + '"')); handled = true; break; }
          m = trimmed.match(/URI=([^\s,]+)/);
          if (m && m[1].charAt(0) !== '"') { out.push(trimmed.replace('URI=' + m[1], 'URI="' + resolve(m[1]) + '"')); handled = true; break; }
          out.push(line); handled = true; break;
        }
      }
      if (handled) continue;
      if (trimmed.charAt(0) === '#') { out.push(line); continue; }
      if (trimmed.indexOf('http') === 0) { out.push(trimmed); continue; }
      out.push(resolve(trimmed));
    }
    return out.join('\n');
  }

  // ── DLHD Server Lookup + M3U8 Fetch ──────────────────────────────────

  async function fetchDLHDM3U8(channelId) {
    var channelKey = channelId.indexOf('premium') === 0 ? channelId : 'premium' + channelId;

    // Check cache (60s TTL)
    if (DLHD_KEY_CACHE[channelKey] && DLHD_KEY_CACHE[channelKey].ts > Date.now() - 60000) {
      return await fetchAndRewriteDLHD(channelKey, DLHD_KEY_CACHE[channelKey].key);
    }

    // Server lookup — try each domain
    var serverKey = null;
    for (var i = 0; i < LOOKUP_DOMAINS.length; i++) {
      try {
        var lu = 'https://chevy.' + LOOKUP_DOMAINS[i] + '/server_lookup?channel_id=' + channelKey;
        console.log('[Flyx Bypass] DLHD lookup:', lu);
        var resp = await fetch(lu, {
          headers: {
            'User-Agent': UA,
            'Origin': 'https://' + DLHD_PLAYER,
            'Referer': 'https://' + DLHD_PLAYER + '/',
            'Accept': '*/*'
          }
        });
        if (resp.ok) {
          var t = await resp.text();
          console.log('[Flyx Bypass] DLHD lookup response:', t.substring(0, 200));
          if (t.charAt(0) === '{') {
            try {
              var d = JSON.parse(t);
              if (d.server_key) { serverKey = d.server_key; console.log('[Flyx Bypass] DLHD server:', serverKey); break; }
            } catch(e) {}
          }
          // Some servers return plain text server key
          if (t.trim().length < 20 && t.trim().length > 1 && !t.includes('<')) {
            serverKey = t.trim();
            console.log('[Flyx Bypass] DLHD server (raw):', serverKey);
            break;
          }
        } else {
          console.warn('[Flyx Bypass] DLHD lookup failed:', resp.status, LOOKUP_DOMAINS[i]);
        }
      } catch(e) {
        console.warn('[Flyx Bypass] DLHD lookup error:', e.message, LOOKUP_DOMAINS[i]);
      }
    }

    if (!serverKey) {
      serverKey = 'ddy6'; // fallback
      console.warn('[Flyx Bypass] DLHD lookup: all domains failed, using fallback ddy6');
    }

    DLHD_KEY_CACHE[channelKey] = { key: serverKey, ts: Date.now() };
    return await fetchAndRewriteDLHD(channelKey, serverKey);
  }

  async function fetchAndRewriteDLHD(channelKey, serverKey) {
    var m3u8Url = 'https://chevy.' + DLHD_DOMAIN + '/proxy/' + serverKey + '/' + channelKey + '/mono.css';
    console.log('[Flyx Bypass] DLHD M3U8 URL:', m3u8Url);

    var resp = await fetch(m3u8Url, {
      headers: {
        'User-Agent': UA,
        'Origin': 'https://' + DLHD_PLAYER,
        'Referer': 'https://' + DLHD_PLAYER + '/',
        'Accept': '*/*'
      }
    });

    if (!resp.ok) {
      throw new Error('DLHD M3U8 fetch failed: HTTP ' + resp.status + ' from ' + m3u8Url);
    }

    var text = await resp.text();
    if (text.indexOf('#EXT') === -1 && text.indexOf('#EXTM3U') === -1) {
      console.warn('[Flyx Bypass] DLHD response does not look like M3U8:', text.substring(0, 300));
      throw new Error('DLHD response is not an M3U8 playlist');
    }

    console.log('[Flyx Bypass] DLHD M3U8 received:', text.substring(0, 200));

    // Rewrite: resolve relative URLs → absolute CDN URLs
    var rewritten = rewriteDLHDM3U8(text, resp.url || m3u8Url);
    console.log('[Flyx Bypass] DLHD M3U8 rewritten, first 300 chars:', rewritten.substring(0, 300));
    return rewritten;
  }

  function rewriteDLHDM3U8(playlist, baseUrl) {
    // Fix split-line URLs
    var lines = playlist.split('\n');
    var joined = [], carry = '';
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t || t.charAt(0) === '#') { if (carry) { joined.push(carry); carry = ''; } joined.push(lines[i]); }
      else if (t.indexOf('http') === 0) { if (carry) joined.push(carry); carry = t; }
      else { carry += t; }
    }
    if (carry) joined.push(carry);

    var keyOrigin = '', basePath = '/';
    try { keyOrigin = new URL(baseUrl).origin; basePath = new URL(baseUrl).pathname; basePath = basePath.substring(0, basePath.lastIndexOf('/') + 1); } catch(e) {}

    function resolve(u) {
      if (u.indexOf('http://') === 0 || u.indexOf('https://') === 0) return u;
      try { return new URL(u, keyOrigin + basePath).toString(); } catch(e) { return u; }
    }

    var out = [];
    for (var i = 0; i < joined.length; i++) {
      var line = joined[i], trimmed = line.trim();

      // Rewrite key URIs to absolute
      if (trimmed.indexOf('#EXT-X-KEY:') === 0 || trimmed.indexOf('#EXT-X-SESSION-KEY:') === 0) {
        var m = trimmed.match(/URI="([^"]+)"/);
        if (m && m[1].indexOf('http') !== 0) {
          out.push(trimmed.replace('URI="' + m[1] + '"', 'URI="' + resolve(m[1]) + '"'));
          continue;
        }
        out.push(line); continue;
      }

      // Strip ENDLIST for live
      if (trimmed.indexOf('#EXT-X-ENDLIST') === 0) continue;

      if (!trimmed || trimmed.charAt(0) === '#') { out.push(line); continue; }
      if (trimmed.indexOf('http') === 0) { out.push(trimmed); continue; }
      out.push(resolve(trimmed));
    }
    return out.join('\n');
  }

  // ── Generic Stream Proxy Handler ──────────────────────────────────────

  async function handleStreamProxy(pu) {
    // Extract target URL from query params
    var targetUrl = pu.searchParams.get('url');
    if (!targetUrl) throw new Error('No url param in stream proxy URL');

    // Determine provider-specific headers
    var headers = {};
    var path = pu.pathname;
    var ref = pu.searchParams.get('referer');

    if (path.indexOf('/flixer') !== -1) headers.Referer = 'https://hexa.su/';
    else if (path.indexOf('/videasy') !== -1) headers.Referer = 'https://player.videasy.net/';
    else if (path.indexOf('/vidsrc') !== -1) headers.Referer = ref || 'https://www.2embed.cc/';
    else if (path.indexOf('/bingebox') !== -1) headers.Referer = 'https://bingebox.to/';
    else if (path.indexOf('/moviebox') !== -1) headers.Referer = 'https://themoviebox.org/';
    else if (path.indexOf('/miruro') !== -1) headers.Referer = 'https://miruro.to/';
    else if (path.indexOf('/hianime') !== -1) headers.Referer = 'https://aniwatchtv.to/';
    else if (isMegaUp(targetUrl)) { /* no headers */ }
    else if (path.indexOf('/ntv') !== -1) { /* CORS-open */ }
    else if (path.indexOf('/ufreetv') !== -1) headers.Referer = 'https://ufreetv.com/';
    else if (path.indexOf('/globetv') !== -1) headers.Referer = 'https://globetv.app/';
    else if (path.indexOf('/cdn-live') !== -1) { headers.Referer = 'https://cdn-live.tv/'; headers.Origin = 'https://cdn-live.tv'; }
    else if (ref) headers.Referer = ref;

    console.log('[Flyx Bypass] Stream proxy:', targetUrl.substring(0, 100), 'headers:', JSON.stringify(headers));

    // DLHD CDN domains need Origin + Referer
    if (targetUrl.indexOf('newkso.ru') !== -1 || targetUrl.indexOf('keylocking.ru') !== -1) {
      headers.Origin = 'https://' + DLHD_PLAYER;
      headers.Referer = 'https://' + DLHD_PLAYER + '/';
    }

    var resp = await cdnFetch(targetUrl, headers);

    var ct = resp.headers.get('content-type') || '';
    if (ct.indexOf('mpegurl') !== -1 || targetUrl.indexOf('.m3u8') !== -1) {
      var text = await resp.text();
      return rewriteM3U8(text, targetUrl);
    }

    // Binary response — return as-is (the page/worker handles binary responses directly)
    // For simplicity, we just return the fetch response which HLS.js consumes
    return resp;
  }

  // ── Main Intercept Handler ────────────────────────────────────────────

  async function handleIntercept(url, method) {
    console.log('[Flyx Bypass] INTERCEPT:', url.substring(0, 120));
    var pu;
    try { pu = new URL(url); } catch(e) { throw new Error('Invalid URL'); }

    var path = pu.pathname;
    var host = pu.hostname;

    // DLHD playlist: dlhd.vynx-3b3.workers.dev/play/{channelId}
    if (host.indexOf('dlhd.') === 0 || path.indexOf('/play/') === 0) {
      var channelId = pu.searchParams.get('channel') || path.split('/').pop() || '';
      console.log('[Flyx Bypass] DLHD channel:', channelId);
      return await fetchDLHDM3U8(channelId);
    }

    // Generic stream/segment proxy: extract URL from params, fetch directly
    var targetUrl = pu.searchParams.get('url');
    if (targetUrl) {
      console.log('[Flyx Bypass] Stream proxy URL:', targetUrl.substring(0, 100));
      var result = await handleStreamProxy(pu);
      return result; // Can be string (rewritten M3U8) or Response
    }

    throw new Error('Unknown worker URL pattern: ' + url);
  }

  // ── ReCAPTCHA Bridge (via extension SW) ───────────────────────────────

  var _capId = 0, _capPending = {};
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (d && d.type === '__FB_CAP_RESP__') {
      var p = _capPending[d.id];
      if (p) { clearTimeout(p.t); delete _capPending[d.id]; if (d.err) p.rej(new Error(d.err)); else p.res(d.token); }
    }
  });

  function solveRecaptcha(channelKey) {
    return new Promise(function (resolve, reject) {
      var id = ++_capId;
      var t = setTimeout(function () { delete _capPending[id]; reject(new Error('reCAPTCHA timeout')); }, 30000);
      _capPending[id] = { res: resolve, rej: reject, t: t };
      window.postMessage({ type: '__FB_CAP_REQ__', id: id, channel: channelKey }, '*');
    });
  }

  // ── fetch() Override ──────────────────────────────────────────────────

  var _fetch = window.fetch;
  var _diagEnd = Date.now() + 10000;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
    if (Date.now() < _diagEnd) {
      try { console.log('[Flyx Bypass] DIAG:', new URL(url, location.origin).hostname); } catch(e) {}
    }
    if (!isWorkerProxy(url)) return _fetch.call(window, input, init);

    console.log('[Flyx Bypass] FETCH INTERCEPT:', url.substring(0, 150));

    return handleIntercept(url, (init && init.method) || 'GET')
      .then(function (result) {
        if (typeof result === 'string') {
          // Rewritten M3U8 text
          return new Response(result, {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*' }
          });
        }
        // Response object (binary stream or already a Response)
        return result;
      })
      .catch(function (err) {
        console.warn('[Flyx Bypass] fetch intercept failed, using proxy:', err.message);
        return _fetch.call(window, input, init);
      });
  };

  // ── XMLHttpRequest Override ───────────────────────────────────────────

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
      Object.keys(_headers).forEach(function (k) { XHR.prototype.setRequestHeader.call(xhr, k, _headers[k]); });
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
        if (_rt === 'json') try { return JSON.parse(new TextDecoder().decode(_rbody)); } catch (e) { return null; }
        return new TextDecoder().decode(_rbody);
      }, configurable: true });
      Object.defineProperty(xhr, 'responseText', { get: function () { return _rbody ? new TextDecoder().decode(_rbody) : ''; }, configurable: true });
      var add = XHR.prototype.addEventListener, rem = XHR.prototype.removeEventListener;
      xhr.addEventListener = function (n, fn) { if (_events[n]) _events[n].push(fn); else add.call(xhr, n, fn); };
      xhr.removeEventListener = function (n, fn) {
        if (_events[n]) { var i = _events[n].indexOf(fn); if (i >= 0) _events[n].splice(i, 1); return; }
        rem.call(xhr, n, fn);
      };
      xhr.getResponseHeader = function (n) {
        var k = Object.keys(_rh).find(function (kk) { return kk.toLowerCase() === n.toLowerCase(); });
        return k ? _rh[k] : null;
      };
      xhr.getAllResponseHeaders = function () {
        return Object.keys(_rh).map(function (k) { return k + ': ' + _rh[k]; }).join('\r\n');
      };
    }

    var _headers = {};

    xhr.open = function (method, url, async) {
      _method = (method || 'GET').toUpperCase();
      _url = String(url);
      _intercept = isWorkerProxy(_url);
      if (_intercept) {
        console.log('[Flyx Bypass] XHR INTERCEPT:', _url.substring(0, 120));
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

      handleIntercept(_url, _method).then(function (result) {
        if (_aborted) return;
        var text;
        if (typeof result === 'string') {
          text = result;
        } else if (result instanceof Response) {
          text = result.text(); // Note: async — need to await
        }
        // We need to handle async text()
        return Promise.resolve(typeof result === 'string' ? result : result.text()).then(function (t) {
          _status = 200; _st = 'OK';
          _rh = { 'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*' };
          setRS(2);
          _rbody = new TextEncoder().encode(t);
          setRS(3); setRS(4);
        });
      }).then(function () {
        // handled above
      }).catch(function (err) {
        if (_aborted) return;
        console.warn('[Flyx Bypass] XHR intercept failed, using proxy:', err.message);
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

  console.log('[Flyx Bypass v3] Injected — direct CDN fetch from residential IP');
})();
