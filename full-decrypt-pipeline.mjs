// Full decrypt pipeline: XOR transform → encodeHex → API → WASM decrypt → AES decrypt
import { readFileSync } from 'fs';
import crypto from 'crypto';

// Load WASM
const wasmBuffer = readFileSync('videasy-module-patched.wasm');

let wasmExports, memory;

const imports = {
  env: {
    seed() { return 12345.6789; },
    abort(msgPtr, filePtr, line, column) {
      throw new Error('WASM abort');
    }
  }
};

function readFullString(ptr) {
  if (!ptr) return '(null)';
  const buf = new Uint8Array(memory.buffer);
  const chars = [];
  let zeroCount = 0;
  for (let i = ptr; i < buf.length - 1; i += 2) {
    const code = buf[i] | (buf[i + 1] << 8);
    if (code === 0) { zeroCount++; if (zeroCount > 10) break; }
    else zeroCount = 0;
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

// ===== Hashids implementation (extracted from chunk) =====
function createHashids(salt = '', minLength = 0,
  alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
  separators = 'cfhistuCFHISTU') {

  const s = arr => [...new Set(arr)];
  const n = (arr, exclude) => arr.filter(x => !exclude.includes(x));
  const i = (arr, include) => arr.filter(x => include.includes(x));

  function shuffle(arr, salt) {
    if (salt.length === 0) return arr;
    let result = [...arr];
    let saltIdx = 0, acc = 0;
    for (let idx = result.length - 1; idx > 0; idx--, saltIdx++) {
      saltIdx %= salt.length;
      acc += salt[saltIdx].codePointAt(0);
      const j = (salt[saltIdx].codePointAt(0) + saltIdx + acc) % idx;
      const tmp = result[idx];
      result[idx] = result[j];
      result[j] = tmp;
    }
    return result;
  }

  function toAlphabet(input, alphabet) {
    let result = [];
    let val = input;
    if (typeof val === 'bigint') {
      const len = BigInt(alphabet.length);
      do {
        result.unshift(alphabet[Number(val % len)]);
        val /= len;
      } while (val > BigInt(0));
    } else {
      do {
        result.unshift(alphabet[val % alphabet.length]);
        val = Math.floor(val / alphabet.length);
      } while (val > 0);
    }
    return result;
  }

  function fromAlphabet(input, alphabet) {
    return input.reduce((result, char) => {
      const idx = alphabet.indexOf(char);
      if (idx === -1) throw Error(`Invalid character ${char}`);
      if (typeof result === 'bigint') return result * BigInt(alphabet.length) + BigInt(idx);
      const val = result * alphabet.length + idx;
      return Number.isSafeInteger(val) ? val : BigInt(result) * BigInt(alphabet.length) + BigInt(idx);
    }, 0);
  }

  function escapeRegExp(str) {
    return str.replace(/[\s#$()*+,.?[\\\]^{|}-]/g, '\\$&');
  }

  const saltArr = Array.from(salt);
  let alpha = s(Array.from(alphabet));
  if (alpha.length < 16) throw Error('alphabet must contain at least 16 unique characters');

  alpha = n(alpha, Array.from(separators));
  let seps = shuffle(i(Array.from(separators), alpha), saltArr);
  if (seps.length === 0 || alpha.length / seps.length > 3.5) {
    let count = Math.ceil(alpha.length / 3.5);
    if (count > seps.length) {
      const diff = count - seps.length;
      seps.push(...alpha.slice(0, diff));
      alpha = alpha.slice(diff);
    }
  }
  alpha = shuffle(alpha, saltArr);

  const guardCount = Math.ceil(alpha.length / 12);
  let guards;
  if (alpha.length < 3) {
    guards = seps.slice(0, guardCount);
    seps = seps.slice(guardCount);
  } else {
    guards = alpha.slice(0, guardCount);
    alpha = alpha.slice(guardCount);
  }

  const guardsRegExp = new RegExp(guards.map(g => escapeRegExp(g)).sort((a, b) => b.length - a.length).join('|'));
  const sepsRegExp = new RegExp(seps.map(s => escapeRegExp(s)).sort((a, b) => b.length - a.length).join('|'));
  const allowedCharsRegExp = new RegExp(`^[${[...alpha, ...guards, ...seps].map(c => escapeRegExp(c)).sort((a, b) => b.length - a.length).join('')}]+$`);

  function encode(...args) {
    let numbers = Array.isArray(args[0]) ? args[0] : (args[0] != null ? [args[0]] : []);
    if (args.length > 1) numbers = numbers.concat(args.slice(1));
    if (numbers.length === 0) return '';

    // Validate: all must be integer-like
    const isInt = x => typeof x === 'bigint' || (!Number.isNaN(Number(x)) && Math.floor(Number(x)) === Number(x));
    const isSafe = x => typeof x === 'bigint' || (x >= 0 && Number.isSafeInteger(x));

    // If any element fails the integer check, try parsing as BigInt string
    if (!numbers.every(isInt)) {
      numbers = numbers.map(x => {
        if (typeof x === 'bigint' || typeof x === 'number') return x;
        const str = String(x);
        if (!/^\+?\d+$/.test(str)) return Number.NaN; // not a decimal string
        const val = Number.parseInt(str, 10);
        return Number.isSafeInteger(val) ? val : BigInt(str);
      });
    }

    if (!numbers.every(isSafe)) return '';

    return _encode(numbers).join('');
  }

  function encodeHex(hex) {
    let str = hex;
    if (typeof str === 'bigint') str = str.toString(16);
    if (typeof str === 'string') {
      if (!/^[\dA-Fa-f]+$/.test(str)) return '';
    } else {
      throw Error(`Hashids: The provided value is neither a string, nor a BigInt`);
    }
    // Split into 12-char chunks, prepend "1", parse as hex
    const chunks = [];
    for (let i = 0; i < str.length; i += 12) {
      chunks.push(Number.parseInt('1' + str.slice(i, i + 12), 16));
    }
    return encode(chunks);
  }

  function _encode(numbers) {
    let alphaCopy = [...alpha];
    const hash = numbers.reduce((sum, num, idx) =>
      sum + (typeof num === 'bigint' ? Number(num % BigInt(idx + 100)) : num % (idx + 100)), 0);

    let result = [alphaCopy[hash % alphaCopy.length]];
    let lottery = [...result];

    numbers.forEach((num, idx) => {
      const buffer = lottery.concat(saltArr, alphaCopy);
      alphaCopy = shuffle(alphaCopy, buffer);
      const subst = toAlphabet(num, alphaCopy);
      result.push(...subst);
      if (idx + 1 < numbers.length) {
        const sepIdx = (subst[0].codePointAt(0) + idx) % seps.length;
        result.push(seps[Number(typeof num === 'bigint' ? num % BigInt(sepIdx) : num % sepIdx) % seps.length]);
      }
      lottery = [...result];
    });

    if (result.length < minLength) {
      const guardIdx = (hash + result[0].codePointAt(0)) % guards.length;
      result.unshift(guards[guardIdx]);
      if (result.length < minLength) {
        const guardIdx2 = (hash + result[2].codePointAt(0)) % guards.length;
        result.push(guards[guardIdx2]);
      }
    }

    const halfLen = Math.floor(alphaCopy.length / 2);
    while (result.length < minLength) {
      alphaCopy = shuffle(alphaCopy, alphaCopy);
      result.unshift(...alphaCopy.slice(halfLen));
      result.push(...alphaCopy.slice(0, halfLen));
      const excess = result.length - minLength;
      if (excess > 0) {
        const start = excess / 2;
        result = result.slice(start, start + minLength);
      }
    }

    return result;
  }

  return { encode, encodeHex };
}

// ===== XOR Transform (from movie chunk) =====
function xorTransform(input) {
  const keyStr = '8c465aa8af6cbfd4c1f91bf0c8d678ba';
  const keyBytes = Array.from(keyStr, c => c.charCodeAt(0));
  return Array.from(input, c => {
    return keyBytes.reduce((acc, kb) => acc ^ kb, c.charCodeAt(0));
  }).map(b => ('0' + Number(b).toString(16)).substr(-2)).join('');
}

// ===== b35ebba4 key generation =====
function generateB35ebba4(tmdbId) {
  const salt = 'd486ae1ce6fdbe63b60bd1704541fcf0';
  const hexString = xorTransform(tmdbId + salt);
  const hashids = createHashids();
  return hashids.encodeHex(hexString);
}

// ===== AES Decrypt (CryptoJS compatible) =====
function aesDecrypt(encryptedBase64, key) {
  // The encrypted data from WASM is "Salted__XXXXXXXX" + encrypted
  // This is OpenSSL format: "Salted__" (8 bytes) + salt (8 bytes) + ciphertext
  // CryptoJS uses its own format

  // Actually, looking at the structure more carefully:
  // WASM decrypt produces a base64 string that starts with "U2FsdGVkX1" = "Salted_"
  // which is OpenSSL/CryptoJS format.
  // CryptoJS.AES.decrypt(ciphertext, key) handles this format automatically.
  // The key is the b35ebba4 value.

  // In Node.js, we need to replicate CryptoJS.AES.decrypt
  // CryptoJS uses: EVP_BytesToKey(password, salt, keySize=256/32, ivSize=128/16)
  // with MD5 hash and 1 iteration

  const base64Data = encryptedBase64;
  const rawData = Buffer.from(base64Data, 'base64');

  // Check for "Salted__" prefix
  if (rawData.slice(0, 8).toString() === 'Salted__') {
    const salt = rawData.slice(8, 16);
    const ciphertext = rawData.slice(16);

    // EVP_BytesToKey: derive key and IV from password + salt
    const keySize = 32; // AES-256
    const ivSize = 16;  // AES block size

    const deriveKey = (password, salt, keySize, ivSize) => {
      let hash = Buffer.alloc(0);
      let result = Buffer.alloc(0);
      while (result.length < keySize + ivSize) {
        const md5 = crypto.createHash('md5');
        md5.update(hash);
        md5.update(password);
        md5.update(salt);
        hash = md5.digest();
        result = Buffer.concat([result, hash]);
      }
      return {
        key: result.slice(0, keySize),
        iv: result.slice(keySize, keySize + ivSize)
      };
    };

    const { key: derivedKey, iv } = deriveKey(Buffer.from(key, 'utf8'), salt, keySize, ivSize);

    const decipher = crypto.createDecipheriv('aes-256-cbc', derivedKey, iv);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('utf8');
  }

  // If no "Salted__" prefix, try raw
  const decipher = crypto.createDecipheriv('aes-256-cbc',
    Buffer.from(key, 'utf8').slice(0, 32),
    Buffer.alloc(16, 0));
  let decrypted = decipher.update(rawData);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString('utf8');
}

// ===== Main Flow =====
async function main() {
  console.log('=== Step 1: Generate b35ebba4 key ===');
  const tmdbId = '550';
  const b35ebba4 = generateB35ebba4(tmdbId);
  console.log('b35ebba4 key:', b35ebba4);
  console.log('Key length:', b35ebba4.length);

  // Also generate for a couple more
  console.log('\nKeys for different tmdbIds:');
  for (const id of ['550', '299534', '872585', '13804']) {
    console.log(`  ${id}: ${generateB35ebba4(id)}`);
  }

  console.log('\n=== Step 2: Fetch encrypted API data ===');
  const apiUrl = `https://api.videasy.net/downloader2/sources-with-title?tmdbId=${tmdbId}&type=movie&title=Fight+Club&season=0&episode=0`;
  console.log('API URL:', apiUrl);

  let encryptedHex;
  try {
    const res = await fetch(apiUrl, {
      headers: {
        'Origin': 'https://player.videasy.net',
        'Referer': 'https://player.videasy.net/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    encryptedHex = await res.text();
    console.log('API response status:', res.status);
    console.log('API response (first 200 chars):', encryptedHex.substring(0, 200));
    console.log('Response length:', encryptedHex.length);
  } catch(e) {
    console.error('API fetch error:', e.message);
    console.log('Will test with sample data instead');
    encryptedHex = null;
  }

  console.log('\n=== Step 3: Load WASM and decrypt ===');
  const wasmModule = await WebAssembly.instantiate(wasmBuffer, imports);
  wasmExports = wasmModule.instance.exports;
  memory = wasmExports.memory;

  if (encryptedHex && !encryptedHex.startsWith('{')) {
    console.log('Decrypting API response with WASM...');
    try {
      const ptr = allocString(encryptedHex);
      const decryptedPtr = wasmExports.decrypt(ptr, parseFloat(tmdbId));
      if (decryptedPtr) {
        // Read exactly the right number of bytes (hex input length / 2)
        const expectedLen = Math.floor(encryptedHex.length / 2);
        const wasmDecrypted = readWasmString(decryptedPtr, expectedLen);
        console.log('WASM decrypted length:', wasmDecrypted.length);
        console.log('WASM decrypted (first 100):', wasmDecrypted.substring(0, 100));

        // Now AES decrypt
        console.log('\n=== Step 4: AES decrypt with b35ebba4 ===');
        try {
          const finalJson = aesDecrypt(wasmDecrypted, b35ebba4);
          console.log('AES decrypted:', finalJson.substring(0, 500));
          try {
            const parsed = JSON.parse(finalJson);
            console.log('\n=== SOURCES ===');
            if (parsed.sources) {
              parsed.sources.slice(0, 5).forEach(s => console.log('  -', s.quality, s.url?.substring(0, 80)));
            }
            if (parsed.subtitles) {
              console.log('\nSubtitles:', parsed.subtitles.length);
              parsed.subtitles.slice(0, 3).forEach(s => console.log('  -', s.lang, s.url?.substring(0, 80)));
            }
          } catch(e) {
            console.log('JSON parse failed:', e.message);
          }
        } catch(e) {
          console.error('AES decrypt error:', e.message);
        }
      }
    } catch(e) {
      console.error('WASM decrypt error:', e.message);
    }
  } else {
    console.log('No encrypted data available (API returned error/unexpected response)');
    console.log('Response:', encryptedHex?.substring(0, 300));
  }
}

main().catch(console.error);
