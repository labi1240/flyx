#!/usr/bin/env node
/**
 * Solve Cap.js PoW challenge and write token to Cloudflare KV.
 * 
 * Usage: node solve-cap-token.js
 * 
 * This solves the PoW locally (~60-80s) and pushes the token to KV
 * via wrangler CLI. Run this every 2.5 hours (or use a cron job).
 * 
 * Requires: wrangler CLI authenticated (wrangler login)
 */

const { createHash } = require('crypto');
const { execSync } = require('child_process');

const CAP_BASE = 'https://cap.hexa.su/15d2cf0395';
const KV_NAMESPACE_ID = 'ef441bca9b6148e098689a9334fd6288';

function prng(seed, length) {
  function fnv1a(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return hash >>> 0;
  }
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
  const startTime = Date.now();
  console.log('=== Cap.js PoW Solver → KV Writer ===\n');

  // Step 1: Get challenge
  console.log('Getting challenge...');
  const challengeRes = await fetch(`${CAP_BASE}/challenge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'https://hexa.su',
      'Referer': 'https://hexa.su/',
    },
    body: JSON.stringify({}),
  });
  const { challenge, token: challengeToken } = await challengeRes.json();
  console.log(`Challenge: c=${challenge.c}, s=${challenge.s}, d=${challenge.d}`);

  // Step 2: Generate + solve
  const { c: count, s: saltSize, d: difficulty } = challenge;
  const solutions = [];

  console.log(`Solving ${count} challenges...`);
  for (let i = 1; i <= count; i++) {
    const salt = prng(`${challengeToken}${i}`, saltSize);
    const target = prng(`${challengeToken}${i}d`, difficulty);

    for (let nonce = 0; ; nonce++) {
      if (sha256hex(`${salt}${nonce}`).startsWith(target)) {
        solutions.push(nonce);
        break;
      }
    }
    if (i % 20 === 0) process.stdout.write(`  ${i}/${count}\n`);
  }
  console.log(`Solved in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  // Step 3: Redeem
  console.log('Redeeming...');
  const redeemRes = await fetch(`${CAP_BASE}/redeem`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'https://hexa.su',
      'Referer': 'https://hexa.su/',
    },
    body: JSON.stringify({ token: challengeToken, solutions }),
  });
  const redeemData = await redeemRes.json();

  if (!redeemData.success || !redeemData.token) {
    console.error('Redeem FAILED:', redeemData);
    process.exit(1);
  }

  const capToken = redeemData.token;
  const expires = redeemData.expires;
  const ttlSeconds = Math.floor((expires - Date.now()) / 1000);

  console.log(`\nGot cap token: ${capToken}`);
  console.log(`Expires: ${new Date(expires).toISOString()} (TTL: ${ttlSeconds}s / ${(ttlSeconds/3600).toFixed(1)}h)`);

  // Step 4: Write to KV via wrangler
  console.log('\nWriting to Cloudflare KV...');
  try {
    execSync(
      `npx wrangler kv key put --namespace-id="${KV_NAMESPACE_ID}" "cap_token" "${capToken}" --ttl=${ttlSeconds}`,
      { stdio: 'inherit', cwd: __dirname }
    );
    execSync(
      `npx wrangler kv key put --namespace-id="${KV_NAMESPACE_ID}" "cap_token_expires" "${expires}" --ttl=${ttlSeconds}`,
      { stdio: 'inherit', cwd: __dirname }
    );
    console.log('\n✅ Cap token written to KV! Flixer extraction should work now.');
  } catch (e) {
    console.error('\nFailed to write to KV. Manual commands:');
    console.log(`npx wrangler kv key put --namespace-id="${KV_NAMESPACE_ID}" "cap_token" "${capToken}" --ttl=${ttlSeconds}`);
    console.log(`npx wrangler kv key put --namespace-id="${KV_NAMESPACE_ID}" "cap_token_expires" "${expires}" --ttl=${ttlSeconds}`);
  }

  console.log(`\nTotal time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
