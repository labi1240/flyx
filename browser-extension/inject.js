/**
 * Flyx Bypass v7 — Page Interceptor (MAIN world, document_start)
 *
 * Intercepts XHR/fetch to *.workers.dev and fetches content directly
 * from CDNs. DNR rules (installed by service-worker.js) handle
 * Origin+Referer header injection transparently.
 */
(function () {
  'use strict';

  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36';
  var DLHD_CACHE = {};

  // ── URL Detection ────────────────────────────────────────────────────

  function isWorker(url) {
    try { return new URL(url, location.origin).hostname.endsWith('.workers.dev'); } catch(e) { return false; }
  }
  function isDLHD(url) {
    try { return new URL(url, location.origin).hostname === 'dlhd.vynx-3b3.workers.dev'; } catch(e) { return false; }
  }

  // ── DLHD Handler ─────────────────────────────────────────────────────

  async function handleDLHD(url) {
    var pu = new URL(url);
    var ch = pu.searchParams.get('channel') || pu.pathname.split('/').pop() || '';
    var ck = ch.indexOf('premium') === 0 ? ch : 'premium' + ch;
    console.log('[Flyx] DLHD: ' + ck);

    // Server lookup (cached 60s)
    var sk;
    if (DLHD_CACHE[ck] && DLHD_CACHE[ck].ts > Date.now() - 60000) {
      sk = DLHD_CACHE[ck].key;
    } else {
      sk = await lookupServer(ck);
      DLHD_CACHE[ck] = { key: sk, ts: Date.now() };
    }
    console.log('[Flyx] Server: ' + sk);

    // Fetch M3U8
    var m3u8 = 'https://chevy.newkso.ru/proxy/' + sk + '/' + ck + '/mono.css';
    console.log('[Flyx] M3U8: ' + m3u8);
    var r = await fetch(m3u8, { headers: { 'User-Agent': UA, 'Accept': '*/*' } });
    if (!r.ok) throw new Error('M3U8 HTTP ' + r.status);
    var t = await r.text();
    if (t.indexOf('#EXT') === -1) throw new Error('Not M3U8: ' + t.substring(0, 200));
    console.log('[Flyx] M3U8 OK, ' + t.length + ' bytes');

    // Rewrite: relative → absolute HTTPS
    var base = 'https://chevy.newkso.ru/proxy/' + sk + '/' + ck + '/';
    var rw = rewrite(t, base);
    console.log('[Flyx] M3U8 rewritten');
    return rw;
  }

  async function lookupServer(ck) {
    var domains = ['newkso.ru', 'enviromentalanimal.horse', 'soyspace.cyou'];
    for (var i = 0; i < domains.length; i++) {
      try {
        var url = 'https://chevy.' + domains[i] + '/server_lookup?channel_id=' + ck;
        var r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' } });
        if (r.ok) {
          var t = await r.text();
          console.log('[Flyx] Lookup: ' + t.substring(0, 100));
          if (t.charAt(0) === '{') { try { var d = JSON.parse(t); if (d.server_key) return d.server_key; } catch(e) {} }
          t = t.trim();
          if (t.length > 1 && t.length < 20 && t.indexOf('<') === -1) return t;
        } else { console.warn('[Flyx] Lookup HTTP ' + r.status); }
      } catch(e) { console.warn('[Flyx] Lookup err: ' + e.message); }
    }
    return 'ddy6';
  }

  function rewrite(list, base) {
    var bo = '', bp = '';
    try { var bu = new URL(base); bo = bu.origin; bp = bu.pathname; bp = bp.substring(0, bp.lastIndexOf('/') + 1); } catch(e) {}

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
      try { return new URL(u, bo + bp).toString(); } catch(e) { return u; }
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
    console.log('[Flyx] Generic: ' + tgt.substring(0, 100));
    var r = await fetch(tgt, { headers: { 'User-Agent': UA, 'Accept': '*/*' } });
    var ct = r.headers.get('content-type') || '';
    if (ct.indexOf('mpegurl') !== -1 || tgt.indexOf('.m3u8') !== -1) {
      var t = await r.text();
      return rewrite(t, tgt);
    }
    return r;
  }

  // ── XHR Override ─────────────────────────────────────────────────────

  var XHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    var x = new XHR();
    var _url = '', _method = 'GET', _intercept = false, _aborted = false;
    var _rs = 0, _status = 0, _st = '', _rbody = null, _events = null;

    function fire(n) { var a = _events[n]; if (!a) return; if (a._on) try { a._on.call(x); } catch(e) {} for (var i=0;i<a.length;i++) try{a[i].call(x)}catch(e){} }
    function setRS(rs) { _rs=rs; fire('readystatechange'); if (rs===4) { fire('load'); fire('loadend'); } }
    function fallback() { _intercept=false; XHR.prototype.open.call(x, _method, _url, true); XHR.prototype.send.call(x, null); }

    function patch() {
      if (_events) return; _events = {};
      ['readystatechange','load','error','abort','loadend','loadstart'].forEach(function(n){
        _events[n]=[]; Object.defineProperty(x, 'on'+n, { get:function(){return _events[n]._on||null}, set:function(f){_events[n]._on=f}, configurable:true });
      });
      Object.defineProperty(x,'readyState',{get:function(){return _rs},configurable:true});
      Object.defineProperty(x,'status',{get:function(){return _status},configurable:true});
      Object.defineProperty(x,'statusText',{get:function(){return _st},configurable:true});
      Object.defineProperty(x,'response',{get:function(){return _rbody?new TextDecoder().decode(_rbody):null},configurable:true});
      Object.defineProperty(x,'responseText',{get:function(){return _rbody?new TextDecoder().decode(_rbody):''},configurable:true});
    }

    x.open = function (m, u, a) {
      _method = (m || 'GET').toUpperCase(); _url = String(u);
      _intercept = isWorker(_url);
      if (_intercept) { console.log('[Flyx] XHR: '+_url.substring(0,120)); patch(); }
      else XHR.prototype.open.call(x, m, u, a!==false, arguments[3], arguments[4]);
    };
    x.send = function (b) {
      if (_aborted) return;
      if (!_intercept) return XHR.prototype.send.call(x, b);
      fire('loadstart'); setRS(1);
      var h = isDLHD(_url) ? handleDLHD : handleGeneric;
      h(_url).then(function(result) {
        if (_aborted) return;
        var text;
        if (typeof result === 'string') text = result;
        else return result.text().then(function(t) { done(t); });
        done(text);
        function done(t) {
          _status = 200; _st = 'OK';
          _rbody = new TextEncoder().encode(t);
          setRS(2); setRS(3); setRS(4);
        }
      }).catch(function(err) {
        if (_aborted) return;
        console.error('[Flyx] FAIL: '+err.message+' — fallback');
        fallback();
      });
    };
    x.abort = function () { _aborted=true; fire('abort'); fire('loadend'); };
    return x;
  };
  window.XMLHttpRequest.UNSENT = 0; window.XMLHttpRequest.OPENED = 1;
  window.XMLHttpRequest.HEADERS_RECEIVED = 2; window.XMLHttpRequest.LOADING = 3;
  window.XMLHttpRequest.DONE = 4;

  console.log('[Flyx Bypass v7] Ready — direct CDN fetch + DNR headers');
})();
