// Extract Videasy stream URLs and verify they're playable in VLC
import { readFileSync } from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATCHED_WASM = path.join(__dirname, 'videasy-module-patched.wasm');

// ============================================================================
// WASM Singleton
// ============================================================================
let wasmExports = null;
let wasmMemory = null;

async function getWasm() {
  if (wasmExports) return { exports: wasmExports, memory: wasmMemory };
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
}

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

function aesDecrypt(base64Data, key = '') {
  const rawData = Buffer.from(base64Data, 'base64');
  if (rawData.length < 16 || rawData.slice(0, 8).toString() !== 'Salted__') {
    throw new Error('Not OpenSSL salted format');
  }
  const salt = rawData.slice(8, 16);
  const ciphertext = rawData.slice(16);
  const keySize = 32, ivSize = 16;
  let hash = Buffer.alloc(0), derived = Buffer.alloc(0);
  while (derived.length < keySize + ivSize) {
    const md5 = crypto.createHash('md5');
    md5.update(hash);
    md5.update(Buffer.from(key, 'utf8'));
    md5.update(salt);
    hash = md5.digest();
    derived = Buffer.concat([derived, hash]);
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', derived.slice(0, keySize), derived.slice(keySize, keySize + ivSize));
  decipher.setAutoPadding(true);
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString('utf8');
}

async function extract(title, tmdbId, type = 'movie', year = '', imdbId = '') {
  // Step 1: Fetch hex data from API
  const params = new URLSearchParams({
    title,
    mediaType: type === 'tv' ? 'TV Series' : 'Movie',
    year: String(year),
    totalSeasons: '0',
    episodeId: '0',
    seasonId: '0',
    tmdbId: String(tmdbId),
    imdbId: String(imdbId),
  });

  const apiUrl = `https://api.videasy.net/cdn/sources-with-title?${params}`;
  console.log(`[1] Fetching: ${apiUrl.substring(0, 100)}...`);
  const res = await fetch(apiUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      // ZERO other headers needed!
    }
  });

  if (!res.ok) throw new Error(`API returned ${res.status}`);
  const hexData = await res.text();

  if (hexData.startsWith('{')) {
    const err = JSON.parse(hexData);
    throw new Error(`API error: ${err.message}`);
  }

  console.log(`    Got ${hexData.length} bytes encrypted hex`);

  // Step 2: WASM decrypt
  console.log('[2] WASM stream cipher decrypt...');
  const { exports, memory } = await getWasm();
  wasmExports = exports;
  wasmMemory = memory;
  const ptr = allocWasmString(hexData);
  const decryptedPtr = wasmExports.decrypt(ptr, parseFloat(tmdbId));
  if (!decryptedPtr) throw new Error('WASM decrypt returned null');
  const wasmDecrypted = readWasmString(decryptedPtr, Math.floor(hexData.length / 2));
  console.log(`    Decrypted ${wasmDecrypted.length} chars base64`);

  // Step 3: AES decrypt with empty key
  console.log('[3] AES-256-CBC decrypt (key="")...');
  const json = aesDecrypt(wasmDecrypted, '');
  const data = JSON.parse(json);
  console.log(`    Parsed JSON: ${data.sources?.length || 0} sources, ${data.subtitles?.length || 0} subtitles`);

  return data;
}

// ============================================================================
// Verify m3u8 is valid via Node.js fetch
// ============================================================================
async function verifyM3u8(url, label) {
  console.log(`\n[VERIFY] ${label}`);
  console.log(`    URL: ${url.substring(0, 120)}...`);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://player.videasy.net/',
        'Origin': 'https://player.videasy.net',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.log(`    FAILED: HTTP ${res.status} ${res.statusText}`);
      return false;
    }
    const body = await res.text();
    if (body.includes('#EXTM3U')) {
      const variants = (body.match(/#EXT-X-STREAM-INF/g) || []).length;
      const segments = (body.match(/#EXTINF/g) || []).length;
      console.log(`    VALID M3U8! ${variants} quality variants, ${segments} segments, ${body.length} bytes`);

      // Show first few lines
      const lines = body.split('\n').filter(l => l.trim()).slice(0, 10);
      console.log('    First lines:');
      lines.forEach(l => console.log(`      ${l.trim().substring(0, 100)}`));
      return true;
    } else {
      console.log(`    NOT M3U8: ${body.substring(0, 150)}`);
      return false;
    }
  } catch (e) {
    console.log(`    ERROR: ${e.message}`);
    return false;
  }
}

async function main() {
  const tests = [
    ['Fight Club', '550', 'movie', '1999', 'tt0137523'],
    ['Interstellar', '157336', 'movie', '2014', 'tt0816692'],
  ];

  for (const [title, tmdbId, type, year, imdbId] of tests) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`EXTRACTING: ${title} (TMDB ${tmdbId})`);
    console.log('='.repeat(60));

    try {
      const data = await extract(title, tmdbId, type, year, imdbId);
      const sources = data.sources || [];

      // Print all sources
      console.log(`\n[SOURCES] ${sources.length} total:`);
      for (const s of sources) {
        console.log(`  ${s.quality || '?'}: ${s.url?.substring(0, 100) || 'N/A'}`);
      }

      // Verify the best quality URL
      if (sources.length > 0) {
        const best = sources[0]; // Usually sorted best first
        const valid = await verifyM3u8(best.url, `${best.quality} - ${title}`);

        if (valid) {
          console.log('\n' + '='.repeat(60));
          console.log(`SUCCESS! Playable stream URL for ${title}:`);
          console.log(`  ${best.url}`);
          console.log('='.repeat(60));
        }
      }
    } catch (e) {
      console.error(`ERROR: ${e.message}`);
    }
  }
}

main().catch(console.error);
