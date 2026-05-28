/**
 * DLHD Authentication v5 - February 2026
 *
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║  DEPRECATED — March 25, 2026                                     ║
 * ║                                                                   ║
 * ║  EPlayerAuth has been REMOVED from DLHD's player pages.          ║
 * ║  Keys now require ZERO auth headers — only reCAPTCHA IP whitelist.║
 * ║                                                                   ║
 * ║  This file is kept for type exports (DLHDAuthDataV5) and as      ║
 * ║  reference. The fetchAuthData() function will return null for     ║
 * ║  all channels since the player page no longer contains EPlayerAuth║
 * ║  init blocks.                                                     ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * Previous auth system (no longer active):
 * - Pipe-delimited authToken: channelKey|country|timestamp|expiry|signature
 * - MD5-based PoW
 * - channelSalt extracted from player page
 * - Required headers: Authorization, X-Key-Timestamp, X-Key-Nonce, X-Key-Path, X-Fingerprint
 */

/**
 * Auth data from hitsplay.fun player page
 */
export interface DLHDAuthDataV5 {
  authToken: string;
  channelKey: string;
  country: string;
  timestamp: number;
  channelSalt: string;
  source: string;
}

/**
 * Generate browser fingerprint
 * SHA-256(UA + screen + timezone + language).substring(0, 16)
 */
export async function generateFingerprint(): Promise<string> {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const scr = '1920x1080';
  const tz = 'America/New_York';
  const lg = 'en-US';
  const data = ua + scr + tz + lg;
  
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return hashHex.substring(0, 16);
}

/**
 * HMAC-SHA256 helper
 */
async function hmacSha256(data: string, key: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const messageData = encoder.encode(data);
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Export for debugging
export const hmacSha256Debug = hmacSha256;

/**
 * MD5 hash (using Web Crypto workaround since MD5 isn't directly supported)
 * We'll use a simple implementation for the PoW
 */
function md5(str: string): string {
  // Simple MD5 implementation for PoW
  // This is a minimal implementation - in production, use a proper library
  
  function rotateLeft(x: number, n: number): number {
    return (x << n) | (x >>> (32 - n));
  }
  
  function addUnsigned(x: number, y: number): number {
    const x4 = x & 0x80000000;
    const y4 = y & 0x80000000;
    const x8 = x & 0x40000000;
    const y8 = y & 0x40000000;
    const result = (x & 0x3FFFFFFF) + (y & 0x3FFFFFFF);
    if (x8 & y8) return result ^ 0x80000000 ^ x4 ^ y4;
    if (x8 | y8) {
      if (result & 0x40000000) return result ^ 0xC0000000 ^ x4 ^ y4;
      return result ^ 0x40000000 ^ x4 ^ y4;
    }
    return result ^ x4 ^ y4;
  }
  
  function F(x: number, y: number, z: number): number { return (x & y) | (~x & z); }
  function G(x: number, y: number, z: number): number { return (x & z) | (y & ~z); }
  function H(x: number, y: number, z: number): number { return x ^ y ^ z; }
  function I(x: number, y: number, z: number): number { return y ^ (x | ~z); }
  
  function FF(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
    a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }
  function GG(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
    a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }
  function HH(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
    a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }
  function II(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
    a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }
  
  function convertToWordArray(str: string): number[] {
    const lWordCount = (((str.length + 8) - ((str.length + 8) % 64)) / 64 + 1) * 16;
    const lWordArray: number[] = new Array(lWordCount).fill(0);
    let lByteCount = 0;
    let lBytePosition = 0;
    while (lByteCount < str.length) {
      const lWordPosition = (lByteCount - (lByteCount % 4)) / 4;
      lBytePosition = (lByteCount % 4) * 8;
      lWordArray[lWordPosition] = lWordArray[lWordPosition] | (str.charCodeAt(lByteCount) << lBytePosition);
      lByteCount++;
    }
    const lWordPosition = (lByteCount - (lByteCount % 4)) / 4;
    lBytePosition = (lByteCount % 4) * 8;
    lWordArray[lWordPosition] = lWordArray[lWordPosition] | (0x80 << lBytePosition);
    lWordArray[lWordCount - 2] = str.length << 3;
    lWordArray[lWordCount - 1] = str.length >>> 29;
    return lWordArray;
  }
  
  function wordToHex(value: number): string {
    let hex = '';
    for (let i = 0; i <= 3; i++) {
      const byte = (value >>> (i * 8)) & 255;
      hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
  }
  
  const x = convertToWordArray(str);
  let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
  
  const S11 = 7, S12 = 12, S13 = 17, S14 = 22;
  const S21 = 5, S22 = 9, S23 = 14, S24 = 20;
  const S31 = 4, S32 = 11, S33 = 16, S34 = 23;
  const S41 = 6, S42 = 10, S43 = 15, S44 = 21;
  
  for (let k = 0; k < x.length; k += 16) {
    const AA = a, BB = b, CC = c, DD = d;
    
    a = FF(a, b, c, d, x[k + 0], S11, 0xD76AA478);
    d = FF(d, a, b, c, x[k + 1], S12, 0xE8C7B756);
    c = FF(c, d, a, b, x[k + 2], S13, 0x242070DB);
    b = FF(b, c, d, a, x[k + 3], S14, 0xC1BDCEEE);
    a = FF(a, b, c, d, x[k + 4], S11, 0xF57C0FAF);
    d = FF(d, a, b, c, x[k + 5], S12, 0x4787C62A);
    c = FF(c, d, a, b, x[k + 6], S13, 0xA8304613);
    b = FF(b, c, d, a, x[k + 7], S14, 0xFD469501);
    a = FF(a, b, c, d, x[k + 8], S11, 0x698098D8);
    d = FF(d, a, b, c, x[k + 9], S12, 0x8B44F7AF);
    c = FF(c, d, a, b, x[k + 10], S13, 0xFFFF5BB1);
    b = FF(b, c, d, a, x[k + 11], S14, 0x895CD7BE);
    a = FF(a, b, c, d, x[k + 12], S11, 0x6B901122);
    d = FF(d, a, b, c, x[k + 13], S12, 0xFD987193);
    c = FF(c, d, a, b, x[k + 14], S13, 0xA679438E);
    b = FF(b, c, d, a, x[k + 15], S14, 0x49B40821);
    
    a = GG(a, b, c, d, x[k + 1], S21, 0xF61E2562);
    d = GG(d, a, b, c, x[k + 6], S22, 0xC040B340);
    c = GG(c, d, a, b, x[k + 11], S23, 0x265E5A51);
    b = GG(b, c, d, a, x[k + 0], S24, 0xE9B6C7AA);
    a = GG(a, b, c, d, x[k + 5], S21, 0xD62F105D);
    d = GG(d, a, b, c, x[k + 10], S22, 0x2441453);
    c = GG(c, d, a, b, x[k + 15], S23, 0xD8A1E681);
    b = GG(b, c, d, a, x[k + 4], S24, 0xE7D3FBC8);
    a = GG(a, b, c, d, x[k + 9], S21, 0x21E1CDE6);
    d = GG(d, a, b, c, x[k + 14], S22, 0xC33707D6);
    c = GG(c, d, a, b, x[k + 3], S23, 0xF4D50D87);
    b = GG(b, c, d, a, x[k + 8], S24, 0x455A14ED);
    a = GG(a, b, c, d, x[k + 13], S21, 0xA9E3E905);
    d = GG(d, a, b, c, x[k + 2], S22, 0xFCEFA3F8);
    c = GG(c, d, a, b, x[k + 7], S23, 0x676F02D9);
    b = GG(b, c, d, a, x[k + 12], S24, 0x8D2A4C8A);
    
    a = HH(a, b, c, d, x[k + 5], S31, 0xFFFA3942);
    d = HH(d, a, b, c, x[k + 8], S32, 0x8771F681);
    c = HH(c, d, a, b, x[k + 11], S33, 0x6D9D6122);
    b = HH(b, c, d, a, x[k + 14], S34, 0xFDE5380C);
    a = HH(a, b, c, d, x[k + 1], S31, 0xA4BEEA44);
    d = HH(d, a, b, c, x[k + 4], S32, 0x4BDECFA9);
    c = HH(c, d, a, b, x[k + 7], S33, 0xF6BB4B60);
    b = HH(b, c, d, a, x[k + 10], S34, 0xBEBFBC70);
    a = HH(a, b, c, d, x[k + 13], S31, 0x289B7EC6);
    d = HH(d, a, b, c, x[k + 0], S32, 0xEAA127FA);
    c = HH(c, d, a, b, x[k + 3], S33, 0xD4EF3085);
    b = HH(b, c, d, a, x[k + 6], S34, 0x4881D05);
    a = HH(a, b, c, d, x[k + 9], S31, 0xD9D4D039);
    d = HH(d, a, b, c, x[k + 12], S32, 0xE6DB99E5);
    c = HH(c, d, a, b, x[k + 15], S33, 0x1FA27CF8);
    b = HH(b, c, d, a, x[k + 2], S34, 0xC4AC5665);
    
    a = II(a, b, c, d, x[k + 0], S41, 0xF4292244);
    d = II(d, a, b, c, x[k + 7], S42, 0x432AFF97);
    c = II(c, d, a, b, x[k + 14], S43, 0xAB9423A7);
    b = II(b, c, d, a, x[k + 5], S44, 0xFC93A039);
    a = II(a, b, c, d, x[k + 12], S41, 0x655B59C3);
    d = II(d, a, b, c, x[k + 3], S42, 0x8F0CCC92);
    c = II(c, d, a, b, x[k + 10], S43, 0xFFEFF47D);
    b = II(b, c, d, a, x[k + 1], S44, 0x85845DD1);
    a = II(a, b, c, d, x[k + 8], S41, 0x6FA87E4F);
    d = II(d, a, b, c, x[k + 15], S42, 0xFE2CE6E0);
    c = II(c, d, a, b, x[k + 6], S43, 0xA3014314);
    b = II(b, c, d, a, x[k + 13], S44, 0x4E0811A1);
    a = II(a, b, c, d, x[k + 4], S41, 0xF7537E82);
    d = II(d, a, b, c, x[k + 11], S42, 0xBD3AF235);
    c = II(c, d, a, b, x[k + 2], S43, 0x2AD7D2BB);
    b = II(b, c, d, a, x[k + 9], S44, 0xEB86D391);
    
    a = addUnsigned(a, AA);
    b = addUnsigned(b, BB);
    c = addUnsigned(c, CC);
    d = addUnsigned(d, DD);
  }
  
  return wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d);
}

/**
 * Compute PoW nonce using MD5
 * 
 * Algorithm from deobfuscated _0x182b1f():
 * - First computes HMAC-SHA256(channelKey, channelSalt) as prefix
 * - Then iterates: MD5(hmacPrefix + channelKey + keyNumber + timestamp + nonce)
 * - Looks for hash where first 4 hex chars < 0x1000
 */
export async function computePowNonce(
  channelKey: string,
  keyNumber: string,
  timestamp: number,
  channelSalt: string
): Promise<number> {
  if (!channelSalt) {
    throw new Error('channelSalt is REQUIRED - no fallback allowed!');
  }
  
  // First compute HMAC of channelKey with channelSalt
  const hmacPrefix = await hmacSha256(channelKey, channelSalt);
  
  const threshold = 0x1000; // 4096
  const maxIterations = 100000;
  
  for (let nonce = 0; nonce < maxIterations; nonce++) {
    // Build the data string: hmacPrefix + channelKey + keyNumber + timestamp + nonce
    const data = hmacPrefix + channelKey + keyNumber + timestamp + nonce;
    const hash = md5(data);
    
    // Check if first 4 hex chars (16 bits) < 0x1000
    const first4 = parseInt(hash.substring(0, 4), 16);
    if (first4 < threshold) {
      console.log(`[PoW-V5] Found nonce ${nonce} (hash: ${hash.substring(0, 8)}...)`);
      return nonce;
    }
  }
  
  console.log(`[PoW-V5] No valid nonce found, using ${maxIterations - 1}`);
  return maxIterations - 1;
}

/**
 * Compute key path using HMAC-SHA256
 * HMAC-SHA256(resource|keyNumber|timestamp|fingerprint, channelSalt).substring(0, 16)
 */
export async function computeKeyPath(
  resource: string,
  keyNumber: string,
  timestamp: number,
  fingerprint: string,
  channelSalt: string
): Promise<string> {
  if (!channelSalt) {
    throw new Error('channelSalt is REQUIRED - no fallback allowed!');
  }
  
  const data = `${resource}|${keyNumber}|${timestamp}|${fingerprint}`;
  const hmac = await hmacSha256(data, channelSalt);
  return hmac.substring(0, 16);
}

/**
 * Fetch auth data from player page
 * 
 * Uses www.ksohls.ru (current primary as of Mar 2026)
 * 
 * Domain history: epicplayplay.cfd â†’ codepcplay.fun â†’ epaly.fun â†’ lefttoplay.xyz â†’ www.ksohls.ru â†’ www.ksohls.ru
 * Dead domains: epaly.fun (SSL), eplayer.to (DNS), codepcplay.fun (DNS), hitsplay.fun (403), lefttoplay.xyz (403)
 * 
 * IMPORTANT (Feb 25, 2026): Auth values are now XOR-encrypted with polymorphic keys.
 * The page no longer has plain `authToken: "value"` â€” instead it has:
 *   const _dec_XXXX = (d, k) => d.map(b => String.fromCharCode(b ^ k)).join('');
 *   EPlayerAuth.init({ authToken: _dec_XXXX(_init_YYYY, xorKey), ... })
 * We must extract the decoder function, byte arrays, and XOR keys to decrypt.
 */

/**
 * XOR-decrypt an array of bytes with a single-byte key
 */
function xorDecrypt(bytes: number[], key: number): string {
  return bytes.map(b => String.fromCharCode(b ^ key)).join('');
}

/**
 * Extract XOR-encrypted auth values from player page HTML.
 * 
 * The page contains a polymorphic decoder pattern:
 *   const _dec_XXXX = (d, k) => d.map(b => String.fromCharCode(b ^ k)).join('');
 *   const _init_YYYY = [byte1, byte2, ...];
 *   EPlayerAuth.init({ authToken: _dec_XXXX(_init_YYYY, xorKey), ... })
 * 
 * Function name, variable names, and XOR key all change per page load.
 */
function extractEncryptedAuth(html: string): Record<string, string> | null {
  // Step 1: Find the decoder function name pattern
  // Pattern: const _dec_XXXX = (d, k) => d.map(b => String.fromCharCode(b ^ k)).join('');
  // Or: const _dec_XXXX = (d, k) => { let r = ''; for (...) r += String.fromCharCode(d[i] ^ k); return r; };
  // Or variations like: function _dec_XXXX(d, k) { return d.map(...) }
  const decoderMatch = html.match(/(?:const|var|let)\s+(_dec_\w+)\s*=\s*\(?d\s*,\s*k\)?\s*=>\s*(?:d\.map\(|[\s\S]*?String\.fromCharCode)/)
    || html.match(/(?:const|var|let)\s+(_dec_\w+)\s*=\s*\(?d\s*,\s*k\)?\s*=>/)
    || html.match(/function\s+(_dec_\w+)\s*\(\s*d\s*,\s*k\s*\)/);
  
  if (!decoderMatch) {
    return null;
  }
  const decoderFuncName = decoderMatch[1];
  console.log(`[AuthV5] Found decoder function: ${decoderFuncName}`);
  
  // Step 2: Find all byte array variable declarations
  // Pattern: const _init_YYYY = [104, 52, 67, ...];
  const byteArrays: Record<string, number[]> = {};
  const arrayRegex = /(?:const|var|let)\s+(_init_\w+)\s*=\s*\[([0-9,\s]+)\]/g;
  let arrayMatch;
  while ((arrayMatch = arrayRegex.exec(html)) !== null) {
    const varName = arrayMatch[1];
    const bytes = arrayMatch[2].split(',').map(s => parseInt(s.trim(), 10));
    byteArrays[varName] = bytes;
  }
  
  if (Object.keys(byteArrays).length === 0) {
    console.log(`[AuthV5] No byte arrays found`);
    return null;
  }
  console.log(`[AuthV5] Found ${Object.keys(byteArrays).length} byte arrays`);
  
  // Step 3: Find EPlayerAuth.init() call and extract fieldâ†’decrypt mappings
  // Pattern: authToken: _dec_XXXX(_init_YYYY, 42)
  // The init block may span multiple lines, so use a broader regex
  const initMatch = html.match(/EPlayerAuth\.init\s*\(\s*\{([\s\S]*?)\}\s*\)/);
  if (!initMatch) {
    console.log(`[AuthV5] No EPlayerAuth.init() found`);
    return null;
  }
  
  const initBlock = initMatch[1];
  const result: Record<string, string> = {};
  
  // Match both encrypted fields: fieldName: _dec_XXXX(_init_YYYY, xorKey)
  const fieldRegex = /(\w+)\s*:\s*_dec_\w+\s*\(\s*(_init_\w+)\s*,\s*(\d+)\s*\)/g;
  let fieldMatch;
  while ((fieldMatch = fieldRegex.exec(initBlock)) !== null) {
    const fieldName = fieldMatch[1];
    const arrayVar = fieldMatch[2];
    const xorKey = parseInt(fieldMatch[3], 10);
    
    const bytes = byteArrays[arrayVar];
    if (bytes) {
      result[fieldName] = xorDecrypt(bytes, xorKey);
      console.log(`[AuthV5] Decrypted ${fieldName}: ${result[fieldName].substring(0, 40)}...`);
    } else {
      console.log(`[AuthV5] âš ï¸ Byte array ${arrayVar} not found for field ${fieldName}`);
    }
  }
  
  // Also match plain string fields: fieldName: "value" or fieldName: 'value'
  const plainRegex = /(\w+)\s*:\s*["']([^"']+)["']/g;
  let plainMatch;
  while ((plainMatch = plainRegex.exec(initBlock)) !== null) {
    const fieldName = plainMatch[1];
    if (!result[fieldName]) { // Don't overwrite decrypted values
      result[fieldName] = plainMatch[2];
    }
  }
  
  // Also match numeric fields: timestamp: 1234567890
  const numRegex = /(\w+)\s*:\s*(\d{8,})/g;
  let numMatch;
  while ((numMatch = numRegex.exec(initBlock)) !== null) {
    const fieldName = numMatch[1];
    if (!result[fieldName]) {
      result[fieldName] = numMatch[2];
    }
  }
  
  return Object.keys(result).length > 0 ? result : null;
}

export async function fetchAuthData(channel: string): Promise<DLHDAuthDataV5 | null> {
  // Input validation
  if (!/^\d{1,4}$/.test(channel)) {
    console.log(`[AuthV5] Invalid channel ID: ${channel}`);
    return null;
  }
  
  console.log(`[AuthV5] Fetching auth for channel ${channel}...`);
  
  // Try multiple player domains - DLHD rotates these frequently
  // Domain history: epicplayplay.cfd → codepcplay.fun → epaly.fun → lefttoplay.xyz → ksohls.ru → enviromentalspace.sbs → embedkclx.sbs → newkso.ru (May 27, 2026)
  // UPDATED May 27 2026: embedkclx.sbs DEAD. www.newkso.ru is the new primary.
  const endpoints = [
    `https://www.newkso.ru/premiumtv/daddyhd.php?id=${channel}`,
  ];
  
  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://dlstreams.top/',
        },
      });
      
      if (!response.ok) continue;
      
      const html = await response.text();
      
      // NEW (Feb 25, 2026): Try XOR-encrypted auth extraction first
      const encryptedAuth = extractEncryptedAuth(html);
      if (encryptedAuth && encryptedAuth.authToken && encryptedAuth.channelSalt) {
        const channelSalt = encryptedAuth.channelSalt;
        
        // Validate channelSalt is a valid 64-char hex string
        if (!/^[a-f0-9]{64}$/i.test(channelSalt)) {
          console.log(`[AuthV5] Invalid channelSalt format from encrypted auth: ${channelSalt}`);
          continue;
        }
        
        const authToken = encryptedAuth.authToken;
        const channelKey = encryptedAuth.channelKey || `premium${channel}`;
        const country = encryptedAuth.country || 'US';
        const timestamp = encryptedAuth.timestamp ? parseInt(encryptedAuth.timestamp) : Math.floor(Date.now() / 1000);
        
        console.log(`[AuthV5] âœ… Got XOR-encrypted EPlayerAuth data with salt: ${channelSalt.substring(0, 16)}...`);
        
        return {
          authToken,
          channelKey,
          country,
          timestamp,
          channelSalt,
          source: 'EPlayerAuth-XOR',
        };
      }
      
      // FALLBACK: Try plain-text EPlayerAuth.init() (legacy format)
      const initMatch = html.match(/EPlayerAuth\.init\s*\(\s*\{([^}]+)\}\s*\)/);
      
      if (initMatch) {
        const initStr = initMatch[1];
        
        // Extract fields
        const authTokenMatch = initStr.match(/authToken\s*:\s*["']([^"']+)["']/);
        const channelKeyMatch = initStr.match(/channelKey\s*:\s*["']([^"']+)["']/);
        const countryMatch = initStr.match(/country\s*:\s*["']([^"']+)["']/);
        const timestampMatch = initStr.match(/timestamp\s*:\s*(\d+)/);
        const channelSaltMatch = initStr.match(/channelSalt\s*:\s*["']([^"']+)["']/);
        
        if (authTokenMatch && channelSaltMatch) {
          const authToken = authTokenMatch[1];
          const channelSalt = channelSaltMatch[1];
          
          // Validate channelSalt is a valid 64-char hex string
          if (!/^[a-f0-9]{64}$/i.test(channelSalt)) {
            console.log(`[AuthV5] Invalid channelSalt format: ${channelSalt}`);
            continue;
          }
          
          const channelKey = channelKeyMatch ? channelKeyMatch[1] : `premium${channel}`;
          const country = countryMatch ? countryMatch[1] : 'US';
          const timestamp = timestampMatch ? parseInt(timestampMatch[1]) : Math.floor(Date.now() / 1000);
          
          console.log(`[AuthV5] âœ… Got plain EPlayerAuth data with salt: ${channelSalt.substring(0, 16)}...`);
          
          return {
            authToken,
            channelKey,
            country,
            timestamp,
            channelSalt,
            source: 'EPlayerAuth',
          };
        } else {
          console.log(`[AuthV5] Missing authToken or channelSalt in page`);
        }
      }
    } catch (e) {
      console.log(`[AuthV5] Endpoint failed: ${e}`);
    }
  }
  
  console.log(`[AuthV5] No auth data found`);
  return null;
}

/**
 * Generate auth headers for key request
 * NOTE: Browser uses Math.floor(Date.now() / 1000) with NO offset!
 * The -7 offset was WRONG â€” deobfuscation of EPlayerAuth confirmed no offset.
 */
export async function generateKeyHeaders(
  resource: string,
  keyNumber: string,
  authData: DLHDAuthDataV5
): Promise<Record<string, string>> {
  // NO OFFSET â€” browser uses current time exactly (confirmed via deobfuscation)
  return generateKeyHeadersWithOffset(resource, keyNumber, authData, 0);
}

/**
 * Generate auth headers with a specific timestamp offset
 */
export async function generateKeyHeadersWithOffset(
  resource: string,
  keyNumber: string,
  authData: DLHDAuthDataV5,
  offsetSeconds: number
): Promise<Record<string, string>> {
  // Use CURRENT timestamp + offset (NOT the authToken timestamp!)
  const timestamp = Math.floor(Date.now() / 1000) + offsetSeconds;
  
  const fingerprint = await generateFingerprint();
  const nonce = await computePowNonce(resource, keyNumber, timestamp, authData.channelSalt);
  const keyPath = await computeKeyPath(resource, keyNumber, timestamp, fingerprint, authData.channelSalt);
  
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Origin': 'https://www.newkso.ru',
    'Referer': 'https://www.ksohls.ru/',
    'Authorization': `Bearer ${authData.authToken}`,
    'X-Key-Timestamp': timestamp.toString(),
    'X-Key-Nonce': nonce.toString(),
    'X-Key-Path': keyPath,
    'X-Fingerprint': fingerprint,
  };
}
