/**
 * Flixer Stream Proxy
 * 
 * Handles Flixer API requests with WASM-based encryption/decryption.
 * The WASM module generates keys and decrypts API responses.
 * 
 * Flow:
 *   Client -> Cloudflare Worker -> Flixer API -> Decrypt -> Return m3u8 URL
 * 
 * Routes:
 *   GET /flixer/extract?tmdbId=<id>&type=<movie|tv>&season=<n>&episode=<n>&server=<name>
 *   GET /flixer/health - Health check
 * 
 * Key discoveries from cracking:
 *   - The `bW90aGFmYWth` header BLOCKS requests when present - must NOT send it
 *   - The `Origin` header should NOT be sent
 *   - The `sec-fetch-*` headers should NOT be sent
 *   - A "warm-up" request without X-Server header is needed before the actual request
 *   - `x-fingerprint-lite` header is REQUIRED (March 2026) — injected by hexa.su's
 *     frontend via window.fetch monkey-patch. Value read from KV config (default:
 *     "e9136c41504646444"). Without it, API returns 403.
 * 
 * IMPORTANT: WASM is bundled at build time via wrangler, not fetched at runtime.
 * This avoids the "Wasm code generation disallowed by embedder" error.
 */

import { createLogger, type LogLevel } from './logger';
import { getHexaConfig, type HexaConfig, type ApiRoutes } from './hexa-config';
import { getCachedCapToken, getCapToken, cacheCapToken } from './hexa-cap-solver';
// Import WASM module - bundled at build time by wrangler
import FLIXER_WASM from './flixer.wasm';

export interface Env {
  LOG_LEVEL?: string;
  RPI_PROXY_URL?: string;
  RPI_PROXY_KEY?: string;
  HEXA_CONFIG?: KVNamespace;
}

/**
 * Build the API path for movie or TV image requests using config routes.
 * Replaces {tmdbId}, {season}, {episode} placeholders in the route templates.
 */
function buildApiPath(
  config: HexaConfig,
  type: string,
  tmdbId: string,
  season?: string,
  episode?: string,
): string {
  if (type === 'movie') {
    return config.apiRoutes.movieImages
      .replace('{tmdbId}', tmdbId);
  }
  return config.apiRoutes.tvImages
    .replace('{tmdbId}', tmdbId)
    .replace('{season}', season || '')
    .replace('{episode}', episode || '');
}

// CORS headers
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-cap-token',
  };
}

function jsonResponse(data: object, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// Server name to display name mapping (NATO alphabet to mythology)
// hexa.su supports all 26 NATO servers; we prioritize the first 7 that typically return sources
const SERVER_NAMES: Record<string, string> = {
  alpha: 'Ares',
  bravo: 'Balder',
  charlie: 'Circe',
  delta: 'Dionysus',
  echo: 'Eros',
  foxtrot: 'Freya',
  golf: 'Gaia',
  hotel: 'Hades',
  india: 'Isis',
  juliet: 'Juno',
  kilo: 'Kronos',
  lima: 'Loki',
  mike: 'Medusa',
  november: 'Nyx',
  oscar: 'Odin',
  papa: 'Persephone',
  quebec: 'Quirinus',
  romeo: 'Ra',
  sierra: 'Selene',
  tango: 'Thor',
  uniform: 'Uranus',
  victor: 'Vulcan',
  whiskey: 'Woden',
  xray: 'Xolotl',
  yankee: 'Ymir',
  zulu: 'Zeus',
};

/**
 * WASM Loader for Flixer decryption
 * Mocks browser APIs required by the WASM module
 */
class FlixerWasmLoader {
  private wasm: any = null;
  private heap: any[] = new Array(128).fill(undefined);
  private heap_next: number;
  private WASM_VECTOR_LEN = 0;
  private cachedUint8ArrayMemory0: Uint8Array | null = null;
  private cachedDataViewMemory0: DataView | null = null;
  private cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
  private cachedTextEncoder = new TextEncoder();
  
  // Browser fingerprint values
  private sessionId: string;
  private timestamp: number;
  private randomSeed: number;
  private screenWidth = 1920;
  private screenHeight = 1080;
  private colorDepth = 24;
  private platform = 'Win32';
  private language = 'en-US';
  private userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  private timezoneOffset: number;

  constructor(opts: { sessionId?: string; timestamp?: number } = {}) {
    this.heap.push(undefined, null, true, false);
    this.heap_next = this.heap.length;
    this.sessionId = opts.sessionId || crypto.randomUUID().replace(/-/g, '');
    this.timestamp = opts.timestamp || (Date.now() - 5000);
    this.randomSeed = Math.random();
    this.timezoneOffset = new Date().getTimezoneOffset();
  }

  private getObject(idx: number) { return this.heap[idx]; }
  
  private addHeapObject(obj: any): number {
    if (this.heap_next === this.heap.length) this.heap.push(this.heap.length + 1);
    const idx = this.heap_next;
    this.heap_next = this.heap[idx] as number;
    this.heap[idx] = obj;
    return idx;
  }
  
  private dropObject(idx: number) {
    if (idx < 132) return;
    this.heap[idx] = this.heap_next;
    this.heap_next = idx;
  }
  
  private takeObject(idx: number) {
    const ret = this.getObject(idx);
    this.dropObject(idx);
    return ret;
  }

  private getUint8ArrayMemory0(): Uint8Array {
    if (!this.cachedUint8ArrayMemory0 || this.cachedUint8ArrayMemory0.byteLength === 0
        || this.cachedUint8ArrayMemory0.buffer !== this.wasm.memory.buffer) {
      this.cachedUint8ArrayMemory0 = new Uint8Array(this.wasm.memory.buffer);
    }
    return this.cachedUint8ArrayMemory0;
  }

  private getDataViewMemory0(): DataView {
    if (!this.cachedDataViewMemory0
        || (this.cachedDataViewMemory0 as any).buffer?.detached === true
        || ((this.cachedDataViewMemory0 as any).buffer?.detached === undefined
            && this.cachedDataViewMemory0.buffer !== this.wasm.memory.buffer)) {
      this.cachedDataViewMemory0 = new DataView(this.wasm.memory.buffer);
    }
    return this.cachedDataViewMemory0;
  }

  private getStringFromWasm0(ptr: number, len: number): string {
    return this.cachedTextDecoder.decode(this.getUint8ArrayMemory0().subarray(ptr >>> 0, (ptr >>> 0) + len));
  }

  // Matches the live img_data.js passStringToWasm0 exactly — supports realloc
  // for strings with non-ASCII characters (encrypted API responses).
  private encodeString(arg: string, view: Uint8Array): { read: number; written: number } {
    if (typeof this.cachedTextEncoder.encodeInto === 'function') {
      return this.cachedTextEncoder.encodeInto(arg, view);
    }
    const buf = this.cachedTextEncoder.encode(arg);
    view.set(buf);
    return { read: arg.length, written: buf.length };
  }

  private passStringToWasm0(
    arg: string,
    malloc: (len: number, align: number) => number,
    realloc?: (ptr: number, oldLen: number, newLen: number, align: number) => number,
  ): number {
    if (realloc === undefined) {
      const buf = this.cachedTextEncoder.encode(arg);
      const ptr = malloc(buf.length, 1) >>> 0;
      this.getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
      this.WASM_VECTOR_LEN = buf.length;
      return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = this.getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
      const code = arg.charCodeAt(offset);
      if (code > 0x7F) break;
      mem[ptr + offset] = code;
    }

    if (offset !== len) {
      if (offset !== 0) {
        arg = arg.slice(offset);
      }
      ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
      const view = this.getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
      const ret = this.encodeString(arg, view);

      offset += ret.written;
      ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    this.WASM_VECTOR_LEN = offset;
    return ptr;
  }

  private isLikeNone(x: any): boolean { return x === undefined || x === null; }

  private handleError(f: Function, args: any[]) {
    try { return f.apply(this, args); }
    catch (e) { this.wasm.__wbindgen_export_0(this.addHeapObject(e)); }
  }

  private createMockCanvas() {
    const canvasData = `canvas-fp-${this.screenWidth}x${this.screenHeight}-${this.colorDepth}-${this.platform}-${this.language}`;
    const dataUrl = 'data:image/png;base64,' + btoa(canvasData);
    
    const ctx = {
      _font: '14px Arial',
      _textBaseline: 'alphabetic',
      fillText: function() {},
      get font() { return this._font; },
      set font(v: string) { this._font = v; },
      get textBaseline() { return this._textBaseline; },
      set textBaseline(v: string) { this._textBaseline = v; },
    };
    
    return {
      _width: 200,
      _height: 50,
      get width() { return this._width; },
      set width(v: number) { this._width = v; },
      get height() { return this._height; },
      set height(v: number) { this._height = v; },
      getContext: (type: string) => type === '2d' ? ctx : null,
      toDataURL: () => dataUrl,
    };
  }

  private buildImports() {
    const self = this;
    
    // Mock DOM elements
    const mockBody = { 
      appendChild: () => {},
      tagName: 'BODY',
      nodeName: 'BODY',
      nodeType: 1,
      innerHTML: '',
      outerHTML: '<body></body>',
      parentNode: null,
      parentElement: null,
      children: [],
      childNodes: [],
      firstChild: null,
      lastChild: null,
      nextSibling: null,
      previousSibling: null,
      ownerDocument: null,
      style: {},
      className: '',
      classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
      getAttribute: () => null,
      setAttribute: () => {},
      removeAttribute: () => {},
      hasAttribute: () => false,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
      getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }),
      scrollTop: 0,
      scrollLeft: 0,
      scrollWidth: 0,
      scrollHeight: 0,
      clientWidth: this.screenWidth,
      clientHeight: this.screenHeight,
      offsetWidth: this.screenWidth,
      offsetHeight: this.screenHeight,
      offsetTop: 0,
      offsetLeft: 0,
    };

    const createCollection = (elements: any[]) => {
      const collection: any = {
        length: elements.length,
        item: (i: number) => elements[i] || null,
        namedItem: () => null,
        [Symbol.iterator]: function* () { for (const e of elements) yield e; }
      };
      elements.forEach((el, i) => { collection[i] = el; });
      return new Proxy(collection, {
        get(target, prop) {
          if (typeof prop === 'string' && !isNaN(parseInt(prop))) {
            return target[parseInt(prop)];
          }
          return target[prop];
        }
      });
    };
    
    const trackedBody = new Proxy(mockBody, {
      get(target: any, prop) { return target[prop]; },
      set(target: any, prop, value) { target[prop] = value; return true; }
    });
    
    const doc = { 
      createElement: (t: string) => t === 'canvas' ? self.createMockCanvas() : {},
      getElementsByTagName: (t: string) => t === 'body' ? createCollection([trackedBody]) : createCollection([]),
      body: trackedBody,
    };
    
    const ls = { 
      getItem: (k: string) => k === 'tmdb_session_id' ? self.sessionId : null,
      setItem: () => {},
    };
    
    const nav = { platform: this.platform, language: this.language, userAgent: this.userAgent };
    const scr = { width: this.screenWidth, height: this.screenHeight, colorDepth: this.colorDepth };
    const perf = { now: () => performance.now() };
    const win = { document: doc, localStorage: ls, navigator: nav, screen: scr, performance: perf, queueMicrotask: (fn: any) => queueMicrotask(fn) };
    
    const i: any = { wbg: {} };

    // Function calls
    i.wbg.__wbg_call_672a4d21634d4a24 = function() { 
      return self.handleError((a: number, b: number) => self.addHeapObject(self.getObject(a).call(self.getObject(b))), arguments as any); 
    };
    i.wbg.__wbg_call_7cccdd69e0791ae2 = function() { 
      return self.handleError((a: number, b: number, c: number) => self.addHeapObject(self.getObject(a).call(self.getObject(b), self.getObject(c))), arguments as any); 
    };

    // Screen
    i.wbg.__wbg_colorDepth_59677c81c61d599a = function() { 
      return self.handleError((a: number) => self.getObject(a).colorDepth, arguments as any);
    };
    i.wbg.__wbg_height_614ba187d8cae9ca = function() {
      return self.handleError((a: number) => self.getObject(a).height, arguments as any);
    };
    i.wbg.__wbg_width_679079836447b4b7 = function() {
      return self.handleError((a: number) => self.getObject(a).width, arguments as any);
    };
    i.wbg.__wbg_screen_8edf8699f70d98bc = function() {
      return self.handleError((a: number) => {
        const w = self.getObject(a);
        return self.addHeapObject(w ? w.screen : scr);
      }, arguments as any);
    };
    
    // Document
    i.wbg.__wbg_document_d249400bd7bd996d = (a: number) => { 
      const w = self.getObject(a);
      const d = w ? w.document : null;
      if (d) {
        const trackedDoc = new Proxy(d, { get(target: any, prop) { return target[prop]; } });
        return self.addHeapObject(trackedDoc);
      }
      return 0;
    };
    i.wbg.__wbg_createElement_8c9931a732ee2fea = function() { 
      return self.handleError((a: number, b: number, c: number) => self.addHeapObject(doc.createElement(self.getStringFromWasm0(b, c))), arguments as any);
    };
    i.wbg.__wbg_getElementsByTagName_f03d41ce466561e8 = (a: number, b: number, c: number) => self.addHeapObject(doc.getElementsByTagName(self.getStringFromWasm0(b, c)));
    
    // Canvas
    i.wbg.__wbg_getContext_e9cf379449413580 = function() { 
      return self.handleError((a: number, b: number, c: number) => { 
        const r = self.getObject(a).getContext(self.getStringFromWasm0(b, c)); 
        return self.isLikeNone(r) ? 0 : self.addHeapObject(r); 
      }, arguments as any);
    };
    i.wbg.__wbg_fillText_2a0055d8531355d1 = function() { 
      return self.handleError((a: number, b: number, c: number, d: number, e: number) => self.getObject(a).fillText(self.getStringFromWasm0(b, c), d, e), arguments as any);
    };
    i.wbg.__wbg_setfont_42a163ef83420b93 = (a: number, b: number, c: number) => { self.getObject(a).font = self.getStringFromWasm0(b, c); };
    i.wbg.__wbg_settextBaseline_c28d2a6aa4ff9d9d = (a: number, b: number, c: number) => { self.getObject(a).textBaseline = self.getStringFromWasm0(b, c); };
    i.wbg.__wbg_setheight_da683a33fa99843c = (a: number, b: number) => { self.getObject(a).height = b >>> 0; };
    i.wbg.__wbg_setwidth_c5fed9f5e7f0b406 = (a: number, b: number) => { self.getObject(a).width = b >>> 0; };
    i.wbg.__wbg_toDataURL_eaec332e848fe935 = function() { 
      return self.handleError((a: number, b: number) => { 
        const r = self.getObject(b).toDataURL(); 
        const p = self.passStringToWasm0(r, self.wasm.__wbindgen_export_1, self.wasm.__wbindgen_export_2); 
        self.getDataViewMemory0().setInt32(a + 4, self.WASM_VECTOR_LEN, true); 
        self.getDataViewMemory0().setInt32(a, p, true); 
      }, arguments as any);
    };
    i.wbg.__wbg_instanceof_CanvasRenderingContext2d_df82a4d3437bf1cc = (a: number) => {
      let result; try { result = true; } catch (_) { result = false; } return result;
    };
    i.wbg.__wbg_instanceof_HtmlCanvasElement_2ea67072a7624ac5 = (a: number) => {
      let result; try { result = true; } catch (_) { result = false; } return result;
    };
    i.wbg.__wbg_instanceof_Window_def73ea0955fc569 = (a: number) => {
      let result; try { result = true; } catch (_) { result = false; } return result;
    };

    // LocalStorage
    i.wbg.__wbg_localStorage_1406c99c39728187 = function() { 
      return self.handleError((a: number) => {
        const w = self.getObject(a);
        const storage = w ? w.localStorage : ls;
        return self.isLikeNone(storage) ? 0 : self.addHeapObject(storage);
      }, arguments as any); 
    };
    i.wbg.__wbg_getItem_17f98dee3b43fa7e = function() { 
      return self.handleError((a: number, b: number, c: number, d: number) => { 
        const r = self.getObject(b).getItem(self.getStringFromWasm0(c, d)); 
        const p = self.isLikeNone(r) ? 0 : self.passStringToWasm0(r, self.wasm.__wbindgen_export_1, self.wasm.__wbindgen_export_2); 
        const len = self.WASM_VECTOR_LEN;
        self.getDataViewMemory0().setInt32(a + 4 * 1, len, true); 
        self.getDataViewMemory0().setInt32(a + 4 * 0, p, true); 
      }, arguments as any); 
    };
    i.wbg.__wbg_setItem_212ecc915942ab0a = function() { 
      return self.handleError((a: number, b: number, c: number, d: number, e: number) => {
        self.getObject(a).setItem(self.getStringFromWasm0(b, c), self.getStringFromWasm0(d, e));
      }, arguments as any); 
    };
    
    // Navigator
    i.wbg.__wbg_navigator_1577371c070c8947 = (a: number) => { 
      const w = self.getObject(a);
      return self.addHeapObject(w ? w.navigator : nav); 
    };
    i.wbg.__wbg_language_d871ec78ee8eec62 = (a: number, b: number) => { 
      const r = self.getObject(b).language; 
      const p = self.isLikeNone(r) ? 0 : self.passStringToWasm0(r, self.wasm.__wbindgen_export_1, self.wasm.__wbindgen_export_2); 
      const len = self.WASM_VECTOR_LEN;
      self.getDataViewMemory0().setInt32(a + 4 * 1, len, true); 
      self.getDataViewMemory0().setInt32(a + 4 * 0, p, true); 
    };
    i.wbg.__wbg_platform_faf02c487289f206 = function() { 
      return self.handleError((a: number, b: number) => { 
        const r = self.getObject(b).platform; 
        const p = self.passStringToWasm0(r, self.wasm.__wbindgen_export_1, self.wasm.__wbindgen_export_2); 
        const len = self.WASM_VECTOR_LEN;
        self.getDataViewMemory0().setInt32(a + 4 * 1, len, true); 
        self.getDataViewMemory0().setInt32(a + 4 * 0, p, true); 
      }, arguments as any); 
    };
    i.wbg.__wbg_userAgent_12e9d8e62297563f = function() { 
      return self.handleError((a: number, b: number) => { 
        const r = self.getObject(b).userAgent; 
        const p = self.passStringToWasm0(r, self.wasm.__wbindgen_export_1, self.wasm.__wbindgen_export_2); 
        const len = self.WASM_VECTOR_LEN;
        self.getDataViewMemory0().setInt32(a + 4 * 1, len, true); 
        self.getDataViewMemory0().setInt32(a + 4 * 0, p, true); 
      }, arguments as any); 
    };

    // Date/Time — MUST return FIXED values from init time. The WASM uses these
    // during both key generation (getImgKey) and decryption (processImgData).
    // If they return different values at decrypt time vs keygen time, the key
    // and decryption are out of sync and extraction fails silently.
    // The docker proxy (which works) freezes these at init time — we must too.
    i.wbg.__wbg_new0_f788a2397c7ca929 = () => self.addHeapObject(new Date(self.timestamp));
    i.wbg.__wbg_now_807e54c39636c349 = () => self.timestamp;
    i.wbg.__wbg_getTimezoneOffset_6b5752021c499c47 = () => self.timezoneOffset;
    i.wbg.__wbg_performance_c185c0cdc2766575 = (a: number) => {
      const w = self.getObject(a);
      const p = w ? w.performance : perf;
      return self.isLikeNone(p) ? 0 : self.addHeapObject(p);
    };
    i.wbg.__wbg_now_d18023d54d4e5500 = (a: number) => self.getObject(a).now();
    // Math.random() — MUST return a FIXED seed. The WASM uses this during both
    // keygen and decryption. Different values = broken crypto. Docker proxy does this.
    i.wbg.__wbg_random_3ad904d98382defe = () => self.randomSeed;
    
    // Utility
    i.wbg.__wbg_length_347907d14a9ed873 = (a: number) => self.getObject(a).length;
    i.wbg.__wbg_new_23a2665fac83c611 = (a: number, b: number) => { 
      try { 
        var s: any = { a, b }; 
        var cb = (x: any, y: any) => { 
          const t = s.a; s.a = 0; 
          try { return self.wasm.__wbindgen_export_6(t, s.b, self.addHeapObject(x), self.addHeapObject(y)); } 
          finally { s.a = t; } 
        }; 
        return self.addHeapObject(new Promise(cb)); 
      } finally { s.a = s.b = 0; } 
    };
    i.wbg.__wbg_resolve_4851785c9c5f573d = (a: number) => self.addHeapObject(Promise.resolve(self.getObject(a)));
    i.wbg.__wbg_reject_b3fcf99063186ff7 = (a: number) => self.addHeapObject(Promise.reject(self.getObject(a)));
    i.wbg.__wbg_then_44b73946d2fb3e7d = (a: number, b: number) => self.addHeapObject(self.getObject(a).then(self.getObject(b)));
    i.wbg.__wbg_newnoargs_105ed471475aaf50 = (a: number, b: number) => {
      try {
        const ret = new Function(self.getStringFromWasm0(a, b));
        return self.addHeapObject(ret);
      } catch (_) {
        // new Function() may be blocked in CF Workers — return a no-op
        return self.addHeapObject(() => {});
      }
    };
    
    // Global accessors — match live JS exactly
    i.wbg.__wbg_static_accessor_GLOBAL_88a902d13a557d07 = () => {
      try {
        const ret = (globalThis as any).global;
        return self.isLikeNone(ret) ? 0 : self.addHeapObject(ret);
      } catch (_) {
        return 0;
      }
    };
    i.wbg.__wbg_static_accessor_GLOBAL_THIS_56578be7e9f832b0 = () => {
      const ret = typeof globalThis === 'undefined' ? null : globalThis;
      return self.isLikeNone(ret) ? 0 : self.addHeapObject(ret);
    };
    i.wbg.__wbg_static_accessor_SELF_37c5d418e4bf5819 = () => {
      // In CF Workers, `self` is the global scope — return our mock window instead
      return self.addHeapObject(win);
    };
    i.wbg.__wbg_static_accessor_WINDOW_5de37043a91a9c40 = () => {
      // `window` is undefined in CF Workers — return our mock
      return self.addHeapObject(win);
    };
    
    // Microtask
    i.wbg.__wbg_queueMicrotask_97d92b4fcc8a61c5 = (a: number) => queueMicrotask(self.getObject(a));
    i.wbg.__wbg_queueMicrotask_d3219def82552485 = (a: number) => self.addHeapObject(self.getObject(a).queueMicrotask);
    
    // Wbindgen internals — match live img_data.js exactly
    i.wbg.__wbindgen_cb_drop = (a: number) => {
      const obj = self.takeObject(a).original;
      if (obj.cnt-- == 1) { obj.a = 0; return true; }
      const ret = false;
      return ret;
    };
    i.wbg.__wbindgen_closure_wrapper982 = (a: number, b: number, _c: number) => { 
      const state: any = { a, b, cnt: 1, dtor: 36 }; 
      const real: any = (...args: any[]) => { 
        state.cnt++;
        const t = state.a;
        state.a = 0; 
        try { return self.wasm.__wbindgen_export_5(t, state.b, self.addHeapObject(args[0])); } 
        finally { if (--state.cnt === 0) { self.wasm.__wbindgen_export_3.get(state.dtor)(t, state.b); } else { state.a = t; } } 
      }; 
      real.original = state; 
      return self.addHeapObject(real); 
    };
    i.wbg.__wbindgen_is_function = (a: number) => typeof self.getObject(a) === 'function';
    i.wbg.__wbindgen_is_undefined = (a: number) => self.getObject(a) === undefined;
    i.wbg.__wbindgen_object_clone_ref = (a: number) => self.addHeapObject(self.getObject(a));
    i.wbg.__wbindgen_object_drop_ref = (a: number) => self.takeObject(a);
    i.wbg.__wbindgen_string_new = (a: number, b: number) => self.addHeapObject(self.getStringFromWasm0(a, b));
    i.wbg.__wbindgen_throw = (a: number, b: number) => { throw new Error(self.getStringFromWasm0(a, b)); };
    
    return i;
  }

  async initialize(wasmModule: WebAssembly.Module): Promise<this> {
    const imports = this.buildImports();
    // Use WebAssembly.Module directly (bundled by wrangler at build time)
    // This avoids the "Wasm code generation disallowed" error
    const instance = await WebAssembly.instantiate(wasmModule, imports);
    this.wasm = instance.exports;
    return this;
  }

  getImgKey(): string {
    const retptr = this.wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      this.wasm.get_img_key(retptr);
      const dv = this.getDataViewMemory0();
      const r0 = dv.getInt32(retptr, true);
      const r1 = dv.getInt32(retptr + 4, true);
      const r2 = dv.getInt32(retptr + 8, true);
      const r3 = dv.getInt32(retptr + 12, true);
      if (r3) throw this.takeObject(r2);
      const result = this.getStringFromWasm0(r0, r1);
      this.wasm.__wbindgen_export_4(r0, r1, 1);
      return result;
    } finally {
      this.wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }

  async processImgData(data: string, key: string): Promise<any> {
    const p0 = this.passStringToWasm0(data, this.wasm.__wbindgen_export_1, this.wasm.__wbindgen_export_2);
    const l0 = this.WASM_VECTOR_LEN;
    const p1 = this.passStringToWasm0(key, this.wasm.__wbindgen_export_1, this.wasm.__wbindgen_export_2);
    const l1 = this.WASM_VECTOR_LEN;
    const ret = this.wasm.process_img_data(p0, l0, p1, l1);
    return this.takeObject(ret);
  }
}

// Cached WASM instance (reused across requests)
let cachedWasmLoader: FlixerWasmLoader | null = null;
let cachedApiKey: string | null = null;
let serverTimeOffset = 0;

// WASM init lock — prevents 4 parallel requests from all initializing WASM
let wasmInitPromise: Promise<void> | null = null;

// Track consecutive failures to auto-reset stale WASM state
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
let lastSuccessTime = 0;
const WASM_MAX_AGE = 10 * 60 * 1000; // 10 minutes — force re-init to avoid stale API key
let wasmInitTime = 0;

// ── Server health tracking ──────────────────────────────────────────────────
// Tracks which servers recently returned valid m3u8 URLs vs which failed.
// Used to sort sources so the player gets a likely-working server first.
// TTL: 10 minutes — servers can come and go, don't cache too long.
interface ServerHealthEntry {
  lastSuccess: number;   // timestamp of last successful extraction
  lastFailure: number;   // timestamp of last failure
  successCount: number;  // rolling success count
  failureCount: number;  // rolling failure count
}
const serverHealth = new Map<string, ServerHealthEntry>();
const HEALTH_TTL = 10 * 60 * 1000; // 10 minutes

function recordServerResult(server: string, success: boolean): void {
  const entry = serverHealth.get(server) || { lastSuccess: 0, lastFailure: 0, successCount: 0, failureCount: 0 };
  if (success) {
    entry.lastSuccess = Date.now();
    entry.successCount++;
  } else {
    entry.lastFailure = Date.now();
    entry.failureCount++;
  }
  serverHealth.set(server, entry);
}

function getServerScore(server: string): number {
  const entry = serverHealth.get(server);
  if (!entry) return 0; // unknown — neutral
  const now = Date.now();
  // Expire old data
  if (now - Math.max(entry.lastSuccess, entry.lastFailure) > HEALTH_TTL) return 0;
  // Score: positive = healthy, negative = unhealthy
  const recentSuccess = entry.lastSuccess > 0 && (now - entry.lastSuccess) < HEALTH_TTL;
  const recentFailure = entry.lastFailure > 0 && (now - entry.lastFailure) < HEALTH_TTL;
  if (recentSuccess && !recentFailure) return 2;
  if (recentSuccess && recentFailure) return entry.lastSuccess > entry.lastFailure ? 1 : -1;
  if (!recentSuccess && recentFailure) return -2;
  return 0;
}

async function ensureWasmInitialized(logger: ReturnType<typeof createLogger>, config: HexaConfig): Promise<void> {
  // Auto-reset if too many consecutive failures or WASM is too old
  if (cachedWasmLoader && cachedApiKey) {
    const age = Date.now() - wasmInitTime;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES || age > WASM_MAX_AGE) {
      logger.warn(`Resetting WASM: ${consecutiveFailures} consecutive failures, age ${Math.round(age/1000)}s`);
      cachedWasmLoader = null;
      cachedApiKey = null;
      wasmInitPromise = null;
      consecutiveFailures = 0;
    } else {
      return;
    }
  }
  if (wasmInitPromise) return wasmInitPromise;
  wasmInitPromise = (async () => {
    if (cachedWasmLoader && cachedApiKey) return; // double-check after await
    logger.info('Initializing Flixer WASM...');
    try {
      await syncServerTime(config);
      logger.info('Time sync done', { offset: serverTimeOffset });
    } catch (e) {
      logger.warn('Time sync failed, using local time', { error: e instanceof Error ? e.message : String(e) });
    }
    cachedWasmLoader = new FlixerWasmLoader();
    await cachedWasmLoader.initialize(FLIXER_WASM);
    cachedApiKey = cachedWasmLoader.getImgKey();
    wasmInitTime = Date.now();
    consecutiveFailures = 0;
    logger.info('Flixer WASM initialized', { keyPrefix: cachedApiKey.slice(0, 16), keyLen: cachedApiKey.length });
  })();
  wasmInitPromise.catch(() => { 
    wasmInitPromise = null;
    cachedWasmLoader = null;
    cachedApiKey = null;
  });
  return wasmInitPromise;
}

/**
 * Sync with Flixer server time
 */
async function syncServerTime(config: HexaConfig): Promise<void> {
  try {
    const localTimeBefore = Date.now();
    // hexa.su time sync — no JS challenge, direct fetch works from CF Workers
    const timePath = config.apiRoutes.time;
    const response = await fetch(`${config.apiDomain}${timePath}?t=${localTimeBefore}`, {
      signal: AbortSignal.timeout(5000),
    });
    
    if (!response.ok) {
      console.log(`[Flixer] Time sync failed: HTTP ${response.status}, using local time`);
      serverTimeOffset = 0;
      return;
    }
    
    const localTimeAfter = Date.now();
    const text = await response.text();
    
    // Guard against non-JSON responses (e.g., Cloudflare error pages)
    let data: { timestamp: number };
    try {
      data = JSON.parse(text);
    } catch {
      console.log(`[Flixer] Time sync returned non-JSON: ${text.substring(0, 80)}, using local time`);
      serverTimeOffset = 0;
      return;
    }
    
    const rtt = localTimeAfter - localTimeBefore;
    const serverTimeMs = data.timestamp * 1000;
    serverTimeOffset = serverTimeMs + (rtt / 2) - localTimeAfter;
  } catch (e) {
    console.log(`[Flixer] Time sync error: ${e instanceof Error ? e.message : String(e)}, using local time`);
    serverTimeOffset = 0;
  }
}

function getServerTimestamp(): number {
  return Math.floor((Date.now() + serverTimeOffset) / 1000);
}

/**
 * Generate client fingerprint matching the browser implementation
 */
function generateClientFingerprint(): string {
  const screenWidth = 2560;
  const screenHeight = 1440;
  const colorDepth = 24;
  const platform = 'Win32';
  const language = 'en-US';
  const timezoneOffset = new Date().getTimezoneOffset();
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
  const canvasSubstr = 'iVBORw0KGgoAAAANSUhEUgAAASwA';
  
  const fpString = `${screenWidth}x${screenHeight}:${colorDepth}:${userAgent.substring(0, 50)}:${platform}:${language}:${timezoneOffset}:${canvasSubstr}`;
  
  let hash = 0;
  for (let i = 0; i < fpString.length; i++) {
    hash = (hash << 5) - hash + fpString.charCodeAt(i);
    hash &= hash;
  }
  
  return Math.abs(hash).toString(36);
}

/**
 * Generate authentication headers for Flixer API
 */
function generateAuthHeaders(apiKey: string, path: string): Record<string, string> {
  const timestamp = getServerTimestamp();
  
  // Generate nonce - 22 chars from base64
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = btoa(String.fromCharCode(...nonceBytes))
    .replace(/[/+=]/g, '').substring(0, 22);
  
  // Generate HMAC-SHA256 signature
  const message = `${apiKey}:${timestamp}:${nonce}:${path}`;
  
  // Use SubtleCrypto for HMAC (async, but we'll handle it)
  // For now, use a simple hash since we need sync
  // The actual signature is computed in the request function
  
  return {
    'X-Api-Key': apiKey,
    'X-Request-Timestamp': timestamp.toString(),
    'X-Request-Nonce': nonce,
    'X-Client-Fingerprint': generateClientFingerprint(),
    'Accept': 'text/plain',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
}

/**
 * Make authenticated API request to Flixer/Hexa
 * 
 * IMPORTANT: hexa.su works fine from datacenter IPs (no JS challenge).
 * We fetch DIRECTLY — no RPI proxy needed. This avoids double-proxying
 * and eliminates the RPI as a failure point.
 */
async function makeFlixerRequest(
  apiKey: string,
  path: string,
  config: HexaConfig,
  extraHeaders: Record<string, string> = {},
  capToken?: string | null,
): Promise<string> {
  const timestamp = getServerTimestamp();
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = btoa(String.fromCharCode(...nonceBytes))
    .replace(/[/+=]/g, '').substring(0, 22);
  
  // Generate HMAC-SHA256 signature
  const message = `${apiKey}:${timestamp}:${nonce}:${path}`;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(apiKey);
  const messageData = encoder.encode(message);
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
  
  // Match flixer.su's actual request pattern (verified via Puppeteer sniffing):
  // - Origin: https://flixer.su is REQUIRED
  // - Referer: https://flixer.su/ is sent
  // - bw90agfmywth: 1 is sent on warm-up (via extraHeaders)
  // - No cap token needed
  // - No sec-fetch-* headers
  const headers: Record<string, string> = {
    'X-Api-Key': apiKey,
    'X-Request-Timestamp': timestamp.toString(),
    'X-Request-Nonce': nonce,
    'X-Request-Signature': signature,
    'X-Client-Fingerprint': generateClientFingerprint(),
    'Accept': 'text/plain',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://flixer.su',
    'Referer': 'https://flixer.su/',
    ...extraHeaders,
  };
  
  headers['x-fingerprint-lite'] = config.fingerprintLite;

  // Direct fetch to flixer API.
  // Do NOT route through RPI — that adds latency and a failure point.
  const url = `${config.apiDomain}${path}`;
  console.log(`[Flixer] API request: ${path} (server: ${extraHeaders['X-Server'] || 'none'})`);
  
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    // Detect Cloudflare infrastructure errors (1016 = DNS error, 1015 = rate limited, etc.)
    if (errorText.includes('error code:') || errorText.includes('Cloudflare')) {
      throw new Error(`Flixer API unreachable (CF error): ${errorText.substring(0, 100)}`);
    }
    throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 200)}`);
  }
  
  return response.text();
}

/**
 * Get source URL from a specific server (single attempt, no warm-up).
 * Warm-up is done once before calling this in parallel.
 */
async function getSourceFromServer(
  loader: FlixerWasmLoader,
  apiKey: string,
  type: string,
  tmdbId: string,
  server: string,
  config: HexaConfig,
  seasonId?: string,
  episodeId?: string,
  capToken?: string | null,
): Promise<{ url: string | null; raw: any }> {
  const path = buildApiPath(config, type, tmdbId, seasonId, episodeId);

  try {
    const encrypted = await makeFlixerRequest(apiKey, path, config, {
      'X-Only-Sources': '1',
      'X-Server': server,
    }, capToken);

    const decrypted = await loader.processImgData(encrypted, apiKey);
    // processImgData returns a Promise that resolves to either a JSON string or
    // an already-parsed object, depending on the WASM internals.
    const data = typeof decrypted === 'string' ? JSON.parse(decrypted) : decrypted;

    // Extract URL from various possible locations
    let url: string | null = null;
    
    if (Array.isArray(data.sources)) {
      const source = data.sources.find((s: any) => s.server === server) || data.sources[0];
      url = source?.url || source?.file || source?.stream;
      if (!url && source?.sources) {
        url = source.sources[0]?.url || source.sources[0]?.file;
      }
    }
    
    if (!url) {
      url = data.sources?.file || data.sources?.url || data.file || data.url || data.stream;
    }
    
    if (!url && data.servers && data.servers[server]) {
      const serverData = data.servers[server];
      url = serverData.url || serverData.file || serverData.stream;
      if (Array.isArray(serverData)) {
        url = serverData[0]?.url || serverData[0]?.file;
      }
    }

    if (url && url.trim() !== '') {
      return { url, raw: data };
    }
    
    // Log the actual decrypted structure so we can diagnose format changes
    const keys = Object.keys(data || {});
    const sourcesType = data.sources ? (Array.isArray(data.sources) ? `array[${data.sources.length}]` : typeof data.sources) : 'missing';
    console.log(`[Flixer] ${server}: decrypted OK but no URL found. Keys: [${keys.join(',')}], sources: ${sourcesType}, raw: ${JSON.stringify(data).substring(0, 300)}`);
  } catch (e) {
    console.log(`[Flixer] ${server}: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { url: null, raw: null };
}

/**
 * Extract ALL servers in parallel. Returns as soon as at least one source is found,
 * with a short grace period to collect more. Doesn't wait for all 12 to finish.
 */
/**
 * Extract the server list from the warm-up response.
 * The warm-up (with bW90aGFmYWth header) returns encrypted data containing
 * which servers are available. We decrypt it to get the list.
 */
async function getAvailableServers(
  loader: FlixerWasmLoader,
  apiKey: string,
  warmupPath: string,
  logger: ReturnType<typeof createLogger>,
  config: HexaConfig,
  capToken?: string | null,
): Promise<string[]> {
  try {
    const encrypted = await makeFlixerRequest(apiKey, warmupPath, config, { 'bw90agfmywth': '1' }, capToken);
    const decrypted = await loader.processImgData(encrypted, apiKey);
    const data = typeof decrypted === 'string' ? JSON.parse(decrypted) : decrypted;

    let servers: string[] = [];

    // Extract server list from various response formats
    if (data?.sources && Array.isArray(data.sources)) {
      for (const s of data.sources) {
        if (s?.server) servers.push(s.server);
      }
      // Also check data.servers object
      if (data?.servers && Object.keys(data.servers).length > 0) {
        servers = Object.keys(data.servers);
      }
    } else if (data?.servers) {
      servers = Object.keys(data.servers);
    }

    logger.info(`Warm-up returned ${servers.length} available servers: [${servers.slice(0, 8).join(',')}${servers.length > 8 ? '...' : ''}]`);
    return servers;
  } catch (e) {
    logger.warn(`Warm-up decrypt failed: ${e instanceof Error ? e.message : String(e)}, falling back to all servers`);
    // Fall back to all known servers
    return Object.keys(SERVER_NAMES);
  }
}

/**
 * Extract ALL servers using the same simple approach as /flixer/validate.
 * One warm-up, then sequential per-server fetch+decrypt.
 * No overcomplicated batching — just the pattern that works.
 */
async function extractAllServers(
  tmdbId: string,
  type: string,
  season: string | undefined,
  episode: string | undefined,
  logger: ReturnType<typeof createLogger>,
  config: HexaConfig,
  env?: Env,
  _isRetry: boolean = false,
  clientCapToken?: string,
): Promise<Response> {
  const startTime = Date.now();

  try {
    // Step 1: WASM init
    await ensureWasmInitialized(logger, config);

    const apiKey = cachedApiKey!;
    const loader = cachedWasmLoader!;
    const apiPath = buildApiPath(config, type, tmdbId, season, episode);

    // No cap token needed — verified via Puppeteer sniffing of flixer.su.
    // flixer.su makes ZERO requests to cap.hexa.su.

    // Step 2: Warm-up (with bw90agfmywth header)
    const availableServers = await getAvailableServers(loader, apiKey, apiPath, logger, config);

    // Use warm-up results if we got a filtered list (< 26 = real availability data).
    // If warm-up returned all 26 (decrypt failed → fallback) or 0, query ALL servers.
    // Promise.allSettled handles failures gracefully, and querying all 26 in parallel
    // only adds ~0-200ms vs querying 7, while ensuring we never miss content that
    // lives on less-common servers (hotel→zulu).
    const serversToQuery = availableServers.length > 0 && availableServers.length < 26
      ? availableServers
      : Object.keys(SERVER_NAMES);

    logger.info(`Querying ${serversToQuery.length} servers in parallel for ${type}/${tmdbId}`);

    // Step 3: Extract ALL servers in PARALLEL with health tracking
    const results = await Promise.allSettled(
      serversToQuery.map(async (server) => {
        const encrypted = await makeFlixerRequest(apiKey, apiPath, config, {
          'X-Only-Sources': '1',
          'X-Server': server,
        });

        const decrypted = await loader.processImgData(encrypted, apiKey);
        const parsed = typeof decrypted === 'string' ? JSON.parse(decrypted) : decrypted;

        let url: string | null = null;
        if (Array.isArray(parsed.sources)) {
          const source = parsed.sources.find((s: any) => s.server === server) || parsed.sources[0];
          url = source?.url || source?.file || source?.stream || null;
        }
        if (!url) {
          url = parsed.sources?.file || parsed.sources?.url || parsed.file || parsed.url || parsed.stream || null;
        }

        if (url && url.trim()) {
          recordServerResult(server, true);
          return { server, url };
        }
        recordServerResult(server, false);
        throw new Error(`${server}: no URL in decrypted data`);
      })
    );

    const extractedSources: Array<{ server: string; url: string }> = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        extractedSources.push(r.value);
      } else {
        logger.debug(r.reason?.message || 'server extraction failed');
      }
    }

    // Sort by health score — servers that worked recently go first
    extractedSources.sort((a, b) => getServerScore(b.server) - getServerScore(a.server));

    logger.info(`Extraction done: ${extractedSources.length}/${serversToQuery.length} URLs extracted`);

    // Step 4: Validate the TOP source's m3u8 via direct fetch.
    // Flixer CDN (*.workers.dev) is cross-account — CF Workers can fetch directly.
    // No RPI needed. URL-token auth only, no IP/origin restrictions.
    let validatedFirst = false;
    if (extractedSources.length > 0) {
      const top = extractedSources[0];
      try {
        const probeRes = await fetch(top.url, {
          signal: AbortSignal.timeout(8000),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://flixer.su/',
          },
          cf: { cacheTtl: 30 }, // Cache m3u8 briefly to reduce CDN load
        });
        if (probeRes.ok) {
          const firstBytes = new Uint8Array(await probeRes.arrayBuffer());
          const contentType = probeRes.headers.get('content-type') || '';
          // Valid if it looks like m3u8 (#EXTM3U) or MPEG-TS (0x47 sync byte)
          const looksValid = contentType.includes('mpegurl') ||
            (firstBytes.length > 6 && firstBytes[0] === 0x23 && firstBytes[1] === 0x45) ||
            firstBytes[0] === 0x47;
          if (looksValid) {
            validatedFirst = true;
            logger.info(`Validated top source: ${top.server} ✓`);
          } else {
            logger.warn(`Top source ${top.server} probe: unexpected content`);
            recordServerResult(top.server, false);
            extractedSources.push(extractedSources.shift()!);
          }
        } else {
          logger.warn(`Top source ${top.server} probe: HTTP ${probeRes.status}`);
          recordServerResult(top.server, false);
          extractedSources.push(extractedSources.shift()!);
        }
      } catch {
        logger.debug('Top source probe timed out, skipping validation');
      }
    }

    const allSources = extractedSources.map((src, idx) => ({
      quality: 'auto',
      title: `Flixer ${SERVER_NAMES[src.server] || src.server}`,
      url: src.url,
      type: 'hls',
      referer: 'https://hexa.su/',
      requiresSegmentProxy: true,
      status: (idx === 0 && validatedFirst) ? 'validated' : 'working',
      language: 'en',
      server: src.server,
    }));

    const elapsed = Date.now() - startTime;
    logger.info(`extract-all: ${allSources.length} sources in ${elapsed}ms`);

    if (allSources.length > 0) {
      consecutiveFailures = 0;
      lastSuccessTime = Date.now();
    } else {
      consecutiveFailures++;
      if (!_isRetry) {
        logger.warn('0 sources — forcing WASM re-init and retrying');
        cachedWasmLoader = null;
        cachedApiKey = null;
        wasmInitPromise = null;
        consecutiveFailures = 0;
        return extractAllServers(tmdbId, type, season, episode, logger, config, env, true, clientCapToken);
      }
    }

    return jsonResponse({
      success: allSources.length > 0,
      sources: allSources,
      serverCount: serversToQuery.length,
      extractedCount: allSources.length,
      validatedFirst,
      elapsed_ms: elapsed,
      timestamp: new Date().toISOString(),
    }, allSources.length > 0 ? 200 : 404);

  } catch (error) {
    logger.error('extract-all error', error as Error);
    cachedWasmLoader = null;
    cachedApiKey = null;
    wasmInitPromise = null;
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
}


/**
 * Main handler for Flixer proxy requests
 */
export async function handleFlixerRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const logLevel = (env.LOG_LEVEL || 'info') as LogLevel;
  const logger = createLogger(request, logLevel);

  // Load KV-backed config (cached in-memory for 5 min, falls back to hardcoded defaults)
  const config = await getHexaConfig(env.HEXA_CONFIG);

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // Health check
  if (path === '/flixer/health' || path.endsWith('/health')) {
    return jsonResponse({
      status: 'ok',
      wasmLoaded: !!cachedWasmLoader,
      hasApiKey: !!cachedApiKey,
      serverTimeOffset,
      wasmAge: wasmInitTime ? Math.round((Date.now() - wasmInitTime) / 1000) : null,
      consecutiveFailures,
      lastSuccessAge: lastSuccessTime ? Math.round((Date.now() - lastSuccessTime) / 1000) : null,
      timestamp: new Date().toISOString(),
    }, 200);
  }

  // Debug endpoint — shows raw decrypted data for diagnosis
  if (path === '/flixer/debug') {
    const tmdbId = url.searchParams.get('tmdbId') || '550';
    const type = url.searchParams.get('type') || 'movie';
    const season = url.searchParams.get('season') || undefined;
    const episode = url.searchParams.get('episode') || undefined;
    const server = url.searchParams.get('server') || 'alpha';

    try {
      await ensureWasmInitialized(logger, config);
      const apiKey = cachedApiKey!;
      const loader = cachedWasmLoader!;

      // Get cap token: prefer request header/param, then KV cache
      let capToken: string | null = request.headers.get('x-cap-token') || url.searchParams.get('capToken') || null;
      if (!capToken && env.HEXA_CONFIG) {
        capToken = await getCachedCapToken(env.HEXA_CONFIG);
      }

      const apiPath = buildApiPath(config, type, tmdbId, season, episode);

      // Warm-up (proper — decrypt to register session)
      await getAvailableServers(loader, apiKey, apiPath, logger, config, capToken);

      // Fetch encrypted
      const encrypted = await makeFlixerRequest(apiKey, apiPath, config, {
        'X-Only-Sources': '1',
        'X-Server': server,
      }, capToken);

      // Decrypt
      const decrypted = await loader.processImgData(encrypted, apiKey);
      let parsed: any = null;
      try { parsed = typeof decrypted === 'string' ? JSON.parse(decrypted) : decrypted; } catch {}

      // Extract URL using same logic as getSourceFromServer
      let extractedUrl: string | null = null;
      if (parsed) {
        if (Array.isArray(parsed.sources)) {
          const source = parsed.sources.find((s: any) => s.server === server) || parsed.sources[0];
          extractedUrl = source?.url || source?.file || source?.stream || null;
        }
        if (!extractedUrl) {
          extractedUrl = parsed.sources?.file || parsed.sources?.url || parsed.file || parsed.url || parsed.stream || null;
        }
      }

      return jsonResponse({
        success: !!extractedUrl,
        server,
        decryptedType: typeof decrypted,
        encryptedLength: encrypted.length,
        decryptedLength: typeof decrypted === 'string' ? decrypted.length : JSON.stringify(decrypted).length,
        parsedKeys: parsed ? Object.keys(parsed) : [],
        sourcesType: parsed?.sources ? (Array.isArray(parsed.sources) ? `array[${parsed.sources.length}]` : typeof parsed.sources) : 'missing',
        extractedUrl: extractedUrl ? extractedUrl.substring(0, 120) + '...' : null,
        rawPreview: parsed ? JSON.stringify(parsed).substring(0, 500) : null,
        timestamp: new Date().toISOString(),
      }, 200);
    } catch (e) {
      // Reset WASM on error
      cachedWasmLoader = null;
      cachedApiKey = null;
      wasmInitPromise = null;
      return jsonResponse({ success: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // Full pipeline validation — WASM init → key gen → API call → decrypt → URL extract → m3u8 fetch → segment fetch
  if (path === '/flixer/validate') {
    const tmdbId = url.searchParams.get('tmdbId') || '550';
    const type = url.searchParams.get('type') || 'movie';
    const season = url.searchParams.get('season') || undefined;
    const episode = url.searchParams.get('episode') || undefined;
    const server = url.searchParams.get('server') || 'alpha';
    const steps: Record<string, any> = {};

    try {
      // Step 1: WASM init
      const t0 = Date.now();
      await ensureWasmInitialized(logger, config);
      steps.wasmInit = { ok: true, ms: Date.now() - t0, keyPrefix: cachedApiKey!.slice(0, 16), keyLen: cachedApiKey!.length };

      const apiKey = cachedApiKey!;
      const loader = cachedWasmLoader!;
      const apiPath = buildApiPath(config, type, tmdbId, season, episode);

      // Get cap token: prefer request header/param, then KV cache
      let capToken: string | null = request.headers.get('x-cap-token') || url.searchParams.get('capToken') || null;
      if (!capToken && env.HEXA_CONFIG) {
        capToken = await getCachedCapToken(env.HEXA_CONFIG);
      }

      // Step 2: Warm-up
      const t1 = Date.now();
      const servers = await getAvailableServers(loader, apiKey, apiPath, logger, config, capToken);
      steps.warmup = { ok: servers.length > 0, ms: Date.now() - t1, serverCount: servers.length, servers: servers.slice(0, 8) };

      // Step 3: Fetch + decrypt
      const t2 = Date.now();
      const encrypted = await makeFlixerRequest(apiKey, apiPath, config, { 'X-Only-Sources': '1', 'X-Server': server }, capToken);
      steps.apiFetch = { ok: true, ms: Date.now() - t2, encryptedLen: encrypted.length, preview: encrypted.substring(0, 80) };

      const t3 = Date.now();
      const decrypted = await loader.processImgData(encrypted, apiKey);
      const parsed = typeof decrypted === 'string' ? JSON.parse(decrypted) : decrypted;
      steps.decrypt = { ok: true, ms: Date.now() - t3, type: typeof decrypted, keys: Object.keys(parsed), preview: JSON.stringify(parsed).substring(0, 300) };

      // Step 4: URL extraction
      let extractedUrl: string | null = null;
      if (Array.isArray(parsed.sources)) {
        const source = parsed.sources.find((s: any) => s.server === server) || parsed.sources[0];
        extractedUrl = source?.url || source?.file || source?.stream || null;
      }
      if (!extractedUrl) {
        extractedUrl = parsed.sources?.file || parsed.sources?.url || parsed.file || parsed.url || parsed.stream || null;
      }
      steps.urlExtract = { ok: !!extractedUrl, url: extractedUrl ? extractedUrl.substring(0, 150) : null };

      // Step 5: Fetch m3u8 master playlist via RPI proxy (same path as /flixer/stream)
      // Direct fetch from CF Worker gets 403 — CDN blocks datacenter IPs
      if (extractedUrl) {
        const cdnHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Encoding': 'identity',
          'Referer': 'https://hexa.su/',
          'Origin': 'https://hexa.su',
        };

        // Helper: fetch via RPI rust-fetch (same as /flixer/stream strategy 2)
        const fetchViaCdn = async (targetUrl: string): Promise<Response> => {
          // Try direct first
          try {
            const directRes = await fetch(targetUrl, { headers: cdnHeaders, signal: AbortSignal.timeout(6000) });
            if (directRes.ok) return directRes;
          } catch {}
          // RPI rust-fetch
          if (env.RPI_PROXY_URL && env.RPI_PROXY_KEY) {
            let rpiBase = env.RPI_PROXY_URL.replace(/\/+$/, '');
            if (!rpiBase.startsWith('http')) rpiBase = `https://${rpiBase}`;
            const rustParams = new URLSearchParams({ url: targetUrl, headers: JSON.stringify(cdnHeaders), timeout: '20' });
            const rustRes = await fetch(`${rpiBase}/fetch-rust?${rustParams.toString()}`, {
              headers: { 'X-API-Key': env.RPI_PROXY_KEY },
              signal: AbortSignal.timeout(20000),
            });
            if (rustRes.ok) return rustRes;
            throw new Error(`RPI rust-fetch returned ${rustRes.status}`);
          }
          throw new Error('No proxy available (RPI not configured)');
        };

        const t4 = Date.now();
        try {
          const m3u8Res = await fetchViaCdn(extractedUrl);
          const m3u8Text = await m3u8Res.text();
          const hasStreams = m3u8Text.includes('#EXT-X-STREAM-INF') || m3u8Text.includes('#EXTINF');
          const hasKey = m3u8Text.includes('#EXT-X-KEY');
          steps.m3u8Fetch = {
            ok: hasStreams,
            ms: Date.now() - t4,
            length: m3u8Text.length,
            hasStreams,
            hasKey,
            preview: m3u8Text.substring(0, 400),
          };

          // Step 6: If master playlist, fetch first variant
          if (hasStreams && m3u8Text.includes('#EXT-X-STREAM-INF')) {
            const variantLines = m3u8Text.split('\n').filter(l => !l.startsWith('#') && l.trim().length > 0);
            if (variantLines.length > 0) {
              let variantUrl = variantLines[0].trim();
              if (!variantUrl.startsWith('http')) {
                const base = new URL(extractedUrl);
                const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
                variantUrl = variantUrl.startsWith('/') ? `${base.origin}${variantUrl}` : `${base.origin}${basePath}${variantUrl}`;
              }
              const t5 = Date.now();
              try {
                const varRes = await fetchViaCdn(variantUrl);
                const varText = await varRes.text();
                const hasSegments = varText.includes('#EXTINF');
                const varHasKey = varText.includes('#EXT-X-KEY');
                steps.variantFetch = {
                  ok: hasSegments,
                  ms: Date.now() - t5,
                  length: varText.length,
                  hasSegments,
                  hasKey: varHasKey,
                  preview: varText.substring(0, 400),
                };

                // Step 7: Fetch AES-128 key (if encrypted)
                if (varHasKey) {
                  const keyMatch = varText.match(/URI="([^"]+)"/);
                  if (keyMatch) {
                    let keyUrl = keyMatch[1];
                    if (!keyUrl.startsWith('http')) {
                      const base = new URL(variantUrl);
                      const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
                      keyUrl = keyUrl.startsWith('/') ? `${base.origin}${keyUrl}` : `${base.origin}${basePath}${keyUrl}`;
                    }
                    const t6 = Date.now();
                    try {
                      const keyRes = await fetchViaCdn(keyUrl);
                      const keyBuf = await keyRes.arrayBuffer();
                      steps.keyFetch = { ok: keyBuf.byteLength === 16, ms: Date.now() - t6, bytes: keyBuf.byteLength };
                    } catch (e) {
                      steps.keyFetch = { ok: false, ms: Date.now() - t6, error: e instanceof Error ? e.message : String(e) };
                    }
                  }
                }

                // Step 8: Fetch first segment
                if (hasSegments) {
                  const segLines = varText.split('\n');
                  let segUrl: string | null = null;
                  for (let i = 0; i < segLines.length; i++) {
                    if (segLines[i].startsWith('#EXTINF') && i + 1 < segLines.length) {
                      segUrl = segLines[i + 1].trim();
                      break;
                    }
                  }
                  if (segUrl) {
                    if (!segUrl.startsWith('http')) {
                      const base = new URL(variantUrl);
                      const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
                      segUrl = segUrl.startsWith('/') ? `${base.origin}${segUrl}` : `${base.origin}${basePath}${segUrl}`;
                    }
                    const t7 = Date.now();
                    try {
                      const segRes = await fetchViaCdn(segUrl);
                      const segBuf = await segRes.arrayBuffer();
                      const segBytes = new Uint8Array(segBuf);
                      steps.segmentFetch = {
                        ok: segBuf.byteLength > 100,
                        ms: Date.now() - t7,
                        bytes: segBuf.byteLength,
                        firstByte: `0x${segBytes[0]?.toString(16).padStart(2, '0')}`,
                        isMpegTs: segBytes[0] === 0x47,
                        isEncrypted: segBytes[0] !== 0x47, // If not MPEG-TS sync byte, likely AES encrypted
                      };
                    } catch (e) {
                      steps.segmentFetch = { ok: false, ms: Date.now() - t7, error: e instanceof Error ? e.message : String(e) };
                    }
                  }
                }
              } catch (e) {
                steps.variantFetch = { ok: false, ms: Date.now() - t5, error: e instanceof Error ? e.message : String(e) };
              }
            }
          }
        } catch (e) {
          steps.m3u8Fetch = { ok: false, ms: Date.now() - t4, error: e instanceof Error ? e.message : String(e) };
        }
      }

      const allOk = steps.wasmInit?.ok && steps.warmup?.ok && steps.decrypt?.ok && steps.urlExtract?.ok
        && steps.m3u8Fetch?.ok && (steps.variantFetch?.ok ?? true) && (steps.keyFetch?.ok ?? true) && (steps.segmentFetch?.ok ?? true);
      return jsonResponse({ success: allOk, steps, totalMs: Date.now() - t0 }, allOk ? 200 : 500);
    } catch (e) {
      cachedWasmLoader = null;
      cachedApiKey = null;
      wasmInitPromise = null;
      return jsonResponse({ success: false, error: e instanceof Error ? e.message : String(e), steps }, 500);
    }
  }

  // =========================================================================
  // /flixer/sign — Generate signed auth headers for browser-direct requests
  // Browser calls this, gets headers, then calls hexa.su API directly.
  // Hexa sees the user's residential IP → no captcha needed.
  // =========================================================================
  if (path === '/flixer/sign') {
    const tmdbId = url.searchParams.get('tmdbId');
    const type = url.searchParams.get('type') || 'movie';
    const season = url.searchParams.get('season') || undefined;
    const episode = url.searchParams.get('episode') || undefined;
    const server = url.searchParams.get('server') || undefined;
    const warmup = url.searchParams.get('warmup') === '1';

    if (!tmdbId) {
      return jsonResponse({ error: 'Missing tmdbId parameter' }, 400);
    }

    try {
      await ensureWasmInitialized(logger, config);
      const apiKey = cachedApiKey!;
      const apiPath = buildApiPath(config, type, tmdbId, season, episode);

      // Generate signed headers
      const timestamp = getServerTimestamp();
      const nonceBytes = new Uint8Array(16);
      crypto.getRandomValues(nonceBytes);
      const nonce = btoa(String.fromCharCode(...nonceBytes))
        .replace(/[/+=]/g, '').substring(0, 22);

      const message = `${apiKey}:${timestamp}:${nonce}:${apiPath}`;
      const encoder = new TextEncoder();
      const keyData = encoder.encode(apiKey);
      const messageData = encoder.encode(message);
      const cryptoKey = await crypto.subtle.importKey(
        'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      );
      const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
      const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

      const headers: Record<string, string> = {
        'X-Api-Key': apiKey,
        'X-Request-Timestamp': timestamp.toString(),
        'X-Request-Nonce': nonce,
        'X-Request-Signature': signature,
        'X-Client-Fingerprint': generateClientFingerprint(),
        'x-fingerprint-lite': config.fingerprintLite,
        'Accept': 'text/plain',
        'Accept-Language': 'en-US,en;q=0.9',
      };

      // Warm-up request — no extra headers needed for flixer.su
      // (bW90aGFmYWth was only needed for hexa.su)

      // Per-server request needs X-Only-Sources + X-Server
      if (server && !warmup) {
        headers['X-Only-Sources'] = '1';
        headers['X-Server'] = server;
      }

      return jsonResponse({
        success: true,
        url: `${config.apiDomain}${apiPath}`,
        headers,
        apiPath,
      }, 200);
    } catch (e) {
      return jsonResponse({ success: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // =========================================================================
  // /flixer/decrypt — Decrypt an encrypted hexa API response
  // Browser fetched from hexa.su directly, sends encrypted text here to decrypt.
  // =========================================================================
  if (path === '/flixer/decrypt' && request.method === 'POST') {
    try {
      await ensureWasmInitialized(logger, config);
      const apiKey = cachedApiKey!;
      const loader = cachedWasmLoader!;

      const body = await request.json() as { encrypted: string };
      if (!body.encrypted || typeof body.encrypted !== 'string') {
        return jsonResponse({ error: 'Missing encrypted field' }, 400);
      }

      const decrypted = await loader.processImgData(body.encrypted, apiKey);
      const parsed = typeof decrypted === 'string' ? JSON.parse(decrypted) : decrypted;

      // Extract URLs from all sources
      const sources: Array<{ server: string; url: string }> = [];
      if (Array.isArray(parsed.sources)) {
        for (const s of parsed.sources) {
          const url = s?.url || s?.file || s?.stream;
          if (url && s?.server) {
            sources.push({ server: s.server, url });
          }
        }
      }

      // Also extract server list (from warm-up response)
      let servers: string[] = [];
      if (parsed?.sources && Array.isArray(parsed.sources)) {
        for (const s of parsed.sources) {
          if (s?.server) servers.push(s.server);
        }
      }
      if (parsed?.servers) {
        servers = Object.keys(parsed.servers);
      }

      return jsonResponse({
        success: true,
        sources,
        servers,
        parsed,
      }, 200);
    } catch (e) {
      return jsonResponse({ success: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // CORS preflight for POST /flixer/decrypt
  if (path === '/flixer/decrypt' && request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-cap-token',
      },
    });
  }

  // Batch extract ALL servers in one request
  if (path === '/flixer/extract-all') {
    const tmdbId = url.searchParams.get('tmdbId');
    const type = url.searchParams.get('type') || 'movie';
    const season = url.searchParams.get('season') || undefined;
    const episode = url.searchParams.get('episode') || undefined;
    // Accept cap token from client (browser-solved PoW) via header or query param
    // Validate: Cap tokens are JWTs (~200-500 chars), reject oversized/malformed input
    const rawCapToken = request.headers.get('x-cap-token') || url.searchParams.get('capToken') || undefined;
    const clientCapToken = rawCapToken && rawCapToken.length <= 2048 && /^[A-Za-z0-9._:\-]+$/.test(rawCapToken) ? rawCapToken : undefined;

    if (!tmdbId) {
      return jsonResponse({ error: 'Missing tmdbId parameter' }, 400);
    }
    if (type === 'tv' && (!season || !episode)) {
      return jsonResponse({ error: 'Season and episode required for TV shows' }, 400);
    }

    return extractAllServers(tmdbId, type, season, episode, logger, config, env, false, clientCapToken);
  }

  // Single server extract endpoint (kept for backwards compatibility)
  if (path === '/flixer/extract' || path === '/flixer') {
    const tmdbId = url.searchParams.get('tmdbId');
    const type = url.searchParams.get('type') || 'movie';
    const season = url.searchParams.get('season');
    const episode = url.searchParams.get('episode');
    const server = url.searchParams.get('server') || 'alpha';
    // Accept cap token from client (browser-solved PoW) via header or query param
    // Validate: Cap tokens are JWTs (~200-500 chars), reject oversized/malformed input
    const rawCapToken2 = request.headers.get('x-cap-token') || url.searchParams.get('capToken') || null;
    const clientCapToken = rawCapToken2 && rawCapToken2.length <= 2048 && /^[A-Za-z0-9._:\-]+$/.test(rawCapToken2) ? rawCapToken2 : null;

    if (!tmdbId) {
      return jsonResponse({ error: 'Missing tmdbId parameter' }, 400);
    }

    if (type === 'tv' && (!season || !episode)) {
      return jsonResponse({ error: 'Season and episode required for TV shows' }, 400);
    }

    try {
      // Initialize WASM if not cached (deduplicated across parallel requests)
      await ensureWasmInitialized(logger, config);

      // Prefer client-provided cap token (browser-solved PoW), fall back to KV cache
      let capToken: string | null = clientCapToken;
      if (!capToken && env.HEXA_CONFIG) {
        capToken = await getCachedCapToken(env.HEXA_CONFIG);
      }

      // Proper warm-up — decrypt response to register session with API
      const warmupPath = buildApiPath(config, type, tmdbId, season || undefined, episode || undefined);
      await getAvailableServers(cachedWasmLoader!, cachedApiKey!, warmupPath, logger, config, capToken);

      // Get source from server
      const result = await getSourceFromServer(
        cachedWasmLoader!,
        cachedApiKey!,
        type,
        tmdbId,
        server,
        config,
        season || undefined,
        episode || undefined,
        capToken,
      );

      if (!result.url) {
        consecutiveFailures++;
        
        // Force WASM re-init and retry once — API key may have expired
        if (consecutiveFailures <= 2) {
          logger.warn(`Single extract: no URL for ${server}, forcing WASM re-init and retrying`);
          cachedWasmLoader = null;
          cachedApiKey = null;
          wasmInitPromise = null;
          
          await ensureWasmInitialized(logger, config);
          const warmupPath2 = buildApiPath(config, type, tmdbId, season || undefined, episode || undefined);
          await getAvailableServers(cachedWasmLoader!, cachedApiKey!, warmupPath2, logger, config, capToken);
          
          const retryResult = await getSourceFromServer(
            cachedWasmLoader!, cachedApiKey!, type, tmdbId, server, config,
            season || undefined, episode || undefined, capToken,
          );
          
          if (retryResult.url) {
            const displayName = SERVER_NAMES[server] || server;
            consecutiveFailures = 0;
            lastSuccessTime = Date.now();
            return jsonResponse({
              success: true,
              sources: [{
                quality: 'auto',
                title: `Flixer ${displayName}`,
                url: retryResult.url,
                type: 'hls',
                referer: 'https://hexa.su/',
                requiresSegmentProxy: true,
                status: 'working',
                language: 'en',
                server,
              }],
              server,
              timestamp: new Date().toISOString(),
            }, 200);
          }
        }

        return jsonResponse({
          success: false,
          error: 'No stream URL found',
          server,
        }, 404);
      }

      const displayName = SERVER_NAMES[server] || server;
      consecutiveFailures = 0;
      lastSuccessTime = Date.now();

      return jsonResponse({
        success: true,
        sources: [{
          quality: 'auto',
          title: `Flixer ${displayName}`,
          url: result.url,
          type: 'hls',
          referer: 'https://hexa.su/',
          requiresSegmentProxy: true,
          status: 'working',
          language: 'en',
          server,
        }],
        server,
        timestamp: new Date().toISOString(),
      }, 200);

    } catch (error) {
      logger.error('Flixer extraction error', error as Error);
      
      // Reset cache on error
      cachedWasmLoader = null;
      cachedApiKey = null;
      wasmInitPromise = null;
      
      return jsonResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  }

  // =========================================================================
  // /flixer/stream-debug — Diagnostic endpoint for stream proxy strategies
  // =========================================================================
  if (path === '/flixer/stream-debug') {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return jsonResponse({ error: 'Missing url parameter' }, 400);

    const results: Record<string, any> = {
      targetUrl: targetUrl.substring(0, 120),
      hasRpiUrl: !!env.RPI_PROXY_URL,
      hasRpiKey: !!env.RPI_PROXY_KEY,
      rpiUrlPrefix: env.RPI_PROXY_URL ? env.RPI_PROXY_URL.substring(0, 40) + '...' : null,
    };

    // CRITICAL: Do NOT send Origin header to Flixer CDN - it returns 403.
    const cdnHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
      'Referer': 'https://hexa.su/',
    };

    // Test Strategy 1: Direct
    try {
      const t0 = Date.now();
      const directRes = await fetch(targetUrl, { headers: cdnHeaders, signal: AbortSignal.timeout(8000) });
      const body = await directRes.text();
      results.direct = { status: directRes.status, ms: Date.now() - t0, bodyLen: body.length, bodyPreview: body.substring(0, 100), contentType: directRes.headers.get('content-type') };
    } catch (e) { results.direct = { error: e instanceof Error ? e.message : String(e) }; }

    // Test Strategy 2: RPI rust-fetch
    if (env.RPI_PROXY_URL && env.RPI_PROXY_KEY) {
      try {
        let rpiBase = env.RPI_PROXY_URL.replace(/\/+$/, '');
        if (!rpiBase.startsWith('http')) rpiBase = `https://${rpiBase}`;
        const rustParams = new URLSearchParams({ url: targetUrl, headers: JSON.stringify(cdnHeaders), timeout: '30' });
        const rustUrl = `${rpiBase}/fetch-rust?${rustParams.toString()}`;
        const t0 = Date.now();
        const rustRes = await fetch(rustUrl, { headers: { 'X-API-Key': env.RPI_PROXY_KEY }, signal: AbortSignal.timeout(20000) });
        const body = await rustRes.text();
        results.rpiRust = { status: rustRes.status, ms: Date.now() - t0, bodyLen: body.length, bodyPreview: body.substring(0, 200), contentType: rustRes.headers.get('content-type') };
      } catch (e) { results.rpiRust = { error: e instanceof Error ? e.message : String(e) }; }

      // Test Strategy 3: RPI legacy
      try {
        let rpiBase = env.RPI_PROXY_URL.replace(/\/+$/, '');
        if (!rpiBase.startsWith('http')) rpiBase = `https://${rpiBase}`;
        const rpiParams = new URLSearchParams({ url: targetUrl, key: env.RPI_PROXY_KEY, referer: 'https://hexa.su/', origin: 'https://hexa.su' });
        const rpiUrl = `${rpiBase}/flixer/stream?${rpiParams.toString()}`;
        const t0 = Date.now();
        const rpiRes = await fetch(rpiUrl, { signal: AbortSignal.timeout(15000) });
        const body = await rpiRes.text();
        results.rpiLegacy = { status: rpiRes.status, ms: Date.now() - t0, bodyLen: body.length, bodyPreview: body.substring(0, 200), contentType: rpiRes.headers.get('content-type') };
      } catch (e) { results.rpiLegacy = { error: e instanceof Error ? e.message : String(e) }; }
    } else {
      results.rpiRust = { skipped: 'RPI_PROXY_URL or RPI_PROXY_KEY not set' };
      results.rpiLegacy = { skipped: 'RPI_PROXY_URL or RPI_PROXY_KEY not set' };
    }

    return jsonResponse(results, 200);
  }

  // =========================================================================
  // /flixer/stream — Proxy Flixer CDN m3u8 playlists and segments
  // This is the DEDICATED route for Flixer playback. Do NOT use /animekai.
  // Flixer CDN (p.XXXXX.workers.dev) blocks CF Worker IPs, so we route
  // through RPI /fetch-rust which has Chrome-like TLS fingerprinting.
  // The CF Worker stays the transparent proxy (edge-close to user).
  // =========================================================================
  if (path === '/flixer/stream') {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return jsonResponse({ error: 'Missing url parameter' }, 400);
    }

    // searchParams.get() already decodes the URL — do NOT double-decode
    const decodedUrl = targetUrl;

    // CRITICAL: Do NOT send Origin header! Flixer CDN blocks ALL requests
    // with an Origin header (returns 403). This is the CDN's anti-hotlinking.
    // The CF Worker strips Origin, fetches from CDN (no Origin header = 200),
    // and adds ACAO: * on the response back to the browser.
    const cdnHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
      'Referer': 'https://flixer.su/',
    };

    const errors: string[] = [];

    // Strategy 1: Direct fetch (cross-account workers.dev works from CF Workers)
    try {
      const directRes = await fetch(decodedUrl, { headers: cdnHeaders, signal: AbortSignal.timeout(10000) });
      if (directRes.ok) {
        return handleFlixerStreamResponse(directRes, decodedUrl, url.origin, 'direct', logger);
      }
      const body = await directRes.text().catch(() => '(unreadable)');
      errors.push(`direct: HTTP ${directRes.status} — ${body.substring(0, 200)}`);
      logger.warn('Flixer stream: direct fetch failed', { status: directRes.status, body: body.substring(0, 200) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`direct: ${msg}`);
      logger.error('Flixer stream: direct fetch error', { error: msg });
    }

    // Strategy 2: RPI proxy fallback (for datacenter IP blocking edge cases)
    if (env.RPI_PROXY_URL && env.RPI_PROXY_KEY) {
      try {
        let rpiBase = env.RPI_PROXY_URL.replace(/\/+$/, '');
        if (!rpiBase.startsWith('http')) rpiBase = `https://${rpiBase}`;

        const rpiParams = new URLSearchParams({
          url: decodedUrl,
          key: env.RPI_PROXY_KEY,
          referer: 'https://flixer.su/',
          origin: 'https://flixer.su',
        });
        const rpiUrl = `${rpiBase}/flixer/stream?${rpiParams.toString()}`;

        const rpiRes = await fetch(rpiUrl, { signal: AbortSignal.timeout(15000) });
        if (rpiRes.ok) {
          return handleFlixerStreamResponse(rpiRes, decodedUrl, url.origin, 'rpi-legacy', logger);
        }
        const rpiBody = await rpiRes.text().catch(() => '(unreadable)');
        errors.push(`rpi: HTTP ${rpiRes.status} — ${rpiBody.substring(0, 200)}`);
        logger.warn('Flixer stream: RPI legacy failed', { status: rpiRes.status, body: rpiBody.substring(0, 200) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`rpi: ${msg}`);
        logger.error('Flixer stream: RPI legacy error', { error: msg });
      }
    } else {
      errors.push('rpi: not configured (no RPI_PROXY_URL/RPI_PROXY_KEY)');
    }

    // Also probe the CDN with a root request to verify general connectivity
    let cdnReachable = 'unknown';
    try {
      const cdnHost = new URL(decodedUrl).hostname;
      const probeRes = await fetch(`https://${cdnHost}/`, { headers: cdnHeaders, signal: AbortSignal.timeout(5000) });
      cdnReachable = `HTTP ${probeRes.status}`;
    } catch (e) {
      cdnReachable = `unreachable: ${e instanceof Error ? e.message : String(e)}`;
    }

    return jsonResponse({
      error: 'All proxy strategies failed for Flixer CDN',
      cdnHost: new URL(decodedUrl).hostname,
      cdnReachable,
      errors,
    }, 502);
  }

  // Debug endpoint: test CDN headers to find what triggers 403
  if (path === '/flixer/debug-cdn') {
    const testUrl = url.searchParams.get('url');
    if (!testUrl) return jsonResponse({ error: 'Missing url param' }, 400);

    const cdnHost = new URL(testUrl).hostname;
    const baseHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'Accept': '*/*',
    };

    const results: Record<string, string> = {};

    // Test 1: No headers at all
    try {
      const r = await fetch(testUrl, { signal: AbortSignal.timeout(8000) });
      results['no-headers'] = `HTTP ${r.status}`;
    } catch (e) { results['no-headers'] = `error: ${e instanceof Error ? e.message : String(e)}`; }

    // Test 2: Just Referer
    try {
      const r = await fetch(testUrl, { headers: { ...baseHeaders, 'Referer': 'https://flixer.su/' }, signal: AbortSignal.timeout(8000) });
      results['+referer'] = `HTTP ${r.status}`;
    } catch (e) { results['+referer'] = `error: ${e instanceof Error ? e.message : String(e)}`; }

    // Test 3: Just Origin
    try {
      const r = await fetch(testUrl, { headers: { ...baseHeaders, 'Origin': 'https://flixer.su' }, signal: AbortSignal.timeout(8000) });
      results['+origin'] = `HTTP ${r.status}`;
    } catch (e) { results['+origin'] = `error: ${e instanceof Error ? e.message : String(e)}`; }

    // Test 4: Referer but no Origin (current code)
    try {
      const r = await fetch(testUrl, { headers: { ...baseHeaders, 'Referer': 'https://flixer.su/' }, signal: AbortSignal.timeout(8000) });
      results['+referer-no-origin'] = `HTTP ${r.status}`;
    } catch (e) { results['+referer-no-origin'] = `error: ${e instanceof Error ? e.message : String(e)}`; }

    // Test 5: No Referer, no Origin (bare minimum)
    try {
      const r = await fetch(testUrl, { headers: baseHeaders, signal: AbortSignal.timeout(8000) });
      results['bare-minimum'] = `HTTP ${r.status}`;
    } catch (e) { results['bare-minimum'] = `error: ${e instanceof Error ? e.message : String(e)}`; }

    // Test 6: Accept-Encoding: identity (current code)
    try {
      const r = await fetch(testUrl, { headers: { ...baseHeaders, 'Referer': 'https://flixer.su/', 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(8000) });
      results['+accept-encoding-identity'] = `HTTP ${r.status}`;
    } catch (e) { results['+accept-encoding-identity'] = `error: ${e instanceof Error ? e.message : String(e)}`; }

    // Test 7: CDN root with no headers
    try {
      const r = await fetch(`https://${cdnHost}/`, { headers: baseHeaders, signal: AbortSignal.timeout(5000) });
      results['cdn-root'] = `HTTP ${r.status}`;
    } catch (e) { results['cdn-root'] = `error: ${e instanceof Error ? e.message : String(e)}`; }

    return jsonResponse({ cdnHost, testUrl, results }, 200);
  }

  return jsonResponse({ error: 'Unknown endpoint' }, 404);
}

/**
 * Handle a successful Flixer CDN response — rewrite m3u8 playlists, pass through segments.
 */
function handleFlixerStreamResponse(
  response: Response,
  originalUrl: string,
  proxyOrigin: string,
  via: string,
  logger: ReturnType<typeof createLogger>,
): Response | Promise<Response> {
  const contentType = response.headers.get('content-type') || '';
  const isPlaylist = contentType.includes('mpegurl') || originalUrl.includes('.m3u8');

  if (isPlaylist) {
    return response.text().then(text => {
      const rewritten = rewriteFlixerPlaylist(text, originalUrl, proxyOrigin);
      return new Response(rewritten, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'public, max-age=5',
          'X-Proxied-Via': via,
          ...corsHeaders(),
        },
      });
    });
  }

  // ALWAYS read as binary first — Flixer CDN uses fake content-types
  // (text/html for keys, text/css for encrypted segments) as anti-scraping.
  // Reading as .text() corrupts binary data via UTF-8 decoding.
  return response.arrayBuffer().then(body => {
    const bytes = new Uint8Array(body);

    // Check if it's actually an m3u8 with wrong content-type
    // #EXTM3U = 23 45 58 54 4D 33 55 38
    if (bytes.length > 7 && bytes[0] === 0x23 && bytes[1] === 0x45 &&
        bytes[2] === 0x58 && bytes[3] === 0x54 && bytes[4] === 0x4D &&
        bytes[5] === 0x33 && bytes[6] === 0x55) {
      const text = new TextDecoder().decode(bytes);
      logger.info('Flixer stream: detected m3u8 with wrong content-type', { contentType });
      const rewritten = rewriteFlixerPlaylist(text, originalUrl, proxyOrigin);
      return new Response(rewritten, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'public, max-age=5',
          'X-Proxied-Via': via,
          ...corsHeaders(),
        },
      });
    }

    // Binary data — segment, key, init segment, etc.
    // Detect actual content type from magic bytes
    const isMpegTs = bytes[0] === 0x47;
    const isFmp4 = bytes.length > 3 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x00;
    let actualContentType: string;
    if (isMpegTs) actualContentType = 'video/mp2t';
    else if (isFmp4) actualContentType = 'video/mp4';
    else actualContentType = 'application/octet-stream';

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': actualContentType,
        'Content-Length': body.byteLength.toString(),
        'Cache-Control': 'public, max-age=3600',
        'X-Proxied-Via': via,
        ...corsHeaders(),
      },
    });
  });
}

/**
 * Rewrite m3u8 playlist URLs to route through /flixer/stream
 */
function rewriteFlixerPlaylist(playlist: string, baseUrl: string, proxyOrigin: string): string {
  const lines = playlist.split('\n');
  const rewritten: string[] = [];
  const base = new URL(baseUrl);
  const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);

  const proxyUrl = (u: string): string => {
    let abs: string;
    if (u.startsWith('http://') || u.startsWith('https://')) abs = u;
    else if (u.startsWith('/')) abs = `${base.origin}${u}`;
    else abs = `${base.origin}${basePath}${u}`;
    return `${proxyOrigin}/flixer/stream?url=${encodeURIComponent(abs)}`;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || (trimmed.startsWith('#') && !trimmed.includes('URI="'))) {
      // Comment/tag without URI, or blank line — pass through
      rewritten.push(line);
    } else if (trimmed.includes('URI="')) {
      // Any tag with URI= attribute: EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA,
      // EXT-X-I-FRAME-STREAM-INF, etc. — rewrite ALL of them through proxy
      rewritten.push(line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxyUrl(uri)}"`));
    } else if (!trimmed.startsWith('#')) {
      // Non-comment line = segment or playlist URL
      try { rewritten.push(proxyUrl(trimmed)); }
      catch { rewritten.push(line); }
    } else {
      rewritten.push(line);
    }
  }
  return rewritten.join('\n');
}

export default {
  fetch: handleFlixerRequest,
};
