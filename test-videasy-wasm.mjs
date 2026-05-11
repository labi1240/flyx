// Test loading player.videasy.net WASM module in Node.js
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

const wasmBuffer = readFileSync('videasy-module.wasm');

// AssemblyScript runtime helpers
let wasmExports;
let memory;

// The seed value - this is called by WASM during init
// We use a fixed seed so we can predict the hash
let seedValue = 12345.6789;
let abortMsg = '';

const imports = {
  env: {
    seed() {
      console.log('[WASM] env.seed() called, returning', seedValue);
      return seedValue;
    },
    abort(msgPtr, filePtr, line, column) {
      const msg = msgPtr ? readString(msgPtr) : 'unknown';
      const file = filePtr ? readString(filePtr) : 'unknown';
      abortMsg = `${msg} at ${file}:${line}:${column}`;
      console.error('[WASM] ABORT:', abortMsg);
      throw new Error(abortMsg);
    }
  }
};

function readString(ptr) {
  if (!ptr) return '';
  // AssemblyScript strings: ptr points to a header, followed by UTF-16 data
  // But the raw memory might need different handling
  try {
    const buf = memory.buffer;
    const view = new DataView(buf);
    // AssemblyScript string header: 20 bytes (rtid, size, etc.)
    // Actually for AssemblyScript, the string length is at offset 4 (32-bit)
    // and data starts at offset 20 (or 16 for newer versions)
    // Let's try different offsets
    const len = view.getUint32(ptr + 16, true); // try offset 16 for size
    if (len > 0 && len < 100000) {
      const chars = new Uint16Array(buf, ptr + 20, len);
      return String.fromCharCode(...chars);
    }
    // Try offset 4 for size (older AssemblyScript)
    const len2 = view.getUint32(ptr + 4, true);
    if (len2 > 0 && len2 < 100000) {
      const chars = new Uint16Array(buf, ptr + 8, len2);
      return String.fromCharCode(...chars);
    }
    // Try reading as C string (null-terminated)
    const arr = new Uint8Array(buf, ptr, 1000);
    let end = arr.indexOf(0);
    if (end > 0) return new TextDecoder().decode(arr.subarray(0, end));
    return `<ptr:${ptr}>`;
  } catch(e) {
    return `<error:${e.message}>`;
  }
}

function readStringFromExports(ptr) {
  // Use the WASM's own string handling
  // In newer AssemblyScript, __new creates objects
  // But for reading strings, we can try to use the exported functions
  return readString(ptr);
}

async function main() {
  console.log('Loading WASM module...');

  const wasmModule = await WebAssembly.instantiate(wasmBuffer, imports);
  wasmExports = wasmModule.instance.exports;
  memory = wasmExports.memory;

  console.log('WASM exports:', Object.keys(wasmExports).filter(k => typeof wasmExports[k] === 'function'));
  console.log('Memory:', memory.buffer.byteLength, 'bytes');

  // Step 1: Call serve() to get the hash
  console.log('\n--- Step 1: serve() ---');
  let hashPtr;
  try {
    hashPtr = wasmExports.serve();
    console.log('serve() returned ptr:', hashPtr);
    const hashStr = readStringFromExports(hashPtr);
    console.log('Hash string:', hashStr);
  } catch(e) {
    console.error('serve() failed:', e.message);
  }

  // Step 2: Call verify with the hash
  console.log('\n--- Step 2: verify() ---');
  try {
    const result = wasmExports.verify(hashPtr);
    console.log('verify() result:', result);
  } catch(e) {
    console.error('verify() failed:', e.message);
    console.log('Abort message:', abortMsg);
  }

  // Step 3: Try decrypt with a test value
  console.log('\n--- Step 3: decrypt() ---');
  try {
    // We need to pass the encrypted hex string as an AssemblyScript string
    // First, let's try with a simple test
    const testData = "0123456789abcdef";
    // We'd need to allocate this in WASM memory - let's skip for now
    console.log('Decrypt test skipped - need proper string allocation');
  } catch(e) {
    console.error('decrypt() failed:', e.message);
  }
}

main().catch(console.error);
