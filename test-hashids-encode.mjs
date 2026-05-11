// Test actual Hashids module from player-videasy-1470-chunk.js
// by extracting and evaluating the module

import { readFileSync } from 'fs';
import vm from 'vm';

const chunk = readFileSync('player-videasy-1470-chunk.js', 'utf8');

// Extract module 3589
const startMarker = '3589:function(t,e,r){';
const idx = chunk.indexOf(startMarker);
const after = chunk.substring(idx + startMarker.length);

// Find the module boundary - need to match braces
let depth = 1;
let i = 0;
while (i < after.length && depth > 0) {
  if (after[i] === '{') depth++;
  else if (after[i] === '}') depth--;
  i++;
}
const moduleCode = startMarker + after.substring(0, i);
// The module ends with }, which closes the object literal
// But we need to strip the trailing comma
const cleanCode = moduleCode.replace(/,$/, '');

// Now we need to evaluate this module in a context that provides
// the webpack module system (t, e, r)
// t = module, e = exports, r = require (which does r.d and r...)

// Let's reconstruct: module 3589 exports {Z: Hashids class}
// r.d(e, {Z: function(){return m}})
// r.d is webpack's define property helper

const HashidsModule = { exports: {} };
const webpackRequire = {
  d: (exports, definition) => {
    for (const key in definition) {
      Object.defineProperty(exports, key, {
        enumerable: true,
        get: definition[key]
      });
    }
  }
};

// Build the sandbox
const sandbox = {
  module: HashidsModule,
  exports: HashidsModule.exports,
  require: webpackRequire,
  console,
  BigInt,
  TypeError,
  Error,
  Number,
  Math,
  Array,
  Object,
  RegExp,
  String,
  Symbol,
  NaN: Number.NaN,
  isNaN: Number.isNaN,
  parseInt: Number.parseInt,
  isSafeInteger: Number.isSafeInteger,
};

// Wrap as object to make valid JS expression
const wrappedCode = '({' + cleanCode + '})';

// Evaluate the module - extract the function at key 3589
const chunkObj = eval(wrappedCode);
const moduleFn = chunkObj['3589'];

// Create module environment
const mod = { exports: {} };
moduleFn(mod, mod.exports, webpackRequire);
const exports = mod.exports;

const Hashids = exports.Z;
  console.log('Hashids class loaded:', typeof Hashids);

  const h = new Hashids();
  console.log('Default instance created');

  // Test basic encode
  console.log('\n--- Basic encode tests ---');
  console.log('encode(12345):', h.encode(12345));
  console.log('encode([1,2,3]):', h.encode([1, 2, 3]));

  // Test with a number that looks like what we'd get from XOR
  console.log('\n--- Test with various inputs ---');
  const testHex = '4e495c02';
  console.log('encode("4e495c02"):', JSON.stringify(h.encode(testHex)));
  console.log('encodeHex("4e495c02"):', JSON.stringify(h.encodeHex(testHex)));

  // Test with decimal string
  console.log('encode("12345"):', JSON.stringify(h.encode("12345")));

  // Test with BigInt
  const bigIntVal = BigInt('0x' + testHex);
  console.log('BigInt of hex:', bigIntVal);
  console.log('encode(BigInt):', h.encode(bigIntVal));

  // Now compute the actual XOR transform for tmdbId 550
  const tmdbId = '550';
  const salt = 'd486ae1ce6fdbe63b60bd1704541fcf0';
  const input = tmdbId + salt;

  const keyStr = '8c465aa8af6cbfd4c1f91bf0c8d678ba';
  const t = str => str.split('').map(c => c.charCodeAt(0));
  const keyBytes = t(keyStr);

  const xorResult = input.split('').map(ch => {
    const charCode = ch.charCodeAt(0);
    return keyBytes.reduce((e, t) => e ^ t, charCode);
  });

  const hexString = xorResult.map(e => ('0' + Number(e).toString(16)).substr(-2)).join('');
  console.log('\n--- Actual XOR result ---');
  console.log('Input length:', input.length);
  console.log('XOR hex string:', hexString);
  console.log('XOR hex length:', hexString.length);

  // Try encoding
  console.log('\n--- Encoding XOR hex string ---');
  console.log('encode(hexString):', JSON.stringify(h.encode(hexString)));
  console.log('encodeHex(hexString):', JSON.stringify(h.encodeHex(hexString)));

  // Try converting to BigInt first
  const bigIntFromHex = BigInt('0x' + hexString);
  console.log('via BigInt:', h.encode(bigIntFromHex));

  // Check if all hex chars happen to be 0-9
  const hasHexLetters = /[a-f]/.test(hexString);
  console.log('Has hex letters:', hasHexLetters);

  // Check each XOR value
  console.log('\nFirst 10 XOR values:');
  for (let i = 0; i < 10; i++) {
    const ch = input[i];
    const xorVal = xorResult[i];
    const hexVal = hexString.substring(i*2, i*2+2);
    console.log(`  '${ch}' (${ch.charCodeAt(0)}) -> XOR=${xorVal} -> hex=${hexVal}`);
  }

  // KEY FINDING: What is the cumulative XOR of key bytes?
  const keyXor = keyBytes.reduce((a, b) => a ^ b, 0);
  console.log('\nCumulative key XOR:', keyXor);
  console.log('So each input byte XORed with', keyXor, 'gives the result');

// Done
