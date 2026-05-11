/**
 * E2E Test: Local machine → CF Worker → Hexa API
 * 
 * Solves Cap.js PoW locally, then calls /flixer/extract-all with the token.
 * Verifies we get working servers with real m3u8 URLs back.
 */

const crypto = require('crypto');

const WORKER_URL = 'https://media-proxy.vynx-3b3.workers.dev';
const CAP_BASE = 'https://cap.hexa.su/0737428d64';
const TMDB_ID = '550'; // Fight Club
const TYPE = 'movie';

// ── Cap.js PoW Solver ──

function fnv1a(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}

function prng(seed, length) {
  let state = fnv1a(seed);
  let result = '';
  function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  }
  while (result.length < length) {
    result += next().toString(16).padStart(8, '0');
  }
  return result.substring(0, length);
}

function sha256hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function solveChallenge(salt, target) {
  for (let nonce = 0; nonce < 50000000; nonce++) {
    const hash = sha256hex(`${salt}${nonce}`);
    if (hash.startsWith(target)) return nonce;
  }
  throw new Error('PoW timeout');
}

async function solveCapToken() {
  console.log('[1/4] Fetching Cap.js challenge...');
  const challengeRes = await fetch(`${CAP_BASE}/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!challengeRes.ok) throw new Error(`Challenge HTTP ${challengeRes.status}`);
  
  const { challenge, token: challengeToken } = await challengeRes.json();
  console.log(`    Challenge: ${challenge.c} puzzles, difficulty ${challenge.d}, salt ${challenge.s}`);

  console.log('[2/4] Solving PoW puzzles...');
  const startTime = Date.now();
  const solutions = [];
  for (let i = 1; i <= challenge.c; i++) {
    const salt = prng(`${challengeToken}${i}`, challenge.s);
    const target = prng(`${challengeToken}${i}d`, challenge.d);
    const nonce = solveChallenge(salt, target);
    solutions.push(nonce);
    if (i % 20 === 0) process.stdout.write(`    ${i}/${challenge.c} solved\n`);
  }
  console.log(`    All ${challenge.c} puzzles solved in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  console.log('[3/4] Redeeming solutions...');
  const redeemRes = await fetch(`${CAP_BASE}/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: challengeToken, solutions }),
  });
  if (!redeemRes.ok) throw new Error(`Redeem HTTP ${redeemRes.status}`);
  
  const redeemData = await redeemRes.json();
  if (!redeemData.success || !redeemData.token) {
    throw new Error(`Redeem rejected: ${JSON.stringify(redeemData)}`);
  }
  
  console.log(`    Token obtained! Expires: ${new Date(redeemData.expires).toISOString()}`);
  return redeemData.token;
}

async function testExtractAll(capToken) {
  console.log(`\n[4/4] Calling CF Worker /flixer/extract-all (tmdbId=${TMDB_ID}, type=${TYPE})...`);
  const url = `${WORKER_URL}/flixer/extract-all?tmdbId=${TMDB_ID}&type=${TYPE}&capToken=${encodeURIComponent(capToken)}`;
  
  const res = await fetch(url, {
    headers: { 'x-cap-token': capToken },
    signal: AbortSignal.timeout(120000),
  });
  
  console.log(`    HTTP ${res.status}`);
  const data = await res.json();
  
  console.log(`\n── RESULTS ──`);
  console.log(`Success: ${data.success}`);
  console.log(`Servers queried: ${data.serverCount || 'N/A'}`);
  console.log(`URLs extracted: ${data.extractedCount || 0}`);
  console.log(`Validated (working): ${data.validatedCount || 0}`);
  console.log(`Elapsed: ${data.elapsed_ms || 'N/A'}ms`);
  
  if (data.sources && data.sources.length > 0) {
    console.log(`\n── SOURCES (${data.sources.length}) ──`);
    for (const src of data.sources) {
      const urlPreview = src.url ? src.url.substring(0, 80) + '...' : '(no URL)';
      const icon = src.status === 'working' ? '✓' : src.status === 'down' ? '✗' : '?';
      console.log(`  ${icon} ${src.title} [${src.status}] ${urlPreview}`);
    }
    
    const working = data.sources.filter(s => s.status === 'working');
    console.log(`\n── SUMMARY ──`);
    console.log(`Working servers: ${working.length}`);
    if (working.length > 0) {
      console.log(`First working URL: ${working[0].url.substring(0, 120)}`);
      console.log('\n✅ E2E TEST PASSED — Hexa extraction is working!');
    } else {
      console.log('\n❌ E2E TEST FAILED — No working servers (URLs extracted but m3u8 validation failed)');
    }
  } else {
    console.log('\n❌ E2E TEST FAILED — No sources returned at all');
    if (data.error) console.log(`Error: ${data.error}`);
  }
}

async function main() {
  try {
    console.log('═══ Hexa/Flixer E2E Test ═══\n');
    const capToken = await solveCapToken();
    await testExtractAll(capToken);
  } catch (e) {
    console.error('\n❌ FATAL ERROR:', e.message);
    process.exit(1);
  }
}

main();
