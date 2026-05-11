// Full WASM test v3 - read full serve output, execute, pass verify, decrypt
import { readFileSync, writeFileSync } from 'fs';
import vm from 'vm';

const wasmBuffer = readFileSync('videasy-module.wasm');

let wasmExports;
let memory;

const imports = {
  env: {
    seed() { return 12345.6789; },
    abort(msgPtr, filePtr, line, column) {
      const msg = readFullString(msgPtr);
      const file = readFullString(filePtr);
      console.error('WASM ABORT:', msg, 'at', file, line, column);
      throw new Error(`WASM abort: ${msg} at ${file}:${line}:${column}`);
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
  console.log('Loading WASM...');
  const wasmModule = await WebAssembly.instantiate(wasmBuffer, imports);
  wasmExports = wasmModule.instance.exports;
  memory = wasmExports.memory;

  // Get full serve() output
  const servePtr = wasmExports.serve();
  const serveCode = readFullString(servePtr);
  console.log('serve() length:', serveCode.length);
  writeFileSync('serve-output.js', serveCode);

  // Execute in sandbox with comprehensive browser mocks
  console.log('Setting up sandbox...');
  const sandbox = vm.createContext({
    window: {},
    document: { createElement: () => ({}), location: {} },
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    location: {},
    self: null,
    globalThis: null,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => { try { fn(); } catch(e) {} },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    performance: { now: () => Date.now() },
    crypto: { getRandomValues: (arr) => { for(let i=0;i<arr.length;i++) arr[i]=Math.floor(Math.random()*256); return arr; }},
    ArrayBuffer,
    Uint8Array,
    Uint16Array,
  });
  sandbox.window.location = { hostname: 'player.videasy.net', href: 'https://player.videasy.net/', host: 'player.videasy.net', protocol: 'https:', pathname: '/', search: '', hash: '' };
  sandbox.document.location = sandbox.window.location;
  sandbox.location = sandbox.window.location;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;
  sandbox.window.navigator = sandbox.navigator;
  sandbox.window.console = sandbox.console;
  sandbox.window.top = sandbox.window;
  sandbox.window.self = sandbox.window;
  sandbox.window.parent = sandbox.window;

  console.log('Executing serve() code...');
  try {
    vm.runInContext(serveCode, sandbox, { timeout: 30000 });
    console.log('Execution completed successfully');
  } catch (e) {
    console.log('Execution error:', e.message);
    console.log('Error stack first line:', e.stack?.split('\n')[0]);
  }

  // Check results
  console.log('\n=== Results ===');
  console.log('window.hash:', sandbox.window.hash?.substring(0, 200));
  console.log('window.X1 exists:', !!sandbox.window.X1);

  // Check ALL properties set on window
  const windowKeys = Object.keys(sandbox.window).filter(k => !['location','document','navigator','console','top','self','parent'].includes(k));
  console.log('Custom window keys:', windowKeys);

  // Try verify with window.hash
  if (sandbox.window.hash) {
    console.log('\n=== verify() with window.hash ===');
    const hashPtr = allocString(sandbox.window.hash);
    console.log('hash value:', sandbox.window.hash.substring(0, 200));
    const result = wasmExports.verify(hashPtr);
    console.log('verify result:', result);

    if (result !== 0) {
      console.log('*** VERIFICATION PASSED! ***');

      // Test decrypt with a real encrypted hex string
      console.log('\n=== Test decrypt ===');
      const testData = "34fa287bd60d8980f2ed92b4814f423e"; // first 32 chars
      const testPtr = allocString(testData);
      try {
        const decryptedPtr = wasmExports.decrypt(testPtr, 550.0);
        if (decryptedPtr) {
          const decrypted = readFullString(decryptedPtr);
          console.log('decrypted (first 500):', decrypted.substring(0, 500));
        } else {
          console.log('decrypt returned null/0');
        }
      } catch(e) {
        console.error('decrypt error:', e.message);
      }
    } else {
      console.log('Verification FAILED');

      // Try different hash values
      const xKeys = windowKeys.filter(k => k.startsWith('X'));
      if (xKeys.length > 0) {
        console.log('\nTrying with individual X values...');
        for (let i = 1; i <= Math.min(5, xKeys.length); i++) {
          const val = sandbox.window['X'+i];
          if (val) {
            const ptr = allocString(val);
            console.log('verify(X'+i+') =', wasmExports.verify(ptr));
          }
        }
      }
    }
  } else {
    console.log('window.hash was NOT set');

    // Check for any hash-like properties
    for (const key of Object.keys(sandbox.window)) {
      if (key.toLowerCase().includes('hash')) {
        console.log('Found hash-like key:', key, '=', sandbox.window[key]?.substring(0, 100));
      }
    }

    // List all window keys with their types
    for (const key of Object.keys(sandbox.window)) {
      const val = sandbox.window[key];
      const type = typeof val;
      const preview = type === 'string' ? val.substring(0, 50) : type;
      console.log(`window.${key}: ${preview}`);
    }
  }
}

main().catch(console.error);
