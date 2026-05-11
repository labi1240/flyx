#!/usr/bin/env node
/**
 * Flixer CDN Probe - Fetches fresh stream URLs, then probes CDN
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('dns');

const FLIXER_API_BASE = 'https://plsdontscrapemelove.flixer.su';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
let serverTimeOffset = 0;

// ── WASM Loader (same as before, abbreviated) ──
class FlixerWasmLoader {
  constructor() { this.wasm = null; this.heap = new Array(128).fill(undefined); this.heap.push(undefined, null, true, false); this.heap_next = this.heap.length; this.WASM_VECTOR_LEN = 0; this.cachedUint8ArrayMemory0 = null; this.cachedDataViewMemory0 = null; this.cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }); this.cachedTextEncoder = new TextEncoder(); this.sessionId = crypto.randomUUID().replace(/-/g, ''); this.timestamp = Date.now() - 5000; this.randomSeed = Math.random(); this.timezoneOffset = new Date().getTimezoneOffset(); }
  getObject(idx) { return this.heap[idx]; }
  addHeapObject(obj) { if (this.heap_next === this.heap.length) this.heap.push(this.heap.length + 1); const idx = this.heap_next; this.heap_next = this.heap[idx]; this.heap[idx] = obj; return idx; }
  dropObject(idx) { if (idx < 132) return; this.heap[idx] = this.heap_next; this.heap_next = idx; }
  takeObject(idx) { const r = this.getObject(idx); this.dropObject(idx); return r; }
  getUint8ArrayMemory0() { if (!this.cachedUint8ArrayMemory0 || this.cachedUint8ArrayMemory0.byteLength === 0) this.cachedUint8ArrayMemory0 = new Uint8Array(this.wasm.memory.buffer); return this.cachedUint8ArrayMemory0; }
  getDataViewMemory0() { if (!this.cachedDataViewMemory0 || this.cachedDataViewMemory0.buffer !== this.wasm.memory.buffer) this.cachedDataViewMemory0 = new DataView(this.wasm.memory.buffer); return this.cachedDataViewMemory0; }
  getStringFromWasm0(ptr, len) { return this.cachedTextDecoder.decode(this.getUint8ArrayMemory0().subarray(ptr >>> 0, (ptr >>> 0) + len)); }
  passStringToWasm0(arg, malloc) { const buf = this.cachedTextEncoder.encode(arg); const ptr = malloc(buf.length, 1) >>> 0; this.getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf); this.WASM_VECTOR_LEN = buf.length; return ptr; }
  isLikeNone(x) { return x === undefined || x === null; }
  handleError(f, args) { try { return f.apply(this, args); } catch (e) { this.wasm.__wbindgen_export_0(this.addHeapObject(e)); } }
  buildImports() {
    const self = this; const scr = { width: 1920, height: 1080, colorDepth: 24 }; const nav = { platform: 'Win32', language: 'en-US', userAgent: UA }; const perf = { now: () => Date.now() - self.timestamp };
    const ls = { getItem: (k) => k === 'tmdb_session_id' ? self.sessionId : null, setItem: () => {} };
    const canvasCtx = { _font: '14px Arial', _textBaseline: 'alphabetic', fillText() {}, get font() { return this._font; }, set font(v) { this._font = v; }, get textBaseline() { return this._textBaseline; }, set textBaseline(v) { this._textBaseline = v; } };
    const canvas = { _width: 200, _height: 50, get width() { return this._width; }, set width(v) { this._width = v; }, get height() { return this._height; }, set height(v) { this._height = v; }, getContext: (t) => t === '2d' ? canvasCtx : null, toDataURL: () => 'data:image/png;base64,' + Buffer.from('canvas-fp-1920x1080-24-Win32-en-US').toString('base64') };
    const mockBody = { appendChild: () => {}, clientWidth: 1920, clientHeight: 1080 };
    const createCollection = (els) => { const c = { length: els.length, item: (i) => els[i] || null }; els.forEach((e, i) => { c[i] = e; }); return new Proxy(c, { get(t, p) { if (typeof p === 'string' && !isNaN(parseInt(p))) return t[parseInt(p)]; return t[p]; } }); };
    const doc = { createElement: (t) => t === 'canvas' ? canvas : {}, getElementsByTagName: (t) => t === 'body' ? createCollection([mockBody]) : createCollection([]), body: mockBody };
    const win = { document: doc, localStorage: ls, navigator: nav, screen: scr, performance: perf };
    const i = { wbg: {} };
    i.wbg.__wbg_call_672a4d21634d4a24 = function() { return self.handleError((a, b) => self.addHeapObject(self.getObject(a).call(self.getObject(b))), arguments); };
    i.wbg.__wbg_call_7cccdd69e0791ae2 = function() { return self.handleError((a, b, c) => self.addHeapObject(self.getObject(a).call(self.getObject(b), self.getObject(c))), arguments); };
    i.wbg.__wbg_colorDepth_59677c81c61d599a = function() { return self.handleError((a) => self.getObject(a).colorDepth, arguments); };
    i.wbg.__wbg_height_614ba187d8cae9ca = function() { return self.handleError((a) => self.getObject(a).height, arguments); };
    i.wbg.__wbg_width_679079836447b4b7 = function() { return self.handleError((a) => self.getObject(a).width, arguments); };
    i.wbg.__wbg_screen_8edf8699f70d98bc = function() { return self.handleError((a) => { const w = self.getObject(a); return self.addHeapObject(w ? w.screen : scr); }, arguments); };
    i.wbg.__wbg_document_d249400bd7bd996d = (a) => { const w = self.getObject(a); const d = w ? w.document : null; return d ? self.addHeapObject(d) : 0; };
    i.wbg.__wbg_createElement_8c9931a732ee2fea = function() { return self.handleError((a, b, c) => self.addHeapObject(doc.createElement(self.getStringFromWasm0(b, c))), arguments); };
    i.wbg.__wbg_getElementsByTagName_f03d41ce466561e8 = (a, b, c) => self.addHeapObject(doc.getElementsByTagName(self.getStringFromWasm0(b, c)));
    i.wbg.__wbg_getContext_e9cf379449413580 = function() { return self.handleError((a, b, c) => { const r = self.getObject(a).getContext(self.getStringFromWasm0(b, c)); return self.isLikeNone(r) ? 0 : self.addHeapObject(r); }, arguments); };
    i.wbg.__wbg_fillText_2a0055d8531355d1 = function() { return self.handleError((a, b, c, d, e) => self.getObject(a).fillText(self.getStringFromWasm0(b, c), d, e), arguments); };
    i.wbg.__wbg_setfont_42a163ef83420b93 = (a, b, c) => { self.getObject(a).font = self.getStringFromWasm0(b, c); };
    i.wbg.__wbg_settextBaseline_c28d2a6aa4ff9d9d = (a, b, c) => { self.getObject(a).textBaseline = self.getStringFromWasm0(b, c); };
    i.wbg.__wbg_setheight_da683a33fa99843c = (a, b) => { self.getObject(a).height = b >>> 0; };
    i.wbg.__wbg_setwidth_c5fed9f5e7f0b406 = (a, b) => { self.getObject(a).width = b >>> 0; };
    i.wbg.__wbg_toDataURL_eaec332e848fe935 = function() { return self.handleError((a, b) => { const r = self.getObject(b).toDataURL(); const p = self.passStringToWasm0(r, self.wasm.__wbindgen_export_1); self.getDataViewMemory0().setInt32(a + 4, self.WASM_VECTOR_LEN, true); self.getDataViewMemory0().setInt32(a, p, true); }, arguments); };
    i.wbg.__wbg_instanceof_CanvasRenderingContext2d_df82a4d3437bf1cc = () => 1;
    i.wbg.__wbg_instanceof_HtmlCanvasElement_2ea67072a7624ac5 = () => 1;
    i.wbg.__wbg_instanceof_Window_def73ea0955fc569 = () => 1;
    i.wbg.__wbg_localStorage_1406c99c39728187 = function() { return self.handleError((a) => { const w = self.getObject(a); return self.isLikeNone(w ? w.localStorage : ls) ? 0 : self.addHeapObject(w ? w.localStorage : ls); }, arguments); };
    i.wbg.__wbg_getItem_17f98dee3b43fa7e = function() { return self.handleError((a, b, c, d) => { const r = self.getObject(b).getItem(self.getStringFromWasm0(c, d)); const p = self.isLikeNone(r) ? 0 : self.passStringToWasm0(r, self.wasm.__wbindgen_export_1); self.getDataViewMemory0().setInt32(a + 4, self.WASM_VECTOR_LEN, true); self.getDataViewMemory0().setInt32(a, p, true); }, arguments); };
    i.wbg.__wbg_setItem_212ecc915942ab0a = function() { return self.handleError((a, b, c, d, e) => { self.getObject(a).setItem(self.getStringFromWasm0(b, c), self.getStringFromWasm0(d, e)); }, arguments); };
    i.wbg.__wbg_navigator_1577371c070c8947 = (a) => { const w = self.getObject(a); return self.addHeapObject(w ? w.navigator : nav); };
    i.wbg.__wbg_language_d871ec78ee8eec62 = (a, b) => { const r = self.getObject(b).language; const p = self.isLikeNone(r) ? 0 : self.passStringToWasm0(r, self.wasm.__wbindgen_export_1); self.getDataViewMemory0().setInt32(a + 4, self.WASM_VECTOR_LEN, true); self.getDataViewMemory0().setInt32(a, p, true); };
    i.wbg.__wbg_platform_faf02c487289f206 = function() { return self.handleError((a, b) => { const r = self.getObject(b).platform; const p = self.passStringToWasm0(r, self.wasm.__wbindgen_export_1); self.getDataViewMemory0().setInt32(a + 4, self.WASM_VECTOR_LEN, true); self.getDataViewMemory0().setInt32(a, p, true); }, arguments); };
    i.wbg.__wbg_userAgent_12e9d8e62297563f = function() { return self.handleError((a, b) => { const r = self.getObject(b).userAgent; const p = self.passStringToWasm0(r, self.wasm.__wbindgen_export_1); self.getDataViewMemory0().setInt32(a + 4, self.WASM_VECTOR_LEN, true); self.getDataViewMemory0().setInt32(a, p, true); }, arguments); };
    i.wbg.__wbg_new0_f788a2397c7ca929 = () => self.addHeapObject(new Date(self.timestamp));
    i.wbg.__wbg_now_807e54c39636c349 = () => self.timestamp;
    i.wbg.__wbg_getTimezoneOffset_6b5752021c499c47 = () => self.timezoneOffset;
    i.wbg.__wbg_performance_c185c0cdc2766575 = (a) => { const w = self.getObject(a); return self.isLikeNone(w ? w.performance : perf) ? 0 : self.addHeapObject(w ? w.performance : perf); };
    i.wbg.__wbg_now_d18023d54d4e5500 = (a) => self.getObject(a).now();
    i.wbg.__wbg_random_3ad904d98382defe = () => self.randomSeed;
    i.wbg.__wbg_length_347907d14a9ed873 = (a) => self.getObject(a).length;
    i.wbg.__wbg_new_23a2665fac83c611 = (a, b) => { try { var s = { a, b }; var cb = (x, y) => { const t = s.a; s.a = 0; try { return self.wasm.__wbindgen_export_6(t, s.b, self.addHeapObject(x), self.addHeapObject(y)); } finally { s.a = t; } }; return self.addHeapObject(new Promise(cb)); } finally { s.a = s.b = 0; } };
    i.wbg.__wbg_resolve_4851785c9c5f573d = (a) => self.addHeapObject(Promise.resolve(self.getObject(a)));
    i.wbg.__wbg_reject_b3fcf99063186ff7 = (a) => self.addHeapObject(Promise.reject(self.getObject(a)));
    i.wbg.__wbg_then_44b73946d2fb3e7d = (a, b) => self.addHeapObject(self.getObject(a).then(self.getObject(b)));
    i.wbg.__wbg_newnoargs_105ed471475aaf50 = (a, b) => self.addHeapObject(new Function(self.getStringFromWasm0(a, b)));
    i.wbg.__wbg_static_accessor_GLOBAL_88a902d13a557d07 = () => 0;
    i.wbg.__wbg_static_accessor_GLOBAL_THIS_56578be7e9f832b0 = () => self.addHeapObject(globalThis);
    i.wbg.__wbg_static_accessor_SELF_37c5d418e4bf5819 = () => self.addHeapObject(win);
    i.wbg.__wbg_static_accessor_WINDOW_5de37043a91a9c40 = () => self.addHeapObject(win);
    i.wbg.__wbg_queueMicrotask_97d92b4fcc8a61c5 = (a) => queueMicrotask(self.getObject(a));
    i.wbg.__wbg_queueMicrotask_d3219def82552485 = (a) => self.addHeapObject(self.getObject(a).queueMicrotask);
    i.wbg.__wbindgen_cb_drop = (a) => { const o = self.takeObject(a).original; if (o.cnt-- == 1) { o.a = 0; return true; } return false; };
    i.wbg.__wbindgen_closure_wrapper982 = (a, b) => { const s = { a, b, cnt: 1, dtor: 36 }; const r = (...args) => { s.cnt++; const t = s.a; s.a = 0; try { return self.wasm.__wbindgen_export_5(t, s.b, self.addHeapObject(args[0])); } finally { if (--s.cnt === 0) self.wasm.__wbindgen_export_3.get(s.dtor)(t, s.b); else s.a = t; } }; r.original = s; return self.addHeapObject(r); };
    i.wbg.__wbindgen_is_function = (a) => typeof self.getObject(a) === 'function';
    i.wbg.__wbindgen_is_undefined = (a) => self.getObject(a) === undefined;
    i.wbg.__wbindgen_object_clone_ref = (a) => self.addHeapObject(self.getObject(a));
    i.wbg.__wbindgen_object_drop_ref = (a) => self.takeObject(a);
    i.wbg.__wbindgen_string_new = (a, b) => self.addHeapObject(self.getStringFromWasm0(a, b));
    i.wbg.__wbindgen_throw = (a, b) => { throw new Error(self.getStringFromWasm0(a, b)); };
    return i;
  }
  async initialize(wasmPath) { const wasmBuffer = fs.readFileSync(wasmPath); const wasmModule = await WebAssembly.compile(wasmBuffer); const imports = this.buildImports(); const instance = await WebAssembly.instantiate(wasmModule, imports); this.wasm = instance.exports; return this; }
  getImgKey() { const retptr = this.wasm.__wbindgen_add_to_stack_pointer(-16); try { this.wasm.get_img_key(retptr); const dv = this.getDataViewMemory0(); const r0 = dv.getInt32(retptr, true), r1 = dv.getInt32(retptr + 4, true); const r2 = dv.getInt32(retptr + 8, true), r3 = dv.getInt32(retptr + 12, true); if (r3) throw this.takeObject(r2); const result = this.getStringFromWasm0(r0, r1); this.wasm.__wbindgen_export_4(r0, r1, 1); return result; } finally { this.wasm.__wbindgen_add_to_stack_pointer(16); } }
  async processImgData(data, key) { const p0 = this.passStringToWasm0(data, this.wasm.__wbindgen_export_1), l0 = this.WASM_VECTOR_LEN; const p1 = this.passStringToWasm0(key, this.wasm.__wbindgen_export_1), l1 = this.WASM_VECTOR_LEN; return this.takeObject(this.wasm.process_img_data(p0, l0, p1, l1)); }
}

// ── Helpers ──
function generateClientFingerprint() {
  const fpString = '2560x1440:24:' + UA.substring(0, 50) + ':Win32:en-US:' + new Date().getTimezoneOffset() + ':iVBORw0KGgoAAAANSUhEUgAAASwA';
  let hash = 0;
  for (let i = 0; i < fpString.length; i++) { hash = (hash << 5) - hash + fpString.charCodeAt(i); hash &= hash; }
  return Math.abs(hash).toString(36);
}
function getTimestamp() { return Math.floor((Date.now() + serverTimeOffset) / 1000); }
async function syncServerTime() {
  const before = Date.now();
  const resp = await fetch(FLIXER_API_BASE + '/api/time?t=' + before, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error('Time sync HTTP ' + resp.status);
  const text = await resp.text(); const data = JSON.parse(text); const after = Date.now();
  const rtt = after - before; serverTimeOffset = data.timestamp * 1000 + (rtt / 2) - after;
}
async function makeFlixerRequest(apiKey, apiPath, extraHeaders = {}) {
  const timestamp = getTimestamp();
  const nonce = crypto.randomBytes(16).toString('base64').replace(/[/+=]/g, '').substring(0, 22);
  const message = apiKey + ':' + timestamp + ':' + nonce + ':' + apiPath;
  const signature = crypto.createHmac('sha256', apiKey).update(message).digest('base64');
  const headers = {
    'X-Api-Key': apiKey, 'X-Request-Timestamp': timestamp.toString(), 'X-Request-Nonce': nonce,
    'X-Request-Signature': signature, 'X-Client-Fingerprint': generateClientFingerprint(),
    'Accept': 'text/plain', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': UA,
    'x-fingerprint-lite': 'e9136c41504646444', 'Origin': 'https://flixer.su', 'Referer': 'https://flixer.su/',
    ...extraHeaders,
  };
  const resp = await fetch(FLIXER_API_BASE + apiPath, { headers, signal: AbortSignal.timeout(10000) });
  if (!resp.ok) { const body = await resp.text(); throw new Error('HTTP ' + resp.status + ': ' + body.substring(0, 300)); }
  return resp.text();
}

// ── CDN Fetch helper ──
async function cdnFetch(url, headers, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const t0 = Date.now();
    const res = await fetch(url, { headers, signal: controller.signal, redirect: 'manual' });
    const ms = Date.now() - t0;
    const body = await res.text();
    clearTimeout(timer);
    return { status: res.status, ms, headers: Object.fromEntries(res.headers), body: body.substring(0, 800), bodyLen: body.length };
  } catch (e) {
    clearTimeout(timer);
    return { error: e.message, code: e.code || 'UNKNOWN' };
  }
}

// ── DNS resolution ──
function resolveDomain(hostname) {
  return new Promise((resolve) => {
    dns.resolve(hostname, 'A', (err, addresses) => {
      if (err) resolve(['DNS error: ' + err.message]);
      else resolve(addresses);
    });
  });
}

async function probeCDNUrl(url, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`PROBING: ${label}`);
  const urlObj = new URL(url);
  console.log(`URL: ${url.substring(0, 130)}...`);
  console.log(`Domain: ${urlObj.hostname}`);
  console.log(`Path: ${urlObj.pathname.length} chars`);
  console.log(`${'='.repeat(60)}`);

  // DNS
  const ips = await resolveDomain(urlObj.hostname);
  console.log(`\nDNS: ${urlObj.hostname} -> ${ips.join(', ')}`);

  // Test 1: Full browser headers
  console.log('\n--- T1: Full browser headers ---');
  const r1 = await cdnFetch(url, {
    'User-Agent': UA,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://flixer.su/',
    'Origin': 'https://flixer.su',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
  });
  console.log(`  Status: ${r1.status}, ${r1.ms}ms, ${r1.bodyLen >= 800 ? '800+' : r1.bodyLen} bytes`);
  if (r1.error) { console.log(`  ERROR: ${r1.error}`); return; }
  if (r1.headers['content-type']) console.log(`  Content-Type: ${r1.headers['content-type']}`);
  if (r1.headers['cf-ray']) console.log(`  CF-Ray: ${r1.headers['cf-ray']}`);
  if (r1.headers['cf-cache-status']) console.log(`  CF-Cache-Status: ${r1.headers['cf-cache-status']}`);
  if (r1.headers['server']) console.log(`  Server: ${r1.headers['server']}`);
  if (r1.status !== 200) { console.log(`  Body: ${r1.body.substring(0, 300)}`); }
  if (r1.status === 200 && r1.body.includes('#EXTM3U')) {
    console.log('  >> VALID M3U8 PLAYLIST');
    // Show playlist structure
    const lines = r1.body.split('\n').filter(l => l.trim());
    console.log(`  Lines: ${lines.length}`);
    for (const l of lines.slice(0, 20)) {
      console.log(`    ${l.substring(0, 150)}`);
    }
  }

  // Test 2: Minimal headers (just referer)
  console.log('\n--- T2: Just referer ---');
  const r2 = await cdnFetch(url, { 'Referer': 'https://flixer.su/' });
  console.log(`  Status: ${r2.status}, ${r2.ms}ms, ${r2.bodyLen} bytes`);
  if (r2.status !== 200) console.log(`  Body: ${r2.body.substring(0, 200)}`);

  // Test 3: JUST the URL (no custom headers at all)
  console.log('\n--- T3: No custom headers ---');
  const r3 = await cdnFetch(url, {});
  console.log(`  Status: ${r3.status}, ${r3.ms}ms, ${r3.bodyLen} bytes`);
  if (r3.status !== 200) console.log(`  Body: ${r3.body.substring(0, 200)}`);

  // Test 4: curl UA + flixer referer
  console.log('\n--- T4: curl UA + flixer referer ---');
  const r4 = await cdnFetch(url, { 'User-Agent': 'curl/8.0', 'Referer': 'https://flixer.su/' });
  console.log(`  Status: ${r4.status}, ${r4.ms}ms, ${r4.bodyLen} bytes`);
  if (r4.status !== 200) console.log(`  Body: ${r4.body.substring(0, 200)}`);

  // Test 5: CF Worker typical (no browser UA, no referer)
  console.log('\n--- T5: CF Worker minimal ---');
  const r5 = await cdnFetch(url, { 'User-Agent': 'Cloudflare-Workers' });
  console.log(`  Status: ${r5.status}, ${r5.ms}ms, ${r5.bodyLen} bytes`);
  if (r5.status !== 200) console.log(`  Body: ${r5.body.substring(0, 200)}`);

  // Test 6: Different referer (google.com)
  console.log('\n--- T6: Google referer ---');
  const r6 = await cdnFetch(url, { 'User-Agent': UA, 'Referer': 'https://www.google.com/', 'Origin': 'https://www.google.com' });
  console.log(`  Status: ${r6.status}, ${r6.ms}ms, ${r6.bodyLen} bytes`);
  if (r6.status !== 200) console.log(`  Body: ${r6.body.substring(0, 200)}`);

  // Test 7: New flixer subdomain referer
  console.log('\n--- T7: hexa.su referer ---');
  const r7 = await cdnFetch(url, { 'User-Agent': UA, 'Referer': 'https://hexa.su/', 'Origin': 'https://hexa.su' });
  console.log(`  Status: ${r7.status}, ${r7.ms}ms, ${r7.bodyLen} bytes`);
  if (r7.status !== 200) console.log(`  Body: ${r7.body.substring(0, 200)}`);

  // Test 8: Range bytes request (how hls.js fetches segments)
  console.log('\n--- T8: Range request (bytes 0-511) ---');
  const r8 = await cdnFetch(url, { 'User-Agent': UA, 'Referer': 'https://flixer.su/', 'Range': 'bytes=0-511' });
  console.log(`  Status: ${r8.status}, ${r8.ms}ms, ${r8.bodyLen} bytes`);
  if (r8.status === 206) console.log('  >> Range request works');

  return { domain: urlObj.hostname, ips, m3u8Body: r1.status === 200 ? r1.body : null };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║        FLIXER CDN PROBE                         ║');
  console.log('╚══════════════════════════════════════════════════╝');

  // Get fresh stream URLs
  console.log('\n--- Getting fresh stream URLs from API ---');
  const wasmPath = path.join(process.cwd(), 'public', 'flixer.wasm');
  const loader = new FlixerWasmLoader();
  await loader.initialize(wasmPath);
  const apiKey = loader.getImgKey();
  await syncServerTime();
  console.log(`API key: ${apiKey.substring(0, 16)}...`);
  console.log(`Time offset: ${serverTimeOffset}ms`);

  // Warmup and extract
  const apiPath = '/api/tmdb/movie/550/images';
  await makeFlixerRequest(apiKey, apiPath);

  const streamUrls = {};
  for (const server of ['alpha', 'bravo']) {
    try {
      const encrypted = await makeFlixerRequest(apiKey, apiPath, { 'X-Only-Sources': '1', 'X-Server': server });
      const decrypted = await loader.processImgData(encrypted, apiKey);
      const parsed = typeof decrypted === 'string' ? JSON.parse(decrypted) : decrypted;
      let url = null;
      if (Array.isArray(parsed.sources)) {
        const s = parsed.sources.find(s => s.server === server) || parsed.sources[0];
        url = s?.url || s?.file || s?.stream;
      }
      if (!url) url = parsed.sources?.file || parsed.sources?.url || parsed.file || parsed.url || parsed.stream;
      if (url) {
        streamUrls[server] = url;
        console.log(`  ${server}: ${url.substring(0, 100)}...`);
      }
    } catch(e) {
      console.log(`  ${server}: ERROR - ${e.message.substring(0, 60)}`);
    }
  }

  // Probe each CDN URL
  const results = {};
  for (const [server, url] of Object.entries(streamUrls)) {
    const r = await probeCDNUrl(url, `Server: ${server}`);
    results[server] = r;
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log('='.repeat(60));
  for (const [server, r] of Object.entries(results)) {
    console.log(`\n${server}:`);
    console.log(`  Domain: ${r.domain}`);
    console.log(`  DNS: ${r.ips.join(', ')}`);
    // Check if m3u8 was accessible from residential
    if (r.m3u8Body) {
      const isMaster = r.m3u8Body.includes('#EXT-X-STREAM-INF');
      const uriRefs = (r.m3u8Body.match(/URI="([^"]+)"/g) || []).length;
      const segCount = (r.m3u8Body.match(/#EXTINF/g) || []).length;
      console.log(`  FROM RESIDENTIAL: valid m3u8 (${isMaster ? 'master' : 'media'}, ${uriRefs} key URIs, ${segCount} segments)`);
    } else {
      console.log(`  FROM RESIDENTIAL: blocked/failed`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('PROBE COMPLETE');
  console.log('='.repeat(60));
}

main().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
});
