/**
 * Verify RPI M3U8 rewriting is working correctly
 * Run this after deploying the updated rpi-proxy/server.js
 */

const https = require('https');

const RPI_PROXY_URL = 'https://rpi-proxy.vynx.cc';
const CF_WORKER_URL = 'https://dlhd.vynx-3b3.workers.dev';
const RPI_API_KEY = '5f1845926d725bb2a8230a6ed231fce1d03f07782f74a3f683c30ec04d4ac560';

async function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : require('http');
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        ...headers
      },
      timeout: 30000
    };
    
    const req = client.request(options, (res) => {
      let data = Buffer.alloc(0);
      res.on('data', chunk => data = Buffer.concat([data, chunk]));
      res.on('end', () => resolve({ 
        status: res.statusCode, 
        headers: res.headers, 
        data,
        ok: res.statusCode >= 200 && res.statusCode < 300
      }));
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

async function main() {
  const channelId = 51;
  
  console.log('='.repeat(60));
  console.log('VERIFYING RPI M3U8 REWRITING');
  console.log('='.repeat(60));
  
  // Test RPI /dlhdfast with cf_proxy
  const url = new URL(`/dlhdfast/${channelId}`, RPI_PROXY_URL);
  url.searchParams.set('key', RPI_API_KEY);
  url.searchParams.set('cf_proxy', CF_WORKER_URL);
  
  console.log(`\nFetching: ${url.toString()}`);
  
  const res = await fetchUrl(url.toString(), { 'X-API-Key': RPI_API_KEY });
  
  if (!res.ok) {
    console.log(`\n❌ FAILED: Status ${res.status}`);
    console.log(res.data.toString());
    return;
  }
  
  const content = res.data.toString();
  const lines = content.split('\n');
  
  let keyUrlRewritten = false;
  let segmentUrlsRewritten = 0;
  let rawSegmentUrls = 0;
  let hasKeyUrl = false;
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Check key URL
    if (trimmed.includes('URI="')) {
      hasKeyUrl = true;
      if (trimmed.includes('dlhd.vynx-3b3.workers.dev/dlhdprivate')) {
        keyUrlRewritten = true;
      }
    }
    
    // Check segment URLs
    if (trimmed.startsWith('https://') && !trimmed.includes('URI=')) {
      if (trimmed.includes('dlhd.vynx-3b3.workers.dev/dlhdprivate')) {
        segmentUrlsRewritten++;
      } else if (trimmed.includes('dvalna.ru/') && !trimmed.includes('/key/')) {
        rawSegmentUrls++;
      }
    }
  }
  
  console.log('\n=== RESULTS ===');
  console.log(`Key URL found: ${hasKeyUrl}`);
  console.log(`Key URL rewritten to CF Worker: ${keyUrlRewritten ? '✅ YES' : '❌ NO'}`);
  console.log(`Segment URLs rewritten: ${segmentUrlsRewritten}`);
  console.log(`Raw segment URLs (NOT rewritten): ${rawSegmentUrls}`);
  
  if (keyUrlRewritten && segmentUrlsRewritten > 0 && rawSegmentUrls === 0) {
    console.log('\n✅ SUCCESS! All URLs are properly rewritten to CF Worker!');
    console.log('\nThe M3U8 should now work with video players.');
  } else if (rawSegmentUrls > 0) {
    console.log('\n❌ FAILED: Segment URLs are NOT being rewritten!');
    console.log('The RPI server needs to be updated with the latest server.js');
    console.log('\nSample raw segment URL:');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('https://') && trimmed.includes('dvalna.ru/') && !trimmed.includes('/key/')) {
        console.log(`  ${trimmed.substring(0, 100)}...`);
        break;
      }
    }
  } else if (!keyUrlRewritten) {
    console.log('\n❌ FAILED: Key URL is NOT being rewritten!');
  }
  
  console.log('\n=== FIRST 1500 CHARS OF M3U8 ===');
  console.log(content.substring(0, 1500));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
