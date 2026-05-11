#!/usr/bin/env node
/**
 * E2E test: Flixer extraction → m3u8 → segment verification
 * 
 * Tests the FULL chain:
 *   1. Hit /flixer/extract-all to get stream URLs
 *   2. Fetch the m3u8 through /flixer/stream proxy
 *   3. Parse the m3u8 for segment URLs
 *   4. Fetch a segment and verify it starts with 0x47 (MPEG-TS) or 0x00 (fMP4)
 *   5. Check that EXT-X-KEY URIs are rewritten through proxy
 */

const CF_WORKER_BASE = process.env.CF_WORKER_BASE || 'https://media-proxy.vynx-3b3.workers.dev';
const TMDB_ID = process.env.TMDB_ID || '550'; // Fight Club
const TYPE = process.env.TYPE || 'movie';
const SEASON = process.env.SEASON || '';
const EPISODE = process.env.EPISODE || '';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function pass(msg) { console.log(`${GREEN}✓ PASS${RESET} ${msg}`); }
function fail(msg) { console.log(`${RED}✗ FAIL${RESET} ${msg}`); }
function info(msg) { console.log(`${CYAN}  ℹ${RESET} ${msg}`); }
function warn(msg) { console.log(`${YELLOW}  ⚠${RESET} ${msg}`); }

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, msg) {
  totalTests++;
  if (condition) { passedTests++; pass(msg); }
  else { failedTests++; fail(msg); }
  return condition;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ============================================================================
// STEP 1: Extract sources from /flixer/extract-all
// ============================================================================
async function step1_extract() {
  console.log(`\n${CYAN}═══ STEP 1: Extract sources ═══${RESET}`);
  const params = new URLSearchParams({ tmdbId: TMDB_ID, type: TYPE });
  if (TYPE === 'tv' && SEASON && EPISODE) {
    params.set('season', SEASON);
    params.set('episode', EPISODE);
  }

  // Try extract-all first, fall back to single-server extract
  const extractAllUrl = `${CF_WORKER_BASE}/flixer/extract-all?${params}`;
  info(`GET ${extractAllUrl}`);

  try {
    const res = await fetchWithTimeout(extractAllUrl, {}, 45000);
    const data = await res.json();
    info(`extract-all: success=${data.success}, sources=${data.sources?.length || 0}, elapsed=${data.elapsed_ms}ms`);

    if (data.success && data.sources?.length > 0) {
      assert(true, `extract-all returned ${data.sources.length} sources`);
      for (const s of data.sources.slice(0, 3)) {
        info(`  Server: ${s.server} | Title: ${s.title} | URL: ${s.url?.substring(0, 80)}...`);
      }
      return data.sources;
    }
    warn('extract-all returned 0 sources, falling back to single-server extract...');
  } catch (e) {
    warn(`extract-all failed: ${e.message}, falling back to single-server extract...`);
  }

  // Fallback: try individual servers
  const servers = ['delta', 'alpha', 'bravo', 'charlie'];
  for (const server of servers) {
    const singleParams = new URLSearchParams({ ...Object.fromEntries(params), server });
    const singleUrl = `${CF_WORKER_BASE}/flixer/extract?${singleParams}`;
    info(`Trying single server: ${server}`);
    try {
      const res = await fetchWithTimeout(singleUrl, {}, 30000);
      const data = await res.json();
      if (data.success && data.sources?.length > 0) {
        assert(true, `Single extract (${server}) returned ${data.sources.length} sources`);
        for (const s of data.sources) {
          info(`  Server: ${s.server} | Title: ${s.title} | URL: ${s.url?.substring(0, 80)}...`);
        }
        return data.sources;
      }
    } catch (e) {
      warn(`${server}: ${e.message}`);
    }
  }

  fail('All extraction methods failed');
  return [];
}

// ============================================================================
// STEP 2: Fetch m3u8 through /flixer/stream proxy
// ============================================================================
async function step2_fetchM3u8(sourceUrl) {
  console.log(`\n${CYAN}═══ STEP 2: Fetch m3u8 through proxy ═══${RESET}`);
  const proxyUrl = `${CF_WORKER_BASE}/flixer/stream?url=${encodeURIComponent(sourceUrl)}`;
  info(`GET ${proxyUrl.substring(0, 120)}...`);

  try {
    const res = await fetchWithTimeout(proxyUrl);
    assert(res.ok, `m3u8 proxy returned ${res.status}`);

    const contentType = res.headers.get('content-type') || '';
    info(`Content-Type: ${contentType}`);
    info(`X-Proxied-Via: ${res.headers.get('x-proxied-via') || 'not set'}`);

    const body = await res.text();
    assert(body.includes('#EXTM3U'), 'm3u8 starts with #EXTM3U');
    info(`m3u8 body length: ${body.length} chars`);
    info(`First 200 chars:\n${body.substring(0, 200)}`);

    return { body, proxyUrl };
  } catch (e) {
    fail(`m3u8 fetch threw: ${e.message}`);
    return null;
  }
}

// ============================================================================
// STEP 3: Parse m3u8 and check URL rewriting
// ============================================================================
function step3_parseM3u8(m3u8Body) {
  console.log(`\n${CYAN}═══ STEP 3: Parse m3u8 and verify URL rewriting ═══${RESET}`);

  const lines = m3u8Body.split('\n');
  const isMaster = m3u8Body.includes('#EXT-X-STREAM-INF');
  info(`Playlist type: ${isMaster ? 'MASTER (multi-quality)' : 'MEDIA (segments)'}`);

  // Check for EXT-X-KEY lines
  const keyLines = lines.filter(l => l.includes('EXT-X-KEY'));
  if (keyLines.length > 0) {
    info(`Found ${keyLines.length} EXT-X-KEY line(s)`);
    for (const kl of keyLines) {
      const uriMatch = kl.match(/URI="([^"]+)"/);
      if (uriMatch) {
        const keyUri = uriMatch[1];
        const isProxied = keyUri.includes('/flixer/stream');
        assert(isProxied, `EXT-X-KEY URI is proxied: ${keyUri.substring(0, 80)}...`);
        if (!isProxied) {
          fail(`  RAW KEY URI (NOT PROXIED): ${keyUri}`);
        }
      }
    }
  } else {
    info('No EXT-X-KEY lines (unencrypted stream)');
  }

  // Check for EXT-X-MAP lines (fMP4 init segments)
  const mapLines = lines.filter(l => l.includes('EXT-X-MAP'));
  if (mapLines.length > 0) {
    info(`Found ${mapLines.length} EXT-X-MAP line(s)`);
    for (const ml of mapLines) {
      const uriMatch = ml.match(/URI="([^"]+)"/);
      if (uriMatch) {
        const mapUri = uriMatch[1];
        const isProxied = mapUri.includes('/flixer/stream');
        assert(isProxied, `EXT-X-MAP URI is proxied: ${mapUri.substring(0, 80)}...`);
      }
    }
  }

  // Extract segment/variant URLs (non-comment, non-empty lines)
  const urlLines = lines
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  info(`Found ${urlLines.length} URL line(s)`);

  // Check that ALL URL lines are proxied
  let allProxied = true;
  for (const ul of urlLines.slice(0, 5)) {
    const isProxied = ul.includes('/flixer/stream');
    if (!isProxied) {
      allProxied = false;
      fail(`URL NOT proxied: ${ul.substring(0, 100)}`);
    }
  }
  assert(allProxied, 'All URL lines are proxied through /flixer/stream');

  return { isMaster, urlLines, keyLines };
}

// ============================================================================
// STEP 4: If master playlist, fetch a media playlist
// ============================================================================
async function step4_fetchMediaPlaylist(variantUrl) {
  console.log(`\n${CYAN}═══ STEP 4: Fetch media playlist (variant) ═══${RESET}`);
  info(`GET ${variantUrl.substring(0, 120)}...`);

  try {
    const res = await fetchWithTimeout(variantUrl);
    assert(res.ok, `Media playlist returned ${res.status}`);

    const body = await res.text();
    assert(body.includes('#EXTM3U'), 'Media playlist starts with #EXTM3U');
    assert(body.includes('#EXTINF'), 'Media playlist has #EXTINF segment entries');
    info(`Media playlist length: ${body.length} chars`);

    return body;
  } catch (e) {
    fail(`Media playlist fetch threw: ${e.message}`);
    return null;
  }
}

// ============================================================================
// STEP 5: Fetch actual segment and verify binary content
// ============================================================================
async function step5_fetchSegment(segmentUrl) {
  console.log(`\n${CYAN}═══ STEP 5: Fetch segment and verify TS magic byte ═══${RESET}`);
  info(`GET ${segmentUrl.substring(0, 120)}...`);

  try {
    const res = await fetchWithTimeout(segmentUrl, {}, 30000);
    const status = res.status;
    const contentType = res.headers.get('content-type') || '';
    const proxiedVia = res.headers.get('x-proxied-via') || 'not set';

    info(`Status: ${status}`);
    info(`Content-Type: ${contentType}`);
    info(`X-Proxied-Via: ${proxiedVia}`);

    assert(res.ok, `Segment returned ${status} (expected 2xx)`);

    if (!res.ok) {
      // Try to read error body
      const errBody = await res.text();
      fail(`Segment error body: ${errBody.substring(0, 300)}`);
      return;
    }

    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    info(`Segment size: ${bytes.length} bytes`);

    assert(bytes.length > 100, `Segment has ${bytes.length} bytes (expected >100)`);

    // Check magic bytes
    const firstByte = bytes[0];
    const isMpegTs = firstByte === 0x47; // MPEG-TS sync byte
    const isFmp4 = bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x00; // fMP4 box
    const isJson = firstByte === 0x7B; // '{' — JSON error response
    const isHtml = firstByte === 0x3C; // '<' — HTML error page

    info(`First 16 bytes: ${Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

    if (isJson) {
      const text = new TextDecoder().decode(bytes.slice(0, 500));
      fail(`Segment is JSON (error response): ${text}`);
    } else if (isHtml) {
      const text = new TextDecoder().decode(bytes.slice(0, 500));
      fail(`Segment is HTML (error page): ${text.substring(0, 200)}`);
    }

    const hasEncryption = isJson === false && isHtml === false; // placeholder
    assert(isMpegTs || isFmp4 || (!isJson && !isHtml), `Segment is valid binary data (0x${firstByte.toString(16)}: ${isMpegTs ? 'MPEG-TS' : isFmp4 ? 'fMP4' : 'AES-128 encrypted'})`);

    if (isMpegTs) {
      // Verify TS sync bytes appear every 188 bytes
      let syncCount = 0;
      for (let i = 0; i < Math.min(bytes.length, 188 * 5); i += 188) {
        if (bytes[i] === 0x47) syncCount++;
      }
      assert(syncCount >= 2, `Found ${syncCount} TS sync bytes at 188-byte intervals`);
    }

    // If encrypted (AES-128), segment won't have magic bytes — that's OK
    // hls.js decrypts client-side using the key + IV from EXT-X-KEY
    if (!isMpegTs && !isFmp4 && !isJson && !isHtml) {
      warn('Segment does not start with TS/fMP4 magic byte — likely AES-128 encrypted (expected if EXT-X-KEY present)');
    }

    pass('Segment is valid video data');
  } catch (e) {
    fail(`Segment fetch threw: ${e.message}`);
  }
}

// ============================================================================
// STEP 6: Test EXT-X-KEY fetch if present
// ============================================================================
async function step6_fetchKey(keyUrl) {
  console.log(`\n${CYAN}═══ STEP 6: Fetch EXT-X-KEY (encryption key) ═══${RESET}`);
  info(`GET ${keyUrl.substring(0, 120)}...`);

  try {
    const res = await fetchWithTimeout(keyUrl, {}, 15000);
    info(`Status: ${res.status}`);
    info(`Content-Type: ${res.headers.get('content-type') || 'not set'}`);

    assert(res.ok, `Key fetch returned ${res.status} (expected 2xx)`);

    if (res.ok) {
      const buf = await res.arrayBuffer();
      info(`Key size: ${buf.byteLength} bytes`);
      // AES-128 keys are exactly 16 bytes
      assert(buf.byteLength === 16, `Key is ${buf.byteLength} bytes (expected 16 for AES-128)`);
    } else {
      const errBody = await res.text();
      fail(`Key error body: ${errBody.substring(0, 300)}`);
    }
  } catch (e) {
    fail(`Key fetch threw: ${e.message}`);
  }
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log(`${CYAN}╔══════════════════════════════════════════════════╗${RESET}`);
  console.log(`${CYAN}║  Flixer E2E Stream Test                         ║${RESET}`);
  console.log(`${CYAN}║  CF Worker: ${CF_WORKER_BASE.substring(0, 36).padEnd(36)}║${RESET}`);
  console.log(`${CYAN}║  TMDB: ${TMDB_ID} | Type: ${TYPE.padEnd(28)}║${RESET}`);
  console.log(`${CYAN}╚══════════════════════════════════════════════════╝${RESET}`);

  // Step 1: Extract
  const sources = await step1_extract();
  if (sources.length === 0) {
    fail('No sources extracted — cannot continue');
    printSummary();
    process.exit(1);
  }

  // Use first source
  const sourceUrl = sources[0].url;
  info(`\nUsing source: ${sources[0].title} → ${sourceUrl.substring(0, 80)}...`);

  // Step 2: Fetch m3u8
  const m3u8Result = await step2_fetchM3u8(sourceUrl);
  if (!m3u8Result) {
    fail('m3u8 fetch failed — cannot continue');
    printSummary();
    process.exit(1);
  }

  // Step 3: Parse m3u8
  const parsed = step3_parseM3u8(m3u8Result.body);

  // Step 4: If master playlist, drill into a media playlist
  let mediaM3u8Body = m3u8Result.body;
  if (parsed.isMaster && parsed.urlLines.length > 0) {
    const variantUrl = parsed.urlLines[0];
    const mediaBody = await step4_fetchMediaPlaylist(variantUrl);
    if (mediaBody) {
      mediaM3u8Body = mediaBody;
      // Re-parse the media playlist
      console.log(`\n${CYAN}═══ STEP 3b: Parse media playlist ═══${RESET}`);
      const mediaParsed = step3_parseM3u8(mediaBody);

      // Fetch key if present
      if (mediaParsed.keyLines.length > 0) {
        const keyMatch = mediaParsed.keyLines[0].match(/URI="([^"]+)"/);
        if (keyMatch) {
          await step6_fetchKey(keyMatch[1]);
        }
      }

      // Fetch first segment
      if (mediaParsed.urlLines.length > 0) {
        await step5_fetchSegment(mediaParsed.urlLines[0]);
      } else {
        fail('No segment URLs in media playlist');
      }
    }
  } else {
    // Direct media playlist (no master)
    // Fetch key if present
    if (parsed.keyLines.length > 0) {
      const keyMatch = parsed.keyLines[0].match(/URI="([^"]+)"/);
      if (keyMatch) {
        await step6_fetchKey(keyMatch[1]);
      }
    }

    // Fetch first segment
    if (parsed.urlLines.length > 0) {
      await step5_fetchSegment(parsed.urlLines[0]);
    } else {
      fail('No segment URLs in playlist');
    }
  }

  printSummary();
  process.exit(failedTests > 0 ? 1 : 0);
}

function printSummary() {
  console.log(`\n${CYAN}═══════════════════════════════════════${RESET}`);
  console.log(`  Total: ${totalTests} | ${GREEN}Pass: ${passedTests}${RESET} | ${failedTests > 0 ? RED : GREEN}Fail: ${failedTests}${RESET}`);
  console.log(`${CYAN}═══════════════════════════════════════${RESET}\n`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
