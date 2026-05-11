// Patch the "g_sb = 0" instruction in f_vb to "g_sb = 1"
// This makes decrypt always re-verifiable (single-use gate removed)
import { readFileSync, writeFileSync } from 'fs';

const wasm = readFileSync('videasy-module-patched.wasm');
const data = new Uint8Array(wasm);

// Find code section (section 10)
let offset = 8;
let codeSectionStart = -1;
let codeSectionSize = 0;

while (offset < data.length) {
  const sectionId = data[offset++];
  let size = 0, shift = 0;
  while (true) {
    const byte = data[offset++];
    size |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  if (sectionId === 10) {
    codeSectionStart = offset;
    codeSectionSize = size;
    break;
  }
  offset += size;
}

console.log('Code section at', codeSectionStart, 'size', codeSectionSize);

// Pattern: i32.const 0 (41 00) + global.set 70 (24 46)
// 70 in LEB128 = 0x46
const pattern = [0x41, 0x00, 0x24, 0x46];
const end = codeSectionStart + codeSectionSize;

let matchCount = 0;
for (let i = codeSectionStart; i < end - pattern.length; i++) {
  let match = true;
  for (let j = 0; j < pattern.length; j++) {
    if (data[i + j] !== pattern[j]) {
      match = false;
      break;
    }
  }
  if (match) {
    matchCount++;
    console.log(`Match ${matchCount} at offset ${i}: [${Array.from(data.slice(i,i+pattern.length)).map(b=>'0x'+b.toString(16).padStart(2,'0')).join(' ')}]`);

    // Change i32.const 0 to i32.const 1
    data[i + 1] = 0x01;
    console.log(`  Patched to: [${Array.from(data.slice(i,i+pattern.length)).map(b=>'0x'+b.toString(16).padStart(2,'0')).join(' ')}]`);
  }
}

console.log(`\nTotal matches patched: ${matchCount}`);

if (matchCount > 0) {
  writeFileSync('videasy-module-patched.wasm', data);
  console.log('Updated videasy-module-patched.wasm');
}
