/**
 * Videasy → VLC Playback Script
 *
 * Runs the full Videasy extraction pipeline and outputs a URL that can be
 * opened directly in VLC Media Player (Ctrl+N → paste URL → Play).
 *
 * Pipeline:
 *   1. Fetch encrypted hex from Videasy API (via CF Worker proxy)
 *   2. WASM stream cipher decrypt (keyed by TMDB ID)
 *   3. AES-256-CBC decrypt (key = "" always)
 *   4. Parse JSON → get best quality HLS .m3u8 URL
 *   5. Wrap through CF Worker /stream proxy (rewrites segment URLs, adds Referer)
 *   6. Output VLC-ready URL
 *
 * Why VLC works:
 *   - VLC sends no Origin/Referer headers → passes CF Worker anti-leech check
 *   - CF Worker rewrites all segment URLs in the .m3u8 to go through the proxy
 *   - CF Worker adds "Referer: https://player.videasy.net/" on upstream CDN fetches
 *
 * Usage:
 *   node scripts/videasy-vlc.mjs 550 movie "Fight Club"
 *   node scripts/videasy-vlc.mjs 1396 tv "Breaking Bad" 1 1
 *   node scripts/videasy-vlc.mjs 157336 movie "Interstellar"
 *
 * Options:
 *   --direct    Fetch from api.videasy.net directly (bypasses CF Worker)
 *   --quality   Preferred quality: 2160p, 1080p, 720p, 480p, auto (default: 1080p)
 *   --all       List all available sources instead of picking best
 */

import { readFileSync } from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATCHED_WASM = path.join(__dirname, "..", "public", "videasy-module-patched.wasm");

// ─── Config ──────────────────────────────────────────────────────────
const CF_WORKER_BASE = "https://media-proxy.vynx-3b3.workers.dev";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const VIDEOASY_HEADERS = {
  Origin: "https://player.videasy.net",
  Referer: "https://player.videasy.net/",
  "User-Agent": UA,
};

// ─── CLI Args ────────────────────────────────────────────────────────
const args = process.argv.slice(2);

let useDirect = false;
let preferredQuality = "1080p";
let listAll = false;

const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--direct") useDirect = true;
  else if (args[i] === "--quality") preferredQuality = args[++i];
  else if (args[i] === "--all") listAll = true;
  else positional.push(args[i]);
}

const [tmdbId, type, title, season, episode] = positional;

if (!tmdbId || !type || !title) {
  console.error("Usage: node scripts/videasy-vlc.mjs <tmdbId> <movie|tv> <title> [season] [episode] [--direct] [--quality 1080p] [--all]");
  console.error("");
  console.error("Examples:");
  console.error("  node scripts/videasy-vlc.mjs 550 movie \"Fight Club\"");
  console.error("  node scripts/videasy-vlc.mjs 1396 tv \"Breaking Bad\" 1 1");
  console.error("  node scripts/videasy-vlc.mjs 157336 movie \"Interstellar\" --quality 2160p");
  process.exit(1);
}

if (type === "tv" && (!season || !episode)) {
  console.error("Error: season and episode required for TV shows");
  process.exit(1);
}

// ─── WASM Singleton ──────────────────────────────────────────────────
let wasmExports, wasmMemory;
async function loadWasm() {
  if (wasmExports) return;
  const buf = readFileSync(PATCHED_WASM);
  const mod = await WebAssembly.instantiate(buf, {
    env: {
      seed() { return Date.now() * Math.random(); },
      abort() { throw new Error("WASM abort"); },
    },
  });
  wasmExports = mod.instance.exports;
  wasmMemory = wasmExports.memory;
}

function allocWasmString(str) {
  const byteLen = str.length * 2;
  const ptr = wasmExports.__new(byteLen, 2);
  const buf = new Uint8Array(wasmMemory.buffer); // fresh view AFTER __new (may grow memory)
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    buf[ptr + i * 2] = code & 0xff;
    buf[ptr + i * 2 + 1] = (code >> 8) & 0xff;
  }
  return ptr;
}

function readWasmString(ptr, maxChars) {
  if (!ptr) return "";
  const buf = new Uint8Array(wasmMemory.buffer);
  let result = "";
  const limit = Math.min(ptr + maxChars * 2, buf.length - 1);
  for (let i = ptr; i < limit; i += 2) {
    const code = buf[i] | (buf[i + 1] << 8);
    if (code === 0) break;
    result += String.fromCharCode(code);
  }
  return result;
}

// ─── Step 1: Fetch hex from Videasy API ──────────────────────────────
async function fetchHex() {
  if (useDirect) {
    return fetchHexDirect();
  }
  return fetchHexViaCfWorker();
}

async function fetchHexViaCfWorker() {
  const params = new URLSearchParams({ tmdbId, type, title });
  if (type === "tv") {
    params.set("season", season);
    params.set("episode", episode);
  }

  const url = `${CF_WORKER_BASE}/videasy/extract?${params}`;
  console.log(`[1/4] Fetching hex via CF Worker...`);
  console.log(`      ${url.substring(0, 100)}...`);

  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`CF Worker returned ${res.status}: ${errText.substring(0, 200)}`);
  }

  const data = await res.json();
  if (!data.success || !data.hexData) {
    throw new Error(`CF Worker error: ${data.error || "no hex data"}`);
  }

  console.log(`      ✓ Got ${data.hexData.length} hex chars via endpoint: ${data.endpoint || "unknown"}`);
  return data.hexData;
}

async function fetchHexDirect() {
  const params = new URLSearchParams({
    title,
    mediaType: type === "tv" ? "TV Series" : "Movie",
    year: "",
    totalSeasons: type === "tv" ? "5" : "0",
    episodeId: type === "tv" ? episode : "0",
    seasonId: type === "tv" ? season : "0",
    tmdbId,
    imdbId: "",
  });

  // Try endpoints in priority order
  const endpoints = ["/cdn/sources-with-title", "/mb-flix/sources-with-title"];
  console.log(`[1/4] Fetching hex directly from api.videasy.net...`);

  for (const endpoint of endpoints) {
    const url = `https://api.videasy.net${endpoint}?${params}`;
    try {
      const res = await fetch(url, {
        headers: VIDEOASY_HEADERS,
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();

      if (text.startsWith("{")) {
        console.log(`      ${endpoint}: JSON error — ${text.substring(0, 100)}`);
        continue;
      }
      if (!/^[0-9a-fA-F]+$/.test(text.trim())) {
        console.log(`      ${endpoint}: doesn't look like hex — skipping`);
        continue;
      }

      console.log(`      ✓ Got ${text.length} hex chars from ${endpoint}`);
      return text.trim();
    } catch (e) {
      console.log(`      ${endpoint}: ${e.message}`);
    }
  }

  throw new Error("All direct API endpoints failed");
}

// ─── Step 2: WASM stream cipher decrypt ──────────────────────────────
function wasmDecrypt(hexData) {
  console.log(`[2/4] WASM decrypt — ${hexData.length} hex chars, key=tmdbId=${parseFloat(tmdbId)}`);
  const ptr = allocWasmString(hexData);
  const decryptedPtr = wasmExports.decrypt(ptr, parseFloat(tmdbId));

  if (!decryptedPtr) {
    throw new Error("WASM decrypt returned NULL — verification failed (g_sb patched?)");
  }

  const expectedLen = Math.floor(hexData.length / 2);
  const result = readWasmString(decryptedPtr, expectedLen);
  console.log(`      ✓ Decrypted: ${result.length} chars (expects ~${expectedLen})`);
  return result;
}

// ─── Step 3: AES-256-CBC decrypt ─────────────────────────────────────
function aesDecrypt(base64Data) {
  console.log(`[3/4] AES-256-CBC decrypt — ${base64Data.length} base64 chars, key=""`);

  const raw = Buffer.from(base64Data, "base64");
  if (raw.length < 16) throw new Error("Data too short for salted format");
  if (raw.slice(0, 8).toString() !== "Salted__") throw new Error("Not OpenSSL salted format");

  const salt = raw.slice(8, 16);
  const ciphertext = raw.slice(16);

  // EVP_BytesToKey (MD5, 1 iteration) → 256-bit key + 128-bit IV
  const keySize = 32, ivSize = 16;
  const pwBytes = Buffer.from("", "utf8");
  let hash = Buffer.alloc(0);
  let derived = Buffer.alloc(0);

  while (derived.length < keySize + ivSize) {
    const md5 = crypto.createHash("md5");
    md5.update(hash);
    md5.update(pwBytes);
    md5.update(salt);
    hash = md5.digest();
    derived = Buffer.concat([derived, hash]);
  }

  const key = derived.slice(0, keySize);
  const iv = derived.slice(keySize, keySize + ivSize);

  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(true);
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  const json = decrypted.toString("utf8");
  console.log(`      ✓ Decrypted: ${json.length} chars of JSON`);
  return json;
}

// ─── Step 4: Parse sources & build VLC URL ──────────────────────────
function buildVlcUrl(sources, subtitles) {
  console.log(`[4/4] Processing ${sources.length} sources...`);

  if (!sources.length) {
    throw new Error("No sources in decrypted payload");
  }

  // Quality ranking for selection
  const qualityRank = { "2160p": 6, "4k": 6, "1440p": 5, "1080p": 4, "720p": 3, "480p": 2, "360p": 1, auto: 0 };

  // Sort by quality preference
  const sorted = [...sources].sort((a, b) => {
    const aRank = qualityRank[a.quality?.toLowerCase()] || 0;
    const bRank = qualityRank[b.quality?.toLowerCase()] || 0;
    return bRank - aRank;
  });

  if (listAll) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  All Videasy Sources for "${title}" (${tmdbId})`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      const rawUrl = s.url || "";
      const wrapped = rawUrl ? wrapUrl(rawUrl) : "(no URL)";
      console.log(`\n  [${i + 1}] ${s.quality || "auto"} — ${s.server || "videasy"}`);
      console.log(`      Raw:    ${rawUrl.substring(0, 100)}...`);
      console.log(`      VLC:    ${wrapped}`);
    }

    if (subtitles?.length) {
      console.log(`\n  ─── Subtitles (${subtitles.length}) ───`);
      for (const sub of subtitles.slice(0, 10)) {
        console.log(`  ${sub.lang || sub.language || "?"}: ${sub.url?.substring(0, 80)}`);
      }
    }
    return;
  }

  // Find best match for preferred quality
  const targetQ = preferredQuality.toLowerCase();
  let best = sorted[0]; // default: highest quality

  // Try exact match first, then closest
  const exact = sorted.find(s => s.quality?.toLowerCase() === targetQ);
  if (exact) best = exact;

  if (!best.url) {
    // Find first source with a URL
    const withUrl = sorted.find(s => s.url);
    if (!withUrl) throw new Error("No sources have URLs");
    best = withUrl;
  }

  const rawUrl = best.url;
  const vlcUrl = wrapUrl(rawUrl);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  🎬 ${title} (TMDB ${tmdbId})`);
  console.log(`  📺 Quality: ${best.quality || "auto"}  |  Server: ${best.server || "videasy"}  |  Type: ${best.type || "hls"}`);
  if (subtitles?.length) {
    const langs = [...new Set(subtitles.map(s => s.lang || s.language).filter(Boolean))];
    console.log(`  💬 Subtitles: ${subtitles.length} track(s) — ${langs.slice(0, 6).join(", ")}${langs.length > 6 ? "..." : ""}`);
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`\n  ▶ VLC URL (Ctrl+N → paste → Play):\n`);
  console.log(`  ${vlcUrl}\n`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // Also print raw URLs for all sources as a quick reference
  console.log(`\n  All sources (${sorted.length}):`);
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const marker = s === best ? "★" : " ";
    console.log(`  ${marker} ${s.quality || "auto".padEnd(6)} | ${(s.server || "videasy").padEnd(12)} | ${(s.url || "").substring(0, 70)}...`);
  }
}

function wrapUrl(rawUrl) {
  // Videasy source URLs may already contain percent-encoded characters
  // (e.g. %3D for = in base64 tokens). decodeURIComponent handles one level.
  // We fully decode then re-encode to avoid double-encoding when the URL
  // passes through the CF Worker's searchParams.get() which decodes once.
  let decoded = rawUrl;
  let prev = "";
  while (decoded !== prev) {
    prev = decoded;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      break; // invalid percent sequence — stop decoding
    }
  }

  const encodedUrl = encodeURIComponent(decoded);
  const encodedReferer = encodeURIComponent("https://player.videasy.net/");
  return `${CF_WORKER_BASE}/stream?url=${encodedUrl}&source=videasy&referer=${encodedReferer}`;
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🎯 Videasy → VLC: "${title}" (${type}, tmdbId=${tmdbId})`);
  if (type === "tv") console.log(`   S${season}E${episode}`);
  console.log(`   Source: ${useDirect ? "api.videasy.net (direct)" : "CF Worker proxy"}`);
  console.log("");

  // Load WASM first
  await loadWasm();

  // Step 1: Fetch hex
  const hexData = await fetchHex();

  // Step 2: WASM decrypt
  const wasmResult = wasmDecrypt(hexData);

  // Step 3: AES decrypt
  const json = aesDecrypt(wasmResult);

  // Step 4: Parse and output
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    console.error(`\n❌ JSON parse failed: ${e.message}`);
    console.error(`   Raw (first 300): ${json.substring(0, 300)}`);
    process.exit(1);
  }

  buildVlcUrl(parsed.sources || [], parsed.subtitles || []);
}

main().catch((e) => {
  console.error(`\n❌ Error: ${e.message}`);
  process.exit(1);
});
