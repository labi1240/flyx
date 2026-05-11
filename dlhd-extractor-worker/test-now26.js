// Test the DEPLOYED worker end-to-end
// 1. Test /play with player6 channel (should work, proxied URLs)
// 2. Test /play with dvalna.ru channel (tests CF direct key fetch)
// 3. Verify proxied segment URLs actually work through /dlhdprivate
const https = require('https');

function httpsReq(url, headers = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...headers },
      timeout, family: 4,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

const WORKER = 'https://dlhd.vynx-3b3.workers.dev';

async function testPlayEndpoint(ch, label) {
  console.log(`\n--- /play/${ch} (${label}) ---`);
  const start = Date.now();
  try {
    const res = await httpsReq(`${WORKER}/play/${ch}?key=vynx`);
    const elapsed = Date.now() - start;
    const body = res.data.toString('utf8');
    const backend = res.headers['x-dlhd-backend'] || 'unknown';
    const server = res.headers['x-dlhd-server'] || 'unknown';
    
    if (res.status !== 200) {
      console.log(`  ❌ ${res.status} (${elapsed}ms) backend=${backend}`);
      console.log(`  Body: ${body.substring(0, 200)}`);
      return false;
    }
    
    const isM3u8 = body.includes('#EXTM3U');
    const lines = body.split('\n');
    const segLines = lines.filter(l => l.trim() && !l.trim().startsWith('#'));
    const allProxied = segLines.every(l => l.includes('/dlhdprivate'));
    const hasDirectUpstream = segLines.some(l => 
      (l.includes('planetary.lovecdn.ru') || l.includes('moveonjoy.com') || l.includes('dvalna.ru'))
      && !l.includes('/dlhdprivate')
    );
    
    console.log(`  ✅ ${res.status} (${elapsed}ms) backend=${backend} server=${server}`);
    console.log(`  M3U8: ${isM3u8}, segments: ${segLines.length}, all proxied: ${allProxied}, leaks upstream: ${hasDirectUpstream}`);
    
    if (segLines.length > 0) {
      console.log(`  Sample: ${segLines[0].substring(0, 130)}...`);
    }
    
    // Test first proxied segment URL
    if (allProxied && segLines.length > 0) {
      console.log(`  Testing proxied segment fetch...`);
      try {
        const segRes = await httpsReq(segLines[0].trim(), {}, 10000);
        console.log(`  Segment: ${segRes.status} ${segRes.data.length}b (${segRes.headers['content-type']})`);
      } catch (e) {
        console.log(`  Segment fetch error: ${e.message}`);
      }
    }
    
    return isM3u8 && allProxied && !hasDirectUpstream;
  } catch (e) {
    console.log(`  💀 ERROR: ${e.message} (${Date.now() - start}ms)`);
    return false;
  }
}

async function main() {
  console.log('=== Deployed Worker E2E Test ===');
  console.log('Time:', new Date().toISOString());
  console.log(`Worker: ${WORKER}`);
  
  let pass = 0, fail = 0;
  
  // Player 6 channels (should definitely work)
  for (const [ch, label] of [['44', 'ESPN (player6)'], ['35', 'Sky Sports Football (player6)'], ['130', 'Sky PL (player6)']]) {
    const ok = await testPlayEndpoint(ch, label);
    if (ok) pass++; else fail++;
  }
  
  // Moveonjoy channels
  for (const [ch, label] of [['51', 'ABC (moveonjoy)'], ['321', 'HBO (moveonjoy)']]) {
    const ok = await testPlayEndpoint(ch, label);
    if (ok) pass++; else fail++;
  }
  
  // dvalna.ru channel (tests CF direct key fetch - the big question)
  for (const [ch, label] of [['577', 'dvalna-only channel']]) {
    const ok = await testPlayEndpoint(ch, label);
    if (ok) pass++; else fail++;
  }
  
  console.log(`\n=== Results: ${pass} pass, ${fail} fail ===`);
}

main().catch(console.error);
