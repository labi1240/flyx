/**
 * VidLink Client-Side Extractor (Worker + Browser compatible)
 *
 * June 2026: Extracts VidLink streams using in-browser WASM token generation.
 * Works on both Cloudflare Workers and browsers — no Node.js APIs needed.
 *
 * Flow:
 * 1. Fetch mercury data from vidlink.pro/api/mercury
 * 2. Load Go WASM runtime + fu.wasm → getAdv(tmdbId) → signed token
 * 3. Call vidlink.pro/api/b/{type}/{token} → plain JSON with HLS playlist
 * 4. Return stream URLs
 *
 * Key difference from vidlink-extractor.ts: uses fetch() for WASM binary,
 * embeds the Go runtime bridge directly, and uses dynamic import for libsodium.
 */

export interface VidLinkStream {
  quality: string;
  title: string;
  url: string;
  type: 'hls';
  referer: string;
  requiresSegmentProxy: boolean;
  status: 'working' | 'down' | 'unknown';
  language: string;
}

const VIDLINK_BASE = 'https://vidlink.pro';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// ── Go WASM Runtime Bridge (embedded from vidlink-script.js) ──
// This is a self-contained WASM runtime that works without Node.js fs/path.
// The Go WASM binary (fu.wasm) uses this bridge for syscalls.
let wasmBridge: any = null;

async function loadWasmBridge(): Promise<any> {
  if (wasmBridge) return wasmBridge;
  wasmBridge = buildGoRuntime();
  return wasmBridge;
}

/**
 * Build a minimal Go WASM runtime (same pattern as vidlink-script.js).
 * The Go WASM binary (fu.wasm) uses this for I/O.
 */
function buildGoRuntime(): any {
  // Reuse global fs stubs from vidlink-script.js pattern
  const outputBuf: string[] = [];
  const decoder = new TextDecoder();

  const fsStubs = {
    constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 },
    writeSync(_fd: number, buf: Uint8Array) { outputBuf.push(decoder.decode(buf)); return buf.length; },
    write(_fd: number, buf: Uint8Array, _offset: number, length: number, _position: any, callback: Function) {
      outputBuf.push(decoder.decode(buf.subarray(0, length)));
      callback(null, length);
    },
    chmod(_p: string, _m: number, cb: Function) { cb(null); },
    chown(_p: string, _u: number, _g: number, cb: Function) { cb(null); },
    close(_fd: number, cb: Function) { cb(null); },
    fchmod(_fd: number, _m: number, cb: Function) { cb(null); },
    fchown(_fd: number, _u: number, _g: number, cb: Function) { cb(null); },
    fstat(_fd: number, cb: Function) { cb(null); },
    fsync(_fd: number, cb: Function) { cb(null); },
    ftruncate(_fd: number, _l: number, cb: Function) { cb(null); },
    lstat(_p: string, cb: Function) { cb(null); },
    mkdir(_p: string, _m: number, cb: Function) { cb(null); },
    open(_p: string, _f: number, _m: number, cb: Function) { cb(null); },
    read(_fd: number, _buf: Uint8Array, _o: number, _l: number, _p: any, cb: Function) { cb(null); },
    readdir(_p: string, cb: Function) { cb(null); },
    rename(_o: string, _n: string, cb: Function) { cb(null); },
    rmdir(_p: string, cb: Function) { cb(null); },
    stat(_p: string, cb: Function) { cb(null); },
    unlink(_p: string, cb: Function) { cb(null); },
    utimes(_p: string, _a: number, _m: number, cb: Function) { cb(null); },
  };

  return class GoRuntime {
    _inst: any;
    _values: any[];
    _refs: Map<any, number>;
    _ids: Map<number, any>;
    importObject: any;
    exited: boolean;

    constructor() {
      this._inst = null;
      this._values = [NaN, 0, null, true, false, globalThis, Object.create(null)];
      this._refs = new Map();
      this._ids = new Map();
      this.exited = false;
      this.importObject = {
        gojs: {
          'runtime.wasmExit': (_code: number) => { this.exited = true; },
          'runtime.wasmWrite': (fd: number, p: number, n: number) => {
            if (fd === 1 || fd === 2) {
              const mem = this._inst.exports.mem as WebAssembly.Memory;
              const buf = new Uint8Array(mem.buffer, p, n);
              fsStubs.writeSync(fd, buf);
            }
          },
          'runtime.resetMemoryDataView': () => {},
          'runtime.nanotime1': () => BigInt(Date.now() * 1_000_000),
          'runtime.walltime': () => {
            const now = new Date();
            return [now.getSeconds(), now.getMilliseconds() * 1_000_000];
          },
          'runtime.scheduleTimeoutEvent': () => {},
          'runtime.clearTimeoutEvent': () => {},
          'runtime.getRandomData': (p: number, n: number) => {
            const mem = this._inst.exports.mem as WebAssembly.Memory;
            crypto.getRandomValues(new Uint8Array(mem.buffer, p, n));
          },
          'syscall/js.finalizeRef': () => {},
          'syscall/js.stringVal': (p: number) => {
            const mem = this._inst.exports.mem as WebAssembly.Memory;
            const buf = new Uint8Array(mem.buffer);
            let len = 0;
            while (buf[p + len] !== 0) len++;
            return decoder.decode(buf.subarray(p, p + len));
          },
          'syscall/js.valueGet': (ref: number, p: number) => {
            const v = this._values[ref];
            const mem = this._inst.exports.mem as WebAssembly.Memory;
            const view = new DataView(mem.buffer);
            if (typeof v === 'number') { view.setFloat64(p, v, true); return 2; }
            if (typeof v === 'string') { view.setFloat64(p, v.length, true); return 3; }
            if (v === null || v === undefined) { view.setFloat64(p, 0, true); return 4; }
            if (typeof v === 'boolean') { view.setFloat64(p, v ? 1 : 0, true); return 1; }
            if (typeof v === 'function') {
              this._values.push(v);
              view.setFloat64(p, this._values.length - 1, true);
              return 5;
            }
            this._values.push(v);
            view.setFloat64(p, this._values.length - 1, true);
            return 6;
          },
          'syscall/js.valueNew': (ref: number) => {
            if (ref === this._values.length) {
              this._values.push(Object.create(null));
              return this._values.length - 1;
            }
            this._values[ref] = Object.create(null);
            return ref;
          },
          'syscall/js.valueLength': (ref: number) => {
            const v = this._values[ref];
            if (typeof v === 'string') return v.length;
            if (Array.isArray(v)) return v.length;
            if (v instanceof ArrayBuffer) return v.byteLength;
            return 0;
          },
          'syscall/js.valueIndex': (ref: number, idx: number) => {
            const v = this._values[ref];
            if (typeof v === 'string') {
              this._values.push(v.charCodeAt(idx));
              return this._values.length - 1;
            }
            if (Array.isArray(v) || v instanceof Uint8Array) {
              this._values.push(v[idx]);
              return this._values.length - 1;
            }
            return 0;
          },
          'syscall/js.valueSetIndex': () => {},
          'syscall/js.valueSet': (ref: number, p: number, val: number) => {
            const obj = this._values[ref];
            const mem = this._inst.exports.mem as WebAssembly.Memory;
            const key = decoder.decode(new Uint8Array(mem.buffer, p, 100)).split('\0')[0];
            obj[key] = this._values[val];
          },
          'syscall/js.valueCall': (ref: number, _methodPtr: number, argsPtr: number, argc: number) => {
            const fn = this._values[ref];
            if (typeof fn !== 'function') return 0;
            const args: any[] = [];
            const mem = this._inst.exports.mem as WebAssembly.Memory;
            const view = new DataView(mem.buffer);
            for (let i = 0; i < argc; i++) {
              const argRef = view.getFloat64(argsPtr + i * 8, true);
              args.push(this._values[argRef]);
            }
            try {
              const result = fn(...args);
              if (result !== undefined) {
                this._values.push(result);
                return this._values.length - 1;
              }
            } catch (e) {}
            return 0;
          },
          'syscall/js.valueInvoke': () => 0,
          'syscall/js.valueNewArray': () => {
            this._values.push([]);
            return this._values.length - 1;
          },
          'syscall/js.valuePrepareString': (ref: number) => {
            const v = this._values[ref];
            return typeof v === 'string' ? v.length : 0;
          },
          'syscall/js.valueLoadString': (ref: number, p: number) => {
            const v = String(this._values[ref] || '');
            const mem = this._inst.exports.mem as WebAssembly.Memory;
            const buf = new Uint8Array(mem.buffer, p);
            for (let i = 0; i < v.length; i++) buf[i] = v.charCodeAt(i);
          },
          'syscall/js.valueDelete': () => {},
          'syscall/js.valueInstanceOf': () => 0,
          'syscall/fs.write': (_fd: number, _p: number, _n: number, cb: Function) => { cb(null); },
          'syscall/fs.read': (_fd: number, _p: number, _n: number, cb: Function) => { cb(null, 0); },
          'syscall/fs.close': (_fd: number, cb: Function) => { cb(null); },
          'syscall/fs.fsync': (_fd: number, cb: Function) => { cb(null); },
          'syscall/fs.open': (_p: number, _f: number, _m: number, cb: Function) => { cb(null, -1); },
          'syscall/fs.stat': (_p: number, cb: Function) => { cb(null); },
          'syscall/fs.lstat': (_p: number, cb: Function) => { cb(null); },
          'syscall/fs.fstat': (_fd: number, cb: Function) => { cb(null); },
          'syscall/fs.mkdir': (_p: number, _m: number, cb: Function) => { cb(null); },
          'syscall/fs.rmdir': (_p: number, cb: Function) => { cb(null); },
          'syscall/fs.rename': (_o: number, _n: number, cb: Function) => { cb(null); },
          'syscall/fs.unlink': (_p: number, cb: Function) => { cb(null); },
          'syscall/fs.readdir': (_p: number, cb: Function) => { cb(null, 0); },
          'syscall/fs.chmod': (_p: number, _m: number, cb: Function) => { cb(null); },
          'syscall/fs.chown': (_p: number, _u: number, _g: number, cb: Function) => { cb(null); },
          'syscall/fs.utimes': (_p: number, _a: number, _m: number, cb: Function) => { cb(null); },
          'syscall/fs.fchmod': (_fd: number, _m: number, cb: Function) => { cb(null); },
          'syscall/fs.fchown': (_fd: number, _u: number, _g: number, cb: Function) => { cb(null); },
          'syscall/fs.ftruncate': (_fd: number, _l: number, cb: Function) => { cb(null); },
        },
      };
    }

    async run(instance: WebAssembly.Instance): Promise<void> {
      this._inst = instance;
      // Go WASM main — runs in background
      try {
        const run = instance.exports.run as (argc: number, argv: number) => void;
        const mem = instance.exports.mem as WebAssembly.Memory;
        // Set up environment
        run(0, 0);
      } catch (e) {
        // Go program exits by calling runtime.wasmExit
      }
    }
  };
}

// ── WASM Token Generator ──────────────────────────────────────────

let getAdvFn: ((tmdbId: string) => string | null) | null = null;
let wasmReady = false;
let wasmInit: Promise<boolean> | null = null;

async function initTokenGenerator(): Promise<boolean> {
  if (wasmReady && getAdvFn) return true;
  if (wasmInit) return wasmInit;

  wasmInit = (async () => {
    try {
      console.log('[VidLink] Initializing WASM token generator...');

      // Step 1: Fetch mercury data and extract the global variable
      console.log('[VidLink] Fetching mercury...');
      const mercuryResp = await fetch(`${VIDLINK_BASE}/api/mercury?tmdbId=0&type=movie`, {
        headers: { 'User-Agent': UA, 'Referer': VIDLINK_BASE + '/', 'Origin': VIDLINK_BASE },
        signal: AbortSignal.timeout(15000),
      });

      if (!mercuryResp.ok) {
        console.error(`[VidLink] Mercury HTTP ${mercuryResp.status}`);
        return false;
      }

      const mercuryText = await mercuryResp.text();
      const varMatch = mercuryText.match(/window\['([^']+)'\]\s*=\s*'([^']+)'/);
      if (!varMatch) {
        console.error('[VidLink] No mercury variable found');
        return false;
      }

      const varName = varMatch[1];
      const varValue = varMatch[2];
      (globalThis as any)[varName] = varValue;
      console.log(`[VidLink] Mercury: ${varName}=${varValue.length} chars`);

      // Step 2: Fetch the Go WASM binary
      console.log('[VidLink] Fetching fu.wasm...');
      const wasmResp = await fetch(`${VIDLINK_BASE}/fu.wasm`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(30000),
      });

      if (!wasmResp.ok) {
        console.error(`[VidLink] fu.wasm HTTP ${wasmResp.status}`);
        return false;
      }

      const wasmBuffer = await wasmResp.arrayBuffer();

      // Step 3: Load the Go runtime and instantiate
      const GoRuntime = await loadWasmBridge();
      const go = new GoRuntime();

      // Set up sodium before running WASM (libsodium used by the Go code)
      // The Go WASM uses sodium via a JavaScript bridge
      try {
        const sodiumModule = await import('libsodium-wrappers');
        await sodiumModule.default.ready;
        (globalThis as any).sodium = sodiumModule.default;
      } catch (e) {
        // libsodium-wrappers might not be available — try alternative
        console.warn('[VidLink] libsodium-wrappers not available, trying fallback...');
        (globalThis as any).sodium = {
          ready: Promise.resolve(),
          crypto_secretbox_easy: (m: Uint8Array, n: Uint8Array, k: Uint8Array) => m,
          crypto_secretbox_open_easy: (c: Uint8Array, n: Uint8Array, k: Uint8Array) => c,
          crypto_sign_detached: (m: Uint8Array, sk: Uint8Array) => new Uint8Array(64),
          crypto_sign_verify_detached: () => false,
        };
      }

      const wasmModule = await WebAssembly.compile(wasmBuffer);
      const instance = await WebAssembly.instantiate(wasmModule, go.importObject);

      // Run Go program (registers getAdv)
      go.run(instance).catch(() => {});

      // Wait for getAdv to register
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 10000;
        const check = () => {
          if (typeof (globalThis as any).getAdv === 'function') {
            resolve();
          } else if (Date.now() < deadline) {
            setTimeout(check, 200);
          } else {
            console.error('[VidLink] getAdv not registered after 10s');
            resolve(); // Resolve anyway — caller checks getAdvFn
          }
        };
        check();
      });

      if (typeof (globalThis as any).getAdv === 'function') {
        getAdvFn = (globalThis as any).getAdv;
        wasmReady = true;
        console.log('[VidLink] WASM token generator ready');
        return true;
      }

      console.error('[VidLink] getAdv not found');
      return false;
    } catch (e) {
      console.error('[VidLink] WASM init error:', e instanceof Error ? e.message : e);
      return false;
    }
  })();

  return wasmInit;
}

function generateToken(tmdbId: string): string | null {
  if (!getAdvFn) return null;
  try {
    const token = getAdvFn(tmdbId);
    if (typeof token !== 'string' || token.length < 10) return null;
    return token;
  } catch (e) {
    console.error('[VidLink] Token error:', e);
    return null;
  }
}

// ── API Fetching ─────────────────────────────────────────────────

async function fetchVidLinkAPI(
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number,
): Promise<any> {
  const token = generateToken(tmdbId);
  if (!token) throw new Error('Token generation failed');

  const encodedToken = encodeURIComponent(token);
  const url = type === 'movie'
    ? `${VIDLINK_BASE}/api/b/movie/${encodedToken}?multiLang=1`
    : `${VIDLINK_BASE}/api/b/tv/${encodedToken}/${season || 1}/${episode || 1}?multiLang=1`;

  console.log('[VidLink] Fetching:', url.substring(0, 100));

  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json',
      'Referer': VIDLINK_BASE + '/',
      'Origin': VIDLINK_BASE,
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) throw new Error(`VidLink API HTTP ${resp.status}`);
  return resp.json();
}

// ── Public API ────────────────────────────────────────────────────

export async function extractVidLinkClient(
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number,
): Promise<VidLinkStream[]> {
  console.log(`[VidLink] Extracting ${type} ${tmdbId}...`);

  // Init WASM if needed
  const ready = await initTokenGenerator();
  if (!ready) {
    console.error('[VidLink] WASM init failed');
    return [];
  }

  try {
    const data = await fetchVidLinkAPI(tmdbId, type, season, episode);

    const sources: VidLinkStream[] = [];

    if (data.stream?.playlist) {
      let referer = 'https://vidlink.pro/';
      try {
        const playlistUrl = new URL(data.stream.playlist);
        const headersParam = playlistUrl.searchParams.get('headers');
        if (headersParam) {
          const parsedHeaders = JSON.parse(headersParam);
          if (parsedHeaders.referer) referer = parsedHeaders.referer;
        }
      } catch {}

      sources.push({
        quality: 'auto',
        title: 'VidLink',
        url: data.stream.playlist,
        type: 'hls',
        referer,
        requiresSegmentProxy: false, // Will test if direct access works
        status: 'working',
        language: 'en',
      });
    }

    // Legacy format
    if (data.sources) {
      for (const src of data.sources) {
        const streamUrl = src.url || src.file;
        if (!streamUrl) continue;
        sources.push({
          quality: src.quality || src.label || 'auto',
          title: src.label || 'VidLink',
          url: streamUrl,
          type: 'hls',
          referer: 'https://vidlink.pro/',
          requiresSegmentProxy: false,
          status: 'working',
          language: 'en',
        });
      }
    }

    console.log(`[VidLink] ${sources.length} sources found`);
    return sources;
  } catch (e) {
    console.error('[VidLink] Extraction error:', e instanceof Error ? e.message : e);
    return [];
  }
}
