// Quick test: solve fresh cap token and test API immediately
const { createHash } = require('crypto');

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
  const CAP_BASE = 'https://cap.hexa.su/15d2cf0395';
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Origin': 'https://hexa.su',
    'Referer': 'https://hexa.su/',
  };

  // Solve
  console.log('Getting challenge...');
  const challengeRes = await fetch(`${CAP_BASE}/challenge`, { method: 'POST', headers, body: '{}' });
  const { challenge, token: challengeToken } = await challengeRes.json();
  console.log(`Challenge: c=${challenge.c}, d=${challenge.d}`);

  const solutions = [];
  const start = Date.now();
  for (let i = 1; i <= challenge.c; i++) {
    const salt = prng(`${challengeToken}${i}`, challenge.s);
    const target = prng(`${challengeToken}${i}d`, challenge.d);
    for (let nonce = 0; ; nonce++) {
      if (sha256hex(`${salt}${nonce}`).startsWith(target)) { solutions.push(nonce); break; }
    }
  }
  console.log(`Solved in ${((Date.now()-start)/1000).toFixed(1)}s`);

  // Redeem
  const redeemRes = await fetch(`${CAP_BASE}/redeem`, { method: 'POST', headers, body: JSON.stringify({ token: challengeToken, solutions }) });
  const redeemData = await redeemRes.json();
  console.log('Redeem:', redeemData.success ? 'OK' : 'FAIL');
  const capToken = redeemData.token;
  console.log('Token:', capToken);

  // Test API immediately
  console.log('\n--- Test 1: with cap token (from same machine) ---');
  const res1 = await fetch('https://theemoviedb.hexa.su/api/tmdb/movie/550/images', {
    headers: {
      'x-fingerprint-lite': 'e9136c41504646444',
      'x-cap-token': capToken,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/plain',
    },
  });
  console.log('Status:', res1.status);
  const text1 = await res1.text();
  console.log('Length:', text1.length);
  if (res1.status !== 200) console.log('Body:', text1.substring(0, 200));

  // Test 2: use the same token again (check if single-use)
  console.log('\n--- Test 2: reuse same token ---');
  const res2 = await fetch('https://theemoviedb.hexa.su/api/tmdb/movie/550/images', {
    headers: {
      'x-fingerprint-lite': 'e9136c41504646444',
      'x-cap-token': capToken,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/plain',
    },
  });
  console.log('Status:', res2.status);
  const text2 = await res2.text();
  console.log('Length:', text2.length);
  if (res2.status !== 200) console.log('Body:', text2.substring(0, 200));

  // Test 3: without cap token
  console.log('\n--- Test 3: without cap token ---');
  const res3 = await fetch('https://theemoviedb.hexa.su/api/tmdb/movie/550/images', {
    headers: {
      'x-fingerprint-lite': 'e9136c41504646444',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/plain',
    },
  });
  console.log('Status:', res3.status);
  const text3 = await res3.text();
  console.log('Length:', text3.length);
  console.log('Body:', text3.substring(0, 200));
}
main();
