// Videasy Source Extractor for Flyx
// Reverse engineered from player.videasy.net — May 2026
//
// Pipeline:
//   API → WASM decrypt(hex, tmdbId) → AES decrypt(base64, "") → JSON {sources, subtitles}
//
// Key findings:
//   - b35ebba4 key is ALWAYS empty string (XOR hex fails Hashids decimal validation)
//   - WASM g_sb global must be patched from 0→1 to bypass verify() gate
//   - WASM decrypt resets g_sb each call; patched to keep it at 1
//   - API endpoint: api.videasy.net/cdn/sources-with-title (most reliable)
import { readFileSync } from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATCHED_WASM = path.join(__dirname, 'videasy-module-patched.wasm');

// ============================================================================
// WASM Singleton
// ============================================================================
let wasmExports = null;
let wasmMemory = null;
let wasmInitPromise = null;

async function getWasm() {
  if (wasmExports) return { exports: wasmExports, memory: wasmMemory };
  if (wasmInitPromise) return wasmInitPromise;

  wasmInitPromise = (async () => {
    const wasmBuffer = readFileSync(PATCHED_WASM);
    const mod = await WebAssembly.instantiate(wasmBuffer, {
      env: {
        seed() { return Date.now() * Math.random(); },
        abort() { throw new Error('WASM abort'); }
      }
    });
    wasmExports = mod.instance.exports;
    wasmMemory = wasmExports.memory;
    return { exports: wasmExports, memory: wasmMemory };
  })();

  return wasmInitPromise;
}

// WASM string helpers
function allocWasmString(str) {
  const buf = new Uint8Array(wasmMemory.buffer);
  const byteLen = str.length * 2;
  const ptr = wasmExports.__new(byteLen, 2);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    buf[ptr + i * 2] = code & 0xff;
    buf[ptr + i * 2 + 1] = (code >> 8) & 0xff;
  }
  return ptr;
}

function readWasmString(ptr, maxChars) {
  if (!ptr) return '';
  const buf = new Uint8Array(wasmMemory.buffer);
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
// AES Decrypt — CryptoJS-compatible (EVP_BytesToKey with MD5)
// ============================================================================
function aesDecrypt(base64Data, key = '') {
  const rawData = Buffer.from(base64Data, 'base64');

  // Verify OpenSSL salted format
  if (rawData.length < 16 || rawData.slice(0, 8).toString() !== 'Salted__') {
    throw new Error('Data is not in OpenSSL salted format');
  }

  const salt = rawData.slice(8, 16);
  const ciphertext = rawData.slice(16);

  // EVP_BytesToKey: MD5 hash chain, 1 iteration, 256-bit key + 128-bit IV
  const keySize = 32;
  const ivSize = 16;
  let hash = Buffer.alloc(0);
  let derived = Buffer.alloc(0);

  while (derived.length < keySize + ivSize) {
    const md5 = crypto.createHash('md5');
    md5.update(hash);
    md5.update(Buffer.from(key, 'utf8'));
    md5.update(salt);
    hash = md5.digest();
    derived = Buffer.concat([derived, hash]);
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    derived.slice(0, keySize),
    derived.slice(keySize, keySize + ivSize)
  );
  decipher.setAutoPadding(true);

  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString('utf8');
}

// ============================================================================
// WASM Decrypt
// ============================================================================
async function wasmDecrypt(hexData, tmdbId) {
  const { exports, memory } = await getWasm();
  wasmExports = exports;
  wasmMemory = memory;

  const ptr = allocWasmString(hexData);
  const decryptedPtr = wasmExports.decrypt(ptr, tmdbId);

  if (!decryptedPtr) {
    throw new Error('WASM decrypt returned null — verification may have failed');
  }

  const expectedLen = Math.floor(hexData.length / 2);
  return readWasmString(decryptedPtr, expectedLen);
}

// ============================================================================
// API Client
// ============================================================================
const API_BASE = 'https://api.videasy.net';
const DEFAULT_HEADERS = {
  'Origin': 'https://player.videasy.net',
  'Referer': 'https://player.videasy.net/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

async function fetchSources(title, tmdbId, type = 'movie', options = {}) {
  const {
    year = '',
    imdbId = '',
    seasonId = '0',
    episodeId = '0',
    totalSeasons = '0',
    endpoint = '/cdn/sources-with-title',
  } = options;

  const params = new URLSearchParams({
    title,
    mediaType: type === 'tv' ? 'TV Series' : 'Movie',
    year: String(year),
    totalSeasons: String(totalSeasons),
    episodeId: String(episodeId),
    seasonId: String(seasonId),
    tmdbId: String(tmdbId),
    imdbId: String(imdbId),
  });

  const url = `${API_BASE}${endpoint}?${params}`;
  const res = await fetch(url, { headers: DEFAULT_HEADERS });

  if (!res.ok) {
    throw new Error(`API returned ${res.status}: ${res.statusText}`);
  }

  return res.text();
}

// ============================================================================
// Main Pipeline
// ============================================================================
async function getSources(title, tmdbId, type = 'movie', options = {}) {
  const hexData = await fetchSources(title, tmdbId, type, options);

  if (hexData.startsWith('{')) {
    // API returned JSON error
    const err = JSON.parse(hexData);
    throw new Error(`Videasy API error: ${err.message || err.error || 'Unknown'}`);
  }

  // Layer 1: WASM stream cipher decrypt (keyed by tmdbId)
  const wasmDecrypted = await wasmDecrypt(hexData, parseFloat(tmdbId));

  // Layer 2: AES decrypt (keyed by empty string — b35ebba4 is always "")
  const json = aesDecrypt(wasmDecrypted, '');

  const data = JSON.parse(json);
  return {
    sources: (data.sources || []).map(s => ({
      quality: s.quality || 'unknown',
      url: s.url || '',
      size: s.size || null,
      type: s.type || 'hls',
    })),
    subtitles: (data.subtitles || []).map(s => ({
      lang: s.lang || s.language || 'unknown',
      url: s.url || '',
      type: s.type || 'vtt',
    })),
    raw: data,
  };
}

// ============================================================================
// Exports
// ============================================================================
export {
  getSources,
  fetchSources,
  wasmDecrypt,
  aesDecrypt,
  getWasm,
};

// ============================================================================
// CLI test
// ============================================================================
async function main() {
  if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const tmdbId = process.argv[2] || '550';
    const title = process.argv[3] || 'Fight Club';
    const type = process.argv[4] || 'movie';

    console.log(`Fetching sources for "${title}" (tmdbId=${tmdbId}, type=${type})...`);
    try {
      const result = await getSources(title, tmdbId, type, {
        year: '1999',
        imdbId: 'tt0137523',
      });
      console.log(`\nFound ${result.sources.length} sources:`);
      result.sources.forEach(s => console.log(`  ${s.quality}: ${s.url.substring(0, 100)}`));
      console.log(`\nFound ${result.subtitles.length} subtitles`);
      if (result.subtitles.length > 0) {
        console.log('  Languages:', [...new Set(result.subtitles.map(s => s.lang))].join(', '));
      }
    } catch (e) {
      console.error('Error:', e.message);
      process.exit(1);
    }
  }
}

main();
