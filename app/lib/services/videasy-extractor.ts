/**
 * Videasy Server-Side Extractor
 *
 * Decryption pipeline:
 *   1. Fetch raw hex from CF Worker /videasy/extract
 *   2. WASM stream cipher decrypt
 *   3. AES-256-CBC decrypt (key="" always)
 *   4. Parse JSON → sources + subtitles
 *
 * Uses pure JS MD5 + Web Crypto API — works in Node.js 19+, CF Pages Workers, browsers.
 */

import { cfFetch } from '@/app/lib/utils/cf-fetch';
import type { StreamSource } from '../providers/types';

function getCfWorkerBaseUrl(): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL ||
    process.env.CF_STREAM_PROXY_URL ||
    'https://media-proxy.vynx-3b3.workers.dev/stream';
  return cfProxyUrl.replace(/\/stream\/?$/, '');
}

// ============================================================================
// Pure JS MD5 — works everywhere (Node, CF Worker, browser)
// ============================================================================
function md5bytes(data: Uint8Array): Uint8Array {
  const len = data.length;
  const totalLen = len + 1 + ((len + 8) % 64 < 56 ? 56 - (len + 8) % 64 : 120 - (len + 8) % 64) + 8;
  const words = new Uint8Array(totalLen);
  words.set(data, 0);
  words[len] = 0x80;
  const bitLen = len * 8;
  const view = new DataView(words.buffer);
  view.setUint32(totalLen - 8, bitLen & 0xffffffff, true);
  view.setUint32(totalLen - 4, (bitLen / 0x100000000) | 0, true);

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
// EVP_BytesToKey with MD5 (key="" always)
// ============================================================================
function deriveKeyIv(salt: Uint8Array, password: string): { key: Uint8Array; iv: Uint8Array } {
  const pwBytes = new TextEncoder().encode(password);
  let hash: Uint8Array = new Uint8Array(0);
  let derived: Uint8Array = new Uint8Array(0);

  while (derived.length < 48) {
    const input = new Uint8Array(hash.length + pwBytes.length + salt.length);
    input.set(hash, 0);
    input.set(pwBytes, hash.length);
    input.set(salt, hash.length + pwBytes.length);
    hash = md5bytes(input) as unknown as Uint8Array;
    const tmp = new Uint8Array(derived.length + hash.length);
    tmp.set(derived, 0);
    tmp.set(hash, derived.length);
    derived = tmp;
  }
  return { key: derived.slice(0, 32), iv: derived.slice(32, 48) };
}

// ============================================================================
// AES decrypt via Web Crypto API
// ============================================================================
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  return buf;
}

async function aesDecrypt(base64Data: string, password: string): Promise<string> {
  const binary = atob(base64Data);
  const raw = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);

  if (raw.length < 16) throw new Error('Data too short for salted format');
  if (new TextDecoder().decode(raw.slice(0, 8)) !== 'Salted__') throw new Error('Not OpenSSL salted format');

  const salt = raw.slice(8, 16);
  const ciphertext = raw.slice(16);
  const { key, iv } = deriveKeyIv(salt, password);

  const cryptoKey = await crypto.subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-CBC' }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: toArrayBuffer(iv) }, cryptoKey, toArrayBuffer(ciphertext));
  return new TextDecoder().decode(plaintext);
}

// ============================================================================
// WASM Singleton
// ============================================================================
let wasmExports: any = null;
let wasmMemory: WebAssembly.Memory | null = null;
let wasmInitPromise: Promise<void> | null = null;

async function getWasmServer(): Promise<void> {
  if (wasmExports) return;
  if (wasmInitPromise) return wasmInitPromise;

  wasmInitPromise = (async () => {
    let wasmBuffer: ArrayBuffer;

    if (typeof process !== 'undefined' && process.versions?.node) {
      const fs = await import('fs');
      const path = await import('path');
      const wasmPath = path.join(process.cwd(), 'public', 'videasy-module-patched.wasm');
      wasmBuffer = fs.readFileSync(wasmPath).buffer;
    } else {
      // CF Pages Worker — try .bin first (bypasses WAF blocking .wasm), then .wasm, then CF Worker
      const urls = [
        'https://tv.vynx.cc/videasy.bin',
        'https://tv.vynx.cc/videasy-module-patched.wasm',
        `${getCfWorkerBaseUrl()}/videasy-module-patched.wasm`,
      ];
      let res: Response | null = null;
      for (const url of urls) {
        try {
          res = await fetch(url);
          if (res.ok) break;
        } catch { /* try next */ }
      }
      if (!res || !res.ok) throw new Error('Videasy WASM not available from any URL');
      wasmBuffer = await res.arrayBuffer();
    }

    const mod = await WebAssembly.instantiate(wasmBuffer, {
      env: {
        seed() { return Date.now() * Math.random(); },
        abort() { throw new Error('WASM abort'); },
      },
    });
    wasmExports = mod.instance.exports;
    wasmMemory = wasmExports.memory as WebAssembly.Memory;
  })();

  return wasmInitPromise;
}

function allocWasmString(str: string): number {
  const buf = new Uint8Array(wasmMemory!.buffer);
  const byteLen = str.length * 2;
  const ptr = wasmExports.__new(byteLen, 2) as number;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    buf[ptr + i * 2] = code & 0xff;
    buf[ptr + i * 2 + 1] = (code >> 8) & 0xff;
  }
  return ptr;
}

function readWasmString(ptr: number, maxChars: number): string {
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

// ============================================================================
// Public API
// ============================================================================
export interface VideasyExtractionResult {
  success: boolean;
  sources: StreamSource[];
  subtitles?: Array<{ label: string; url: string; language: string }>;
  error?: string;
}

export async function extractVideasyStreams(
  tmdbId: string,
  type: 'movie' | 'tv',
  title: string,
  season?: number,
  episode?: number,
): Promise<VideasyExtractionResult> {
  console.log(`[Videasy] Extracting ${type} ${tmdbId} "${title}"`);

  if (type === 'tv' && (!season || !episode)) {
    return { success: false, sources: [], error: 'Season and episode required for TV' };
  }

  try {
    const baseUrl = getCfWorkerBaseUrl();
    const params = new URLSearchParams({ tmdbId, type, title });
    if (type === 'tv' && season != null) params.set('season', season.toString());
    if (type === 'tv' && episode != null) params.set('episode', episode.toString());

    const extractUrl = `${baseUrl}/videasy/extract?${params}`;

    const res = await cfFetch(extractUrl, { signal: AbortSignal.timeout(25000) });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Videasy proxy ${res.status}: ${errText.substring(0, 100)}`);
    }

    const data = await res.json() as { success: boolean; hexData?: string; error?: string };
    if (!data.success || !data.hexData) {
      return { success: false, sources: [], error: data.error || 'No hex data from proxy' };
    }

    // WASM decrypt
    await getWasmServer();
    const ptr = allocWasmString(data.hexData);
    const decryptedPtr = wasmExports.decrypt(ptr, parseFloat(tmdbId)) as number;
    if (!decryptedPtr) {
      return { success: false, sources: [], error: 'WASM decrypt returned null' };
    }
    const wasmDecrypted = readWasmString(decryptedPtr, Math.floor(data.hexData.length / 2));

    // AES decrypt
    const json = await aesDecrypt(wasmDecrypted, '');

    // Parse
    const parsed = JSON.parse(json);
    const rawSources = parsed.sources || [];
    const rawSubtitles = parsed.subtitles || [];

    const sources: StreamSource[] = rawSources
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

    return {
      success: sources.length > 0,
      sources,
      subtitles: rawSubtitles.length > 0 ? rawSubtitles.map((s: any) => ({
        label: s.label || s.lang || s.language || 'unknown',
        url: s.url,
        language: s.lang || s.language || 'unknown',
      })) : undefined,
    };
  } catch (err) {
    console.error(`[Videasy] Error:`, err instanceof Error ? err.message : err);
    return { success: false, sources: [], error: err instanceof Error ? err.message : 'Videasy extraction failed' };
  }
}

export async function fetchVideasySourceByName(
  sourceName: string,
  tmdbId: string,
  type: 'movie' | 'tv',
  title: string,
  season?: number,
  episode?: number,
): Promise<StreamSource | null> {
  try {
    const result = await extractVideasyStreams(tmdbId, type, title, season, episode);
    if (!result.success) return null;
    const match = result.sources.find(s =>
      s.title?.toLowerCase().includes(sourceName.toLowerCase())
    );
    return match || null;
  } catch {
    return null;
  }
}
