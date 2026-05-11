/**
 * Test decryption locally using Node.js crypto
 * This bypasses the CF Worker to verify the decryption logic
 */

const crypto = require('crypto');

const WORKER_URL = 'https://dlhd.vynx-3b3.workers.dev';
const RPI_URL = 'https://rpi-proxy.vynx.cc';
const RPI_KEY = '5f1845926d725bb2a8230a6ed231fce1d03f07782f74a3f683c30ec04d4ac560';

async function testDecryptLocal() {
  console.log('='.repeat(60));
  console.log('LOCAL DECRYPTION TEST');
  console.log('='.repeat(60));
  
  // Step 1: Fetch M3U8 to get key and segment URLs
  console.log('\n--- Step 1: Fetch M3U8 ---');
  const m3u8Response = await fetch(`${WORKER_URL}/play/51?key=vynx`);
  const m3u8Content = await m3u8Response.text();
  
  // Extract key URL
  const keyMatch = m3u8Content.match(/URI="([^"]+)"/);
  const keyUrl = keyMatch ? keyMatch[1] : null;
  console.log(`Key URL: ${keyUrl ? keyUrl.substring(0, 80) + '...' : 'NOT FOUND'}`);
  
  // Extract segment URL
  const lines = m3u8Content.split('\n');
  let segmentUrl = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.startsWith('http')) {
      segmentUrl = trimmed;
      break;
    }
  }
  console.log(`Segment URL: ${segmentUrl ? segmentUrl.substring(0, 80) + '...' : 'NOT FOUND'}`);
  
  // Step 2: Fetch key via CF Worker (uses PoW)
  console.log('\n--- Step 2: Fetch key via CF Worker ---');
  const keyResponse = await fetch(keyUrl);
  const keyBuffer = await keyResponse.arrayBuffer();
  const keyData = new Uint8Array(keyBuffer);
  console.log(`Key size: ${keyData.length} bytes`);
  console.log(`Key (hex): ${Buffer.from(keyData).toString('hex')}`);
  
  // Check if key is valid
  const firstKeyByte = keyData[0];
  if (firstKeyByte === 0x45 || keyData.length !== 16) {
    console.log('❌ Invalid key - aborting');
    console.log(`First byte: 0x${firstKeyByte.toString(16)} (${String.fromCharCode(firstKeyByte)})`);
    return;
  }
  console.log('✅ Key looks valid');
  
  // Step 3: Fetch segment via RPI (raw, encrypted)
  console.log('\n--- Step 3: Fetch raw segment via RPI ---');
  
  // Parse segment URL to get actual dvalna.ru URL
  const segUrl = new URL(segmentUrl);
  const actualSegmentUrl = segUrl.searchParams.get('url');
  const headersJson = segUrl.searchParams.get('headers');
  
  console.log(`Actual segment URL: ${decodeURIComponent(actualSegmentUrl).substring(0, 80)}...`);
  
  // Fetch via RPI /dlhdprivate (raw, no decryption)
  const rpiUrl = new URL('/dlhdprivate', RPI_URL);
  rpiUrl.searchParams.set('url', actualSegmentUrl);
  if (headersJson) {
    rpiUrl.searchParams.set('headers', headersJson);
  }
  
  const segmentResponse = await fetch(rpiUrl.toString(), {
    headers: { 'X-API-Key': RPI_KEY }
  });
  
  console.log(`Segment status: ${segmentResponse.status}`);
  
  const segmentBuffer = await segmentResponse.arrayBuffer();
  const segmentData = new Uint8Array(segmentBuffer);
  console.log(`Segment size: ${segmentData.length} bytes`);
  
  // Step 4: Analyze segment header
  console.log('\n--- Step 4: Analyze segment header ---');
  console.log('First 64 bytes (hex):');
  console.log(Buffer.from(segmentData.slice(0, 64)).toString('hex'));
  
  // Check for MPEG-TS sync byte at various offsets
  console.log('\nChecking for 0x47 sync byte:');
  [0, 16, 32, 48, 64, 188].forEach(offset => {
    if (offset < segmentData.length) {
      const byte = segmentData[offset];
      console.log(`  Offset ${offset}: 0x${byte.toString(16).padStart(2, '0')} ${byte === 0x47 ? '✅ SYNC' : ''}`);
    }
  });
  
  // Step 5: Try decryption with different IV sources
  console.log('\n--- Step 5: Try decryption ---');
  
  // Extract IV from M3U8
  const ivMatch = m3u8Content.match(/IV=0x([0-9a-fA-F]+)/);
  const m3u8IV = ivMatch ? Buffer.from(ivMatch[1].padStart(32, '0'), 'hex') : null;
  console.log(`M3U8 IV: ${m3u8IV ? m3u8IV.toString('hex') : 'NOT FOUND'}`);
  
  // Extract IV from segment header (bytes 16-31)
  const headerIV = Buffer.from(segmentData.slice(16, 32));
  console.log(`Header IV (bytes 16-31): ${headerIV.toString('hex')}`);
  
  // Try decryption with header IV
  console.log('\n--- Trying decryption with header IV ---');
  const encryptedData = segmentData.slice(32); // Skip 32-byte header
  console.log(`Encrypted data size: ${encryptedData.length} bytes`);
  
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(keyData), headerIV);
    decipher.setAutoPadding(true);
    
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedData)),
      decipher.final()
    ]);
    
    console.log(`Decrypted size: ${decrypted.length} bytes`);
    console.log(`First byte: 0x${decrypted[0].toString(16)} (0x47 = valid TS)`);
    
    if (decrypted[0] === 0x47) {
      console.log('✅ DECRYPTION SUCCESSFUL! First byte is MPEG-TS sync byte!');
      
      // Check more sync bytes
      let syncCount = 0;
      for (let i = 0; i < Math.min(decrypted.length, 1880); i += 188) {
        if (decrypted[i] === 0x47) syncCount++;
      }
      console.log(`Sync bytes at 188-byte intervals: ${syncCount}/10`);
    } else {
      console.log('❌ Decryption produced invalid data');
      console.log(`First 32 bytes: ${decrypted.slice(0, 32).toString('hex')}`);
    }
  } catch (e) {
    console.log(`❌ Decryption failed: ${e.message}`);
  }
  
  // Try with M3U8 IV
  if (m3u8IV) {
    console.log('\n--- Trying decryption with M3U8 IV ---');
    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(keyData), m3u8IV);
      decipher.setAutoPadding(true);
      
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedData)),
        decipher.final()
      ]);
      
      console.log(`Decrypted size: ${decrypted.length} bytes`);
      console.log(`First byte: 0x${decrypted[0].toString(16)} (0x47 = valid TS)`);
      
      if (decrypted[0] === 0x47) {
        console.log('✅ DECRYPTION SUCCESSFUL with M3U8 IV!');
      }
    } catch (e) {
      console.log(`❌ Decryption with M3U8 IV failed: ${e.message}`);
    }
  }
  
  // Try without stripping header
  console.log('\n--- Trying decryption without stripping header ---');
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(keyData), m3u8IV || headerIV);
    decipher.setAutoPadding(true);
    
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(segmentData)), // Full segment, no header strip
      decipher.final()
    ]);
    
    console.log(`Decrypted size: ${decrypted.length} bytes`);
    console.log(`First byte: 0x${decrypted[0].toString(16)}`);
    
    // Check for sync byte anywhere in first 200 bytes
    for (let i = 0; i < Math.min(200, decrypted.length); i++) {
      if (decrypted[i] === 0x47) {
        console.log(`Found 0x47 at offset ${i}`);
        break;
      }
    }
  } catch (e) {
    console.log(`❌ Decryption failed: ${e.message}`);
  }
}

testDecryptLocal().catch(console.error);
