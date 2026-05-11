// Test patched WASM - decrypt without verify
import { readFileSync } from 'fs';

const wasmBuffer = readFileSync('videasy-module-patched.wasm');

let wasmExports;
let memory;

const imports = {
  env: {
    seed() { return 12345.6789; },
    abort(msgPtr, filePtr, line, column) {
      const msg = readFullString(msgPtr);
      const file = readFullString(filePtr);
      console.error('WASM ABORT:', msg, 'at', file, line, column);
      throw new Error(`WASM abort: ${msg}`);
    }
  }
};

function readFullString(ptr) {
  if (!ptr) return '(null)';
  const buf = new Uint8Array(memory.buffer);
  const chars = [];
  let zeroCount = 0;
  for (let i = ptr; i < buf.length - 1; i += 2) {
    const code = buf[i] | (buf[i + 1] << 8);
    if (code === 0) { zeroCount++; if (zeroCount > 10) break; }
    else zeroCount = 0;
    chars.push(String.fromCharCode(code));
  }
  return chars.join('');
}

function allocString(str) {
  const len = str.length;
  const byteLen = len * 2;
  const ptr = wasmExports.__new(byteLen, 2);
  const buf = new Uint8Array(memory.buffer);
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    buf[ptr + i * 2] = code & 0xff;
    buf[ptr + i * 2 + 1] = (code >> 8) & 0xff;
  }
  return ptr;
}

async function main() {
  console.log('Loading PATCHED WASM...');
  const wasmModule = await WebAssembly.instantiate(wasmBuffer, imports);
  wasmExports = wasmModule.instance.exports;
  memory = wasmExports.memory;

  // Check g_sb value via verify return (verify returns g_sb)
  console.log('\n=== Checking g_sb state ===');
  // verify() with any hash will return g_sb (the comparison result)
  // If g_sb starts as 1 and the hash doesn't match, it gets set to 0
  // But if we never call verify, g_sb stays at 1
  // Let's try decrypt directly

  console.log('\n=== Testing decrypt() directly (no verify) ===');
  // Try with some test encrypted hex data
  const testEncrypted = "34fa287bd60d8980f2ed92b4814f423e";
  console.log('Encrypted data:', testEncrypted);
  console.log('Length:', testEncrypted.length);

  try {
    const testPtr = allocString(testEncrypted);
    console.log('Calling decrypt...');
    const decryptedPtr = wasmExports.decrypt(testPtr, 550.0);
    console.log('decrypt returned ptr:', decryptedPtr);

    if (decryptedPtr) {
      const decrypted = readFullString(decryptedPtr);
      console.log('decrypted (first 500 chars):', decrypted.substring(0, 500));
      console.log('decrypted total length:', decrypted.length);
    } else {
      console.log('decrypt returned null/0');
    }
  } catch(e) {
    console.error('decrypt error:', e.message);
  }

  // Also test with a shorter hex string
  console.log('\n=== Test with shorter hex ===');
  try {
    const shortHex = "34fa287bd60d8980";
    const ptr = allocString(shortHex);
    const decryptedPtr = wasmExports.decrypt(ptr, 550.0);
    if (decryptedPtr) {
      console.log('Short decrypt:', readFullString(decryptedPtr).substring(0, 200));
    }
  } catch(e) {
    console.error('Short decrypt error:', e.message);
  }

  // Try different tmdbIds
  console.log('\n=== Test with different tmdbId ===');
  for (const tmdbId of [550.0, 299534.0, 872585.0]) {
    try {
      const ptr = allocString(testEncrypted);
      const decryptedPtr = wasmExports.decrypt(ptr, tmdbId);
      if (decryptedPtr) {
        const result = readFullString(decryptedPtr);
        console.log(`tmdbId=${tmdbId}: first 100 chars:`, result.substring(0, 100));
      }
    } catch(e) {
      console.log(`tmdbId=${tmdbId}: error: ${e.message}`);
    }
  }
}

main().catch(console.error);
