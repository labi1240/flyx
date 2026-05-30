/**
 * Flyx Bypass v6 — bulletproof DLHD stream unblocker
 *
 * MAIN world, document_start. Overrides XHR to intercept dlhd worker URLs.
 * Uses extension SW ONLY for HTTP origin IP fetches (page can't do HTTP).
 * Everything else happens directly in page context.
 */
(function () {
  'use strict';

  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36';
  var OIP = '213.21.239.30';
  var VHOST = 'chevy.newkso.ru';

  // ── Extension SW bridge (for HTTP origin IP fetches only) ────────────

  var _reqId = 0, _pending = {};

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (d && d.type === '__FB_RESP__') {
      var p = _pending[d.id];
      if (p) { clearTimeout(p.t); delete _pending[d.id];
        if (d.err) p.rej(new Error(d.err)); else p.res(d.res); }
    }
  });

  /** Send HTTP fetch request to extension SW (for origin IP access) */
  function swFetch(url) {
    return new Promise(function (resolve, reject) {
      var id = ++_reqId;
      var t = setTimeout(function () { delete _pending[id]; reject(new Error('SW timeout')); }, 20000);
      _pending[id] = { res: resolve, rej: reject, t: t };
      window.postMessage({ type: '__FB_REQ__', id: id, url: url }, '*');
    });
  }

  // ── DLHD Pipeline ────────────────────────────────────────────────────

  var _dlhdCache = {};

  async function handleDLHD(url) {
    var pu = new URL(url);
    var channelId = pu.searchParams.get('channel') || pu.pathname.split('/').pop() || '';
    var channelKey = channelId.indexOf('premium') === 0 ? channelId : 'premium' + channelId;

    console.log('[Flyx] DLHD channel: ' + channelKey);

    // 1. Server lookup via origin IP (HTTP, bypasses Cloudflare WAF)
    var serverKey = _dlhdCache[channelKey] && _dlhdCache[channelKey].ts > Date.now() - 60000
      ? _dlhdCache[channelKey].key
      : await lookupServer(channelKey);

    _dlhdCache[channelKey] = { key: serverKey, ts: Date.now() };
    console.log('[Flyx] DLHD server: ' + serverKey);

    // 2. Fetch M3U8 from origin IP
    var m3u8Url = 'http://' + OIP + '/proxy/' + serverKey + '/' + channelKey + '/mono.css';
    console.log('[Flyx] DLHD M3U8: ' + m3u8Url);

    var respData = await swFetch(m3u8Url);
    if (respData.err) throw new Error('SW fetch error: ' + respData.err);
    if (respData.status < 200 || respData.status >= 400) throw new Error('M3U8 HTTP ' + respData.status);

    var m3u8Text = atob(respData.body);
    if (m3u8Text.indexOf('#EXT') === -1) {
      console.error('[Flyx] Not M3U8: ' + m3u8Text.substring(0, 300));
      throw new Error('Not an M3U8 playlist');
    }
    console.log('[Flyx] DLHD M3U8 received, ' + m3u8Text.length + ' bytes');

    // 3. Rewrite M3U8: relative URLs → HTTPS chevy.newkso.ru
    // Segments use HTTPS (no mixed content), DNR rules add Origin+Referer
    var httpsBase = 'https://chevy.newkso.ru/proxy/' + serverKey + '/' + channelKey + '/';
    var rewritten = rewriteDLHD(m3u8Text, httpsBase);
    console.log('[Flyx] DLHD M3U8 rewritten ✓');

    return rewritten;
  }

  async function lookupServer(channelKey) {
    var lu = 'http://' + OIP + '/server_lookup?channel_id=' + channelKey;
    console.log('[Flyx] Lookup: ' + lu);
    try {
      var d = await swFetch(lu);
      if (d.err) { console.warn('[Flyx] Lookup SW error: ' + d.err); return 'ddy6'; }
      if (d.status >= 400) { console.warn('[Flyx] Lookup HTTP ' + d.status); return 'ddy6'; }
      var t = atob(d.body);
      console.log('[Flyx] Lookup response: ' + t.substring(0, 100));
      if (t.charAt(0) === '{') {
        try { var j = JSON.parse(t); if (j.server_key) return j.server_key; } catch(e) {}
      }
      t = t.trim();
      if (t.length > 1 && t.length < 20 && t.indexOf('<') === -1) return t;
    } catch(e) { console.warn('[Flyx] Lookup exception: ' + e.message); }
    return 'ddy6';
  }

  function rewriteDLHD(playlist, baseUrl) {
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

  // ── Generic handler ──────────────────────────────────────────────────

  function isDLHD(url) {
    try { return new URL(url, location.origin).hostname === 'dlhd.vynx-3b3.workers.dev'; } catch { return false; }
  }
  function isWorker(url) {
    try { return new URL(url, location.origin).hostname.endsWith('.workers.dev'); } catch { return false; }
  }

  // ── XHR Override ─────────────────────────────────────────────────────

  var XHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    var xhr = new XHR();
    var _url = '', _intercept = false, _aborted = false;
    var _rs = 0, _status = 0, _st = '', _rbody = null, _rh = {}, _events = null;

    function fire(n) { var a = _events[n]; if (!a) return; if (a._on) try { a._on.call(xhr); } catch(e) {} for (var i=0;i<a.length;i++) try{a[i].call(xhr)}catch(e){} }
    function setRS(rs) { _rs=rs; fire('readystatechange'); if (rs===4) { fire('load'); fire('loadend'); } }
    function fallback() { _intercept=false; XHR.prototype.open.call(xhr, _url, true); XHR.prototype.send.call(xhr, null); }

    function patch() {
      if (_events) return; _events = {};
      ['readystatechange','load','error','abort','loadend','loadstart'].forEach(function(n){
        _events[n]=[]; Object.defineProperty(xhr, 'on'+n, { get:function(){return _events[n]._on||null}, set:function(f){_events[n]._on=f}, configurable:true });
      });
      Object.defineProperty(xhr,'readyState',{get:function(){return _rs},configurable:true});
      Object.defineProperty(xhr,'status',{get:function(){return _status},configurable:true});
      Object.defineProperty(xhr,'statusText',{get:function(){return _st},configurable:true});
      Object.defineProperty(xhr,'responseURL',{get:function(){return _url},configurable:true});
      Object.defineProperty(xhr,'response',{get:function(){return _rbody?new TextDecoder().decode(_rbody):null},configurable:true});
      Object.defineProperty(xhr,'responseText',{get:function(){return _rbody?new TextDecoder().decode(_rbody):''},configurable:true});
      xhr.getResponseHeader=function(n){var k=Object.keys(_rh).find(function(kk){return kk.toLowerCase()===n.toLowerCase()});return k?_rh[k]:null};
      xhr.getAllResponseHeaders=function(){return Object.keys(_rh).map(function(k){return k+': '+_rh[k]}).join('\r\n')};
    }

    xhr.open = function (method, url, async) {
      _url = String(url);
      _intercept = isWorker(_url);
      if (_intercept) { console.log('[Flyx] XHR: '+_url.substring(0,120)); patch(); }
      else XHR.prototype.open.call(xhr, method, url, async!==false, arguments[3], arguments[4]);
    };
    xhr.send = function (body) {
      if (_aborted) return;
      if (!_intercept) return XHR.prototype.send.call(xhr, body);
      fire('loadstart'); setRS(1);

      var handler = isDLHD(_url) ? handleDLHD : handleGeneric;
      handler(_url).then(function(text) {
        if (_aborted) return;
        _status = 200; _st = 'OK';
        _rh = { 'content-type': 'application/vnd.apple.mpegurl', 'access-control-allow-origin': '*' };
        setRS(2);
        _rbody = new TextEncoder().encode(text);
        setRS(3); setRS(4);
      }).catch(function(err) {
        if (_aborted) return;
        console.error('[Flyx] FAIL: '+err.message+' — fallback to proxy');
        fallback();
      });
    };
    xhr.abort = function () { _aborted=true; fire('abort'); fire('loadend'); };
    return xhr;
  };
  window.XMLHttpRequest.UNSENT = 0; window.XMLHttpRequest.OPENED = 1;
  window.XMLHttpRequest.HEADERS_RECEIVED = 2; window.XMLHttpRequest.LOADING = 3;
  window.XMLHttpRequest.DONE = 4;

  async function handleGeneric(url) {
    // Fetch through extension SW for HTTP access, or direct for HTTPS
    var pu = new URL(url);
    var targetUrl = pu.searchParams.get('url');
    if (!targetUrl) throw new Error('No URL param');
    console.log('[Flyx] Generic: '+targetUrl.substring(0,100));
    var respData = await swFetch(targetUrl);
    if (respData.err) throw new Error('SW error: '+respData.err);
    var text = atob(respData.body);
    if (text.indexOf('#EXT') !== -1) {
      // Rewrite M3U8
      var bp = ''; try { var p = new URL(targetUrl); bp = p.pathname; bp = bp.substring(0, bp.lastIndexOf('/')+1); } catch(e) {}
      var bo = ''; try { bo = new URL(targetUrl).origin; } catch(e) {}
      text = text.split('\n').map(function(line) {
        var t = line.trim();
        if (!t || t.charAt(0)==='#') return line;
        if (t.indexOf('http')===0) return t;
        try { return new URL(t, bo+bp).toString(); } catch(e) { return line; }
      }).join('\n');
    }
    return text;
  }

  console.log('[Flyx Bypass v6] Injected — HTTP origin IP via SW bridge');
})();
