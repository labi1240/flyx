// Test: Direct key fetch through the worker's /dlhdprivate to see SOCKS5 errors
// Also test the proxy stats after a key fetch attempt

const WORKER = 'https://dlhd.vynx-3b3.workers.dev';
const KEY = 'vynx';

async function main() {
  console.log('=== Direct Key Fetch Test ===');
  console.log('Time:', new Date().toISOString());

  // Fetch a key directly through /dlhdprivate
  const keyUrl = 'https://chevy.dvalna.ru/key/premium44/5901637';
  const url = `${WORKER}/dlhdprivate?url=${encodeURIComponent(keyUrl)}&key=${KEY}`;
  
  console.log(`\nFetching key: ${keyUrl}`);
  console.log(`Via: ${url.substring(0, 100)}...`);
  
  const start = Date.now();
  const resp = await fetch(url, {
    headers: { 'X-API-Key': KEY },
  });
  const elapsed = Date.now() - start;
  
  console.log(`Status: ${resp.status} (${elapsed}ms)`);
  console.log(`X-Fetched-By: ${resp.headers.get('x-fetched-by')}`);
  console.log(`Content-Type: ${resp.headers.get('content-type')}`);
  
  if (resp.headers.get('content-type')?.includes('json')) {
    const json = await resp.json();
    console.log('Response:', JSON.stringify(json, null, 2));
  } else {
    const buf = await resp.arrayBuffer();
    if (buf.byteLength === 16) {
      const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      console.log(`KEY: ${hex}`);
      const isFake = hex.startsWith('455806f8') || hex.startsWith('45c6497');
      console.log(isFake ? '⚠️ FAKE' : '✅ REAL');
    } else {
      console.log(`Body: ${buf.byteLength}b`);
    }
  }

  // Check proxy stats after the attempt
  console.log('\n--- Proxy Stats After ---');
  const statsResp = await fetch(`${WORKER}/debug/proxies?key=${KEY}`);
  const stats = await statsResp.json();
  // Only show proxies with activity
  const active = stats.proxies.filter(p => p.failures > 0 || p.lastSuccess);
  console.log(`Active proxies: ${active.length}/${stats.total}`);
  active.forEach(p => console.log(`  ${p.proxy}: failures=${p.failures} lastFail=${p.lastFail} lastSuccess=${p.lastSuccess}`));
  console.log(`Current index: ${stats.currentIndex}`);
}

main().catch(console.error);
