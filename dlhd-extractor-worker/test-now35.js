// Test: Verify RPI SOCKS5 bridge integration in CF Worker
// Tests the full chain: CF Worker → RPI /fetch-socks5 → SOCKS5 proxy → dvalna.ru
// Also tests the /debug/socks5-pool endpoint on RPI

const WORKER_URL = 'https://dlhd.vynx-3b3.workers.dev';
const RPI_URL = 'https://rpi-proxy.vynx.cc';
const API_KEY = 'vynx'; // CF Worker API key
const RPI_API_KEY = '5f1845926d725bb2a8230a6ed231fce1d03f07782f74a3f683c30ec04d4ac560'; // RPI API key

async function main() {
  console.log('=== RPI SOCKS5 Bridge Integration Test ===');
  console.log('Time:', new Date().toISOString());
  console.log();

  // Test 1: Check RPI SOCKS5 pool status
  console.log('--- Test 1: RPI SOCKS5 Pool Status ---');
  try {
    const resp = await fetch(`${RPI_URL}/debug/socks5-pool`, {
      headers: { 'X-API-Key': RPI_API_KEY },
    });
    const data = await resp.json();
    console.log(`  Pool size: ${data.poolSize} (min: ${data.minRequired})`);
    console.log(`  Refreshing: ${data.isRefreshing}`);
    console.log(`  Last refresh: ${data.lastRefreshAgo}`);
    console.log(`  Next refresh: ${data.nextRefresh}`);
    console.log(`  Stats: fetched=${data.stats.totalFetched}, validated=${data.stats.totalValidated}, failed=${data.stats.totalFailed}`);
    if (data.proxies && data.proxies.length > 0) {
      console.log(`  First 5 proxies: ${data.proxies.slice(0, 5).map(p => p.proxy).join(', ')}`);
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
    console.log('  (RPI may not be restarted yet with new code)');
  }
  console.log();

  // Test 2: Direct RPI /fetch-socks5 test
  console.log('--- Test 2: Direct RPI /fetch-socks5 ---');
  try {
    // First get auth data
    const authResp = await fetch(`https://codepcplay.fun/premiumtv/daddyhd.php?id=44`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://dlhd.link/',
      },
    });
    const html = await authResp.text();
    const initMatch = html.match(/EPlayerAuth\.init\s*\(\s*\{([^}]+)\}\s*\)/);
    if (!initMatch) { console.log('  Failed to get auth data'); } else {
      const s = initMatch[1];
      const authToken = s.match(/authToken\s*:\s*["']([^"']+)["']/)?.[1];
      console.log(`  Auth token: ${authToken?.substring(0, 40)}...`);
      
      // Build key headers (simplified — just test connectivity)
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Origin': 'https://codepcplay.fun',
        'Referer': 'https://codepcplay.fun/',
        'Authorization': `Bearer ${authToken}`,
      };
      
      const keyUrl = 'https://chevy.dvalna.ru/key/premium44/0';
      const socks5Url = `${RPI_URL}/fetch-socks5?url=${encodeURIComponent(keyUrl)}&headers=${encodeURIComponent(JSON.stringify(headers))}`;
      
      const resp = await fetch(socks5Url, {
        headers: { 'X-API-Key': RPI_API_KEY },
      });
      
      console.log(`  Status: ${resp.status}`);
      console.log(`  Proxy used: ${resp.headers.get('x-socks5-proxy') || 'unknown'}`);
      console.log(`  Proxied by: ${resp.headers.get('x-proxied-by') || 'unknown'}`);
      
      const body = await resp.arrayBuffer();
      console.log(`  Body size: ${body.byteLength}b`);
      if (body.byteLength === 16) {
        const hex = Array.from(new Uint8Array(body)).map(b => b.toString(16).padStart(2, '0')).join('');
        console.log(`  Key hex: ${hex}`);
      } else if (body.byteLength < 500) {
        console.log(`  Body: ${new TextDecoder().decode(body).substring(0, 200)}`);
      }
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  console.log();

  // Test 3: CF Worker /play endpoint (full chain)
  console.log('--- Test 3: CF Worker /play/44 (full chain) ---');
  try {
    const resp = await fetch(`${WORKER_URL}/play/44?key=${API_KEY}`);
    console.log(`  Status: ${resp.status}`);
    console.log(`  Content-Type: ${resp.headers.get('content-type')}`);
    console.log(`  Server: ${resp.headers.get('x-dlhd-server') || 'unknown'}`);
    
    const text = await resp.text();
    if (text.includes('#EXTM3U')) {
      console.log(`  ✅ Got valid M3U8 (${text.length} bytes)`);
      const keyUrls = text.match(/URI="[^"]+"/g) || [];
      console.log(`  Key URLs in M3U8: ${keyUrls.length}`);
      if (keyUrls.length > 0) {
        console.log(`  First key URL: ${keyUrls[0].substring(0, 100)}...`);
      }
      const segments = text.split('\n').filter(l => l.trim().startsWith('http') && !l.includes('/key/'));
      console.log(`  Segments: ${segments.length}`);
    } else {
      console.log(`  Response: ${text.substring(0, 300)}`);
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  console.log();

  // Test 4: CF Worker /dlhdprivate key fetch (tests the new RPI SOCKS5 bridge path)
  console.log('--- Test 4: CF Worker /dlhdprivate key fetch ---');
  try {
    const keyUrl = 'https://chevy.dvalna.ru/key/premium44/0';
    const resp = await fetch(`${WORKER_URL}/dlhdprivate?url=${encodeURIComponent(keyUrl)}&key=${API_KEY}`);
    console.log(`  Status: ${resp.status}`);
    console.log(`  Fetched by: ${resp.headers.get('x-fetched-by') || 'unknown'}`);
    
    const body = await resp.arrayBuffer();
    console.log(`  Body size: ${body.byteLength}b`);
    if (body.byteLength === 16) {
      const hex = Array.from(new Uint8Array(body)).map(b => b.toString(16).padStart(2, '0')).join('');
      const isFake = hex.startsWith('455806f8') || hex.startsWith('45c6497');
      const isError = hex.startsWith('6572726f72');
      console.log(`  Key: ${hex} ${isFake ? '⚠️FAKE' : isError ? '🚫RATE_LIMITED' : '✅REAL'}`);
    } else {
      const text = new TextDecoder().decode(body);
      console.log(`  Body: ${text.substring(0, 300)}`);
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  
  console.log('\n=== Done ===');
}

main().catch(console.error);
