/**
 * Videasy Shared Crypto Module
 *
 * Runtime-agnostic WASM + AES decryption pipeline shared by both the
 * server-side extractor (Node.js / CF Pages Worker) and client-side
 * extractor (browser).
 *
 * Pipeline: hex → WASM stream-cipher decrypt(key=tmdbId) → AES-256-CBC decrypt(key="") → JSON
 *
 * Key invariants (reverse-engineered May 2026):
 *   - b35ebba4 key is ALWAYS empty string (XOR hex fails Hashids validation)
 *   - WASM g_sb global patched from 0→1 to bypass verify() gate
 *   - WASM decrypt resets g_sb each call; patched WASM keeps it at 1
 *   - AES uses OpenSSL salted format (Salted__ + 8-byte salt + ciphertext)
 */

// ============================================================================
// Pure JS MD5 — works everywhere (Node, CF Worker, browser)
// ============================================================================
export function md5bytes(data: Uint8Array): Uint8Array {
  const len = data.length;
  const totalLen =
    len + 1 + ((len + 1) % 64 < 56 ? 56 - ((len + 1) % 64) : 120 - ((len + 1) % 64)) + 8;
  const words = new Uint8Array(totalLen);
  words.set(data, 0);
  words[len] = 0x80;
  const bitLen = len * 8;
  const view = new DataView(words.buffer);
  view.setUint32(totalLen - 8, bitLen & 0xffffffff, true);
  view.setUint32(totalLen - 4, (bitLen / 0x100000000) | 0, true);

  let a = 0x67452301,
    b = 0xefcdab89,
    c = 0x98badcfe,
    d = 0x10325476;
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4,
    11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Int32Array([
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
    0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
    0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
    0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
    0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122,
    0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
    0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244,
    0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
    0xeb86d391,
  ]);

  for (let offset = 0; offset < totalLen; offset += 64) {
    let A = a, B = b, C = c, D = d;
    const M = new Int32Array(16);
    for (let i = 0; i < 16; i++) {
      M[i] =
        words[offset + i * 4] |
        (words[offset + i * 4 + 1] << 8) |
        (words[offset + i * 4 + 2] << 16) |
        (words[offset + i * 4 + 3] << 24);
    }
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (B & C) | (~B & D); g = i; }
      else if (i < 32) { f = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { f = C ^ (B | ~D); g = (7 * i) % 16; }
      const tmp = D; D = C; C = B;
      B = (B + (((A + f + K[i] + M[g]) << S[i]) | ((A + f + K[i] + M[g]) >>> (32 - S[i])))) | 0;
      A = tmp;
    }
    a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 4; i++) {
    out[i] = a >>> (i * 8);
    out[i + 4] = b >>> (i * 8);
    out[i + 8] = c >>> (i * 8);
    out[i + 12] = d >>> (i * 8);
  }
  return out;
}

// ============================================================================
// EVP_BytesToKey with MD5 (key="" always for Videasy)
// ============================================================================
export function deriveKeyIv(
  salt: Uint8Array,
  password: string,
  keySize = 32,
  ivSize = 16,
): { key: Uint8Array; iv: Uint8Array } {
  const pwBytes = new TextEncoder().encode(password);
  let hash: Uint8Array = new Uint8Array(0);
  let derived: Uint8Array = new Uint8Array(0);

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
  return { key: derived.slice(0, keySize), iv: derived.slice(keySize, keySize + ivSize) };
}

// ============================================================================
// Web Crypto helpers
// ============================================================================
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  return buf;
}

/**
 * AES-256-CBC decrypt via Web Crypto API.
 * Expects OpenSSL salted format: "Salted__" + 8-byte salt + ciphertext.
 * Key derivation uses EVP_BytesToKey(MD5, 1 iteration).
 * Password defaults to "" (b35ebba4 always resolves to empty string).
 */
export async function aesDecrypt(base64Data: string, password = ''): Promise<string> {
  const binary = atob(base64Data);
  const raw = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);

  if (raw.length < 16) throw new Error('[VideasyCrypto] Data too short for salted format');
  if (new TextDecoder().decode(raw.slice(0, 8)) !== 'Salted__') {
    throw new Error('[VideasyCrypto] Not OpenSSL salted format');
  }

  const salt = raw.slice(8, 16);
  const ciphertext = raw.slice(16);
  const { key, iv } = deriveKeyIv(salt, password);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(key),
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: toArrayBuffer(iv) },
    cryptoKey,
    toArrayBuffer(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

// ============================================================================
// WASM Singleton
// ============================================================================
let wasmExports: any = null;
let wasmMemory: WebAssembly.Memory | null = null;
let wasmInitPromise: Promise<void> | null = null;

export interface WasmLoadOptions {
  /** Pre-loaded ArrayBuffer (Node.js — fs.readFileSync) */
  wasmBuffer?: ArrayBuffer;
  /** URLs to try fetching in order (browser / CF Worker) */
  wasmUrls?: string[];
}

/**
 * Initialize the Videasy WASM module.
 *
 * If `wasmBuffer` is provided (e.g., loaded via fs in Node.js), it's used directly.
 * Otherwise, fetches from `wasmUrls` (browser / CF Worker).
 *
 * Default URL order: /videasy.bin → /videasy-module-patched.wasm
 * (.bin bypasses Cloudflare WAF blocking of .wasm files)
 */
export async function getWasm(opts?: WasmLoadOptions): Promise<void> {
  if (wasmExports) return;

  // If a prior attempt is still in-flight, wait for it
  if (wasmInitPromise) {
    try {
      await wasmInitPromise;
      return;
    } catch {
      // Prior attempt failed — reset so we can retry (possibly with
      // different opts, e.g. absolute URLs after relative URLs fail).
      wasmInitPromise = null;
    }
  }

  wasmInitPromise = (async () => {
    let wasmBuffer: ArrayBuffer;

    if (opts?.wasmBuffer) {
      wasmBuffer = opts.wasmBuffer;
    } else {
      const urls = opts?.wasmUrls || [
        '/videasy.bin',
        '/videasy-module-patched.wasm',
      ];
      let res: Response | null = null;
      for (const url of urls) {
        try {
          res = await fetch(url);
          if (res.ok) break;
          res = null;
        } catch { /* try next */ }
      }
      if (!res || !res.ok) {
        throw new Error('[VideasyCrypto] WASM not available from any URL');
      }
      wasmBuffer = await res.arrayBuffer();
    }

    const mod = await WebAssembly.instantiate(wasmBuffer, {
      env: {
        seed() { return Date.now() * Math.random(); },
        abort() { throw new Error('[VideasyCrypto] WASM abort'); },
      },
    });
    wasmExports = mod.instance.exports;
    wasmMemory = wasmExports.memory as WebAssembly.Memory;
  })();

  // Reset the singleton on failure so callers can retry with different options
  // (e.g. absolute CDN URLs after relative URLs fail on CF Pages Workers).
  wasmInitPromise = wasmInitPromise.catch((err) => {
    wasmInitPromise = null;
    throw err;
  });

  await wasmInitPromise;
}

// ============================================================================
// WASM string helpers (UCS-2 encoding)
// ============================================================================

/**
 * Allocate a UCS-2 string in WASM memory.
 * MUST be called after getWasm() has initialized the module.
 *
 * IMPORTANT: Creates a fresh Uint8Array view of memory.buffer AFTER calling
 * __new, because __new may grow the WASM memory (detaching the old buffer).
 */
export function allocWasmString(str: string): number {
  const byteLen = str.length * 2;
  // __new may grow memory — call it first, then create a fresh view
  const ptr = wasmExports.__new(byteLen, 2) as number;
  const buf = new Uint8Array(wasmMemory!.buffer);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    buf[ptr + i * 2] = code & 0xff;
    buf[ptr + i * 2 + 1] = (code >> 8) & 0xff;
  }
  return ptr;
}

/**
 * Read a UCS-2 string from WASM memory.
 * Returns empty string if ptr is null/0.
 */
export function readWasmString(ptr: number, maxChars: number): string {
  if (!ptr) return '';
  const buf = new Uint8Array(wasmMemory!.buffer);
  let result = '';
  const limit = Math.min(ptr + maxChars * 2, buf.length - 1);
  for (let i = ptr; i < limit; i += 2) {
    const code = buf[i] | (buf[i + 1] << 8);
    if (code === 0) break;
    result += String.fromCharCode(code);
  }
  return result;
}

/**
 * Run the WASM decrypt function on hex data keyed by tmdbId.
 * Returns the WASM-decrypted base64 string, or throws on failure.
 */
export function wasmDecrypt(hexData: string, tmdbIdFloat: number): string {
  const ptr = allocWasmString(hexData);
  const decryptedPtr = wasmExports.decrypt(ptr, tmdbIdFloat) as number;
  if (!decryptedPtr) {
    throw new Error('[VideasyCrypto] WASM decrypt returned null — verification failed');
  }
  return readWasmString(decryptedPtr, Math.floor(hexData.length / 2));
}

/**
 * Full decryption pipeline: WASM stream cipher → AES-256-CBC
 * Returns the parsed JSON object.
 */
export async function decryptVideasyPayload(
  hexData: string,
  tmdbIdFloat: number,
): Promise<any> {
  const wasmDecrypted = wasmDecrypt(hexData, tmdbIdFloat);
  const json = await aesDecrypt(wasmDecrypted, '');
  return JSON.parse(json);
}
