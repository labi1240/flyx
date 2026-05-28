#!/usr/bin/env node
/**
 * Fast Cap.js PoW solver — synchronous crypto, no async overhead per hash.
 * Difficulty d=5: ~1M hashes/puzzle, 80 puzzles, ~6 minutes total.
 *
 * Saves the token to cap-token.txt for easy reuse.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

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
  process.stderr.write('[1/4] Fetching challenge...\n');
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
  process.stderr.write(`      ${count} puzzles, salt=${saltSize}, diff=${difficulty} (${Date.now()-t0}ms)\n`);

  // Step 2: Generate salt/target pairs
  process.stderr.write('[2/4] Generating challenge pairs...\n');
  const pairs = [];
  for (let i = 1; i <= count; i++) {
    pairs.push({
      salt: prng(`${challengeToken}${i}`, saltSize),
      target: prng(`${challengeToken}${i}d`, difficulty),
    });
  }

  // Step 3: Solve ALL puzzles (SYNCHRONOUS)
  process.stderr.write(`[3/4] Solving ${count} puzzles (diff=${difficulty})...\n`);
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
      process.stderr.write(`      ${i + 1}/${count} solved (${Math.round((Date.now()-t0)/1000)}s)\n`);
    }
  }
  process.stderr.write(`      All solved in ${Math.round((Date.now()-t0)/1000)}s\n`);

  // Step 4: Redeem
  process.stderr.write('[4/4] Redeeming solutions...\n');
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
    const token = redeemData.token;
    const expires = redeemData.expires;

    process.stderr.write(`\n=== CAP TOKEN (${totalTime}s) ===\n`);
    process.stderr.write(`${token}\n`);
    process.stderr.write(`Expires: ${new Date(expires).toISOString()}\n`);
    process.stderr.write(`===============================\n`);

    // Save to file
    const tokenInfo = JSON.stringify({ token, expires, obtained: Date.now() }, null, 2);
    writeFileSync('cap-token.json', tokenInfo);
    process.stderr.write(`Token saved to cap-token.json\n`);

    // Print only the token to stdout for easy piping
    console.log(token);
  } else {
    process.stderr.write(`Redeem response: ${JSON.stringify(redeemData)}\n`);
    process.exit(1);
  }
}

main().catch(e => { process.stderr.write(`FATAL: ${e.message}\n`); process.exit(1); });
