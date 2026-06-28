// Complete Videasy source extraction pipeline
// API → WASM decrypt → AES decrypt → JSON sources
import { readFileSync } from 'fs';
import crypto from 'crypto';

const wasmBuffer = readFileSync('videasy-module-patched.wasm');

let wasmExports, memory;

const imports = {
  env: {
    seed() { return 12345.6789; },
    abort() { throw new Error('WASM abort'); }
  }
};

function readWasmString(ptr, maxLen) {
  if (!ptr) return '';
  const buf = new Uint8Array(memory.buffer);
  const chars = [];
  for (let i = ptr; i < ptr + maxLen * 2 && i + 1 < buf.length; i += 2) {
    const code = buf[i] | (buf[i + 1] << 8);
    if (code === 0) break;
    chars.push(String.fromCharCode(code));
  }
  return chars.join('');
}

function allocString(str) {
  const len = str.length;
  const byteLen = len * 2;
  const ptr = wasmExports.__new(byteLen, 2);
  const buf = new Uint8Array(memory.buffer);
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    buf[ptr + i * 2] = code & 0xff;
    buf[ptr + i * 2 + 1] = (code >> 8) & 0xff;
  }
  return ptr;
}

// ===== XOR Transform =====
function xorTransform(input) {
  const keyBytes = Array.from('8c465aa8af6cbfd4c1f91bf0c8d678ba', c => c.charCodeAt(0));
  const keyXor = keyBytes.reduce((a, b) => a ^ b, 0);
  return Array.from(input, c =>
    ('0' + Number(c.charCodeAt(0) ^ keyXor).toString(16)).substr(-2)
  ).join('');
}

// ===== Minimal Hashids =====
function encodeHex(hexStr) {
  const chunks = [];
  for (let i = 0; i < hexStr.length; i += 12) {
    chunks.push(parseInt('1' + hexStr.slice(i, i + 12), 16));
  }
  // Use the extracted Hashids module for actual encoding
  return hashidsEncode(chunks);
}

// ===== Load Hashids from chunk =====
let hashidsEncode;
{
  const chunk = readFileSync('player-videasy-1470-chunk.js', 'utf8');
  const idx = chunk.indexOf('3589:function(t,e,r){');
  const nextMod = chunk.substring(idx + 20).match(/\d+:function/);
  const endIdx = idx + 20 + nextMod.index;
  const modCode = chunk.substring(idx, endIdx);
  const wrapped = eval('({' + modCode + '})');
  const modFn = wrapped['3589'];
  const mod = { exports: {} };
  modFn(mod, mod.exports, {
    d: (e, def) => { for (const k in def) Object.defineProperty(e, k, { enumerable: true, get: def[k] }); }
  });
  const Hashids = mod.exports.Z;
  const h = new Hashids();
  hashidsEncode = (nums) => h.encode(nums);
}

// ===== Generate b35ebba4 =====
function generateB35ebba4(tmdbId) {
  const salt = 'd486ae1ce6fdbe63b60bd1704541fcf0';
  return encodeHex(xorTransform(tmdbId + salt));
}

// ===== AES Decrypt (CryptoJS-compatible) =====
function aesDecrypt(base64Data, key) {
  const rawData = Buffer.from(base64Data, 'base64');
  if (rawData.slice(0, 8).toString() !== 'Salted__') {
    throw new Error('Not OpenSSL salted format: ' + rawData.slice(0, 20).toString('hex'));
  }

  const salt = rawData.slice(8, 16);
  const ciphertext = rawData.slice(16);

  // EVP_BytesToKey (MD5, 1 iteration)
  const keySize = 32, ivSize = 16;
  let hash = Buffer.alloc(0);
  let result = Buffer.alloc(0);
  while (result.length < keySize + ivSize) {
    const md5 = crypto.createHash('md5');
    md5.update(hash);
    md5.update(Buffer.from(key, 'utf8'));
    md5.update(salt);
    hash = md5.digest();
    result = Buffer.concat([result, hash]);
  }

  const decipher = crypto.createDecipheriv('aes-256-cbc', result.slice(0, keySize), result.slice(keySize, keySize + ivSize));
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString('utf8');
}

// ===== Main =====
async function main() {
  const tmdbId = '550';
  const imdbId = 'tt0137523';

  console.log('=== Step 1: Generate b35ebba4 key ===');
  const b35ebba4 = generateB35ebba4(tmdbId);
  console.log('b35ebba4:', b35ebba4);

  console.log('\n=== Step 2: Fetch encrypted data from API ===');
  const endpoints = [
    '/cdn/sources-with-title',
    '/mb-flix/sources-with-title',
    '/1movies/sources-with-title',
    '/moviebox/sources-with-title',
    '/m4uhd/sources-with-title',
  ];

  for (const endpoint of endpoints) {
    const params = new URLSearchParams({
      title: 'Fight Club',
      mediaType: 'Movie',
      year: '1999',
      totalSeasons: '0',
      episodeId: '0',
      seasonId: '0',
      tmdbId,
      imdbId,
    });
    const url = `https://api.videasy.to${endpoint}?${params}`;

    try {
      const res = await fetch(url, {
        headers: {
          'Origin': 'https://player.videasy.to',
          'Referer': 'https://player.videasy.to/',
        }
      });
      const text = await res.text();

      if (text.startsWith('{')) {
        console.log(`${endpoint}: ERROR - ${text.substring(0, 150)}`);
        continue;
      }

      console.log(`\n${endpoint}: GOT ENCRYPTED DATA (${text.length} chars)`);
      console.log('First 50 hex chars:', text.substring(0, 50));

      // Step 3: WASM decrypt
      console.log('\n=== Step 3: WASM decrypt ===');
      const wasmModule = await WebAssembly.instantiate(wasmBuffer, imports);
      wasmExports = wasmModule.instance.exports;
      memory = wasmExports.memory;

      const ptr = allocString(text);
      const decryptedPtr = wasmExports.decrypt(ptr, parseFloat(tmdbId));

      if (!decryptedPtr) {
        console.log('WASM decrypt returned null');
        continue;
      }

      const expectedLen = Math.floor(text.length / 2);
      const wasmDecrypted = readWasmString(decryptedPtr, expectedLen);
      console.log('WASM decrypted length:', wasmDecrypted.length);
      console.log('WASM decrypted (first 80):', wasmDecrypted.substring(0, 80));

      // Step 4: AES decrypt
      console.log('\n=== Step 4: AES decrypt ===');
      try {
        const finalJson = aesDecrypt(wasmDecrypted, b35ebba4);
        console.log('AES decrypted length:', finalJson.length);
        console.log('First 300 chars:', finalJson.substring(0, 300));

        // Parse and display sources
        const parsed = JSON.parse(finalJson);
        console.log('\n=== SOURCES ===');
        if (parsed.sources?.length > 0) {
          parsed.sources.forEach(s => {
            console.log(`  Quality: ${s.quality}, Size: ${s.size || 'N/A'}`);
            console.log(`    URL: ${s.url?.substring(0, 100)}`);
          });
        } else {
          console.log('  No sources found');
          console.log('  Keys:', Object.keys(parsed));
        }
        if (parsed.subtitles?.length > 0) {
          console.log(`\nSubtitles (${parsed.subtitles.length}):`);
          parsed.subtitles.slice(0, 5).forEach(s => {
            console.log(`  ${s.lang || s.label}: ${s.url?.substring(0, 80)}`);
          });
        }
        break; // Success! Stop trying other endpoints
      } catch(e) {
        console.log('AES decrypt failed:', e.message);

        // Critical test: try empty key (since encode(hexString) returns "")
        console.log('\nTrying with EMPTY KEY (as encode(hexString) returns "")...');
        try {
          const result = aesDecrypt(wasmDecrypted, '');
          console.log('SUCCESS with empty key!');
          console.log('Result:', result.substring(0, 500));
          const parsed = JSON.parse(result);
          console.log('\n=== SOURCES ===');
          if (parsed.sources) {
            parsed.sources.forEach(s => {
              console.log(`  Quality: ${s.quality}, Size: ${s.size || 'N/A'}`);
              console.log(`    URL: ${s.url?.substring(0, 120)}`);
            });
          }
          if (parsed.subtitles) {
            console.log(`\nSubtitles (${parsed.subtitles.length}):`);
            parsed.subtitles.slice(0, 5).forEach(s => {
              console.log(`  ${s.lang || s.label}: ${s.url?.substring(0, 80)}`);
            });
          }
          break;
        } catch(e2) {
          console.log('Empty key failed:', e2.message);
        }

        // Try with various key interpretations
        console.log('\nTrying alternative keys...');
        // The XOR hex result without encodeHex
        const hexOnly = xorTransform(tmdbId + 'd486ae1ce6fdbe63b60bd1704541fcf0');
        for (const altKey of [
          b35ebba4,
          hexOnly, // just the hex string directly as key
          hexOnly.replace(/^0+/, ''), // strip leading zeros
        ]) {
          try {
            const result = aesDecrypt(wasmDecrypted, altKey);
            console.log(`Success with key: "${altKey.substring(0, 50)}..."`);
            console.log('Result:', result.substring(0, 300));
            break;
          } catch(e2) {
            console.log(`  Failed: ${altKey.substring(0, 30)}...`);
          }
        }
      }
    } catch(e) {
      console.log(`${endpoint}: fetch error - ${e.message}`);
    }
  }
}

main().catch(console.error);
