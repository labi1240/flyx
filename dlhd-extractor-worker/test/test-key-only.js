/**
 * Test key fetch only - verify we get a valid key with PoW
 */

const WORKER_URL = 'https://dlhd.vynx-3b3.workers.dev';

async function testKeyFetch() {
  console.log('='.repeat(60));
  console.log('KEY FETCH TEST');
  console.log('='.repeat(60));
  
  // Fetch M3U8 first to get key URL
  const m3u8Response = await fetch(`${WORKER_URL}/play/51?key=vynx`);
  const m3u8Content = await m3u8Response.text();
  
  // Extract key URL
  const keyMatch = m3u8Content.match(/URI="([^"]+)"/);
  if (!keyMatch) {
    console.log('No key URL found');
    return;
  }
  
  const keyUrl = keyMatch[1];
  console.log(`Key URL: ${keyUrl.substring(0, 100)}...`);
  
  // Fetch key
  console.log('\nFetching key...');
  const keyResponse = await fetch(keyUrl);
  console.log(`Status: ${keyResponse.status}`);
  console.log(`Content-Type: ${keyResponse.headers.get('content-type')}`);
  
  const keyBuffer = await keyResponse.arrayBuffer();
  const keyData = new Uint8Array(keyBuffer);
  
  console.log(`Key size: ${keyData.length} bytes`);
  console.log(`Key (hex): ${Array.from(keyData).map(b => b.toString(16).padStart(2, '0')).join('')}`);
  
  // Check if key is valid
  const firstByte = keyData[0];
  console.log(`First byte: 0x${firstByte.toString(16)} (${String.fromCharCode(firstByte)})`);
  
  if (firstByte === 0x45) {
    console.log('❌ Key starts with E - this is an ERROR response!');
  } else if (keyData.length === 16) {
    console.log('✅ Key looks valid (16 bytes, not starting with E)');
  } else {
    console.log('❌ Invalid key size');
  }
}

testKeyFetch().catch(console.error);
