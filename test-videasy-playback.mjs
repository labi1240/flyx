/**
 * Videasy Playback E2E Test
 * Full pipeline: Extract → WASM decrypt → AES decrypt → stream proxy → segment
 */
import { readFileSync } from 'fs';
import crypto from 'crypto';

const CF_WORKER = 'https://media-proxy.vynx-3b3.workers.dev';
const TMDB_ID = '550'; // Fight Club
const TITLE = 'Fight Club';
const TYPE = 'movie';

// ── MD5 bytes (for EVP_BytesToKey) ──
function md5bytes(data) {
  const len = data.length;
  const totalLen = len + 1 + ((len + 1) % 64 < 56 ? 56 - (len + 1) % 64 : 120 - (len + 1) % 64) + 8;
  const words = new Uint8Array(totalLen);
  words.set(data, 0);
  words[len] = 0x80;
  const view = new DataView(words.buffer);
  view.setUint32(totalLen - 8, (len * 8) & 0xffffffff, true);
  view.setUint32(totalLen - 4, ((len * 8) / 0x100000000) | 0, true);

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
      let f, g;
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

function deriveKeyIv(salt, password) {
  const pwBytes = new TextEncoder().encode(password);
  let hash = new Uint8Array(0);
  let derived = new Uint8Array(0);
  while (derived.length < 48) {
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
  return { key: derived.slice(0, 32), iv: derived.slice(32, 48) };
}

async function aesDecrypt(base64Data, password) {
  const binary = atob(base64Data);
  const raw = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);

  if (raw.length < 16) throw new Error('Data too short');
  if (new TextDecoder().decode(raw.slice(0, 8)) !== 'Salted__') throw new Error('Not OpenSSL format');

  const salt = raw.slice(8, 16);
  const ciphertext = raw.slice(16);
  const { key, iv } = deriveKeyIv(salt, password);

  const toBuf = (d) => { const b = new ArrayBuffer(d.byteLength); new Uint8Array(b).set(d); return b; };
  const cryptoKey = await crypto.subtle.importKey('raw', toBuf(key), { name: 'AES-CBC' }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: toBuf(iv) }, cryptoKey, toBuf(ciphertext));
  return new TextDecoder().decode(plaintext);
}

// ── WASM helpers ──
function allocString(exports, memory, str) {
  const byteLen = str.length * 2;
  const ptr = exports.__new(byteLen, 2);
  const buf = new Uint8Array(memory.buffer);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    buf[ptr + i * 2] = code & 0xff;
    buf[ptr + i * 2 + 1] = (code >> 8) & 0xff;
  }
  return ptr;
}

function readString(memory, ptr, maxChars) {
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

const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m', RESET = '\x1b[0m';

async function main() {
  let passed = 0;
  let failed = 0;
  const PASS = (msg) => { passed++; console.log(`${GREEN}✓${RESET} ${msg}`); };
  const FAIL = (msg) => { failed++; console.log(`${RED}✗${RESET} ${msg}`); };
  const INFO = (msg) => console.log(`${CYAN}  ℹ${RESET} ${msg}`);

  console.log(`${CYAN}═══ Videasy Playback E2E Test ═══${RESET}\n`);

  // ── STEP 1: Extract hex data from CF Worker ──
  console.log(`${CYAN}[1/7] Fetching hex from CF Worker /videasy/extract...${RESET}`);
  let hexData;
  try {
    const res = await fetch(`${CF_WORKER}/videasy/extract?tmdbId=${TMDB_ID}&type=${TYPE}&title=${encodeURIComponent(TITLE)}`);
    if (!res.ok) { FAIL(`Extract HTTP ${res.status}`); return summary(passed, failed); }
    const data = await res.json();
    if (!data.success || !data.hexData) { FAIL(`Extract failed: ${data.error}`); return summary(passed, failed); }
    hexData = data.hexData;
    PASS(`Got ${hexData.length} chars of hex data`);
  } catch (e) { FAIL(`Extract error: ${e.message}`); return summary(passed, failed); }

  // ── STEP 2: WASM decrypt ──
  console.log(`\n${CYAN}[2/7] Loading WASM module...${RESET}`);
  let exports, memory;
  try {
    const wasmBuffer = readFileSync('public/videasy-module-patched.wasm').buffer;
    const mod = await WebAssembly.instantiate(wasmBuffer, {
      env: {
        seed() { return Date.now() * Math.random(); },
        abort(p,f,l,c) { throw new Error(`WASM abort at ${f}:${l}`); },
      },
    });
    exports = mod.instance.exports;
    memory = exports.memory;
    PASS('WASM loaded');
  } catch (e) { FAIL(`WASM load: ${e.message}`); return summary(passed, failed); }

  console.log(`\n${CYAN}[3/7] WASM decrypt (stream cipher, key=tmdbId)...${RESET}`);
  let wasmDecrypted;
  try {
    const ptr = allocString(exports, memory, hexData);
    const decryptedPtr = exports.decrypt(ptr, parseFloat(TMDB_ID));
    if (!decryptedPtr) { FAIL('WASM decrypt returned null'); return summary(passed, failed); }
    wasmDecrypted = readString(memory, decryptedPtr, Math.floor(hexData.length / 2));
    PASS(`WASM decrypt: ${wasmDecrypted.length} chars`);
    INFO(`First 80: ${wasmDecrypted.substring(0, 80)}`);
  } catch (e) { FAIL(`WASM decrypt: ${e.message}`); return summary(passed, failed); }

  // ── STEP 3: AES decrypt ──
  console.log(`\n${CYAN}[4/7] AES-256-CBC decrypt (key="")...${RESET}`);
  let sources;
  try {
    const json = await aesDecrypt(wasmDecrypted, '');
    const parsed = JSON.parse(json);
    sources = (parsed.sources || []).filter(s => s.url);
    PASS(`AES decrypt: ${sources.length} sources found`);
    for (const s of sources.slice(0, 3)) {
      INFO(`${s.quality} | ${s.type} | ${s.url?.substring(0, 80)}...`);
    }
    if (parsed.subtitles?.length) INFO(`${parsed.subtitles.length} subtitle tracks`);
  } catch (e) { FAIL(`AES decrypt: ${e.message}`); return summary(passed, failed); }

  if (sources.length === 0) {
    FAIL('No playable sources');
    return summary(passed, failed);
  }

  // ── STEP 4: Test stream proxy with the first m3u8 URL ──
  const source = sources[0];
  const m3u8Url = source.url;
  const referer = source.referer || 'https://player.videasy.net/';

  console.log(`\n${CYAN}[5/7] Fetching m3u8 through stream proxy...${RESET}`);
  const proxyUrl = `${CF_WORKER}/stream?url=${encodeURIComponent(m3u8Url)}&source=videasy&referer=${encodeURIComponent(referer)}`;
  INFO(`Proxy URL: ${proxyUrl.substring(0, 100)}...`);

  let m3u8Body;
  try {
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(30000) });
    INFO(`Status: ${res.status} | Content-Type: ${res.headers.get('content-type')}`);
    if (!res.ok) {
      const errText = await res.text();
      FAIL(`Stream proxy returned ${res.status}: ${errText.substring(0, 200)}`);
      return summary(passed, failed);
    }
    m3u8Body = await res.text();
    if (m3u8Body.includes('#EXTM3U')) {
      PASS(`m3u8 valid (${m3u8Body.length} chars)`);
      INFO(`First 200 chars:\n${m3u8Body.substring(0, 200)}`);
    } else {
      FAIL(`Not a valid m3u8: ${m3u8Body.substring(0, 200)}`);
      return summary(passed, failed);
    }
  } catch (e) { FAIL(`Stream proxy fetch: ${e.message}`); return summary(passed, failed); }

  // ── STEP 5: Parse m3u8, check URL rewriting ──
  console.log(`\n${CYAN}[6/7] Parsing m3u8 and verifying URL rewriting...${RESET}`);
  const lines = m3u8Body.split('\n');
  const isMaster = m3u8Body.includes('#EXT-X-STREAM-INF');
  INFO(`Type: ${isMaster ? 'MASTER' : 'MEDIA'}`);

  // Check EXT-X-KEY
  let keyUrl = null;
  const keyLine = lines.find(l => l.includes('EXT-X-KEY'));
  if (keyLine) {
    const uriMatch = keyLine.match(/URI="([^"]+)"/);
    if (uriMatch) {
      keyUrl = uriMatch[1];
      const proxied = keyUrl.includes('/stream?');
      proxied ? PASS(`EXT-X-KEY proxied`) : FAIL(`EXT-X-KEY NOT proxied: ${keyUrl.substring(0, 80)}`);
    }
  } else {
    INFO('No encryption (no EXT-X-KEY)');
  }

  // Get URL lines
  const urlLines = lines.filter(l => l.trim() && !l.startsWith('#'));
  const allProxied = urlLines.every(l => l.includes('/stream?'));
  allProxied ? PASS(`All ${urlLines.length} URL lines proxied`) :
    FAIL(`Some URLs not proxied: ${urlLines.filter(l => !l.includes('/stream?')).slice(0, 2).join(', ')}`);

  // Pick a target (media playlist or first segment)
  let segmentTestUrl;
  let usedMediaPlaylist = false;

  if (isMaster) {
    // For master: fetch first media playlist, then its first segment
    const mediaUrl = urlLines[0];
    INFO(`Fetching media playlist: ${mediaUrl.substring(0, 100)}...`);
    try {
      const mediaRes = await fetch(mediaUrl, { signal: AbortSignal.timeout(30000) });
      if (mediaRes.ok) {
        const mediaBody = await mediaRes.text();
        const mediaLines = mediaBody.split('\n');
        const segLines = mediaLines.filter(l => l.trim() && !l.startsWith('#'));
        if (segLines.length > 0) {
          segmentTestUrl = segLines[0];
          usedMediaPlaylist = true;
          PASS(`Media playlist OK, ${segLines.length} segments`);
        } else {
          FAIL('Media playlist has no segment URLs');
        }
      } else {
        FAIL(`Media playlist HTTP ${mediaRes.status}`);
      }
    } catch (e) { FAIL(`Media playlist: ${e.message}`); }
  } else {
    segmentTestUrl = urlLines[0];
  }

  // ── STEP 6: Fetch a segment ──
  if (segmentTestUrl) {
    console.log(`\n${CYAN}[7/7] Fetching segment through proxy...${RESET}`);
    INFO(`URL: ${segmentTestUrl.substring(0, 100)}...`);
    try {
      const segRes = await fetch(segmentTestUrl, { signal: AbortSignal.timeout(30000) });
      const buf = await segRes.arrayBuffer();
      const bytes = new Uint8Array(buf);
      INFO(`Status: ${segRes.status} | Size: ${bytes.length} bytes`);
      INFO(`First 16 bytes: ${Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

      if (segRes.ok && bytes.length > 100) {
        const firstByte = bytes[0];
        const isTs = firstByte === 0x47;
        const isFmp4 = bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0;
        const isEncrypted = !isTs && !isFmp4 && bytes[0] !== 0x7B /* JSON */ && bytes[0] !== 0x3C /* HTML */;

        if (isTs) PASS('Segment is valid MPEG-TS');
        else if (isFmp4) PASS('Segment is valid fMP4');
        else if (isEncrypted) INFO('Segment appears encrypted (AES-128) — expected with EXT-X-KEY');
        else FAIL(`Unexpected segment content (0x${firstByte.toString(16)})`);

        // Check TS sync bytes at 188-byte intervals (for unencrypted TS)
        if (isTs) {
          let syncs = 0;
          for (let i = 0; i < Math.min(bytes.length, 188*5); i += 188) {
            if (bytes[i] === 0x47) syncs++;
          }
          syncs >= 2 ? PASS(`TS sync bytes confirmed (${syncs} found)`) : FAIL(`TS sync check: only ${syncs} found`);
        }
      } else if (!segRes.ok) {
        const errText = await new Response(buf).text();
        FAIL(`Segment HTTP ${segRes.status}: ${errText.substring(0, 200)}`);
      } else {
        FAIL(`Segment too small (${bytes.length} bytes)`);
      }
    } catch (e) { FAIL(`Segment fetch: ${e.message}`); }
  }

  // ── STEP 7: Test encryption key fetch ──
  if (keyUrl) {
    console.log(`\n${CYAN}[BONUS] Fetching encryption key...${RESET}`);
    try {
      const keyRes = await fetch(keyUrl, { signal: AbortSignal.timeout(15000) });
      const keyBuf = await keyRes.arrayBuffer();
      INFO(`Key status: ${keyRes.status} | Size: ${keyBuf.byteLength} bytes`);
      keyRes.ok && keyBuf.byteLength === 16 ? PASS('KEY: 16 bytes (AES-128)') :
        keyRes.ok ? FAIL(`KEY wrong size: ${keyBuf.byteLength}`) :
        FAIL(`KEY HTTP ${keyRes.status}`);
    } catch (e) { FAIL(`KEY: ${e.message}`); }
  }

  summary(passed, failed);
}

function summary(passed, failed) {
  console.log(`\n${CYAN}═══════════════════════════════════════${RESET}`);
  console.log(`  ${GREEN}Pass: ${passed}${RESET} | ${failed > 0 ? RED : GREEN}Fail: ${failed}${RESET}`);
  console.log(`${CYAN}═══════════════════════════════════════${RESET}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
