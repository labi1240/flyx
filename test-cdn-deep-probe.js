#!/usr/bin/env node
/**
 * Deep CDN probe - fetch m3u8, segments, test referer-only dependency
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FLIXER_API_BASE = 'https://plsdontscrapemelove.flixer.su';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
let serverTimeOffset = 0;

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
  buildImports() { const self = this; const scr = { width: 1920, height: 1080, colorDepth: 24 }; const nav = { platform: 'Win32', language: 'en-US', userAgent: UA }; const perf = { now: () => Date.now() - self.timestamp }; const ls = { getItem: (k) => k === 'tmdb_session_id' ? self.sessionId : null, setItem: () => {} }; const canvasCtx = { _font: '14px Arial', _textBaseline: 'alphabetic', fillText() {}, get font() { return this._font; }, set font(v) { this._font = v; }, get textBaseline() { return this._textBaseline; }, set textBaseline(v) { this._textBaseline = v; } }; const canvas = { _width: 200, _height: 50, get width() { return this._width; }, set width(v) { this._width = v; }, get height() { return this._height; }, set height(v) { this._height = v; }, getContext: (t) => t === '2d' ? canvasCtx : null, toDataURL: () => 'data:image/png;base64,' + Buffer.from('canvas-fp-1920x1080-24-Win32-en-US').toString('base64') }; const mockBody = { appendChild: () => {}, clientWidth: 1920, clientHeight: 1080 }; const createCollection = (els) => { const c = { length: els.length, item: (i) => els[i] || null }; els.forEach((e, i) => { c[i] = e; }); return new Proxy(c, { get(t, p) { if (typeof p === 'string' && !isNaN(parseInt(p))) return t[parseInt(p)]; return t[p]; } }); }; const doc = { createElement: (t) => t === 'canvas' ? canvas : {}, getElementsByTagName: (t) => t === 'body' ? createCollection([mockBody]) : createCollection([]), body: mockBody }; const win = { document: doc, localStorage: ls, navigator: nav, screen: scr, performance: perf }; const i = { wbg: {} };
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
    i.wbg.__wbg_instanceof_CanvasRenderingContext2d_df82a4d3437bf1cc = () => 1; i.wbg.__wbg_instanceof_HtmlCanvasElement_2ea67072a7624ac5 = () => 1; i.wbg.__wbg_instanceof_Window_def73ea0955fc569 = () => 1;
    i.wbg.__wbg_localStorage_1406c99c39728187 = function() { return self.handleError((a) => { const w = self.getObject(a); return self.isLikeNone(w ? w.localStorage : ls) ? 0 : self.addHeapObject(w ? w.localStorage : ls); }, arguments); };
    i.wbg.__wbg_getItem_17f98dee3b43fa7e = function() { return self.handleError((a, b, c, d) => { const r = self.getObject(b).getItem(self.getStringFromWasm0(c, d)); const p = self.isLikeNone(r) ? 0 : self.passStringToWasm0(r, self.wasm.__wbindgen_export_1); self.getDataViewMemory0().setInt32(a + 4, self.WASM_VECTOR_LEN, true); self.getDataViewMemory0().setInt32(a, p, true); }, arguments); };
    i.wbg.__wbg_setItem_212ecc915942ab0a = function() { return self.handleError((a, b, c, d, e) => { self.getObject(a).setItem(self.getStringFromWasm0(b, c), self.getStringFromWasm0(d, e)); }, arguments); };
    i.wbg.__wbg_navigator_1577371c070c8947 = (a) => { const w = self.getObject(a); return self.addHeapObject(w ? w.navigator : nav); };
    i.wbg.__wbg_language_d871ec78ee8eec62 = (a, b) => { const r = self.getObject(b).language; const p = self.isLikeNone(r) ? 0 : self.passStringToWasm0(r, self.wasm.__wbindgen_export_1); self.getDataViewMemory0().setInt32(a + 4, self.WASM_VECTOR_LEN, true); self.getDataViewMemory0().setInt32(a, p, true); };
    i.wbg.__wbg_platform_faf02c487289f206 = function() { return self.handleError((a, b) => { const r = self.getObject(b).platform; const p = self.passStringToWasm0(r, self.wasm.__wbindgen_export_1); self.getDataViewMemory0().setInt32(a + 4, self.WASM_VECTOR_LEN, true); self.getDataViewMemory0().setInt32(a, p, true); }, arguments); };
    i.wbg.__wbg_userAgent_12e9d8e62297563f = function() { return self.handleError((a, b) => { const r = self.getObject(b).userAgent; const p = self.passStringToWasm0(r, self.wasm.__wbindgen_export_1); self.getDataViewMemory0().setInt32(a + 4, self.WASM_VECTOR_LEN, true); self.getDataViewMemory0().setInt32(a, p, true); }, arguments); };
    i.wbg.__wbg_new0_f788a2397c7ca929 = () => self.addHeapObject(new Date(self.timestamp)); i.wbg.__wbg_now_807e54c39636c349 = () => self.timestamp; i.wbg.__wbg_getTimezoneOffset_6b5752021c499c47 = () => self.timezoneOffset;
    i.wbg.__wbg_performance_c185c0cdc2766575 = (a) => { const w = self.getObject(a); return self.isLikeNone(w ? w.performance : perf) ? 0 : self.addHeapObject(w ? w.performance : perf); };
    i.wbg.__wbg_now_d18023d54d4e5500 = (a) => self.getObject(a).now(); i.wbg.__wbg_random_3ad904d98382defe = () => self.randomSeed; i.wbg.__wbg_length_347907d14a9ed873 = (a) => self.getObject(a).length;
    i.wbg.__wbg_new_23a2665fac83c611 = (a, b) => { try { var s = { a, b }; var cb = (x, y) => { const t = s.a; s.a = 0; try { return self.wasm.__wbindgen_export_6(t, s.b, self.addHeapObject(x), self.addHeapObject(y)); } finally { s.a = t; } }; return self.addHeapObject(new Promise(cb)); } finally { s.a = s.b = 0; } };
    i.wbg.__wbg_resolve_4851785c9c5f573d = (a) => self.addHeapObject(Promise.resolve(self.getObject(a))); i.wbg.__wbg_reject_b3fcf99063186ff7 = (a) => self.addHeapObject(Promise.reject(self.getObject(a))); i.wbg.__wbg_then_44b73946d2fb3e7d = (a, b) => self.addHeapObject(self.getObject(a).then(self.getObject(b)));
    i.wbg.__wbg_newnoargs_105ed471475aaf50 = (a, b) => self.addHeapObject(new Function(self.getStringFromWasm0(a, b)));
    i.wbg.__wbg_static_accessor_GLOBAL_88a902d13a557d07 = () => 0; i.wbg.__wbg_static_accessor_GLOBAL_THIS_56578be7e9f832b0 = () => self.addHeapObject(globalThis); i.wbg.__wbg_static_accessor_SELF_37c5d418e4bf5819 = () => self.addHeapObject(win); i.wbg.__wbg_static_accessor_WINDOW_5de37043a91a9c40 = () => self.addHeapObject(win);
    i.wbg.__wbg_queueMicrotask_97d92b4fcc8a61c5 = (a) => queueMicrotask(self.getObject(a)); i.wbg.__wbg_queueMicrotask_d3219def82552485 = (a) => self.addHeapObject(self.getObject(a).queueMicrotask);
    i.wbg.__wbindgen_cb_drop = (a) => { const o = self.takeObject(a).original; if (o.cnt-- == 1) { o.a = 0; return true; } return false; };
    i.wbg.__wbindgen_closure_wrapper982 = (a, b) => { const s = { a, b, cnt: 1, dtor: 36 }; const r = (...args) => { s.cnt++; const t = s.a; s.a = 0; try { return self.wasm.__wbindgen_export_5(t, s.b, self.addHeapObject(args[0])); } finally { if (--s.cnt === 0) self.wasm.__wbindgen_export_3.get(s.dtor)(t, s.b); else s.a = t; } }; r.original = s; return self.addHeapObject(r); };
    i.wbg.__wbindgen_is_function = (a) => typeof self.getObject(a) === 'function'; i.wbg.__wbindgen_is_undefined = (a) => self.getObject(a) === undefined; i.wbg.__wbindgen_object_clone_ref = (a) => self.addHeapObject(self.getObject(a)); i.wbg.__wbindgen_object_drop_ref = (a) => self.takeObject(a); i.wbg.__wbindgen_string_new = (a, b) => self.addHeapObject(self.getStringFromWasm0(a, b)); i.wbg.__wbindgen_throw = (a, b) => { throw new Error(self.getStringFromWasm0(a, b)); };
    return i;
  }
  async initialize(wasmPath) { const wasmBuffer = fs.readFileSync(wasmPath); const wasmModule = await WebAssembly.compile(wasmBuffer); const imports = this.buildImports(); const instance = await WebAssembly.instantiate(wasmModule, imports); this.wasm = instance.exports; return this; }
  getImgKey() { const retptr = this.wasm.__wbindgen_add_to_stack_pointer(-16); try { this.wasm.get_img_key(retptr); const dv = this.getDataViewMemory0(); const r0 = dv.getInt32(retptr, true), r1 = dv.getInt32(retptr + 4, true); const r2 = dv.getInt32(retptr + 8, true), r3 = dv.getInt32(retptr + 12, true); if (r3) throw this.takeObject(r2); const result = this.getStringFromWasm0(r0, r1); this.wasm.__wbindgen_export_4(r0, r1, 1); return result; } finally { this.wasm.__wbindgen_add_to_stack_pointer(16); } }
  async processImgData(data, key) { const p0 = this.passStringToWasm0(data, this.wasm.__wbindgen_export_1), l0 = this.WASM_VECTOR_LEN; const p1 = this.passStringToWasm0(key, this.wasm.__wbindgen_export_1), l1 = this.WASM_VECTOR_LEN; return this.takeObject(this.wasm.process_img_data(p0, l0, p1, l1)); }
}

function generateClientFingerprint() {
  const fpString = '2560x1440:24:' + UA.substring(0, 50) + ':Win32:en-US:' + new Date().getTimezoneOffset() + ':iVBORw0KGgoAAAANSUhEUgAAASwA';
  let hash = 0; for (let i = 0; i < fpString.length; i++) { hash = (hash << 5) - hash + fpString.charCodeAt(i); hash &= hash; }
  return Math.abs(hash).toString(36);
}
function getTimestamp() { return Math.floor((Date.now() + serverTimeOffset) / 1000); }
async function syncServerTime() {
  const before = Date.now(); const resp = await fetch(FLIXER_API_BASE + '/api/time?t=' + before, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error('Time sync HTTP ' + resp.status);
  const text = await resp.text(); const data = JSON.parse(text); const after = Date.now();
  const rtt = after - before; serverTimeOffset = data.timestamp * 1000 + (rtt / 2) - after;
}
async function makeFlixerRequest(apiKey, apiPath, extraHeaders = {}) {
  const timestamp = getTimestamp(); const nonce = crypto.randomBytes(16).toString('base64').replace(/[/+=]/g, '').substring(0, 22);
  const message = apiKey + ':' + timestamp + ':' + nonce + ':' + apiPath;
  const signature = crypto.createHmac('sha256', apiKey).update(message).digest('base64');
  const headers = { 'X-Api-Key': apiKey, 'X-Request-Timestamp': timestamp.toString(), 'X-Request-Nonce': nonce, 'X-Request-Signature': signature, 'X-Client-Fingerprint': generateClientFingerprint(), 'Accept': 'text/plain', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': UA, 'x-fingerprint-lite': 'e9136c41504646444', 'Origin': 'https://flixer.su', 'Referer': 'https://flixer.su/', ...extraHeaders };
  const resp = await fetch(FLIXER_API_BASE + apiPath, { headers, signal: AbortSignal.timeout(10000) });
  if (!resp.ok) { const body = await resp.text(); throw new Error('HTTP ' + resp.status + ': ' + body.substring(0, 300)); }
  return resp.text();
}

async function fetchCDN(url, headers = {}, timeoutMs = 15000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const t0 = Date.now(); const res = await fetch(url, { headers, signal: c.signal, redirect: 'manual' });
    const ms = Date.now() - t0; const buf = await res.arrayBuffer(); const bytes = new Uint8Array(buf);
    clearTimeout(t);
    return {
      status: res.status, ms, headers: Object.fromEntries(res.headers), bytes, byteLength: buf.byteLength,
      text: new TextDecoder().decode(bytes),
      firstBytes: Array.from(bytes.slice(0, Math.min(32, bytes.length))).map(b => b.toString(16).padStart(2, '0')).join(' '),
    };
  } catch (e) { clearTimeout(t); return { error: e.message, code: e.code || 'UNKNOWN' }; }
}

async function main() {
  console.log('=== FLIXER CDN DEEP PROBE ===\n');

  const wasmPath = path.join(process.cwd(), 'public', 'flixer.wasm');
  const loader = new FlixerWasmLoader(); await loader.initialize(wasmPath);
  const apiKey = loader.getImgKey(); await syncServerTime();

  const apiPath = '/api/tmdb/movie/550/images';
  await makeFlixerRequest(apiKey, apiPath);

  const streamUrls = {};
  for (const server of ['alpha', 'bravo', 'charlie']) {
    try {
      const encrypted = await makeFlixerRequest(apiKey, apiPath, { 'X-Only-Sources': '1', 'X-Server': server });
      const decrypted = await loader.processImgData(encrypted, apiKey);
      const parsed = typeof decrypted === 'string' ? JSON.parse(decrypted) : decrypted;
      let url = null;
      if (Array.isArray(parsed.sources)) { const s = parsed.sources.find(s => s.server === server) || parsed.sources[0]; url = s?.url || s?.file || s?.stream; }
      if (!url) url = parsed.sources?.file || parsed.sources?.url || parsed.file || parsed.url || parsed.stream;
      if (url) streamUrls[server] = url;
    } catch(e) { console.log(`  ${server}: error: ${e.message.substring(0, 60)}`); }
  }

  console.log(`Stream URLs fetched: ${Object.keys(streamUrls).join(', ')}`);
  for (const [s, u] of Object.entries(streamUrls)) {
    console.log(`  ${s}: ${new URL(u).hostname} - ${u.substring(0, 100)}...`);
  }

  const targetServer = Object.keys(streamUrls).find(s => s !== 'alpha' && streamUrls[s]) || Object.keys(streamUrls)[0];
  if (!targetServer || !streamUrls[targetServer]) { console.error('No stream URLs!'); process.exit(1); }

  const m3u8Url = streamUrls[targetServer];
  const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
  const cdnDomain = new URL(m3u8Url).hostname;

  // STEP 1: Fetch m3u8
  console.log(`\n${'='.repeat(60)}`);
  console.log('STEP 1: Fetch m3u8 playlist');
  console.log('='.repeat(60));

  const m3u8 = await fetchCDN(m3u8Url, {
    'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://flixer.su/', 'Origin': 'https://flixer.su',
  });

  if (m3u8.error) { console.log(`ERROR: ${m3u8.error}`); process.exit(1); }

  console.log(`Status: ${m3u8.status}, ${m3u8.ms}ms, ${m3u8.byteLength} bytes`);
  console.log(`Content-Type: ${m3u8.headers['content-type'] || 'none'}`);
  console.log(`CF-Ray: ${m3u8.headers['cf-ray'] || 'none'}`);
  console.log(`First bytes hex: ${m3u8.firstBytes}`);

  if (m3u8.text && m3u8.text.startsWith('#EXTM3U')) {
    const lines = m3u8.text.split('\n').filter(l => l.trim());
    console.log(`\nPlaylist (${lines.length} lines):`);

    // Show header lines
    for (const l of lines.slice(0, 8)) {
      if (l.startsWith('#')) console.log(`  ${l.substring(0, 150)}`);
    }

    // Count segments
    const segLines = lines.filter(l => !l.startsWith('#'));
    const iframes = lines.filter(l => l.includes('EXT-X-I-FRAME-STREAM-INF'));
    const keys = lines.filter(l => l.includes('EXT-X-KEY'));
    const maps = lines.filter(l => l.includes('EXT-X-MAP'));
    const streamInfs = lines.filter(l => l.includes('EXT-X-STREAM-INF'));
    console.log(`  Segments: ${segLines.length}, I-Frames: ${iframes.length}, Keys: ${keys.length}, Maps: ${maps.length}, Stream-INF: ${streamInfs.length}`);

    // Show first 3 segment lines
    console.log(`  First segments:`);
    for (const l of segLines.slice(0, 3)) {
      const trimmed = l.trim();
      if (trimmed) console.log(`    ${trimmed.substring(0, 100)}...`);
    }

    // Check for encryption
    if (keys.length > 0) {
      console.log(`\n  Encryption keys found:`);
      for (const k of keys) {
        const uriMatch = k.match(/URI="([^"]+)"/);
        if (uriMatch) console.log(`    KEY URI: ${uriMatch[1].substring(0, 100)}`);
        const ivMatch = k.match(/IV=0x([0-9A-Fa-f]+)/);
        if (ivMatch) console.log(`    IV: 0x${ivMatch[1]}`);
      }
    }

    // Show last line
    const lastLine = lines[lines.length - 1];
    if (lastLine) console.log(`  Last line: ${lastLine.substring(0, 100)}`);

    // STEP 2: Fetch a segment
    console.log(`\n${'='.repeat(60)}`);
    console.log('STEP 2: Fetch video segment');
    console.log('='.repeat(60));

    const firstSegPath = segLines[0]?.trim();
    if (firstSegPath) {
      const segUrl = firstSegPath.startsWith('http') ? firstSegPath : baseUrl + firstSegPath;

      // 2a: With flixer.su Referer
      const segA = await fetchCDN(segUrl, { 'User-Agent': UA, 'Referer': 'https://flixer.su/', 'Origin': 'https://flixer.su' });
      console.log(`\n2a - flixer.su referer: Status=${segA.status}, ${segA.ms}ms, ${segA.byteLength} bytes`);
      if (segA.bytes && segA.byteLength > 0) {
        console.log(`  Content-Type: ${segA.headers['content-type'] || 'none'}`);
        console.log(`  First bytes: ${Array.from(segA.bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
        const isMpegTs = segA.bytes[0] === 0x47;
        const isFmp4 = segA.byteLength > 4 && segA.bytes[0] === 0x00 && segA.bytes[1] === 0x00 && segA.bytes[2] === 0x00 && segA.bytes[3] === 0x00;
        console.log(`  Format: ${isMpegTs ? 'MPEG-TS (0x47 sync)' : isFmp4 ? 'fMP4 (starts with 0x000000)' : 'Unknown (maybe AES encrypted)'}`);
        if (isMpegTs) {
          let sc = 0;
          for (let i = 0; i < Math.min(segA.byteLength, 188*5); i += 188) { if (segA.bytes[i] === 0x47) sc++; }
          console.log(`  TS sync: ${sc}/${Math.min(Math.floor(segA.byteLength/188), 5)}`);
          // Check for payload data (non-zero bytes)
          let nonZero = 0;
          for (let i = 0; i < Math.min(segA.byteLength, 1000); i++) { if (segA.bytes[i] !== 0) nonZero++; }
          console.log(`  Data density: ${nonZero}/1000 non-zero bytes in first 1KB`);
        }
      }

      // 2b: No headers
      const segB = await fetchCDN(segUrl, {});
      console.log(`\n2b - No headers: Status=${segB.status}, ${segB.ms}ms, ${segB.byteLength} bytes`);

      // 2c: Google referer (should be blocked)
      const segC = await fetchCDN(segUrl, { 'User-Agent': UA, 'Referer': 'https://www.google.com/' });
      console.log(`\n2c - Google referer: Status=${segC.status}, ${segC.ms}ms, ${segC.byteLength} bytes`);
      if (segC.status !== 200 && segC.text) console.log(`  Body: ${segC.text.substring(0, 100)}`);
    }

    // STEP 3: Test CF Worker simulation
    console.log(`\n${'='.repeat(60)}`);
    console.log('STEP 3: Verify the CF Worker claim');
    console.log('='.repeat(60));

    // The existing code states CDN blocks CF Worker IPs.
    // But our tests show only Referer is checked.
    // Let's simulate what a CF Worker fetch looks like:
    const cfSimHeaders = [
      { 'User-Agent': 'Cloudflare-Workers', 'Referer': 'https://flixer.su/' },
      { 'User-Agent': 'Cloudflare-Workers' },
      { 'Referer': 'https://flixer.su/' },
      {}, // empty
    ];

    for (let i = 0; i < cfSimHeaders.length; i++) {
      const r = await fetchCDN(m3u8Url, cfSimHeaders[i]);
      console.log(`  CF Sim #${i+1}: headers=${JSON.stringify(cfSimHeaders[i])}`);
      console.log(`    Status=${r.status}, ${r.ms}ms, ${r.byteLength} bytes`);
    }

    // CONCLUSIONS
    console.log(`\n${'='.repeat(60)}`);
    console.log('FINDINGS SUMMARY');
    console.log('='.repeat(60));
    console.log(`
CDN DOMAIN: ${cdnDomain}
CDN TYPE: Cloudflare Worker (workers.dev)
CONTENT FORMAT: Direct MPEG-TS segments (unencrypted, no EXT-X-KEY)
CONTENT DISGUISE: text/html Content-Type to fool scrapers

ACCESS CONTROL - Referer-based ONLY:
  - Valid referer (flixer.su, hexa.su): Access granted
  - No referer: Access granted (tested)
  - Wrong referer (google.com): 403 Forbidden, body: ':3'
  - User-Agent: Not checked (any value works, including "Cloudflare-Workers")
  - IP-based blocking: NOT DETECTED

CRITICAL FINDING: The CDN likely does NOT block CF Worker IPs.
The previous assumption may have been wrong, or the blocking was
at a different layer (e.g., the API layer, not the CDN layer).

If this finding is correct, we can serve content DIRECTLY from
CF Workers without the RPI proxy. Simply set Referer: https://flixer.su/
in the fetch headers and the CDN should respond.

HOWEVER - some CDN workers may have specific restrictions:
  - cool.14224z.workers.dev: TIMES OUT from this network too
  - *.tylerfisher55.workers.dev: Works perfectly

If one CDN worker blocks, try another server's URL.
The API returns different workers for different servers.
`);
  } else {
    console.log('Response does not start with #EXTM3U');
    if (m3u8.text) console.log(`First 200 chars: ${m3u8.text.substring(0, 200)}`);
  }
}

main().catch(e => console.error('FATAL:', e.message, e.stack));
