const https = require('https');
const crypto = require('crypto');

// Fetch the CF worker's debug output and compare with local computation
async function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    https.get({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

async function fetchKey(url, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    https.get({
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, data: Buffer.concat(chunks) });
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('=== Comparing CF Worker vs Node.js ===\n');
  
  // Get CF worker's computed values
  console.log('1. Fetching CF worker debug output...');
  const cfDebug = await fetchJson('https://dlhd.vynx-3b3.workers.dev/debug-auth/577', {
    'X-API-Key': 'vynx',
  });
  
  console.log('CF Worker computed:');
  console.log('  hmacPrefix:', cfDebug.computed.hmacPrefix);
  console.log('  timestamp:', cfDebug.computed.timestamp);
  console.log('  nonce:', cfDebug.computed.nonce);
  console.log('  keyPath:', cfDebug.computed.keyPath);
  console.log('  fingerprint:', cfDebug.computed.fingerprint);
  
  // Now compute the same locally
  console.log('\n2. Computing locally with same inputs...');
  const channelSalt = cfDebug.authData.channelSalt;
  const resource = cfDebug.computed.resource;
  const keyNumber = cfDebug.computed.keyNumber;
  const timestamp = cfDebug.computed.timestamp;
  const fingerprint = cfDebug.computed.fingerprint;
  
  const localHmac = crypto.createHmac('sha256', channelSalt).update(resource).digest('hex');
  console.log('  hmacPrefix:', localHmac, localHmac === cfDebug.computed.hmacPrefix ? '✅' : '❌');
  
  // Compute nonce
  let localNonce = 0;
  for (let n = 0; n < 100000; n++) {
    const data = localHmac + resource + keyNumber + timestamp + n;
    const hash = crypto.createHash('md5').update(data).digest('hex');
    if (parseInt(hash.substring(0, 4), 16) < 0x1000) {
      localNonce = n;
      console.log('  nonce:', n, n === cfDebug.computed.nonce ? '✅' : '❌', '(hash:', hash.substring(0, 8) + ')');
      break;
    }
  }
  
  // Compute keyPath
  const keyPathData = `${resource}|${keyNumber}|${timestamp}|${fingerprint}`;
  const localKeyPath = crypto.createHmac('sha256', channelSalt).update(keyPathData).digest('hex').substring(0, 16);
  console.log('  keyPath:', localKeyPath, localKeyPath === cfDebug.computed.keyPath ? '✅' : '❌');
  
  // Now test key fetch with CF worker's auth token
  console.log('\n3. Testing key fetch with CF auth token...');
  
  // We need the full auth token - fetch it fresh
  const authPage = await new Promise((resolve, reject) => {
    https.get('https://codepcplay.fun/premiumtv/daddyhd.php?id=577', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://dlhd.link/',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
  
  const initMatch = authPage.match(/EPlayerAuth\.init\s*\(\s*\{([^}]+)\}\s*\)/);
  const authTokenMatch = initMatch[1].match(/authToken\s*:\s*["']([^"']+)["']/);
  const fullAuthToken = authTokenMatch[1];
  
  console.log('  Full authToken:', fullAuthToken.substring(0, 60) + '...');
  
  // Compute fresh auth with current timestamp
  const freshTimestamp = Math.floor(Date.now() / 1000);
  let freshNonce = 0;
  for (let n = 0; n < 100000; n++) {
    const data = localHmac + resource + keyNumber + freshTimestamp + n;
    const hash = crypto.createHash('md5').update(data).digest('hex');
    if (parseInt(hash.substring(0, 4), 16) < 0x1000) {
      freshNonce = n;
      break;
    }
  }
  const freshKeyPathData = `${resource}|${keyNumber}|${freshTimestamp}|${fingerprint}`;
  const freshKeyPath = crypto.createHmac('sha256', channelSalt).update(freshKeyPathData).digest('hex').substring(0, 16);
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Origin': 'https://hitsplay.fun',
    'Referer': 'https://hitsplay.fun/',
    'Authorization': `Bearer ${fullAuthToken}`,
    'X-Key-Timestamp': freshTimestamp.toString(),
    'X-Key-Nonce': freshNonce.toString(),
    'X-Key-Path': freshKeyPath,
    'X-Fingerprint': fingerprint,
  };
  
  console.log('  timestamp:', freshTimestamp);
  console.log('  nonce:', freshNonce);
  console.log('  keyPath:', freshKeyPath);
  
  const keyUrl = `https://chevy.dvalna.ru/key/${resource}/${keyNumber}`;
  console.log('  keyUrl:', keyUrl);
  
  const result = await fetchKey(keyUrl, headers);
  console.log('\n4. Key fetch result:');
  console.log('  Status:', result.status);
  console.log('  Size:', result.data.length, 'bytes');
  console.log('  Hex:', result.data.toString('hex'));
  
  if (result.data.length === 16) {
    const keyHex = result.data.toString('hex');
    if (keyHex.startsWith('45c6497') || keyHex.startsWith('455806f8')) {
      console.log('  ⚠️ FAKE KEY!');
    } else {
      console.log('  ✅ REAL KEY!');
    }
  }
}

main().catch(console.error);
