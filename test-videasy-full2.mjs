// Full WASM test v2 - read full serve() output
import { readFileSync, writeFileSync } from 'fs';
import vm from 'vm';

const wasmBuffer = readFileSync('videasy-module.wasm');

let wasmExports;
let memory;

const imports = {
  env: {
    seed() { return 12345.6789; },
    abort(msgPtr, filePtr, line, column) {
      const msg = readString(msgPtr, 100000);
      const file = readString(filePtr, 100000);
      throw new Error(`WASM abort: ${msg} at ${file}:${line}:${column}`);
    }
  }
};

function readString(ptr, maxBytes = 100000) {
  if (!ptr) return '(null)';
  const buf = new Uint8Array(memory.buffer);
  const chars = [];
  const end = Math.min(ptr + maxBytes, buf.length - 1);
  for (let i = ptr; i < end; i += 2) {
    if (buf[i] === 0 && buf[i + 1] === 0) break;
    const code = buf[i] | (buf[i + 1] << 8);
    chars.push(String.fromCharCode(code));
  }
  return chars.join('');
}

function allocString(str) {
  const len = str.length;
  // For AssemblyScript, use __new with proper string class ID
  // String ID in AssemblyScript: typically STRING class has id=2
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
  console.log('Loading WASM...');
  const wasmModule = await WebAssembly.instantiate(wasmBuffer, imports);
  wasmExports = wasmModule.instance.exports;
  memory = wasmExports.memory;
  const buf = new Uint8Array(memory.buffer);

  // Step 1: Get full serve() output
  console.log('\n=== Step 1: serve() ===');
  const servePtr = wasmExports.serve();
  const serveCode = readString(servePtr, 100000);
  console.log('serve() length:', serveCode.length);

  // Save serve() output to file for analysis
  writeFileSync('serve-output.js', serveCode);
  console.log('Saved serve output to serve-output.js');

  // Step 2: Check what the serve code looks like at the beginning and end
  console.log('\nFirst 200 chars:', serveCode.substring(0, 200));
  console.log('Last 200 chars:', serveCode.substring(serveCode.length - 200));

  // Step 3: Execute in sandbox
  console.log('\n=== Step 2: Execute serve() code ===');
  const sandbox = {
    window: {},
    document: {},
    navigator: { userAgent: 'Mozilla/5.0' },
    location: {},
    self: undefined,
    globalThis: undefined,
    console: { log(...args) {} },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  };

  // Set up window.location
  sandbox.window.location = { hostname: 'player.videasy.net', href: 'https://player.videasy.net/', host: 'player.videasy.net' };
  sandbox.document.location = sandbox.window.location;
  sandbox.location = sandbox.window.location;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;
  sandbox.window.navigator = sandbox.navigator;

  try {
    vm.createContext(sandbox);
    vm.runInContext(serveCode, sandbox, { timeout: 10000 });

    // Check what was set
    console.log('window.X1:', sandbox.window.X1?.substring(0, 80));
    console.log('window.X50:', sandbox.window.X50?.substring(0, 80));
    console.log('window.hash:', sandbox.window.hash?.substring(0, 200));

    for (let i = 1; i <= 50; i++) {
      if (!sandbox.window['X'+i]) console.log('Missing X'+i);
    }
  } catch (e) {
    console.error('Execution error:', e.message);
    console.log('Error line:', e.stack?.split('\n')[1]);

    // Check what was set before error
    console.log('window.X1 after error:', sandbox.window.X1?.substring(0, 80));
    console.log('window.hash after error:', sandbox.window.hash?.substring(0, 200));

    // Count how many X values were set
    let setCount = 0;
    for (let i = 1; i <= 50; i++) {
      if (sandbox.window['X'+i]) setCount++;
    }
    console.log('X values set:', setCount);
  }

  // Step 4: Try verify with window.hash
  if (sandbox.window.hash) {
    console.log('\n=== Step 3: verify() with window.hash ===');
    const hashPtr = allocString(sandbox.window.hash);
    const result = wasmExports.verify(hashPtr);
    console.log('verify result:', result);

    if (result !== 0) {
      console.log('VERIFICATION PASSED!');

      // Step 5: Test decrypt
      console.log('\n=== Step 4: decrypt() ===');
      const testData = "34fa287bd60d8980"; // first 16 chars of encrypted API response
      const testPtr = allocString(testData);
      try {
        const decryptedPtr = wasmExports.decrypt(testPtr, 550.0);
        console.log('decrypt returned:', decryptedPtr);
        if (decryptedPtr) {
          console.log('decrypted:', readString(decryptedPtr, 10000).substring(0, 500));
        }
      } catch(e) {
        console.error('decrypt failed:', e.message);
      }
    }
  } else {
    console.log('\nNo window.hash');
    // Try to figure out the hash from what we know

    // Check if hash is the concatenation of X1-X50 values
    // (the number strings from the serve output)
    const serveOutput = serveCode;
    const xMatches = serveOutput.match(/window\.X\d+\s*=\s*"(\d+)"/g);
    if (xMatches) {
      console.log('Found', xMatches.length, 'X assignments in serve output');
      // Extract just the number values
      const xValues = xMatches.map(m => m.match(/"(\d+)"/)[1]);
      // Try: hash = concatenation of all X values
      const concatAll = xValues.join('');
      console.log('Concat all X (first 100):', concatAll.substring(0, 100));
      const ptr = allocString(concatAll);
      console.log('verify(concatAll) result:', wasmExports.verify(ptr));
    }
  }
}

main().catch(console.error);
