/**
 * Full E2E test: Local -> CF Worker -> RPI -> dvalna.ru -> back
 * 
 * Tests the complete flow:
 * 1. Fetch M3U8 from CF Worker /play endpoint
 * 2. Parse segment URLs from M3U8 (should be rewritten to /dlhdprivate)
 * 3. Fetch segment via CF Worker /dlhdprivate (which calls RPI, which calls dvalna.ru)
 * 4. Verify decrypted segment is valid MPEG-TS
 */

const WORKER_URL = 'https://dlhd.vynx-3b3.workers.dev';
const CHANNEL_ID = 51;
const API_KEY = 'vynx'; // API key for CF Worker auth

async function testFullE2E() {
  console.log('='.repeat(70));
  console.log('FULL E2E TEST: Local -> CF Worker -> RPI -> dvalna.ru');
  console.log('='.repeat(70));
  
  // Step 1: Fetch M3U8 from /play endpoint
  console.log('\n--- Step 1: Fetch M3U8 from CF Worker /play endpoint ---');
  const playUrl = `${WORKER_URL}/play/${CHANNEL_ID}?key=${API_KEY}`;
  console.log(`URL: ${playUrl}`);
  
  const m3u8Response = await fetch(playUrl);
  console.log(`Status: ${m3u8Response.status}`);
  console.log(`Content-Type: ${m3u8Response.headers.get('content-type')}`);
  
  if (!m3u8Response.ok) {
    const errorText = await m3u8Response.text();
    console.log(`❌ Failed to fetch M3U8: ${errorText.substring(0, 500)}`);
    return;
  }
  
  const m3u8Content = await m3u8Response.text();
  console.log(`M3U8 length: ${m3u8Content.length} chars`);
  console.log('\nM3U8 content (first 1000 chars):');
  console.log(m3u8Content.substring(0, 1000));
  
  // Step 2: Parse M3U8 to find key and segment URLs
  console.log('\n--- Step 2: Parse M3U8 ---');
  
  // Find key URL
  const keyMatch = m3u8Content.match(/URI="([^"]+)"/);
  if (!keyMatch) {
    console.log('❌ No key URL found in M3U8');
    return;
  }
  const keyUrl = keyMatch[1];
  console.log(`Key URL: ${keyUrl.substring(0, 120)}...`);
  
  // Check if key URL goes through CF Worker
  const keyThroughWorker = keyUrl.includes('dlhd.vynx-3b3.workers.dev') || keyUrl.includes('/dlhdprivate');
  console.log(`Key through CF Worker: ${keyThroughWorker ? '✅ YES' : '❌ NO'}`);
  
  // Find first segment URL (non-comment, non-empty line that's a URL)
  const lines = m3u8Content.split('\n');
  let segmentUrl = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && (trimmed.startsWith('http') || trimmed.startsWith('/'))) {
      segmentUrl = trimmed;
      break;
    }
  }
  
  if (!segmentUrl) {
    console.log('❌ No segment URL found in M3U8');
    console.log('Lines:');
    lines.slice(0, 20).forEach((l, i) => console.log(`  ${i}: ${l.substring(0, 100)}`));
    return;
  }
  console.log(`Segment URL: ${segmentUrl.substring(0, 120)}...`);
  
  // Parse segment URL to see all params
  try {
    const segUrl = new URL(segmentUrl);
    console.log('Segment URL params:');
    for (const [key, value] of segUrl.searchParams.entries()) {
      console.log(`  ${key}: ${value.substring(0, 80)}${value.length > 80 ? '...' : ''}`);
    }
  } catch (e) {
    console.log('Could not parse segment URL');
  }
  
  // Check if segment URL goes through CF Worker
  const segmentThroughWorker = segmentUrl.includes('dlhd.vynx-3b3.workers.dev') || segmentUrl.includes('/dlhdprivate');
  console.log(`Segment through CF Worker: ${segmentThroughWorker ? '✅ YES' : '❌ NO'}`);
  
  if (!segmentThroughWorker) {
    console.log('\n❌ SEGMENT URLs NOT REWRITTEN!');
    console.log('RPI server needs to be updated. Run:');
    console.log('  scp rpi-proxy/server.js vynx@vynx-pi.local:~/rpi-proxy/server.js');
    console.log('  ssh vynx@vynx-pi.local "pm2 restart rpi-proxy"');
    return;
  }
  
  // Check if segment URL has keyUrl parameter (needed for decryption)
  const hasKeyUrl = segmentUrl.includes('keyUrl=') || segmentUrl.includes('k=');
  console.log(`Segment has keyUrl param: ${hasKeyUrl ? '✅ YES' : '❌ NO'}`);
  
  // Step 3: Fetch segment via CF Worker
  console.log('\n--- Step 3: Fetch segment via CF Worker /dlhdprivate ---');
  console.log(`Fetching: ${segmentUrl.substring(0, 100)}...`);
  
  const segmentStartTime = Date.now();
  const segmentResponse = await fetch(segmentUrl);
  const segmentDuration = Date.now() - segmentStartTime;
  
  console.log(`Status: ${segmentResponse.status}`);
  console.log(`Content-Type: ${segmentResponse.headers.get('content-type')}`);
  console.log(`Content-Length: ${segmentResponse.headers.get('content-length')}`);
  console.log(`Duration: ${segmentDuration}ms`);
  
  if (!segmentResponse.ok) {
    const errorText = await segmentResponse.text();
    console.log(`❌ Failed to fetch segment: ${errorText.substring(0, 500)}`);
    return;
  }
  
  const segmentBuffer = await segmentResponse.arrayBuffer();
  const segmentData = new Uint8Array(segmentBuffer);
  console.log(`Segment size: ${segmentData.length} bytes`);
  
  // Step 4: Verify decrypted segment
  console.log('\n--- Step 4: Verify decrypted segment ---');
  
  // Check for MPEG-TS sync byte (0x47)
  const firstByte = segmentData[0];
  console.log(`First byte: 0x${firstByte.toString(16).padStart(2, '0')} (0x47 = valid MPEG-TS)`);
  
  if (firstByte === 0x47) {
    console.log('✅ First byte is MPEG-TS sync byte!');
    
    // Check for more sync bytes at 188-byte intervals
    let validSyncCount = 0;
    const checkCount = Math.min(10, Math.floor(segmentData.length / 188));
    for (let i = 0; i < checkCount; i++) {
      if (segmentData[i * 188] === 0x47) {
        validSyncCount++;
      }
    }
    console.log(`Sync bytes at 188-byte intervals: ${validSyncCount}/${checkCount}`);
    
    if (validSyncCount >= checkCount * 0.8) {
      console.log('\n' + '🎉'.repeat(20));
      console.log('SUCCESS! Segment is valid MPEG-TS!');
      console.log('The full E2E flow is working:');
      console.log('  Local -> CF Worker /play -> RPI /dlhdfast -> dvalna.ru (M3U8)');
      console.log('  Local -> CF Worker /dlhdprivate -> RPI /dlhdprivate -> dvalna.ru (segment)');
      console.log('  CF Worker decrypts segment and returns plain MPEG-TS');
      console.log('🎉'.repeat(20));
    } else {
      console.log('\n⚠️ Sync byte pattern is inconsistent - may be partially corrupted');
    }
  } else {
    console.log('❌ First byte is NOT MPEG-TS sync byte');
    console.log('This could mean:');
    console.log('  1. Decryption failed (wrong key or IV)');
    console.log('  2. Segment was returned encrypted (missing keyUrl param)');
    console.log('  3. Key fetch failed (455 = missing auth headers)');
    
    // Show first 64 bytes for debugging
    const hexBytes = Array.from(segmentData.slice(0, 64))
      .map(b => b.toString(16).padStart(2, '0'))
      .join(' ');
    console.log(`\nFirst 64 bytes (hex):\n${hexBytes}`);
    
    // Check if it looks like JSON error
    if (segmentData[0] === 0x7b) { // '{'
      const text = new TextDecoder().decode(segmentData.slice(0, 500));
      console.log(`\nLooks like JSON error:\n${text}`);
    }
  }
  
  // Step 5: Also test key fetch directly
  console.log('\n--- Step 5: Test key fetch directly ---');
  console.log(`Fetching key: ${keyUrl.substring(0, 100)}...`);
  
  const keyResponse = await fetch(keyUrl);
  console.log(`Key status: ${keyResponse.status}`);
  console.log(`Key Content-Type: ${keyResponse.headers.get('content-type')}`);
  
  if (keyResponse.ok) {
    const keyBuffer = await keyResponse.arrayBuffer();
    const keyData = new Uint8Array(keyBuffer);
    console.log(`Key size: ${keyData.length} bytes (expected: 16)`);
    if (keyData.length === 16) {
      console.log('✅ Key is valid 16-byte AES key');
      console.log(`Key (hex): ${Array.from(keyData).map(b => b.toString(16).padStart(2, '0')).join('')}`);
    } else {
      console.log('❌ Invalid key size');
      const text = new TextDecoder().decode(keyData.slice(0, 200));
      console.log(`Key content: ${text}`);
    }
  } else {
    const errorText = await keyResponse.text();
    console.log(`❌ Key fetch failed: ${errorText.substring(0, 300)}`);
  }
}

testFullE2E().catch(err => {
  console.error('Test failed with error:', err.message);
  console.error(err.stack);
});
