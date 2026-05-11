/**
 * End-to-end decryption test
 * 
 * This tests the FULL flow:
 * 1. Fetch M3U8 from /play endpoint (which goes through RPI)
 * 2. Extract segment URL and key URL from M3U8
 * 3. Fetch segment via /dlhdprivate (which should decrypt it)
 * 4. Verify the decrypted segment is valid MPEG-TS
 */

const WORKER_URL = 'https://dlhd.vynx-3b3.workers.dev';
const CHANNEL_ID = 51;
const API_KEY = 'vynx'; // API key for CF Worker

async function testDecryptionE2E() {
  console.log('='.repeat(60));
  console.log('END-TO-END DECRYPTION TEST');
  console.log('='.repeat(60));
  
  // Step 1: Fetch M3U8 from /play endpoint
  console.log('\n--- Step 1: Fetch M3U8 from /play endpoint ---');
  const playUrl = `${WORKER_URL}/play/${CHANNEL_ID}?key=${API_KEY}`;
  console.log(`URL: ${playUrl}`);
  
  const m3u8Response = await fetch(playUrl);
  console.log(`Status: ${m3u8Response.status}`);
  
  if (!m3u8Response.ok) {
    console.log(`❌ Failed to fetch M3U8: ${await m3u8Response.text()}`);
    return;
  }
  
  const m3u8Content = await m3u8Response.text();
  console.log(`M3U8 length: ${m3u8Content.length} chars`);
  
  // Step 2: Parse M3U8 to find segment and key URLs
  console.log('\n--- Step 2: Parse M3U8 ---');
  
  // Find key URL
  const keyMatch = m3u8Content.match(/URI="([^"]+)"/);
  if (!keyMatch) {
    console.log('❌ No key URL found in M3U8');
    console.log('M3U8 content:\n', m3u8Content.substring(0, 1000));
    return;
  }
  const keyUrl = keyMatch[1];
  console.log(`Key URL: ${keyUrl.substring(0, 100)}...`);
  
  // Check if key URL is rewritten to CF Worker
  const keyRewritten = keyUrl.includes('dlhd.vynx-3b3.workers.dev') || keyUrl.includes('/dlhdprivate');
  console.log(`Key URL rewritten: ${keyRewritten ? '✅ YES' : '❌ NO'}`);
  
  // Find first segment URL
  const lines = m3u8Content.split('\n');
  let segmentUrl = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      segmentUrl = trimmed;
      break;
    }
  }
  
  if (!segmentUrl) {
    console.log('❌ No segment URL found in M3U8');
    return;
  }
  console.log(`Segment URL: ${segmentUrl.substring(0, 100)}...`);
  
  // Check if segment URL is rewritten to CF Worker
  const segmentRewritten = segmentUrl.includes('dlhd.vynx-3b3.workers.dev') || segmentUrl.includes('/dlhdprivate');
  console.log(`Segment URL rewritten: ${segmentRewritten ? '✅ YES' : '❌ NO'}`);
  
  if (!segmentRewritten) {
    console.log('\n❌ SEGMENT URLs ARE NOT REWRITTEN!');
    console.log('The RPI server needs to be updated with the latest server.js');
    console.log('\nTo fix this:');
    console.log('1. SSH into the RPI server');
    console.log('2. Copy the updated rpi-proxy/server.js');
    console.log('3. Restart the server: pm2 restart rpi-proxy');
    return;
  }
  
  // Step 3: Fetch segment via /dlhdprivate
  console.log('\n--- Step 3: Fetch segment via /dlhdprivate ---');
  console.log(`Fetching: ${segmentUrl.substring(0, 100)}...`);
  
  const segmentResponse = await fetch(segmentUrl);
  console.log(`Status: ${segmentResponse.status}`);
  console.log(`Content-Type: ${segmentResponse.headers.get('content-type')}`);
  console.log(`Content-Length: ${segmentResponse.headers.get('content-length')}`);
  
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
  console.log(`First byte: 0x${firstByte.toString(16)} (0x47 = valid MPEG-TS)`);
  
  if (firstByte === 0x47) {
    console.log('✅ First byte is MPEG-TS sync byte!');
    
    // Check for more sync bytes at 188-byte intervals
    let validSyncCount = 0;
    for (let i = 0; i < Math.min(segmentData.length, 1880); i += 188) {
      if (segmentData[i] === 0x47) {
        validSyncCount++;
      }
    }
    console.log(`Sync bytes at 188-byte intervals: ${validSyncCount}/10`);
    
    if (validSyncCount >= 5) {
      console.log('\n🎉 SUCCESS! Segment is valid MPEG-TS!');
      console.log('The decryption is working correctly!');
    } else {
      console.log('\n⚠️ Sync byte pattern is inconsistent');
    }
  } else {
    console.log('❌ First byte is NOT MPEG-TS sync byte');
    console.log('This could mean:');
    console.log('  1. Decryption failed');
    console.log('  2. Wrong key was used');
    console.log('  3. Wrong IV was used');
    
    // Show first 64 bytes for debugging
    const hexBytes = Array.from(segmentData.slice(0, 64))
      .map(b => b.toString(16).padStart(2, '0'))
      .join(' ');
    console.log(`\nFirst 64 bytes:\n${hexBytes}`);
  }
}

testDecryptionE2E().catch(console.error);
