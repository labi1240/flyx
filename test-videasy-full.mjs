// Full test: Load WASM, run serve(), pass verify(), call decrypt()
import { readFileSync } from 'fs';
import vm from 'vm';

const wasmBuffer = readFileSync('videasy-module.wasm');

let wasmExports;
let memory;

const imports = {
  env: {
    seed() { return 12345.6789; },
    abort(msgPtr, filePtr, line, column) {
      const msg = readString(msgPtr);
      const file = readString(filePtr);
      throw new Error(`WASM abort: ${msg} at ${file}:${line}:${column}`);
    }
  }
};

function readString(ptr) {
  if (!ptr) return '(null)';
  const buf = new Uint8Array(memory.buffer);
  const chars = [];
  for (let i = ptr; i < ptr + 10000 && i < buf.length; i += 2) {
    const code = buf[i] | (buf[i + 1] << 8);
    if (code === 0) break;
    if (code < 128) chars.push(String.fromCharCode(code));
  }
  return chars.join('');
}

function allocString(str) {
  // Allocate a UTF-16LE string in WASM memory using AssemblyScript __new
  // AssemblyScript string: __new(length * 2, id_of_string_class)
  // String class ID for AssemblyScript is typically 2
  const len = str.length;
  const byteLen = len * 2; // UTF-16 = 2 bytes per char
  // __new(size, classId)
  const ptr = wasmExports.__new(byteLen, 2); // 2 = string class ID
  // Write the string data
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

  // Step 1: Get serve() output
  console.log('\n=== Step 1: serve() ===');
  const servePtr = wasmExports.serve();
  const serveCode = readString(servePtr);
  console.log('serve() length:', serveCode.length, 'chars');

  // Step 2: Execute serve() code in sandboxed VM to extract window.hash
  console.log('\n=== Step 2: Execute serve() code ===');
  const sandbox = {
    window: {
      X1: '', X2: '', X3: '', X4: '', X5: '',
      X6: '', X7: '', X8: '', X9: '', X10: '',
      X11: '', X12: '', X13: '', X14: '', X15: '',
      X16: '', X17: '', X18: '', X19: '', X20: '',
      X21: '', X22: '', X23: '', X24: '', X25: '',
      X26: '', X27: '', X28: '', X29: '', X30: '',
      X31: '', X32: '', X33: '', X34: '', X35: '',
      X36: '', X37: '', X38: '', X39: '', X40: '',
      X41: '', X42: '', X43: '', X44: '', X45: '',
      X46: '', X47: '', X48: '', X49: '', X50: '',
      hash: '',
      location: { hostname: 'player.videasy.net', href: 'https://player.videasy.net/', host: 'player.videasy.net' },
      document: { location: { hostname: 'player.videasy.net', host: 'player.videasy.net' } },
      navigator: { userAgent: 'Mozilla/5.0' },
    },
    self: {},
    globalThis: {},
    document: { location: { hostname: 'player.videasy.net' } },
    location: { hostname: 'player.videasy.net' },
    navigator: { userAgent: 'Mozilla/5.0' },
    console: { log() {} },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  try {
    vm.createContext(sandbox);
    vm.runInContext(serveCode, sandbox, { timeout: 5000 });
    console.log('window.X1:', sandbox.window.X1?.substring(0, 80) + '...');
    console.log('window.hash:', sandbox.window.hash?.substring(0, 200));
  } catch (e) {
    console.error('Execution error:', e.message);
    // Continue even if it errors - we might still have window.X values
    console.log('window.hash after error:', sandbox.window.hash?.substring(0, 200));
  }

  // Step 3: If we have window.hash, try verify
  if (sandbox.window.hash) {
    console.log('\n=== Step 3: verify() ===');
    const hashPtr = allocString(sandbox.window.hash);
    console.log('hashPtr:', hashPtr);
    console.log('hash value:', readString(hashPtr).substring(0, 100));
    const verifyResult = wasmExports.verify(hashPtr);
    console.log('verify result:', verifyResult);
  } else {
    console.log('\nNo window.hash found, trying alternatives...');

    // Try concatenating X1-X50 as the hash
    const allX = [];
    for (let i = 1; i <= 50; i++) {
      allX.push(sandbox.window['X' + i]);
    }
    const concatHash = allX.join('');
    console.log('Concatenated X1-X50 length:', concatHash.length);
    const hashPtr = allocString(concatHash);
    const result = wasmExports.verify(hashPtr);
    console.log('verify(concat) result:', result);

    // Try just X1
    if (sandbox.window.X1) {
      const x1Ptr = allocString(sandbox.window.X1);
      console.log('verify(X1) result:', wasmExports.verify(x1Ptr));
    }
  }

  // Step 4: Try decrypt
  console.log('\n=== Step 4: Test decrypt ===');
  // The encrypted hex data from api.videasy.net
  const testEncrypted = "34fa287bd60d8980";
  const testPtr = allocString(testEncrypted);
  try {
    const tmdbId = 550.0;
    const decryptedPtr = wasmExports.decrypt(testPtr, tmdbId);
    console.log('decrypt returned:', decryptedPtr);
    console.log('decrypted string:', readString(decryptedPtr).substring(0, 500));
  } catch(e) {
    console.error('decrypt failed:', e.message);
  }
}

main().catch(console.error);
