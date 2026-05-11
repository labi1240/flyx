// Test: Can the Cloudflare Worker fetch dvalna.ru keys DIRECTLY?
// The worker has its own IP (Cloudflare edge) — NOT your home IP.
// If CF can fetch keys, we don't need the RPI proxy at all for keys.
//
// This test hits the DEPLOYED worker's /play endpoint and checks if it works.
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

async function main() {
  console.log('=== Test CF Worker Direct Key Fetch ===');
  console.log('Time:', new Date().toISOString());

  // Step 1: Test the deployed worker's /play endpoint for a dvalna channel
  // This forces the worker (on CF edge IP) to fetch M3U8 + keys from dvalna.ru
  const workerBase = 'https://dlhd.vynx-3b3.workers.dev';
  const apiKey = 'vynx'; // from the routes.ts validateApiKey

  const channels = ['44', '35', '51', '130'];
  
  for (const ch of channels) {
    console.log(`\n--- ch${ch} via CF Worker /play ---`);
    try {
      const playUrl = `${workerBase}/play/${ch}?key=${apiKey}&backend=zeko.dvalna.ru`;
      console.log(`  Request: ${playUrl}`);
      const res = await httpsReq(playUrl);
      const body = res.data.toString('utf8');
      const server = res.headers['x-dlhd-server'] || 'unknown';
      const backend = res.headers['x-dlhd-backend'] || 'unknown';
      
      if (res.status === 200 && body.includes('#EXTM3U')) {
        // Check if the M3U8 has key URLs pointing to /dlhdprivate
        const hasProxiedKeys = body.includes('/dlhdprivate');
        const hasKeyLine = body.includes('EXT-X-KEY');
        const lines = body.split('\n');
        const segCount = lines.filter(l => l.trim() && !l.trim().startsWith('#')).length;
        console.log(`  ✅ ${res.status} - valid M3U8, server=${server}, backend=${backend}`);
        console.log(`  Segments: ${segCount}, has keys: ${hasKeyLine}, keys proxied: ${hasProxiedKeys}`);
        
        // Show key line if present
        const keyLine = lines.find(l => l.includes('EXT-X-KEY'));
        if (keyLine) console.log(`  Key line: ${keyLine.substring(0, 150)}...`);
        
        // Now try to fetch a proxied key URL from the M3U8 to see if it actually works
        if (hasProxiedKeys && hasKeyLine) {
          const keyMatch = keyLine.match(/URI="([^"]+)"/);
          if (keyMatch) {
            console.log(`  Fetching proxied key...`);
            const keyRes = await httpsReq(keyMatch[1]);
            if (keyRes.status === 200 && keyRes.data.length === 16) {
              const hex = Array.from(keyRes.data).map(b => b.toString(16).padStart(2, '0')).join('');
              console.log(`  ✅ KEY WORKS! ${keyRes.data.length}b, hex=${hex}`);
            } else {
              const errBody = keyRes.data.toString('utf8').substring(0, 200);
              console.log(`  ❌ Key failed: ${keyRes.status}, ${keyRes.data.length}b, body=${errBody}`);
            }
          }
        }
        
        // Also try fetching a segment
        const segLine = lines.find(l => l.trim() && !l.trim().startsWith('#') && l.includes('/dlhdprivate'));
        if (segLine) {
          console.log(`  Fetching proxied segment...`);
          const segRes = await httpsReq(segLine.trim(), {}, 8000);
          console.log(`  Segment: ${segRes.status}, ${segRes.data.length}b`);
        }
      } else {
        console.log(`  ❌ ${res.status} - ${body.substring(0, 200)}`);
      }
    } catch (e) {
      console.log(`  💀 ${e.message}`);
    }
  }

  // Step 2: Test the worker fetching a key directly via /dlhdprivate
  // This bypasses /play and directly tests if CF edge can reach dvalna key servers
  console.log('\n\n--- Direct /dlhdprivate key test (CF Worker → dvalna.ru) ---');
  const keyUrl = `https://zekonew.dvalna.ru/key/premium44/1`;
  const proxyUrl = `${workerBase}/dlhdprivate?url=${encodeURIComponent(keyUrl)}&jwt=test-direct-key-fetch-bypass`;
  console.log(`  Request: ${proxyUrl.substring(0, 120)}...`);
  try {
    const res = await httpsReq(proxyUrl);
    const fetchedBy = res.headers['x-fetched-by'] || 'unknown';
    if (res.status === 200 && res.data.length === 16) {
      const hex = Array.from(res.data).map(b => b.toString(16).padStart(2, '0')).join('');
      console.log(`  ✅ CF Worker fetched key directly! ${hex} (via ${fetchedBy})`);
    } else {
      console.log(`  ❌ ${res.status}, ${res.data.length}b, body=${res.data.toString('utf8').substring(0, 200)}`);
    }
  } catch (e) {
    console.log(`  💀 ${e.message}`);
  }
}

main().catch(console.error);
