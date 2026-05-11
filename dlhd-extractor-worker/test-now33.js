// Test: Deployed worker with SOCKS5 proxy key fetching
// Tests:
// 1. /debug/proxies - check proxy stats
// 2. /debug/keytest - test key fetching (uses SOCKS5 internally now)
// 3. /play/44 - full end-to-end: M3U8 + key fetch through proxy
// 4. Actually fetch a segment to verify decryption works

const WORKER = 'https://dlhd.vynx-3b3.workers.dev';
const KEY = 'vynx';

async function test(label, url) {
  console.log(`\n--- ${label} ---`);
  console.log(`GET ${url}`);
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      headers: { 'X-API-Key': KEY },
    });
    const elapsed = Date.now() - start;
    const ct = resp.headers.get('content-type') || '';
    
    if (ct.includes('json')) {
      const json = await resp.json();
      console.log(`${resp.status} (${elapsed}ms)`);
      console.log(JSON.stringify(json, null, 2).substring(0, 2000));
    } else if (ct.includes('mpegurl')) {
      const text = await resp.text();
      console.log(`${resp.status} (${elapsed}ms) M3U8 ${text.length}b`);
      // Show first 500 chars
      console.log(text.substring(0, 500));
      // Check if key URLs are proxied
      const keyUrls = text.match(/URI="([^"]+)"/g);
      if (keyUrls) {
        console.log(`\nKey URLs (${keyUrls.length}):`);
        keyUrls.forEach(k => console.log(`  ${k.substring(0, 120)}`));
      }
      // Check if segment URLs are proxied
      const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      console.log(`\nSegment URLs (${lines.length}):`);
      lines.slice(0, 3).forEach(l => console.log(`  ${l.substring(0, 120)}`));
      
      // Try fetching the first key URL to see if it works
      if (keyUrls && keyUrls.length > 0) {
        const keyUrl = keyUrls[0].match(/URI="([^"]+)"/)[1];
        console.log(`\nFetching key: ${keyUrl.substring(0, 100)}...`);
        const keyStart = Date.now();
        const keyResp = await fetch(keyUrl);
        const keyElapsed = Date.now() - keyStart;
        if (keyResp.ok) {
          const keyBuf = await keyResp.arrayBuffer();
          const keyHex = Array.from(new Uint8Array(keyBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
          const fetchedBy = keyResp.headers.get('x-fetched-by') || 'unknown';
          console.log(`  KEY: ${keyHex} (${keyElapsed}ms) via ${fetchedBy}`);
          
          const isFake = keyHex.startsWith('455806f8') || keyHex.startsWith('45c6497');
          const isError = keyHex.startsWith('6572726f72');
          if (isFake) console.log('  ⚠️ FAKE KEY!');
          else if (isError) console.log('  🚫 RATE LIMITED!');
          else console.log('  ✅ REAL KEY!');
        } else {
          const errText = await keyResp.text();
          console.log(`  KEY FETCH FAILED: ${keyResp.status} ${errText.substring(0, 200)} (${keyElapsed}ms)`);
        }
      }
      
      // Try fetching first segment
      if (lines.length > 0) {
        const segUrl = lines[0];
        console.log(`\nFetching segment: ${segUrl.substring(0, 100)}...`);
        const segStart = Date.now();
        const segResp = await fetch(segUrl);
        const segElapsed = Date.now() - segStart;
        if (segResp.ok) {
          const segBuf = await segResp.arrayBuffer();
          console.log(`  SEGMENT: ${segBuf.byteLength}b (${segElapsed}ms) ✅`);
        } else {
          console.log(`  SEGMENT FAILED: ${segResp.status} (${segElapsed}ms)`);
        }
      }
    } else if (ct.includes('octet-stream')) {
      const buf = await resp.arrayBuffer();
      const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      console.log(`${resp.status} (${elapsed}ms) binary ${buf.byteLength}b: ${hex}`);
    } else {
      const text = await resp.text();
      console.log(`${resp.status} (${elapsed}ms) ${ct} ${text.length}b`);
      console.log(text.substring(0, 500));
    }
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
  }
}

async function main() {
  console.log('=== Deployed Worker SOCKS5 Proxy Test ===');
  console.log('Time:', new Date().toISOString());
  console.log('Worker:', WORKER);

  // Test 1: Proxy stats
  await test('Proxy Stats', `${WORKER}/debug/proxies?key=${KEY}`);

  // Test 2: Key test endpoint (tests key fetching with SOCKS5)
  await test('Key Test ch44', `${WORKER}/debug/keytest?ch=44&key=${KEY}`);

  // Test 3: Full play endpoint for ch44 (dvalna.ru channel)
  await test('Play ch44 (dvalna.ru)', `${WORKER}/play/44?key=${KEY}`);

  // Test 4: Play ch577 (another dvalna.ru channel)
  await test('Play ch577 (dvalna.ru)', `${WORKER}/play/577?key=${KEY}`);
}

main().catch(console.error);
