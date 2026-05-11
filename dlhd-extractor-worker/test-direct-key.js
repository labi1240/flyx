const https = require('https');
const crypto = require('crypto');

// Test fetching key directly from the same IP as CF worker would use
// vs from this machine

async function fetchPage(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    https.get({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
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
  // Get fresh auth
  console.log('Fetching auth...');
  const html = await fetchPage('https://codepcplay.fun/premiumtv/daddyhd.php?id=577', {
    'Referer': 'https://dlhd.link/',
  });
  
  const initMatch = html.match(/EPlayerAuth\.init\s*\(\s*\{([^}]+)\}\s*\)/);
  const authTokenMatch = initMatch[1].match(/authToken\s*:\s*["']([^"']+)["']/);
  const channelSaltMatch = initMatch[1].match(/channelSalt\s*:\s*["']([^"']+)["']/);
  
  const authToken = authTokenMatch[1];
  const channelSalt = channelSaltMatch[1];
  const resource = 'premium577';
  const keyNumber = '5900830';
  
  console.log('authToken:', authToken.substring(0, 50) + '...');
  console.log('channelSalt:', channelSalt);
  
  // Compute auth
  const timestamp = Math.floor(Date.now() / 1000);
  const fingerprint = crypto.createHash('sha256').update(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' +
    '1920x1080' + 'America/New_York' + 'en-US'
  ).digest('hex').substring(0, 16);
  
  const hmacPrefix = crypto.createHmac('sha256', channelSalt).update(resource).digest('hex');
  let nonce = 0;
  for (let n = 0; n < 100000; n++) {
    const data = hmacPrefix + resource + keyNumber + timestamp + n;
    const hash = crypto.createHash('md5').update(data).digest('hex');
    if (parseInt(hash.substring(0, 4), 16) < 0x1000) {
      nonce = n;
      break;
    }
  }
  
  const keyPathData = `${resource}|${keyNumber}|${timestamp}|${fingerprint}`;
  const keyPath = crypto.createHmac('sha256', channelSalt).update(keyPathData).digest('hex').substring(0, 16);
  
  console.log('\nComputed:');
  console.log('  timestamp:', timestamp);
  console.log('  nonce:', nonce);
  console.log('  keyPath:', keyPath);
  console.log('  fingerprint:', fingerprint);
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Origin': 'https://hitsplay.fun',
    'Referer': 'https://hitsplay.fun/',
    'Authorization': `Bearer ${authToken}`,
    'X-Key-Timestamp': timestamp.toString(),
    'X-Key-Nonce': nonce.toString(),
    'X-Key-Path': keyPath,
    'X-Fingerprint': fingerprint,
  };
  
  // Test 1: Fetch directly from this machine
  console.log('\n=== Test 1: Direct fetch from this machine ===');
  const keyUrl = `https://chevy.dvalna.ru/key/${resource}/${keyNumber}`;
  const result1 = await fetchKey(keyUrl, headers);
  console.log('Status:', result1.status);
  console.log('Size:', result1.data.length);
  console.log('Hex:', result1.data.toString('hex'));
  if (result1.data.toString('hex').startsWith('45c6497')) {
    console.log('⚠️ FAKE KEY!');
  } else if (result1.data.length === 16) {
    console.log('✅ REAL KEY!');
  }
  
  // Test 2: Fetch via CF worker's /dlhdprivate endpoint
  console.log('\n=== Test 2: Via CF worker /dlhdprivate ===');
  const cfKeyUrl = `https://dlhd.vynx-3b3.workers.dev/dlhdprivate?url=${encodeURIComponent(keyUrl)}&jwt=${encodeURIComponent(authToken)}&salt=${encodeURIComponent(channelSalt)}`;
  try {
    const result2 = await new Promise((resolve, reject) => {
      https.get(cfKeyUrl, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode, data: Buffer.concat(chunks) });
        });
      }).on('error', reject);
    });
    console.log('Status:', result2.status);
    console.log('Size:', result2.data.length);
    if (result2.data.length === 16) {
      console.log('Hex:', result2.data.toString('hex'));
      if (result2.data.toString('hex').startsWith('45c6497')) {
        console.log('⚠️ FAKE KEY!');
      } else {
        console.log('✅ REAL KEY!');
      }
    } else {
      console.log('Response:', result2.data.toString('utf8').substring(0, 200));
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
}

main().catch(console.error);
