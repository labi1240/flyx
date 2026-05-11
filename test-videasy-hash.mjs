// Simpler approach: get serve() output, extract X values, compute hash
import { readFileSync } from 'fs';

const wasmBuffer = readFileSync('videasy-module.wasm');

let wasmExports;
let memory;

const imports = {
  env: {
    seed() { return 12345.6789; },
    abort(msgPtr, filePtr, line, column) {
      throw new Error('abort');
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

  // Get serve() output
  const servePtr = wasmExports.serve();
  const serveCode = readFullString(servePtr);
  console.log('serve() length:', serveCode.length);

  // Extract X1-X50 values
  const xValues = [];
  for (let i = 1; i <= 50; i++) {
    const re = new RegExp(`window\\.X${i}\\s*=\\s*"(\\d+)"`);
    const match = serveCode.match(re);
    if (match) xValues.push(match[1]);
  }
  console.log('Extracted', xValues.length, 'X values');
  console.log('X1 (first 30):', xValues[0]?.substring(0, 30));
  console.log('X50 (first 30):', xValues[49]?.substring(0, 30));

  // Try various hash candidates
  const candidates = [];

  // 1. Concatenation of all X values
  candidates.push(['concat all X', xValues.join('')]);

  // 2. Just X1
  candidates.push(['X1 alone', xValues[0]]);

  // 3. X values joined by some delimiter
  candidates.push(['X joined by +', xValues.join('+')]);
  candidates.push(['X joined by empty', xValues.join('')]);

  // 4. First few X values
  candidates.push(['X1+X2+X3', xValues.slice(0,3).join('')]);
  candidates.push(['X1+X2+X3+X4+X5', xValues.slice(0,5).join('')]);

  // 5. The last 200 chars of serve code (which ends with the hash assignment)
  // Extract from the serve output: the hash is set to the result of the obfuscated computation
  // The obfuscated code structure:
  // _0x24();_0x36(_0x3.split("+")[0] + window[X])[forEach](function($){window[hash]=$})
  //
  // Try to get the _0x3 value from the obfuscated code
  // _0x3 is likely defined as X1+X2+...+X50 or similar

  // Let me look at what the obfuscated code section computes
  // Extract the obfuscated section
  const obfStart = serveCode.indexOf('!function');
  if (obfStart >= 0) {
    const obfCode = serveCode.substring(obfStart);
    // Normalize line endings for JS
    const normalizedCode = obfCode.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Try to execute in a controlled scope
    const window = {};
    for (let i = 1; i <= 50; i++) {
      window['X' + i] = xValues[i - 1];
    }
    window.location = { hostname: 'player.videasy.net', href: 'https://player.videasy.net/', host: 'player.videasy.net' };

    try {
      // Use Function constructor with specific globals
      const fn = new Function('window', 'atob', 'btoa', 'console', normalizedCode);
      fn(window,
        (s) => Buffer.from(s, 'base64').toString('binary'),
        (s) => Buffer.from(s, 'binary').toString('base64'),
        { log() {}, warn() {}, error() {} }
      );
      console.log('Execution succeeded!');
      console.log('window.hash:', window.hash?.substring(0, 200));

      if (window.hash) {
        // Test verify
        const hashPtr = allocString(window.hash);
        const verifyResult = wasmExports.verify(hashPtr);
        console.log('verify result:', verifyResult);

        if (verifyResult !== 0) {
          console.log('*** VERIFICATION PASSED! ***');
          // Test decrypt
          const testData = "34fa287bd60d8980f2ed92b4814f423e";
          const testPtr = allocString(testData);
          const decryptedPtr = wasmExports.decrypt(testPtr, 550.0);
          if (decryptedPtr) {
            console.log('decrypted:', readFullString(decryptedPtr).substring(0, 500));
          }
        }
      }
    } catch(e) {
      console.log('Execution error:', e.message);

      // Try extracting hash by analyzing the obfuscated code
      // The hash is computed from _0x3.split("+")[0] + window[X]
      // Find _0x3 definition
      const m3 = normalizedCode.match(/var _0x3\s*=\s*["']([^"']+)["']/);
      if (m3) console.log('_0x3:', m3[1].substring(0, 200));

      // Find the split target
      const splitMatch = normalizedCode.match(/_0x3\[.*?\]\("(\+)"\)/);
      if (splitMatch) console.log('Split delimiter found:', splitMatch[1]);

      // Look for window property access
      const propMatch = normalizedCode.match(/window\[.*?\]/g);
      if (propMatch) {
        for (const m of propMatch.slice(0, 5)) {
          console.log('Window access:', m.substring(0, 80));
        }
      }
    }
  }

  // Also try verify with the X values directly
  console.log('\n=== Trying verify with various candidates ===');
  for (const [name, hash] of candidates) {
    try {
      const ptr = allocString(hash);
      const result = wasmExports.verify(ptr);
      if (result !== 0) {
        console.log(`*** ${name}: VERIFY PASSED! ***`);
      }
    } catch(e) {
      // skip
    }
  }
  console.log('Done trying candidates');
}

main().catch(console.error);
