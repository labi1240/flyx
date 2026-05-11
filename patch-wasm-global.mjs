// Patch WASM g_sb global (index 70) from init=0 to init=1
import { readFileSync, writeFileSync } from 'fs';

const wasm = readFileSync('videasy-module.wasm');
const data = new Uint8Array(wasm);

// Parse WASM sections to find global section (id=6)
let offset = 8; // skip magic + version
console.log('Parsing WASM sections...');

let globalSectionOffset = -1;
let globalSectionSize = 0;

while (offset < data.length) {
  const sectionId = data[offset];
  offset += 1;

  // Read LEB128 size
  let size = 0;
  let shift = 0;
  while (true) {
    const byte = data[offset++];
    size |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }

  console.log(`Section ${sectionId}: offset=${offset}, size=${size}`);

  if (sectionId === 6) {
    globalSectionOffset = offset;
    globalSectionSize = size;
    break;
  }

  offset += size;
}

if (globalSectionOffset < 0) {
  console.error('Global section not found!');
  process.exit(1);
}

console.log(`\nGlobal section at offset ${globalSectionOffset}, size ${globalSectionSize}`);

// Parse the global section to count entries and find index 70
let pos = globalSectionOffset;
const globalSectionEnd = globalSectionOffset + globalSectionSize;

// Read count of globals
let numGlobals = 0;
let shift = 0;
while (true) {
  const byte = data[pos++];
  numGlobals |= (byte & 0x7f) << shift;
  shift += 7;
  if ((byte & 0x80) === 0) break;
}
console.log(`Number of globals: ${numGlobals}`);

// Walk through each global
let globalIdx = 0;
while (pos < globalSectionEnd && globalIdx < numGlobals) {
  const startPos = pos;
  const type = data[pos++];
  const mutable = data[pos++];

  // Read init expression (ends with 0x0b)
  const initStart = pos;
  while (pos < data.length && data[pos] !== 0x0b) pos++;
  pos++; // skip 0x0b

  const initLen = pos - initStart - 1;
  const initBytes = Array.from(data.slice(initStart, initStart + Math.min(initLen, 10)));

  if (globalIdx === 70) {
    console.log(`\n*** Global 70 found at offset ${startPos} ***`);
    console.log(`  type: ${type} (0x${type.toString(16)}, ${type === 0x7f ? 'i32' : type === 0x7e ? 'i64' : 'other'})`);
    console.log(`  mutable: ${mutable}`);
    console.log(`  init bytes: ${initBytes.map(b => '0x' + b.toString(16).padStart(2,'0')).join(' ')}`);

    // For i32.const 0, the init is: 0x41 0x00 0x0b
    // We want: 0x41 0x01 0x0b
    if (initBytes[0] === 0x41 && initBytes[1] === 0x00) {
      console.log(`  Patching: 0x41 0x00 -> 0x41 0x01 at offset ${initStart + 1}`);
      data[initStart + 1] = 0x01;
      console.log('  Patch applied!');
    } else if (initBytes[0] !== 0x41) {
      console.log(`  WARNING: Expected i32.const (0x41), got 0x${initBytes[0].toString(16)}`);
    } else {
      console.log(`  WARNING: Already non-zero: ${initBytes[1]}`);
    }
  } else if (globalIdx > 70) {
    // Just show first few after
    console.log(`  Global ${globalIdx}: type=${type}, mutable=${mutable}, init=${initBytes.slice(0,5).map(b=>'0x'+b.toString(16).padStart(2,'0')).join(' ')}`);
  }

  globalIdx++;
}

console.log(`\nTotal globals parsed: ${globalIdx}`);

// Write patched WASM
writeFileSync('videasy-module-patched.wasm', data);
console.log('Saved patched WASM to videasy-module-patched.wasm');
