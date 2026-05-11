/**
 * Videasy Client-Side Extractor
 *
 * Full browser-side decryption pipeline:
 *   1. Fetch raw hex from CF Worker /videasy/extract (lightweight CORS proxy)
 *   2. Load WASM from /videasy-module-patched.wasm
 *   3. WASM decrypt(hex, tmdbId) → base64 string
 *   4. AES-256-CBC decrypt via Web Crypto API (key="" always — b35ebba4 quirk)
 *   5. Parse JSON → sources + subtitles
 */

function md5bytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  // MD5 over raw bytes (used for iterative EVP_BytesToKey)
  const words = new Array(data.length + 72);
  for (let i = 0; i < data.length; i++) words[i] = data[i];
  words[data.length] = 0x80;
  const bitLen = data.length * 8;
  const lo = bitLen & 0xffffffff;
  const hi = (bitLen / 0x100000000) | 0;
  const padLen = ((data.length + 1) % 64 < 56) ? (56 - (data.length + 1) % 64) : (120 - (data.length + 1) % 64);
  const totalLen = data.length + 1 + padLen + 8;
  words[totalLen - 8] = lo & 0xff; words[totalLen - 7] = (lo >>> 8) & 0xff;
  words[totalLen - 6] = (lo >>> 16) & 0xff; words[totalLen - 5] = (lo >>> 24) & 0xff;
  words[totalLen - 4] = hi & 0xff; words[totalLen - 3] = (hi >>> 8) & 0xff;
  words[totalLen - 2] = (hi >>> 16) & 0xff; words[totalLen - 1] = (hi >>> 24) & 0xff;

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = new Int32Array([0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391]);

  for (let offset = 0; offset < totalLen; offset += 64) {
    let A = a, B = b, C = c, D = d;
    const M = new Int32Array(16);
    for (let i = 0; i < 16; i++) {
      M[i] = words[offset + i*4] | (words[offset + i*4 + 1] << 8) | (words[offset + i*4 + 2] << 16) | (words[offset + i*4 + 3] << 24);
    }
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (B & C) | (~B & D); g = i; }
      else if (i < 32) { f = (D & B) | (~D & C); g = (5*i + 1) % 16; }
      else if (i < 48) { f = B ^ C ^ D; g = (3*i + 5) % 16; }
      else { f = C ^ (B | ~D); g = (7*i) % 16; }
      const tmp = D; D = C; C = B;
      B = (B + ((A + f + K[i] + M[g]) << S[i] | (A + f + K[i] + M[g]) >>> (32 - S[i]))) | 0;
      A = tmp;
    }
    a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 4; i++) { out[i] = a>>> (i*8); out[i+4] = b>>> (i*8); out[i+8] = c>>> (i*8); out[i+12] = d>>> (i*8); }
  return out;
}

// ============================================================================
// EVP_BytesToKey with MD5 — key="" always (b35ebba4 = "" for any hex input)
// ============================================================================
function deriveKeyIv(salt: Uint8Array, password: string, keySize: number, ivSize: number): { key: Uint8Array; iv: Uint8Array } {
  const pwBytes = new TextEncoder().encode(password);
  let hash = new Uint8Array(0);
  let derived = new Uint8Array(0);

  while (derived.length < keySize + ivSize) {
    const input = new Uint8Array(hash.length + pwBytes.length + salt.length);
    input.set(hash, 0);
    input.set(pwBytes, hash.length);
    input.set(salt, hash.length + pwBytes.length);
    hash = md5bytes(input);
    const tmp = new Uint8Array(derived.length + hash.length);
    tmp.set(derived, 0);
    tmp.set(hash, derived.length);
    derived = tmp;
  }

  return {
    key: derived.slice(0, keySize),
    iv: derived.slice(keySize, keySize + ivSize),
  };
}

// ============================================================================
// Web Crypto helpers — work around TS 5.6+ ArrayBufferLike strictness
// ============================================================================
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  return buf;
}

async function aesDecrypt(base64Data: string, password: string): Promise<string> {
  const raw = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

  if (raw.length < 16) throw new Error('Data too short for salted format');
  if (new TextDecoder().decode(raw.slice(0, 8)) !== 'Salted__') throw new Error('Not OpenSSL salted format');

  const salt = raw.slice(8, 16);
  const ciphertext = raw.slice(16);
  const { key, iv } = deriveKeyIv(salt, password, 32, 16);

  const cryptoKey = await crypto.subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-CBC' }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: toArrayBuffer(iv) }, cryptoKey, toArrayBuffer(ciphertext));
  return new TextDecoder().decode(plaintext);
}

// ============================================================================
// WASM Singleton
// ============================================================================
let wasmExports: WebAssembly.Exports | null = null;
let wasmMemory: WebAssembly.Memory | null = null;
let wasmInitPromise: Promise<{ exports: WebAssembly.Exports; memory: WebAssembly.Memory }> | null = null;

async function getWasm(): Promise<{ exports: WebAssembly.Exports; memory: WebAssembly.Memory }> {
  if (wasmExports && wasmMemory) return { exports: wasmExports, memory: wasmMemory };
  if (wasmInitPromise) return wasmInitPromise;

  wasmInitPromise = (async () => {
    // Try .bin first (bypasses Cloudflare WAF blocking .wasm), fall back to .wasm
    const urls = ['/videasy.bin', '/videasy-module-patched.wasm'];
    let result: WebAssembly.WebAssemblyInstantiatedSource | null = null;
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const buf = await res.arrayBuffer();
          result = await WebAssembly.instantiate(buf, {
            env: {
              seed() { return Date.now() * Math.random(); },
              abort() { throw new Error('WASM abort'); },
            },
          });
          break;
        }
      } catch { /* try next URL */ }
    }
    if (!result) throw new Error('Failed to load Videasy WASM from all URLs');
    wasmExports = result.instance.exports;
    wasmMemory = result.instance.exports.memory as WebAssembly.Memory;
    return { exports: wasmExports!, memory: wasmMemory! };
  })();

  return wasmInitPromise;
}

// WASM string helpers (UCS-2 encoding)
function allocWasmString(str: string, memory: WebAssembly.Memory, exports: WebAssembly.Exports): number {
  const buf = new Uint8Array(memory.buffer);
  const byteLen = str.length * 2;
  const ptr = (exports as any).__new(byteLen, 2) as number;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    buf[ptr + i * 2] = code & 0xff;
    buf[ptr + i * 2 + 1] = (code >> 8) & 0xff;
  }
  return ptr;
}

function readWasmString(ptr: number, maxChars: number, memory: WebAssembly.Memory): string {
  if (!ptr) return '';
  const buf = new Uint8Array(memory.buffer);
  let result = '';
  const limit = Math.min(ptr + maxChars * 2, buf.length - 1);
  for (let i = ptr; i < limit; i += 2) {
    const code = buf[i] | (buf[i + 1] << 8);
    if (code === 0) break;
    result += String.fromCharCode(code);
  }
  return result;
}

// ============================================================================
// CF Worker proxy URL
// ============================================================================
const CF_WORKER_BASE = typeof window !== 'undefined'
  ? (process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL || 'https://media-proxy.vynx-3b3.workers.dev/stream').replace(/\/stream\/?$/, '')
  : '';

// ============================================================================
// Source type
// ============================================================================
export interface VideasySource {
  quality: string;
  title: string;
  url: string;
  type: 'hls' | 'mp4';
  referer: string;
  requiresSegmentProxy: boolean;
  status: 'working' | 'down' | 'unknown';
  language: string;
  server: string;
}

// ============================================================================
// Main extraction function
// ============================================================================
export async function extractVideasyClient(
  tmdbId: string,
  type: 'movie' | 'tv',
  title: string,
  season?: number,
  episode?: number,
  year?: string,
): Promise<VideasySource[]> {
  console.log(`[Videasy] Extracting: ${type} ${tmdbId} "${title}"`);

  const params = new URLSearchParams({ tmdbId, type, title });
  if (type === 'tv' && season != null) params.set('season', season.toString());
  if (type === 'tv' && episode != null) params.set('episode', episode.toString());
  if (year) params.set('year', year);

  // Step 1: Fetch raw hex from CF Worker proxy
  const res = await fetch(`${CF_WORKER_BASE}/videasy/extract?${params}`, {
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Videasy extract ${res.status}: ${err.substring(0, 100)}`);
  }

  const data = await res.json() as { success: boolean; hexData?: string; error?: string };

  if (!data.success || !data.hexData) {
    console.warn(`[Videasy] CF Worker error: ${data.error || 'no hex data'}`);
    return [];
  }

  // Step 2: WASM decrypt (stream cipher keyed by tmdbId)
  const { exports, memory } = await getWasm();
  const ptr = allocWasmString(data.hexData, memory, exports);
  const decryptedPtr = (exports as any).decrypt(ptr, parseFloat(tmdbId)) as number;

  if (!decryptedPtr) {
    console.warn('[Videasy] WASM decrypt returned null — verification may have failed');
    return [];
  }

  const expectedLen = Math.floor(data.hexData.length / 2);
  const wasmDecrypted = readWasmString(decryptedPtr, expectedLen, memory);

  // Step 3: AES-256-CBC decrypt (key="" always — b35ebba4 quirk)
  let json: string;
  try {
    json = await aesDecrypt(wasmDecrypted, '');
  } catch (e) {
    console.warn(`[Videasy] AES decrypt failed:`, e instanceof Error ? e.message : e);
    return [];
  }

  // Step 4: Parse sources
  const parsed = JSON.parse(json);
  const rawSources = parsed.sources || [];
  const subtitles = parsed.subtitles || [];

  const sources: VideasySource[] = rawSources
    .filter((s: any) => s.url)
    .map((s: any) => ({
      quality: s.quality || 'auto',
      title: s.title || `Videasy ${s.quality || 'auto'}`,
      url: s.url,
      type: (s.type || 'hls') as 'hls' | 'mp4',
      referer: s.referer || 'https://player.videasy.net/',
      requiresSegmentProxy: false,
      status: 'working' as const,
      language: s.language || s.lang || 'en',
      server: s.server || 'videasy',
    }));

  console.log(`[Videasy] ${sources.length} working sources, ${subtitles.length} subtitles`);
  return sources;
}
