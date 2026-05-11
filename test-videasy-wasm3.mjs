// Test WASM module - extract serve() string and hash values
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

async function main() {
  const wasmModule = await WebAssembly.instantiate(wasmBuffer, imports);
  wasmExports = wasmModule.instance.exports;
  memory = wasmExports.memory;
  const buf = new Uint8Array(memory.buffer);

  // Read serve() return value as proper AssemblyScript string
  // The returned ptr is an AssemblyScript string object
  const servePtr = wasmExports.serve();
  console.log('serve() ptr:', servePtr);

  // Read the serve string
  console.log('\n=== serve() string (first 500 chars) ===');
  // AssemblyScript string: try reading as UTF-16 at ptr with various offsets
  // The raw bytes at ptr start with: 0d 00 0a 00 2f 00...
  // This looks like it starts directly at ptr (no header)
  const chars = [];
  for (let i = servePtr; i < servePtr + 2000 && i < buf.length; i += 2) {
    const code = buf[i] | (buf[i+1] << 8);
    if (code === 0) break;
    if (code < 128) chars.push(String.fromCharCode(code));
  }
  console.log(chars.join(''));

  // Now let's look at the window.X<n> strings
  // The template is at offset 216368 but the actual filled-in values are
  // likely elsewhere. Let's search for "window.X" at runtime
  console.log('\n=== Searching for window.X values in runtime memory ===');
  const windowPattern = [];
  for (const ch of 'window.X') {
    windowPattern.push(ch.charCodeAt(0), 0);
  }

  for (let i = 0; i < buf.length - 100; i++) {
    let match = true;
    for (let j = 0; j < windowPattern.length; j++) {
      if (buf[i + j] !== windowPattern[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      // Read the full string
      const chars = [];
      for (let k = i; k < i + 200 && k < buf.length; k += 2) {
        const code = buf[k] | (buf[k+1] << 8);
        if (code === 0 || code === 0x0d || code === 0x0a) break;
        if (code < 128) chars.push(String.fromCharCode(code));
      }
      const str = chars.join('');
      if (str.startsWith('window.X') && str.includes('=')) {
        console.log(`offset ${i}: ${str}`);
      }
    }
  }

  // Also try to find "window.hash" or just "hash" strings
  console.log('\n=== Searching for .hash pattern ===');
  const hashPattern = [];
  for (const ch of '.hash=') {
    hashPattern.push(ch.charCodeAt(0), 0);
  }
  for (let i = 0; i < buf.length - 30; i++) {
    let match = true;
    for (let j = 0; j < hashPattern.length; j++) {
      if (buf[i + j] !== hashPattern[j]) { match = false; break; }
    }
    if (match) {
      const chars = [];
      for (let k = i - 20; k < i + 100 && k < buf.length; k += 2) {
        const code = buf[k] | (buf[k+1] << 8);
        if (code === 0) break;
        if (code >= 32 && code < 128) chars.push(String.fromCharCode(code));
      }
      console.log(`offset ${i}: ...${chars.join('')}`);
    }
  }

  // Check the verification status
  console.log('\n=== Trying verify with serve() value ===');
  // serve() returns a JS code string. We need to extract the actual hash value
  // from it. The cineby.sc code does: Function(s.serve())() then reads window.hash
  // So serve() returns code that SETS window.hash

  // Let's look for the full serve string around position 309808
  console.log('\n=== Full serve() string dump (UTF-16LE, starting at ptr) ===');
  const serveStr = [];
  for (let i = servePtr; i < servePtr + 10000 && i < buf.length; i += 2) {
    const code = buf[i] | (buf[i+1] << 8);
    if (code === 0) break;
    serveStr.push(String.fromCharCode(code));
  }
  const fullServe = serveStr.join('');
  console.log(fullServe.substring(0, 3000));

  // Look for the hash value pattern in the serve output
  // The hash should be assigned to window.hash or similar
  const hashMatch = fullServe.match(/window\.hash\s*=\s*['"]([^'"]+)['"]/);
  if (hashMatch) {
    console.log('\n*** FOUND window.hash =', hashMatch[1], '***');
  }
}

main().catch(console.error);
