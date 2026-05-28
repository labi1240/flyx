#!/usr/bin/env node
/**
 * Fast Cap.js PoW solver — synchronous crypto, no async overhead per hash.
 * Difficulty d=5: ~1M hashes/puzzle, 80 puzzles, ~6 minutes total.
 */
import { createHash } from 'node:crypto';

const CAP_BASE = 'https://cap.hexa.su/15d2cf0395';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': UA,
  'Origin': 'https://hexa.su',
  'Referer': 'https://hexa.su/',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
};

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
  return createHash('sha256').update(str).digest('hex');
}

async function main() {
  const t0 = Date.now();

  // Step 1: Get challenge
  console.log('[1/4] Fetching challenge...');
  const challengeRes = await fetch(`${CAP_BASE}/challenge`, {
    method: 'POST',
    headers: FETCH_HEADERS,
    body: JSON.stringify({}),
  });
  if (!challengeRes.ok) {
    const text = await challengeRes.text().catch(() => '');
    throw new Error(`Challenge HTTP ${challengeRes.status}: ${text}`);
  }
  const { challenge, token: challengeToken } = await challengeRes.json();
  const { c: count, s: saltSize, d: difficulty } = challenge;
  console.log(`      ${count} puzzles, salt=${saltSize}, diff=${difficulty} (${Date.now()-t0}ms)`);

  // Step 2: Generate salt/target pairs
  console.log('[2/4] Generating challenge pairs...');
  const pairs = [];
  for (let i = 1; i <= count; i++) {
    pairs.push({
      salt: prng(`${challengeToken}${i}`, saltSize),
      target: prng(`${challengeToken}${i}d`, difficulty),
    });
  }

  // Step 3: Solve ALL puzzles (SYNCHRONOUS — no async per hash)
  console.log(`[3/4] Solving ${count} puzzles (diff=${difficulty}, sync)...`);
  const solutions = [];
  for (let i = 0; i < count; i++) {
    const { salt, target } = pairs[i];
    let nonce = 0;
    while (true) {
      if (sha256hex(`${salt}${nonce}`).startsWith(target)) break;
      nonce++;
    }
    solutions.push(nonce);
    if ((i + 1) % 20 === 0) {
      console.log(`      ${i + 1}/${count} solved (${Math.round((Date.now()-t0)/1000)}s)`);
    }
  }
  console.log(`      All solved in ${Math.round((Date.now()-t0)/1000)}s`);

  // Step 4: Redeem
  console.log('[4/4] Redeeming solutions...');
  const redeemRes = await fetch(`${CAP_BASE}/redeem`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Origin': 'https://hexa.su',
      'Referer': 'https://hexa.su/',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ token: challengeToken, solutions }),
  });
  if (!redeemRes.ok) {
    const text = await redeemRes.text().catch(() => '');
    throw new Error(`Redeem HTTP ${redeemRes.status}: ${text}`);
  }
  const redeemData = await redeemRes.json();
  const totalTime = Math.round((Date.now() - t0) / 1000);

  if (redeemData.success && redeemData.token) {
    console.log(`\n=== CAP TOKEN (${totalTime}s) ===`);
    console.log(redeemData.token);
    console.log(`Expires: ${new Date(redeemData.expires).toISOString()}`);
    console.log(`===============================`);
  } else {
    console.error(`Redeem response: ${JSON.stringify(redeemData)}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(`FATAL: ${e.message}`); process.exit(1); });
