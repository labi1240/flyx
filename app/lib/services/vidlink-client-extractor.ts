/**
 * VidLink Client-Side Extractor (browser-only)
 *
 * Replaces Videasy — uses vidlink.pro's API with WASM token generation.
 * Runs entirely in the browser. Does NOT use Node.js APIs (no fs/path/require).
 *
 * Flow:
 * 1. Fetch mercury data → extract global variable
 * 2. Load Go WASM (fu.wasm) + libsodium → getAdv(tmdbId) → signed token
 * 3. Call vidlink.pro/api/b/{type}/{token} → JSON → HLS playlist URL
 */

// Dynamic import of libsodium at runtime
let sodiumModule: any = null;

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

const BASE = 'https://vidlink.pro';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// ── Token Generator State ────────────────────────────────────────

let getAdvFn: ((tmdbId: string) => string | null) | null = null;
let wasmPromise: Promise<boolean> | null = null;

async function initWasm(): Promise<boolean> {
  if (getAdvFn) return true;
  if (wasmPromise) return wasmPromise;

  wasmPromise = (async (): Promise<boolean> => {
    try {
      // 1. Mercury data
      const mr = await fetch(`${BASE}/api/mercury?tmdbId=0&type=movie`, {
        headers: { 'User-Agent': UA, 'Referer': `${BASE}/`, 'Origin': BASE },
        signal: AbortSignal.timeout(15000),
      });
      if (!mr.ok) { console.error(`[VidLink] Mercury HTTP ${mr.status}`); return false; }
      const mt = await mr.text();
      const vm = mt.match(/window\['([^']+)'\]\s*=\s*'([^']+)'/);
      if (!vm) { console.error('[VidLink] No mercury var'); return false; }
      (window as any)[vm[1]] = vm[2];

      // 2. libsodium
      try {
        sodiumModule = await import('libsodium-wrappers');
        await sodiumModule.default.ready;
        (window as any).sodium = sodiumModule.default;
      } catch {
        console.warn('[VidLink] No libsodium — using stub');
        (window as any).sodium = {
          ready: Promise.resolve(),
          crypto_secretbox_easy: (m: Uint8Array, _n: Uint8Array, _k: Uint8Array) => m,
          crypto_secretbox_open_easy: (c: Uint8Array, _n: Uint8Array, _k: Uint8Array) => c,
        };
        await (window as any).sodium.ready;
      }

      // 3. Go WASM runtime
      const go = new GoRuntime();
      const wr = await fetch(`${BASE}/fu.wasm`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!wr.ok) { console.error(`[VidLink] fu.wasm HTTP ${wr.status}`); return false; }
      const wb = await wr.arrayBuffer();
      const wm = await WebAssembly.compile(wb);
      const wi = await WebAssembly.instantiate(wm, go.importObject);
      go.run(wi).catch(() => {});

      // 4. Wait for getAdv
      await new Promise<void>(r => {
        const d = Date.now() + 15000;
        const c = () => {
          if (typeof (window as any).getAdv === 'function') { r(); return; }
          if (Date.now() < d) setTimeout(c, 200); else { console.error('[VidLink] getAdv timeout'); r(); }
        };
        c();
      });

      if (typeof (window as any).getAdv === 'function') {
        getAdvFn = (window as any).getAdv;
        console.log('[VidLink] WASM ready');
        return true;
      }
      return false;
    } catch (e) {
      console.error('[VidLink] WASM init:', e instanceof Error ? e.message : e);
      return false;
    }
  })();

  return wasmPromise;
}

function token(tmdbId: string): string | null {
  if (!getAdvFn) return null;
  try { const t = getAdvFn(tmdbId); return typeof t === 'string' && t.length > 10 ? t : null; }
  catch { return null; }
}

// ── Go WASM Runtime Bridge ───────────────────────────────────────

function buildGoImportObject(inst: any): any {
  return {
    gojs: {
      'runtime.wasmExit': () => { inst.exited = true; },
      'runtime.wasmWrite': (_fd: number, _p: number, _n: number) => {
        /* stdout/stderr — ignore */
      },
      'runtime.resetMemoryDataView': () => {},
      'runtime.nanotime1': () => BigInt(Date.now() * 1_000_000),
      'runtime.walltime': () => 0,
      'runtime.scheduleTimeoutEvent': () => {},
      'runtime.clearTimeoutEvent': () => {},
      'runtime.getRandomData': (p: number, n: number) => {
        crypto.getRandomValues(new Uint8Array(inst.exports.mem.buffer, p, n));
      },
      'syscall/js.finalizeRef': () => {},
      'syscall/js.stringVal': () => '',
      'syscall/js.valueGet': () => 0,
      'syscall/js.valueNew': () => 0,
      'syscall/js.valueLength': () => 0,
      'syscall/js.valueIndex': () => 0,
      'syscall/js.valueSetIndex': () => {},
      'syscall/js.valueSet': () => {},
      'syscall/js.valueCall': () => 0,
      'syscall/js.valueInvoke': () => 0,
      'syscall/js.valueNewArray': () => 0,
      'syscall/js.valuePrepareString': () => 0,
      'syscall/js.valueLoadString': () => {},
      'syscall/js.valueDelete': () => {},
      'syscall/js.valueInstanceOf': () => 0,
      'syscall/fs.write': (_fd: number, _p: number, _n: number, cb: Function) => cb(null),
      'syscall/fs.read': (_fd: number, _p: number, _n: number, cb: Function) => cb(null, 0),
      'syscall/fs.close': (_fd: number, cb: Function) => cb(null),
      'syscall/fs.fsync': (_fd: number, cb: Function) => cb(null),
      'syscall/fs.open': (_p: number, _f: number, _m: number, cb: Function) => cb(null, -1),
      'syscall/fs.stat': (_p: number, cb: Function) => cb(null),
      'syscall/fs.lstat': (_p: number, cb: Function) => cb(null),
      'syscall/fs.fstat': (_fd: number, cb: Function) => cb(null),
      'syscall/fs.mkdir': (_p: number, _m: number, cb: Function) => cb(null),
      'syscall/fs.rmdir': (_p: number, cb: Function) => cb(null),
      'syscall/fs.rename': (_o: number, _n: number, cb: Function) => cb(null),
      'syscall/fs.unlink': (_p: number, cb: Function) => cb(null),
      'syscall/fs.readdir': (_p: number, cb: Function) => cb(null, 0),
      'syscall/fs.chmod': (_p: number, _m: number, cb: Function) => cb(null),
      'syscall/fs.chown': (_p: number, _u: number, _g: number, cb: Function) => cb(null),
      'syscall/fs.utimes': (_p: number, _a: number, _m: number, cb: Function) => cb(null),
      'syscall/fs.fchmod': (_fd: number, _m: number, cb: Function) => cb(null),
      'syscall/fs.fchown': (_fd: number, _u: number, _g: number, cb: Function) => cb(null),
      'syscall/fs.ftruncate': (_fd: number, _l: number, cb: Function) => cb(null),
    },
  };
}

class GoRuntime {
  inst: any = null;
  exited = false;
  importObject: any;

  constructor() {
    this.importObject = buildGoImportObject(this);
  }

  async run(instance: WebAssembly.Instance): Promise<void> {
    this.inst = instance;
    try {
      const fn = instance.exports.run as (a: number, b: number) => void;
      fn(0, 0);
    } catch { /* exits via wasmExit */ }
  }
}

// ── API ──────────────────────────────────────────────────────────

async function fetchAPI(tmdbId: string, type: 'movie' | 'tv', season?: number, episode?: number): Promise<any> {
  const tk = token(tmdbId);
  if (!tk) throw new Error('Token gen failed');
  const etk = encodeURIComponent(tk);
  const u = type === 'movie'
    ? `${BASE}/api/b/movie/${etk}?multiLang=1`
    : `${BASE}/api/b/tv/${etk}/${season || 1}/${episode || 1}?multiLang=1`;
  const r = await fetch(u, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': `${BASE}/`, 'Origin': BASE },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`VidLink API HTTP ${r.status}`);
  return r.json();
}

export async function extractVidLinkClient(
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number,
): Promise<VidLinkStream[]> {
  console.log(`[VidLink] Extracting ${type} ${tmdbId}...`);
  if (!await initWasm()) { console.error('[VidLink] WASM init failed'); return []; }

  try {
    const data = await fetchAPI(tmdbId, type, season, episode);
    const sources: VidLinkStream[] = [];
    if (data.stream?.playlist) {
      let ref = 'https://vidlink.pro/';
      try {
        const pu = new URL(data.stream.playlist);
        const hp = pu.searchParams.get('headers');
        if (hp) { const ph = JSON.parse(hp); if (ph.referer) ref = ph.referer; }
      } catch {}
      sources.push({
        quality: 'auto', title: 'VidLink', url: data.stream.playlist,
        type: 'hls', referer: ref, requiresSegmentProxy: false,
        status: 'working', language: 'en',
      });
    }
    (data.sources || []).forEach((s: any) => {
      const su = s.url || s.file;
      if (!su) return;
      sources.push({
        quality: s.quality || s.label || 'auto', title: s.label || 'VidLink',
        url: su, type: 'hls', referer: 'https://vidlink.pro/',
        requiresSegmentProxy: false, status: 'working', language: 'en',
      });
    });
    console.log(`[VidLink] ${sources.length} sources`);
    return sources;
  } catch (e) {
    console.error('[VidLink] Error:', e instanceof Error ? e.message : e);
    return [];
  }
}
