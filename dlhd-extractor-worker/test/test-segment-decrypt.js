/**
 * Test segment decryption through CF Worker /dlhdprivate endpoint
 * This tests the full decryption flow: CF Worker -> RPI -> dvalna.ru -> decrypt
 */

const https = require('https');
const crypto = require('crypto');

const CF_WORKER_URL = 'https://dlhd.vynx-3b3.workers.dev';
const RPI_PROXY_URL = 'https://rpi-proxy.vynx.cc';
const RPI_API_KEY = '5f1845926d725bb2a8230a6ed231fce1d03f07782f74a3f683c30ec04d4ac560';
const HMAC_SECRET = 'd6398a30dd88f3defad36e0a10226679a045f47df9428e9cb4d98e9a6bd364b4';

function generateJWT(channelKey) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: channelKey, country: 'US', iat: now, exp: now + 18000 };
  
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', HMAC_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');
  
  return `${headerB64}.${payloadB64}.${signature}`;
}

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
      timeout: 60000
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
  const channelKey = `premium${channelId}`;
  
  console.log('=== Step 1: Fetch M3U8 directly from dvalna.ru ===');
  const jwt = generateJWT(channelKey);
  const m3u8Url = `https://zekonew.dvalna.ru/zeko/${channelKey}/mono.css`;
  
  const m3u8Res = await fetchUrl(m3u8Url, {
    'Authorization': `Bearer ${jwt}`,
    'Referer': 'https://hitsplay.fun/',
    'Origin': 'https://hitsplay.fun'
  });
  
  if (!m3u8Res.ok) {
    console.log(`M3U8 fetch failed: ${m3u8Res.status}`);
    return;
  }
  
  const m3u8Content = m3u8Res.data.toString();
  console.log(`M3U8 fetched: ${m3u8Content.length} bytes`);
  
  // Extract segment and key URLs
  let segmentUrl = null;
  let keyUrl = null;
  
  const lines = m3u8Content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('https://') && !trimmed.includes('/key/')) {
      segmentUrl = trimmed;
      break; // Get first segment
    }
    if (trimmed.includes('URI="')) {
      const match = trimmed.match(/URI="([^"]+)"/);
      if (match) keyUrl = match[1];
    }
  }
  
  console.log(`Segment URL: ${segmentUrl?.substring(0, 80)}...`);
  console.log(`Key URL: ${keyUrl?.substring(0, 80)}...`);
  
  if (!segmentUrl || !keyUrl) {
    console.log('Could not extract segment or key URL');
    return;
  }
  
  console.log('\n=== Step 2: Test CF Worker /dlhdprivate with segment + keyUrl ===');
  
  // Build the CF Worker URL with segment and key URL
  const cfUrl = new URL('/dlhdprivate', CF_WORKER_URL);
  cfUrl.searchParams.set('url', segmentUrl);
  cfUrl.searchParams.set('keyUrl', keyUrl);
  cfUrl.searchParams.set('key', 'vynx');
  cfUrl.searchParams.set('headers', JSON.stringify({
    'Authorization': `Bearer ${jwt}`,
    'Referer': 'https://hitsplay.fun/',
    'Origin': 'https://hitsplay.fun'
  }));
  
  console.log(`CF Worker URL: ${cfUrl.toString().substring(0, 100)}...`);
  
  const segmentRes = await fetchUrl(cfUrl.toString(), {
    'X-API-Key': 'vynx'
  });
  
  console.log(`Status: ${segmentRes.status}`);
  console.log(`Content-Type: ${segmentRes.headers['content-type']}`);
  console.log(`Content-Length: ${segmentRes.data.length} bytes`);
  
  if (segmentRes.ok) {
    const firstByte = segmentRes.data[0];
    console.log(`First byte: 0x${firstByte.toString(16)} (0x47 = valid TS)`);
    
    if (firstByte === 0x47) {
      console.log('\n✅ SUCCESS! Segment is decrypted and valid MPEG-TS!');
    } else {
      console.log(`\n⚠️ First byte is not 0x47 - segment may still be encrypted`);
      console.log(`First 32 bytes: ${Array.from(segmentRes.data.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    }
  } else {
    console.log(`\n❌ Segment fetch failed`);
    console.log(`Response: ${segmentRes.data.toString().substring(0, 500)}`);
  }
  
  console.log('\n=== Step 3: Test RPI /dlhdprivate directly (for comparison) ===');
  
  const rpiUrl = new URL('/dlhdprivate', RPI_PROXY_URL);
  rpiUrl.searchParams.set('url', segmentUrl);
  
  const rpiRes = await fetchUrl(rpiUrl.toString(), {
    'X-API-Key': RPI_API_KEY
  });
  
  console.log(`RPI Status: ${rpiRes.status}`);
  console.log(`RPI Content-Length: ${rpiRes.data.length} bytes`);
  
  if (rpiRes.ok) {
    const firstByte = rpiRes.data[0];
    console.log(`RPI First byte: 0x${firstByte.toString(16)} (0x47 = valid TS, other = encrypted)`);
    
    if (firstByte !== 0x47) {
      console.log('RPI returns encrypted data (expected - RPI does not decrypt)');
    }
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
