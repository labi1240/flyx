/**
 * Test if RPI /fetch-rust preserves binary data.
 * Uses a known binary URL (a small PNG) to verify byte-for-byte accuracy.
 * Then tests with the actual Flixer CDN key URL from the CF Worker.
 */

const RPI_URL = 'https://rpi-proxy.vynx.cc';
const RPI_KEY = '5f1845926d725bb2a8230a6ed231fce1d03f07782f74a3f683c30ec04d4ac560';
const CF_WORKER = 'https://media-proxy.vynx-3b3.workers.dev';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function pass(msg) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function fail(msg) { console.log(`${RED}✗${RESET} ${msg}`); }

async function testRpiBinaryPreservation() {
  console.log(`${CYAN}=== Test 1: RPI binary preservation (known PNG) ===${RESET}`);
  
  // Use the favicon from the Flixer CDN as a known binary file
  const testUrl = 'https://hexa.su/favicon.ico';
  
  // Direct fetch
  const directRes = await fetch(testUrl);
  const directBuf = await directRes.arrayBuffer();
  const directBytes = new Uint8Array(directBuf);
  console.log('Direct:', directBytes.length, 'bytes, first 8:', Array.from(directBytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' '));
  
  // RPI /fetch-rust
  const headers = JSON.stringify({ 'User-Agent': 'Mozilla/5.0' });
  const rustUrl = `${RPI_URL}/fetch-rust?url=${encodeURIComponent(testUrl)}&headers=${encodeURIComponent(headers)}&timeout=15`;
  const rustRes = await fetch(rustUrl, { headers: { 'X-API-Key': RPI_KEY } });
  const rustBuf = await rustRes.arrayBuffer();
  const rustBytes = new Uint8Array(rustBuf);
  console.log('Rust:  ', rustBytes.length, 'bytes, first 8:', Array.from(rustBytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' '));
  
  const match = directBytes.length === rustBytes.length && directBytes.every((b, i) => b === rustBytes[i]);
  if (match) pass('Binary data preserved through /fetch-rust');
  else fail(`Binary mismatch! Direct: ${directBytes.length} bytes, Rust: ${rustBytes.length} bytes`);
}

async function testFlixerKeyThroughCfWorker() {
  console.log(`\n${CYAN}=== Test 2: Flixer key through CF Worker /flixer/stream ===${RESET}`);
  
  // Get a source from the CF Worker
  const extractRes = await fetch(`${CF_WORKER}/flixer/extract?tmdbId=550&type=movie&server=delta`, {
    signal: AbortSignal.timeout(30000),
  });
  const data = await extractRes.json();
  if (!data.sources?.[0]) { fail('No sources from extract'); return; }
  
  const srcUrl = data.sources[0].url;
  console.log('Source:', srcUrl.substring(0, 80));
  
  // Get master m3u8 through CF Worker proxy
  const masterRes = await fetch(`${CF_WORKER}/flixer/stream?url=${encodeURIComponent(srcUrl)}`);
  const master = await masterRes.text();
  
  // Get first variant
  const variantLine = master.split('\n').find(l => l.trim() && !l.startsWith('#'));
  if (!variantLine) { fail('No variant URL'); return; }
  
  // Get media playlist through CF Worker proxy
  const mediaRes = await fetch(variantLine.trim());
  const media = await mediaRes.text();
  
  // Find EXT-X-KEY
  const keyLine = media.split('\n').find(l => l.includes('EXT-X-KEY'));
  if (!keyLine) {
    console.log('No EXT-X-KEY in media playlist (unencrypted stream from this CDN edge)');
    // Still test a segment
    const segLine = media.split('\n').find(l => l.trim() && !l.startsWith('#'));
    if (segLine) {
      console.log('\nTesting segment instead...');
      const segRes = await fetch(segLine.trim());
      const segBuf = await segRes.arrayBuffer();
      const segBytes = new Uint8Array(segBuf);
      console.log('Segment:', segBytes.length, 'bytes');
      console.log('CT:', segRes.headers.get('content-type'));
      console.log('Via:', segRes.headers.get('x-proxied-via'));
      console.log('First 16:', Array.from(segBytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' '));
      
      const isMpegTs = segBytes[0] === 0x47;
      if (isMpegTs) pass('Segment is valid MPEG-TS (0x47)');
      else if (segBytes.length > 100) pass(`Segment is ${segBytes.length} bytes of binary data (likely encrypted)`);
      else fail('Segment is too small or invalid');
      
      // Check for UTF-8 replacement character corruption
      let hasCorruption = false;
      for (let i = 0; i < Math.min(segBytes.length, 100); i++) {
        if (segBytes[i] === 0xef && i + 2 < segBytes.length && segBytes[i+1] === 0xbf && segBytes[i+2] === 0xbd) {
          hasCorruption = true;
          break;
        }
      }
      if (hasCorruption) fail('Segment has UTF-8 replacement characters (0xEF 0xBF 0xBD) — binary data was corrupted by text encoding!');
      else pass('No UTF-8 corruption detected in segment');
    }
    return;
  }
  
  const keyMatch = keyLine.match(/URI="([^"]+)"/);
  if (!keyMatch) { fail('No URI in EXT-X-KEY'); return; }
  
  const keyUri = keyMatch[1];
  console.log('Key URI:', keyUri.substring(0, 120));
  
  // Fetch key through CF Worker proxy
  const keyRes = await fetch(keyUri);
  const keyBuf = await keyRes.arrayBuffer();
  const keyBytes = new Uint8Array(keyBuf);
  
  console.log('Key status:', keyRes.status);
  console.log('Key CT:', keyRes.headers.get('content-type'));
  console.log('Key Via:', keyRes.headers.get('x-proxied-via'));
  console.log('Key size:', keyBytes.length, 'bytes');
  console.log('Key hex:', Array.from(keyBytes).map(b => b.toString(16).padStart(2, '0')).join(' '));
  
  if (keyBytes.length === 16) pass('Key is exactly 16 bytes (valid AES-128)');
  else fail(`Key is ${keyBytes.length} bytes (expected 16 for AES-128)`);
  
  // Check for UTF-8 replacement character corruption (0xEF 0xBF 0xBD)
  let hasCorruption = false;
  for (let i = 0; i < keyBytes.length - 2; i++) {
    if (keyBytes[i] === 0xef && keyBytes[i+1] === 0xbf && keyBytes[i+2] === 0xbd) {
      hasCorruption = true;
      break;
    }
  }
  if (hasCorruption) fail('Key has UTF-8 replacement characters (0xEF 0xBF 0xBD) — binary data was corrupted by text encoding!');
  else pass('No UTF-8 corruption detected in key');
}

async function testRpiDirectKeyFetch() {
  console.log(`\n${CYAN}=== Test 3: Direct RPI /fetch-rust with Flixer CDN key ===${RESET}`);
  
  // Get a source
  const extractRes = await fetch(`${CF_WORKER}/flixer/extract?tmdbId=550&type=movie&server=delta`, {
    signal: AbortSignal.timeout(30000),
  });
  const data = await extractRes.json();
  if (!data.sources?.[0]) { fail('No sources'); return; }
  
  const srcUrl = data.sources[0].url;
  
  // Get master m3u8 through RPI (like the CF Worker does)
  const cdnHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Referer': 'https://hexa.su/',
    'Origin': 'https://hexa.su',
    'Accept': '*/*',
  };
  
  const rustMasterUrl = `${RPI_URL}/fetch-rust?url=${encodeURIComponent(srcUrl)}&headers=${encodeURIComponent(JSON.stringify(cdnHeaders))}&timeout=15`;
  const masterRes = await fetch(rustMasterUrl, { headers: { 'X-API-Key': RPI_KEY } });
  const master = await masterRes.text();
  
  if (!master.includes('#EXTM3U')) { fail('Master m3u8 not valid'); return; }
  
  // Get first variant URL (resolve relative)
  const base = new URL(srcUrl);
  const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
  const variantLine = master.split('\n').find(l => l.trim() && !l.startsWith('#'));
  if (!variantLine) { fail('No variant'); return; }
  const variantUrl = variantLine.startsWith('http') ? variantLine.trim() : `${base.origin}${basePath}${variantLine.trim()}`;
  
  // Get media playlist through RPI
  const rustMediaUrl = `${RPI_URL}/fetch-rust?url=${encodeURIComponent(variantUrl)}&headers=${encodeURIComponent(JSON.stringify(cdnHeaders))}&timeout=15`;
  const mediaRes = await fetch(rustMediaUrl, { headers: { 'X-API-Key': RPI_KEY } });
  const media = await mediaRes.text();
  
  const keyLine = media.split('\n').find(l => l.includes('EXT-X-KEY'));
  if (!keyLine) { console.log('No EXT-X-KEY (unencrypted from RPI IP)'); return; }
  
  const keyMatch = keyLine.match(/URI="([^"]+)"/);
  if (!keyMatch) { fail('No URI'); return; }
  
  let keyUrl = keyMatch[1];
  if (!keyUrl.startsWith('http')) {
    const mediaBase = new URL(variantUrl);
    const mediaBasePath = mediaBase.pathname.substring(0, mediaBase.pathname.lastIndexOf('/') + 1);
    keyUrl = keyUrl.startsWith('/') ? `${mediaBase.origin}${keyUrl}` : `${mediaBase.origin}${mediaBasePath}${keyUrl}`;
  }
  
  console.log('CDN Key URL:', keyUrl.substring(0, 100));
  
  // Fetch key through RPI /fetch-rust
  const rustKeyUrl = `${RPI_URL}/fetch-rust?url=${encodeURIComponent(keyUrl)}&headers=${encodeURIComponent(JSON.stringify(cdnHeaders))}&timeout=15`;
  const keyRes = await fetch(rustKeyUrl, { headers: { 'X-API-Key': RPI_KEY } });
  const keyBuf = await keyRes.arrayBuffer();
  const keyBytes = new Uint8Array(keyBuf);
  
  console.log('RPI Key status:', keyRes.status);
  console.log('RPI Key CT:', keyRes.headers.get('content-type'));
  console.log('RPI Key size:', keyBytes.length, 'bytes');
  console.log('RPI Key hex:', Array.from(keyBytes).map(b => b.toString(16).padStart(2, '0')).join(' '));
  
  if (keyBytes.length === 16) pass('RPI key is exactly 16 bytes');
  else fail(`RPI key is ${keyBytes.length} bytes (expected 16)`);
  
  let hasCorruption = false;
  for (let i = 0; i < keyBytes.length - 2; i++) {
    if (keyBytes[i] === 0xef && keyBytes[i+1] === 0xbf && keyBytes[i+2] === 0xbd) {
      hasCorruption = true;
      break;
    }
  }
  if (hasCorruption) fail('RPI key has UTF-8 corruption!');
  else pass('No UTF-8 corruption in RPI key');
}

async function main() {
  await testRpiBinaryPreservation();
  await testFlixerKeyThroughCfWorker();
  await testRpiDirectKeyFetch();
}

main().catch(e => console.error('Fatal:', e));
