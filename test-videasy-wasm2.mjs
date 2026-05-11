// Test loading player.videasy.net WASM module in Node.js - v2
import { readFileSync } from 'fs';

const wasmBuffer = readFileSync('videasy-module.wasm');

let wasmExports;
let memory;

const imports = {
  env: {
    seed() { return 12345.6789; },
    abort(msgPtr, filePtr, line, column) {
      throw new Error(`WASM abort at ${line}:${column}`);
    }
  }
};

function inspectPtr(ptr, label) {
  const buf = new Uint8Array(memory.buffer);
  console.log(`\n=== ${label} (ptr=${ptr}) ===`);
  // Dump 100 bytes around the pointer
  console.log('Raw bytes (first 80):');
  const hex = [];
  for (let i = 0; i < 80 && i + ptr < buf.length; i++) {
    hex.push(buf[ptr + i].toString(16).padStart(2, '0'));
  }
  console.log(hex.join(' '));

  // Try to read as UTF-16LE (AssemblyScript string encoding)
  // AssemblyScript string layout (version varies):
  // Offset 0: rtid (4 bytes) or length for older versions
  // For newer AS: offset 16 = length (4 bytes LE), offset 20 = data start
  const view = new DataView(memory.buffer);

  console.log('DataView interpretations:');
  console.log('  [0] i32:', view.getUint32(ptr, true));
  console.log('  [4] i32:', view.getUint32(ptr + 4, true));
  console.log('  [8] i32:', view.getUint32(ptr + 8, true));
  console.log('  [12] i32:', view.getUint32(ptr + 12, true));
  console.log('  [16] i32:', view.getUint32(ptr + 16, true));
  console.log('  [20] i32:', view.getUint32(ptr + 20, true));

  // Try reading as UTF-16 string at various offsets
  for (const dataOff of [16, 8, 4, 0]) {
    const len = view.getUint32(ptr + dataOff, true);
    if (len > 0 && len < 10000) {
      try {
        const chars = new Uint16Array(memory.buffer, ptr + dataOff + 4, len);
        const str = String.fromCharCode(...chars);
        console.log(`  UTF-16 at off+${dataOff}, len=${len}: "${str.substring(0, 200)}"`);
      } catch(e) {
        console.log(`  UTF-16 at off+${dataOff}, len=${len}: ERROR ${e.message}`);
      }
    }
  }

  // Try reading as ASCII/C string
  let asciiEnd = 0;
  for (let i = ptr; i < ptr + 500 && i < buf.length; i++) {
    if (buf[i] === 0) { asciiEnd = i; break; }
  }
  if (asciiEnd > ptr) {
    const ascii = new TextDecoder().decode(buf.subarray(ptr, asciiEnd));
    console.log(`  ASCII (null-term): "${ascii.substring(0, 200)}"`);
  }
}

async function main() {
  console.log('Loading WASM module...');
  const wasmModule = await WebAssembly.instantiate(wasmBuffer, imports);
  wasmExports = wasmModule.instance.exports;
  memory = wasmExports.memory;

  console.log('Memory size:', memory.buffer.byteLength);

  // Dump assembled string template area
  const templatePtr = 216368;
  inspectPtr(templatePtr, 'g_rb template area');

  // Call serve()
  console.log('\n--- Calling serve() ---');
  const hashPtr = wasmExports.serve();
  console.log('serve() returned:', hashPtr);
  inspectPtr(hashPtr, 'serve() result');

  // Try to extract the hash value from the serve string
  // The serve() result should be something like: window.hash='<hex>'
  // or it could be an integer value that gets used as window.hash

  // Let's also try directly examining g_rb
  // Check what other globals exist
  console.log('\n--- Checking WASM memory for hash-like values ---');

  // Try verify with different approaches
  // First, let's see if serve() returns a string we can eval
  const buf = new Uint8Array(memory.buffer);

  // Try to find "window" in memory
  for (let i = 0; i < Math.min(buf.length, 300000); i++) {
    if (buf[i] === 0x77 && buf[i+1] === 0x00 && buf[i+2] === 0x69 && buf[i+3] === 0x00) { // "wi"
      // Check for "window"
      const chunk = new Uint16Array(memory.buffer, i, 30);
      const str = String.fromCharCode(...chunk.slice(0, 20)).replace(/\0/g, '');
      if (str.startsWith('window')) {
        console.log('Found "window" string at offset', i, ':', str.substring(0, 80));
      }
    }
  }
}

main().catch(console.error);
