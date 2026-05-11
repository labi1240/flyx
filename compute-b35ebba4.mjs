// Compute b35ebba4 key for tmdbId using reverse-engineered algorithm
// This mirrors the exact code from player-videasy-movie-chunk.js

// XOR transform - exact replica of the movie chunk code
function xorTransform(input) {
  const t = str => str.split("").map(ch => ch.charCodeAt(0));
  const key = "8c465aa8af6cbfd4c1f91bf0c8d678ba";
  const keyBytes = t(key);
  const keyXor = keyBytes.reduce((e, t) => e ^ t, 0); // cumulative XOR of all key bytes

  return input.split("").map(ch => {
    // t(ch) gives [charCode], which coerces to charCode in XOR
    const charCode = ch.charCodeAt(0);
    return keyBytes.reduce((e, t) => e ^ t, charCode);
  }).map(e => ("0" + Number(e).toString(16)).substr(-2)).join("");
}

// Compute cumulative key XOR
const key = "8c465aa8af6cbfd4c1f91bf0c8d678ba";
const keyXor = key.split("").map(c => c.charCodeAt(0)).reduce((a, b) => a ^ b, 0);
console.log('Cumulative key XOR:', keyXor, '(0x' + keyXor.toString(16) + ')');

// Test with tmdbId = "550"
const tmdbId = "550";
const salt = "d486ae1ce6fdbe63b60bd1704541fcf0";
const hexResult = xorTransform(tmdbId + salt);
console.log('Input:', tmdbId + salt);
console.log('XOR result (hex):', hexResult);
console.log('Hex length:', hexResult.length);

// Verify: each char of input XORed with cumulative key XOR, converted to hex
const manualCheck = (tmdbId + salt).split("").map(c => {
  return ("0" + (c.charCodeAt(0) ^ keyXor).toString(16)).substr(-2);
}).join("");
console.log('Manual check:', manualCheck);
console.log('Match:', hexResult === manualCheck);

// Now Hashids encodeHex - this takes a hex string
// From the code: encodeHex splits into 12-char chunks, prepends "1", parses as hex int
function encodeHex(hexStr) {
  const chunkSize = 12;
  const chunks = [];
  for (let i = 0; i < hexStr.length; i += chunkSize) {
    chunks.push(hexStr.slice(i, i + chunkSize));
  }
  // Each chunk: prepend "1", parse as hex integer
  return chunks.map(chunk => parseInt("1" + chunk, 16));
}

const numbers = encodeHex(hexResult);
console.log('Encoded numbers:', numbers);

// Now we need the actual Hashids library
// Let's use a standard hashids implementation
// But first, let me check if the encode takes an array directly
// From the Hashids module: encode(t,...e) where t can be array or single value

// We can use the hashids npm package or implement just what we need
// For now, let's compute using the standard Hashids algorithm:
// salt="", minLength=0, alphabet=default, separators="cfhistuCFHISTU"

// Let me just implement a minimal Hashids for testing
// Or better, let me use the actual module extracted from the chunk

// Actually, let's just test with a simple approach:
// Write the numbers array and use the hashids npm package to encode
console.log('\nNumbers to encode with Hashids:', numbers);
console.log('Ready for Hashids encoding');
