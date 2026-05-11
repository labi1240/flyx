// Test: compute b35ebba4 key for tmdbId and test API call
import { createHashids } from './hashids.mjs';

// XOR transform from movie chunk
function xorTransform(input) {
  const key = "8c465aa8af6cbfd4c1f91bf0c8d678ba";
  const t = s => s.split("").map(c => c.charCodeAt(0));
  const keyBytes = t(key);
  return t(input).map(byte =>
    keyBytes.reduce((e, t) => e ^ t, byte)
  ).map(e => ("0" + Number(e).toString(16)).substr(-2)).join("");
}

// Test with tmdbId 550
const tmdbId = "550";
const salt = "d486ae1ce6fdbe63b60bd1704541fcf0";
const hexResult = xorTransform(tmdbId + salt);
console.log('XOR result (hex):', hexResult);

// Now Hashids encode the hex result
// The hex string is the input to Hashids.encode()
// But note: Hashids expects a number or array of numbers
// In the browser code: new b.Z().encode(I) where I is the hex string
// But Hashids.encode() takes numbers, not hex strings!
// Let me check the JS chunk more carefully...

// Actually, looking at the code again:
// I = xorTransform(S + "d486ae1ce6fdbe63b60bd1704541fcf0");
// e = { b35ebba4: new b.Z().encode(I), ... };
//
// b.Z() is Hashids. But Hashids.encode() takes a number (or numbers), not a string!
// Unless this is a modified Hashids...

// Let me check: the hex string "4e495c02..." when passed to Hashids.encode()
// would be treated as... a string? That doesn't make sense.
//
// Maybe the XOR result (which produces a hex string) is actually meant to be
// interpreted as a BigInt or number?
//
// Let me look at the Hashids implementation more carefully.
// From the summary: module 3589 is standard Hashids with default alphabet
// and separators "cfhistuCFHISTU"

// Actually wait - Hashids.encode() can take a string in some implementations?
// Or maybe it takes a BigInt?
//
// The hex string is like "4e495c024e495c02..." which is very long (tmdbId+salt length chars * 2 hex chars)
// For tmdbId="550", input = "550d486ae1ce6fdbe63b60bd1704541fcf0"
// Length = 3 + 32 = 35 chars
// Hex result = 35 * 2 = 70 hex chars

// Hashids with a hex string as input...
// Actually, looking at the movie chunk code:
//   e => ("0" + Number(e).toString(16)).substr(-2)
// This converts each XORed byte to a 2-char hex string
// Then .join("") concatenates them all
//
// So I is a long hex string like "4e495c02..."
// Then new b.Z().encode(I) where b.Z() is Hashids
//
// But Hashids.encode() expects integers! In the standard implementation:
// encode(...numbers: number[]): string
//
// Could the input hex string be converted to BigInt first?
// Or maybe this is NOT standard Hashids?

const hashids = createHashids();
console.log('Hashids test with number:', hashids.encode(12345));
console.log('Hashids test with hex string:', hashids.encode(hexResult));
console.log('Hashids test with BigInt:', hashids.encode(BigInt('0x' + hexResult)));
