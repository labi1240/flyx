/**
 * TV Proxy Cloudflare Worker
 *
 * DLHD ONLY - NO IPTV/STALKER PROVIDERS!
 * 
 * Proxies DLHD live streams with automatic server lookup.
 * Uses proper channel routing to differentiate from other providers.
 *
 * Routes:
 *   GET /?channel=<id>           - Get proxied M3U8 playlist (DLHD channels only)
 *   GET /cdnlive?url=<url>       - Proxy nested M3U8 manifests (through Next.js /tv route)
 *   GET /segment?url=<url>       - Proxy video segments (DIRECT to worker, bypasses Next.js)
 *   GET /key?url=<encoded_url>   - Proxy encryption key (direct + RPI fallback)
 *   GET /health                  - Health check
 * 
 * ROUTING ARCHITECTURE (January 2026):
 * - Manifests (.m3u8) → /tv/cdnlive (through Next.js for proper handling)
 * - Segments (.ts) → /segment (DIRECT to worker for optimal performance)
 * - This separation reduces latency and improves video playback
 * - See: cloudflare-proxy/SECURITY-ANALYSIS-TV-PROXY.md for details
 * 
 * KEY FETCHING (March 25, 2026 Update):
 * - EPlayerAuth v5 is GONE from DLHD — no PoW, no HMAC, no auth headers needed
 * - Keys require only reCAPTCHA IP whitelist (20 min TTL)
 * - Direct CF fetch tried first (fast path ~120ms), RPI proxy as fallback
 * - WASM PoW kept but no longer used for key fetching
 */

import { createLogger, type LogLevel } from './logger';
import { initDLHDPoW, computeNonce as computeWasmNonce, getVersion as getWasmVersion } from './dlhd-pow';

// ============================================================================
// DLHD Channel Configuration - January 2026
// FORCED: Using ddy6 server ONLY for all DLHD live TV streams
// All other servers (wiki, hzt, x4, etc.) are disabled for reliability
// ============================================================================
const DLHD_SERVER = 'ddy6';  // Only server we use

// Simple helper - always returns premium{id} for ddy6 server
function getChannelKey(channelId: string): string {
  return `premium${channelId}`;
}

export interface Env {
  LOG_LEVEL?: string;
  RPI_PROXY_URL?: string;
  RPI_PROXY_KEY?: string;
  HETZNER_PROXY_URL?: string;
  HETZNER_PROXY_KEY?: string;
  RATE_LIMIT_KV?: KVNamespace; // For rate limiting segment requests
  SEGMENT_TOKEN_SECRET?: string; // For signed segment URLs
}

const ALLOWED_ORIGINS = [
  'https://tv.vynx.cc',
  'https://flyx.tv',
  'https://www.flyx.tv',
  'http://localhost:3000',
  'http://localhost:3001',
  // SECURITY: Removed '*' - was allowing all origins, defeating anti-leech protection
  '.pages.dev',
  '.workers.dev',
];

// UPDATED March 27, 2026: www.ksohls.ru is the current player domain (browser recon confirmed)
const PLAYER_DOMAIN = 'www.ksohls.ru';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

// Regions where DLHD CDN blocks datacenter IPs — these MUST route through RPI residential proxy.
// Netherlands (NL) confirmed blocking daddylive.pk as of May 2026.
// Expand this list as users report blocked regions.
const BLOCKED_REGIONS = new Set(['NL', 'DE', 'FR', 'GB', 'AU', 'BE', 'CH', 'AT', 'SE', 'NO', 'DK', 'FI']);


// UPDATED March 30, 2026: Full server list from live scan. x4 is NEW.
const ALL_SERVER_KEYS = [
  'zeko',
  'ddy6',
  'wind',
  'dokko1',
  'nfs',
  'wiki',
  'x4',
];
const CDN_DOMAIN = 'embedkclx.sbs';
const M3U8_SERVER = 'chevy.embedkclx.sbs'; // UPDATED Apr 10 2026: sec.ai-hls.site is DEAD (403)

// CORRECT SECRET - extracted from WASM module (January 2026)
// The old 64-char hex secret is WRONG! This is the real one from the WASM.
const HMAC_SECRET = '444c44cc8888888844444444';
const POW_THRESHOLD = 0x1000;
const MAX_NONCE_ITERATIONS = 100000;

// ============================================================================
// MD5 Implementation for Cloudflare Workers (crypto.subtle doesn't support MD5)
// ============================================================================
function md5(string: string): string {
  function rotateLeft(value: number, shift: number): number {
    return (value << shift) | (value >>> (32 - shift));
  }

  function addUnsigned(x: number, y: number): number {
    const lsw = (x & 0xFFFF) + (y & 0xFFFF);
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xFFFF);
  }

  function F(x: number, y: number, z: number): number { return (x & y) | ((~x) & z); }
  function G(x: number, y: number, z: number): number { return (x & z) | (y & (~z)); }
  function H(x: number, y: number, z: number): number { return x ^ y ^ z; }
  function I(x: number, y: number, z: number): number { return y ^ (x | (~z)); }

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
    const lWordCount: number[] = [];
    const lMessageLength = str.length;
    const lNumberOfWords_temp1 = lMessageLength + 8;
    const lNumberOfWords_temp2 = (lNumberOfWords_temp1 - (lNumberOfWords_temp1 % 64)) / 64;
    const lNumberOfWords = (lNumberOfWords_temp2 + 1) * 16;
    
    for (let i = 0; i < lNumberOfWords; i++) lWordCount[i] = 0;
    
    let lBytePosition = 0;
    let lByteCount = 0;
    while (lByteCount < lMessageLength) {
      const lWordIndex = (lByteCount - (lByteCount % 4)) / 4;
      lBytePosition = (lByteCount % 4) * 8;
      lWordCount[lWordIndex] = lWordCount[lWordIndex] | (str.charCodeAt(lByteCount) << lBytePosition);
      lByteCount++;
    }
    const lWordIndex = (lByteCount - (lByteCount % 4)) / 4;
    lBytePosition = (lByteCount % 4) * 8;
    lWordCount[lWordIndex] = lWordCount[lWordIndex] | (0x80 << lBytePosition);
    lWordCount[lNumberOfWords - 2] = lMessageLength << 3;
    lWordCount[lNumberOfWords - 1] = lMessageLength >>> 29;
    return lWordCount;
  }

  function wordToHex(value: number): string {
    let hex = '';
    for (let i = 0; i <= 3; i++) {
      const byte = (value >>> (i * 8)) & 255;
      hex += ('0' + byte.toString(16)).slice(-2);
    }
    return hex;
  }

  const x = convertToWordArray(string);
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
    d = GG(d, a, b, c, x[k + 10], S22, 0x02441453);
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
    b = HH(b, c, d, a, x[k + 6], S34, 0x04881D05);
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

// ============================================================================
// HMAC-SHA256 using Web Crypto API
// ============================================================================
async function hmacSha256(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================================
// PoW Computation (WASM-based - January 2026)
// ============================================================================
let wasmInitialized = false;

async function computePoWNonce(resource: string, keyNumber: string, timestamp: number): Promise<bigint | null> {
  try {
    // Initialize WASM if not already done
    if (!wasmInitialized) {
      await initDLHDPoW();
      wasmInitialized = true;
      console.log(`[PoW] WASM initialized: ${getWasmVersion()}`);
    }
    
    // Compute nonce using WASM
    const nonce = computeWasmNonce(resource, keyNumber, timestamp);
    return nonce;
  } catch (error) {
    console.error('[PoW] WASM computation failed:', error);
    return null;
  }
}

// ============================================================================
// Caches
// ============================================================================
const serverKeyCache = new Map<string, { serverKey: string; fetchedAt: number }>();
const SERVER_KEY_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes - servers change frequently!

// JWT cache - stores JWT tokens fetched from player page
// Key is the topembed channel name (e.g., 'AbcTv[USA]')
interface JWTCacheEntry {
  jwt: string;
  channelKey: string;  // The 'sub' field from JWT (e.g., 'ustvabc', 'eplayerespn_usa')
  exp: number;
  fetchedAt: number;
}
const jwtCache = new Map<string, JWTCacheEntry>();
const JWT_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours (JWT valid for 5)

// Reverse mapping: channel key (from JWT sub) → topembed channel name
// This allows us to find the JWT when we only have the channel key from a key URL
const channelKeyToTopembed = new Map<string, string>();

// DLHD channel ID → channel key mapping
// This is populated when we successfully fetch JWTs
// Format: { '51': 'ustvabc', '44': 'eplayerespn_usa', ... }
const dlhdIdToChannelKey = new Map<string, string>();

/**
 * Fetch JWT from player page.
 *
 * UPDATED March 25, 2026:
 * - EPlayerAuth is GONE from DLHD — pages no longer contain JWT/auth tokens
 * - Player pages now use reCAPTCHA v3 → /verify → server_lookup → HLS.js
 * - This function may return null for most channels now — that's OK
 * - Key fetching no longer needs JWT/auth, only reCAPTCHA IP whitelist
 */
async function fetchPlayerJWT(channel: string, logger: any, env?: Env): Promise<string | null> {
  const cacheKey = channel;
  const cached = jwtCache.get(cacheKey);

  // Check cache - use if not expired
  if (cached && Date.now() - cached.fetchedAt < JWT_CACHE_TTL_MS) {
    const now = Math.floor(Date.now() / 1000);
    if (cached.exp > now + 300) { // At least 5 min remaining
      logger.info('JWT cache hit', { channel, expiresIn: cached.exp - now });
      return cached.jwt;
    }
  }

  logger.info('Fetching fresh JWT', { channel });

  // ============================================================================
  // METHOD 1: Try player domains (www.ksohls.ru primary, embedkclx.sbs fallback)
  // ============================================================================
  const playerDomains = [PLAYER_DOMAIN, 'embedkclx.sbs'];
  for (const domain of playerDomains) {
    try {
      const playerUrl = `https://${domain}/premiumtv/daddyhd.php?id=${channel}`;
      logger.info(`Trying ${domain} for JWT`, { channel });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      try {
        const res = await fetch(playerUrl, {
          headers: {
            'User-Agent': USER_AGENT,
            'Referer': `https://dlstreams.top/`,
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (res.ok) {
          const html = await res.text();
          const jwtMatch = html.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
          if (jwtMatch) {
            const jwt = jwtMatch[0];
            let channelKey = `premium${channel}`;
            let exp = Math.floor(Date.now() / 1000) + 18000;

            try {
              const payloadB64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
              const payload = JSON.parse(atob(payloadB64));
              channelKey = payload.sub || channelKey;
              exp = payload.exp || exp;
              logger.info(`JWT from ${domain}`, { channelKey, exp, expiresIn: exp - Math.floor(Date.now() / 1000) });
            } catch (e) {
              logger.warn('JWT decode failed, using defaults');
            }

            jwtCache.set(cacheKey, { jwt, channelKey, exp, fetchedAt: Date.now() });
            channelKeyToTopembed.set(channelKey, channel);
            dlhdIdToChannelKey.set(channel, channelKey);

            return jwt;
          }
        }
      } catch (e) {
        clearTimeout(timeoutId);
        logger.warn(`${domain} fetch error`, { error: (e as Error).message });
      }
    } catch (e) {
      logger.warn(`${domain} JWT fetch failed`, { error: (e as Error).message });
    }
  }

  // ============================================================================
  // METHOD 2: Try hitsplay.fun - fallback for channels without topembed mapping
  // NOTE: hitsplay uses 'premium{id}' keys which may not work on all servers
  // Route through RPI proxy since hitsplay.fun may block CF IPs
  // ============================================================================
  try {
    const hitsplayUrl = `https://hitsplay.fun/premiumtv/daddyhd.php?id=${channel}`;
    logger.info('Trying hitsplay.fun for JWT (fallback)', { channel });
    
    let html: string | undefined;
    
    // Try RPI proxy first (hitsplay blocks CF IPs)
    if (env?.RPI_PROXY_URL && env?.RPI_PROXY_KEY) {
      const rpiUrl = `${env.RPI_PROXY_URL}/dlhd/stream?url=${encodeURIComponent(hitsplayUrl)}&key=${env.RPI_PROXY_KEY}&referer=${encodeURIComponent('https://daddylive.mp/')}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000); // 6 sec timeout
      
      try {
        const res = await fetch(rpiUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
          html = await res.text();
        }
      } catch (e) {
        clearTimeout(timeoutId);
        logger.warn('RPI hitsplay fetch failed', { error: (e as Error).message });
      }
    }
    
    // Direct fetch fallback (may not work from CF)
    if (!html) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 sec - fail fast
      
      try {
        const res = await fetch(hitsplayUrl, {
          headers: {
            'User-Agent': USER_AGENT,
            'Referer': 'https://daddylive.mp/',
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (res.ok) {
          html = await res.text();
        }
      } catch (e) {
        clearTimeout(timeoutId);
      }
    }
    
    if (html) {
      
      // hitsplay.fun embeds JWT directly in the page
      const jwtMatch = html.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
      if (jwtMatch) {
        const jwt = jwtMatch[0];
        
        // Decode payload
        let channelKey = `premium${channel}`;
        let exp = Math.floor(Date.now() / 1000) + 18000;
        
        try {
          const payloadB64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
          const payload = JSON.parse(atob(payloadB64));
          channelKey = payload.sub || channelKey;
          exp = payload.exp || exp;
          logger.info('JWT from hitsplay.fun', { channelKey, exp, expiresIn: exp - Math.floor(Date.now() / 1000) });
        } catch (e) {
          logger.warn('JWT decode failed, using defaults');
        }
        
        // Cache it
        jwtCache.set(cacheKey, { jwt, channelKey, exp, fetchedAt: Date.now() });
        channelKeyToTopembed.set(channelKey, channel);
        dlhdIdToChannelKey.set(channel, channelKey);
        
        return jwt;
      }
    }
  } catch (e) {
    logger.warn('hitsplay.fun JWT fetch failed', { error: (e as Error).message });
  }
  

  
  logger.warn('All JWT fetch methods failed', { channel });
  return null;
}

async function getServerKey(channelKey: string, logger: any, env?: Env): Promise<string> {
  const cached = serverKeyCache.get(channelKey);
  if (cached && Date.now() - cached.fetchedAt < SERVER_KEY_CACHE_TTL_MS) return cached.serverKey;

  // UPDATED Apr 10, 2026: sec.ai-hls.site is DEAD (403). All chevy.{domain} now.
  const lookupUrls = [
    `https://${M3U8_SERVER}/server_lookup?channel_id=${channelKey}`,
    `https://chevy.enviromentalanimal.horse/server_lookup?channel_id=${channelKey}`,
    `https://chevy.soyspace.cyou/server_lookup?channel_id=${channelKey}`,
    `https://chevy.vovlacosa.sbs/server_lookup?channel_id=${channelKey}`,
  ];

  for (const lookupUrl of lookupUrls) {
    try {
      const res = await fetch(lookupUrl, {
        headers: { 'User-Agent': USER_AGENT, 'Origin': `https://${PLAYER_DOMAIN}`, 'Referer': `https://${PLAYER_DOMAIN}/` },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const text = await res.text();
        if (!text.startsWith('<')) {
          const data = JSON.parse(text);
          if (data.server_key) {
            logger.info('Server lookup success (direct)', { channelKey, serverKey: data.server_key, url: lookupUrl });
            serverKeyCache.set(channelKey, { serverKey: data.server_key, fetchedAt: Date.now() });
            return data.server_key;
          }
        } else {
          logger.warn('Server lookup returned HTML (blocked?)', { channelKey, url: lookupUrl });
        }
      } else {
        logger.warn('Server lookup HTTP error', { channelKey, status: res.status, url: lookupUrl });
      }
    } catch (e) {
      logger.warn('Server lookup direct fetch failed', { channelKey, error: (e as Error).message, url: lookupUrl });
    }
  }
  
  // Try RPI proxy if configured
  if (env?.RPI_PROXY_URL && env?.RPI_PROXY_KEY) {
    try {
      const rpiUrl = `${env.RPI_PROXY_URL}/dlhd/stream?url=${encodeURIComponent(lookupUrls[0])}&key=${env.RPI_PROXY_KEY}`;
      const rpiRes = await fetch(rpiUrl);
      if (rpiRes.ok) {
        const text = await rpiRes.text();
        if (!text.startsWith('<')) {
          const data = JSON.parse(text);
          if (data.server_key) {
            logger.info('Server lookup success (RPI)', { channelKey, serverKey: data.server_key });
            serverKeyCache.set(channelKey, { serverKey: data.server_key, fetchedAt: Date.now() });
            return data.server_key;
          }
        }
      }
    } catch (e) {
      logger.warn('Server lookup RPI fetch failed', { channelKey, error: (e as Error).message });
    }
  }
  
  logger.warn('Server lookup failed, using default', { channelKey, default: 'zeko' });
  return 'zeko';
}

function constructM3U8Url(serverKey: string, channelKey: string): string {
  // UPDATED Apr 10, 2026: sec.ai-hls.site is DEAD. Using chevy.embedkclx.sbs now.
  return `https://${M3U8_SERVER}/proxy/${serverKey}/${channelKey}/mono.css`;
}

/**
 * Fetch server key from server_lookup endpoint
 * This returns the correct server for a given channel key
 */
async function fetchServerKeyFromLookup(channelKey: string, logger: any, env?: Env): Promise<string | null> {
  // March 24, 2026: ai.the-sunmoon.site is new primary lookup server
  const lookupUrl = `https://${M3U8_SERVER}/server_lookup?channel_id=${encodeURIComponent(channelKey)}`;

  try {
    let res: Response;
    if (env?.RPI_PROXY_URL && env?.RPI_PROXY_KEY) {
      const rpiUrl = `${env.RPI_PROXY_URL}/dlhd/stream?url=${encodeURIComponent(lookupUrl)}&key=${env.RPI_PROXY_KEY}&referer=${encodeURIComponent(`https://${PLAYER_DOMAIN}/`)}`;
      res = await fetch(rpiUrl);
    } else {
      res = await fetch(lookupUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Origin': `https://${PLAYER_DOMAIN}`,
          'Referer': `https://${PLAYER_DOMAIN}/`,
        },
      });
    }
    
    if (!res.ok) {
      logger.warn('server_lookup failed', { status: res.status, channelKey });
      return null;
    }
    
    const text = await res.text();
    const match = text.match(/"server_key"\s*:\s*"([^"]+)"/);
    if (match) {
      logger.info('server_lookup success', { channelKey, serverKey: match[1] });
      return match[1];
    }
    
    return null;
  } catch (e) {
    logger.warn('server_lookup error', { channelKey, error: (e as Error).message });
    return null;
  }
}

// ============================================================================
// BACKEND 2: cdn-live.tv → cdn-live-tv.ru (NO JWT/PoW NEEDED!)
// ============================================================================
// This backend uses simple token-based auth embedded in the player page.
// Much simpler than the DLHD CDN backend which requires JWT + PoW.
// ============================================================================

interface CdnLiveResult {
  success: boolean;
  m3u8Url?: string;
  token?: string;
  error?: string;
}

// Cache for cdn-live tokens (they expire, but we can reuse for a while)
const cdnLiveTokenCache = new Map<string, { token: string; fetchedAt: number }>();
const CDN_LIVE_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Decode the obfuscated JavaScript from cdn-live.tv player page
 * The script uses a custom base conversion cipher
 */
function decodeCdnLiveScript(encodedData: string, charset: string, base: number, delimiterIdx: number, offset: number): string {
  let result = '';
  let i = 0;
  const delimiter = charset[delimiterIdx];
  
  while (i < encodedData.length) {
    let s = '';
    // Read until delimiter
    while (i < encodedData.length && encodedData[i] !== delimiter) {
      s += encodedData[i];
      i++;
    }
    i++; // Skip delimiter
    
    if (!s) continue;
    
    // Replace charset chars with indices
    let numStr = '';
    for (const char of s) {
      const idx = charset.indexOf(char);
      if (idx !== -1) {
        numStr += idx.toString();
      }
    }
    
    // Convert from base to decimal, subtract offset
    const charCode = parseInt(numStr, base) - offset;
    if (charCode > 0 && charCode < 65536) {
      result += String.fromCharCode(charCode);
    }
  }
  
  return result;
}

/**
 * Extract stream URL from cdn-live.tv player page
 * CRITICAL: Uses RPI proxy - cdn-live.tv blocks Cloudflare IPs
 */
async function fetchCdnLiveStream(channelName: string, countryCode: string, logger: any, env?: Env): Promise<CdnLiveResult> {
  const cacheKey = `${countryCode}-${channelName}`;
  const cached = cdnLiveTokenCache.get(cacheKey);
  
  // Check cache
  if (cached && Date.now() - cached.fetchedAt < CDN_LIVE_TOKEN_TTL_MS) {
    const m3u8Url = `https://cdn-live-tv.ru/api/v1/channels/${countryCode}-${channelName}/index.m3u8?token=${cached.token}`;
    logger.info('cdn-live cache hit', { channel: channelName, code: countryCode });
    return { success: true, m3u8Url, token: cached.token };
  }
  
  logger.info('Fetching cdn-live.tv stream', { channel: channelName, code: countryCode });
  
  try {
    // Fetch the player page - MUST use RPI proxy (cdn-live.tv blocks CF IPs)
    const playerUrl = `https://cdn-live.tv/api/v1/channels/player/?name=${encodeURIComponent(channelName)}&code=${countryCode}&user=cdnlivetv&plan=free`;
    
    let res: Response;
    if (env?.RPI_PROXY_URL && env?.RPI_PROXY_KEY) {
      const rpiUrl = `${env.RPI_PROXY_URL}/dlhd/stream?url=${encodeURIComponent(playerUrl)}&key=${env.RPI_PROXY_KEY}&referer=${encodeURIComponent('https://daddylive.mp/')}`;
      res = await fetch(rpiUrl);
    } else {
      // Fallback to direct fetch if RPI not configured (will likely fail)
      logger.warn('RPI proxy not configured for cdn-live token fetch');
      res = await fetch(playerUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Referer': 'https://daddylive.mp/',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
    }
    
    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}` };
    }
    
    const html = await res.text();
    
    // Method 1: Try to find direct M3U8 URL in the page
    const directM3u8Match = html.match(/https:\/\/(?:edge\.)?cdn-live-tv\.ru\/api\/v1\/channels\/[^"'\s]+\.m3u8\?token=[^"'\s]+/);
    if (directM3u8Match) {
      const m3u8Url = directM3u8Match[0].replace(/&amp;/g, '&');
      const tokenMatch = m3u8Url.match(/token=([^&]+)/);
      if (tokenMatch) {
        cdnLiveTokenCache.set(cacheKey, { token: tokenMatch[1], fetchedAt: Date.now() });
      }
      logger.info('cdn-live direct URL found', { url: m3u8Url.substring(0, 80) });
      return { success: true, m3u8Url };
    }
    
    // Method 2: Try to find playlistUrl in decoded script
    const playlistMatch = html.match(/playlistUrl\s*=\s*['"]([^'"]+)['"]/);
    if (playlistMatch) {
      const m3u8Url = playlistMatch[1];
      const tokenMatch = m3u8Url.match(/token=([^&]+)/);
      if (tokenMatch) {
        cdnLiveTokenCache.set(cacheKey, { token: tokenMatch[1], fetchedAt: Date.now() });
      }
      logger.info('cdn-live playlistUrl found', { url: m3u8Url.substring(0, 80) });
      return { success: true, m3u8Url };
    }
    
    // Method 3: Try to decode obfuscated script
    // Look for eval(function(h,u,n,t,e,r) pattern
    // Format: }("ENCODED",unused,"CHARSET",offset,base,unused))
    // Security: Limit input size to prevent ReDoS attacks
    if (html.length > 500000) {
      logger.warn('cdn-live: HTML too large for regex parsing', { size: html.length });
      return { success: false, error: 'Response too large' };
    }
    
    // Method 3a: Try to find HUNTER obfuscation pattern
    // The pattern is: eval(function(h,u,n,t,e,r){...}("encoded",num,"charset",num,num,num))
    // We need to find the function body end and then parse the arguments
    const hunterIdx = html.indexOf('eval(function(h,u,n,t,e,r)');
    if (hunterIdx !== -1) {
      const context = html.substring(hunterIdx, hunterIdx + 50000); // Get enough context for the encoded data
      const bodyStart = context.indexOf('{');
      
      if (bodyStart !== -1) {
        // Count braces to find the end of the function body
        let depth = 0;
        let bodyEnd = -1;
        for (let i = bodyStart; i < context.length; i++) {
          if (context[i] === '{') depth++;
          if (context[i] === '}') {
            depth--;
            if (depth === 0) {
              bodyEnd = i;
              break;
            }
          }
        }
        
        if (bodyEnd !== -1) {
          const afterBody = context.substring(bodyEnd);
          // Parse arguments: }("encoded",unused,"charset",offset,base,unused))
          const argsMatch = afterBody.match(/\}\s*\(\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
          
          if (argsMatch) {
            const [, encodedData, , charset, offsetStr, baseStr] = argsMatch;
            const base = parseInt(baseStr, 10);
            const offset = parseInt(offsetStr, 10);
            
            // Security: Validate parsed parameters are within reasonable bounds
            if (isNaN(base) || isNaN(offset) || base < 2 || base > 64 || offset < 0 || offset > 65536) {
              logger.warn('cdn-live: invalid decode parameters', { base, offset });
            } else if (encodedData.length > 100000) {
              logger.warn('cdn-live: encoded data too large', { size: encodedData.length });
            } else {
              logger.info('cdn-live: decoding HUNTER obfuscated script', { 
                encodedLen: encodedData.length, 
                charset: charset.substring(0, 20),
                base, 
                offset 
              });
              
              const decoded = decodeCdnLiveScript(encodedData, charset, base, base, offset);
              logger.info('cdn-live: decoded script', { decodedLen: decoded.length, preview: decoded.substring(0, 200) });
              
              const decodedM3u8Match = decoded.match(/https:\/\/(?:edge\.)?cdn-live-tv\.ru\/api\/v1\/channels\/[^"'\s]+\.m3u8\?token=[^"'\s&]+/);
              if (decodedM3u8Match) {
                const m3u8Url = decodedM3u8Match[0];
                const tokenMatch = m3u8Url.match(/token=([^&"'\s]+)/);
                if (tokenMatch) {
                  cdnLiveTokenCache.set(cacheKey, { token: tokenMatch[1], fetchedAt: Date.now() });
                }
                logger.info('cdn-live decoded URL found', { url: m3u8Url.substring(0, 80) });
                return { success: true, m3u8Url };
              }
            }
          }
        }
      }
    }
    
    // Method 3b: Fallback to old regex pattern (for backwards compatibility)
    const evalMatch = html.match(/\}\s*\(\s*"([^"]+)"\s*,\s*\d+\s*,\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*\d+\s*\)\s*\)/);
    if (evalMatch) {
      const [, encodedData, charset, offsetStr, baseStr] = evalMatch;
      const base = parseInt(baseStr, 10);
      const offset = parseInt(offsetStr, 10);
      
      // Security: Validate parsed parameters are within reasonable bounds
      if (isNaN(base) || isNaN(offset) || base < 2 || base > 64 || offset < 0 || offset > 65536) {
        logger.warn('cdn-live: invalid decode parameters', { base, offset });
        return { success: false, error: 'Invalid decode parameters' };
      }
      
      // Security: Limit encoded data size
      if (encodedData.length > 100000) {
        logger.warn('cdn-live: encoded data too large', { size: encodedData.length });
        return { success: false, error: 'Encoded data too large' };
      }
      
      logger.info('cdn-live: decoding obfuscated script (fallback)', { 
        encodedLen: encodedData.length, 
        charset: charset.substring(0, 20),
        base, 
        offset 
      });
      const decoded = decodeCdnLiveScript(encodedData, charset, base, base, offset);
      logger.info('cdn-live: decoded script', { decodedLen: decoded.length, preview: decoded.substring(0, 200) });
      
      const decodedM3u8Match = decoded.match(/https:\/\/(?:edge\.)?cdn-live-tv\.ru\/api\/v1\/channels\/[^"'\s]+\.m3u8\?token=[^"'\s&]+/);
      if (decodedM3u8Match) {
        const m3u8Url = decodedM3u8Match[0];
        const tokenMatch = m3u8Url.match(/token=([^&"'\s]+)/);
        if (tokenMatch) {
          cdnLiveTokenCache.set(cacheKey, { token: tokenMatch[1], fetchedAt: Date.now() });
        }
        logger.info('cdn-live decoded URL found', { url: m3u8Url.substring(0, 80) });
        return { success: true, m3u8Url };
      }
    }
    
    logger.warn('cdn-live: could not extract stream URL', { htmlLength: html.length });
    return { success: false, error: 'Could not extract stream URL from player page' };
    
  } catch (err) {
    logger.error('cdn-live fetch error', { error: (err as Error).message });
    return { success: false, error: (err as Error).message };
  }
}

// ============================================================================
// PLAYER 5 EXTRACTOR: ddyplayer.cfd → cdn-live-tv.ru (HUNTER obfuscation)
// ============================================================================
// Path: DLHD /casting/ → ddyplayer.cfd → cdn-live-tv.ru
// Uses HUNTER obfuscation: eval(function(h,u,n,t,e,r){...})
// ============================================================================

interface Player5Result {
  success: boolean;
  m3u8Url?: string;
  channelName?: string;
  countryCode?: string;
  error?: string;
}

/**
 * Decode HUNTER obfuscation used by ddyplayer.cfd
 */
function decodeHunter(encodedData: string, charset: string, offset: number, delimiterIdx: number): string {
  let result = '';
  const delimiter = charset[delimiterIdx];
  
  for (let i = 0; i < encodedData.length; i++) {
    let s = '';
    while (i < encodedData.length && encodedData[i] !== delimiter) {
      s += encodedData[i];
      i++;
    }
    if (s === '') continue;
    
    // Replace each char with its index in charset
    for (let j = 0; j < charset.length; j++) {
      s = s.split(charset[j]).join(j.toString());
    }
    
    // Convert from base-delimiterIdx to base-10, subtract offset
    const code = parseInt(s, delimiterIdx) - offset;
    if (code > 0 && code < 65536) {
      result += String.fromCharCode(code);
    }
  }
  
  try {
    return decodeURIComponent(escape(result));
  } catch {
    return result;
  }
}

/**
 * Extract HUNTER parameters from HTML
 * Format: }("encodedData",num,"charset",num,num,num))
 */
function extractHunterParams(html: string): { encodedData: string; charset: string; offset: number; delimiterIdx: number } | null {
  const fullPattern = /\}\s*\(\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)\s*\)/;
  const match = html.match(fullPattern);
  
  if (match) {
    return {
      encodedData: match[1],
      charset: match[3],
      offset: parseInt(match[4]),
      delimiterIdx: parseInt(match[5])
    };
  }
  
  return null;
}

/**
 * Extract stream URL from Player 5 (ddyplayer.cfd)
 * This is the REAL Player 5 extractor that fetches dynamically
 */
async function extractPlayer5Stream(channel: string, logger: any): Promise<Player5Result> {
  logger.info('Player 5: Extracting stream', { channel });
  
  try {
    // Step 1: Get DLHD /casting/ page to find ddyplayer iframe
    const dlhdUrl = `https://daddylive.mp/casting/stream-${channel}.php`;
    const dlhdRes = await fetch(dlhdUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': 'https://daddylive.mp/'
      }
    });
    
    if (!dlhdRes.ok) {
      return { success: false, error: `DLHD page returned ${dlhdRes.status}` };
    }
    
    const dlhdHtml = await dlhdRes.text();
    
    // Find ddyplayer.cfd iframe
    const iframeMatch = dlhdHtml.match(/src=["'](https:\/\/ddyplayer\.cfd[^"']+)["']/);
    if (!iframeMatch) {
      return { success: false, error: 'No ddyplayer.cfd iframe found' };
    }
    
    const ddyUrl = iframeMatch[1];
    const urlObj = new URL(ddyUrl);
    const channelName = urlObj.searchParams.get('name');
    const countryCode = urlObj.searchParams.get('code');
    
    logger.info('Player 5: Found ddyplayer', { channelName, countryCode });
    
    // Step 2: Fetch ddyplayer page
    const ddyRes = await fetch(ddyUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': 'https://daddylive.mp/'
      }
    });
    
    if (!ddyRes.ok) {
      return { success: false, error: `ddyplayer returned ${ddyRes.status}` };
    }
    
    const ddyHtml = await ddyRes.text();
    
    // Step 3: Try to find direct M3U8 URL first
    const directM3u8 = ddyHtml.match(/https:\/\/cdn-live-tv\.ru\/[^"'\s]+\.m3u8[^"'\s]*/);
    if (directM3u8) {
      return {
        success: true,
        m3u8Url: directM3u8[0],
        channelName: channelName || undefined,
        countryCode: countryCode || undefined
      };
    }
    
    // Step 4: Extract HUNTER parameters and decode
    const params = extractHunterParams(ddyHtml);
    if (!params) {
      return { success: false, error: 'No HUNTER params found' };
    }
    
    logger.info('Player 5: Decoding HUNTER', { charset: params.charset.substring(0, 20), offset: params.offset });
    
    const decoded = decodeHunter(params.encodedData, params.charset, params.offset, params.delimiterIdx);
    
    if (decoded.length < 100) {
      return { success: false, error: 'Decoding failed' };
    }
    
    // Step 5: Extract M3U8 URL from decoded content
    const m3u8Match = decoded.match(/https:\/\/cdn-live-tv\.ru\/api\/v1\/channels\/[^"'\s]+\.m3u8\?token=[^"'\s]+/);
    
    if (!m3u8Match) {
      const altMatch = decoded.match(/https:\/\/[^"'\s]*\.m3u8\?token=[^"'\s]+/);
      if (altMatch) {
        return { success: true, m3u8Url: altMatch[0], channelName: channelName || undefined, countryCode: countryCode || undefined };
      }
      return { success: false, error: 'No M3U8 URL in decoded content' };
    }
    
    return {
      success: true,
      m3u8Url: m3u8Match[0],
      channelName: channelName || undefined,
      countryCode: countryCode || undefined
    };
    
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ============================================================================
// BACKEND 3: moveonjoy.com (NO AUTH AT ALL!)
// ============================================================================
// This is the simplest backend - direct M3U8 access with no authentication.
// Stream URLs are pre-mapped in CHANNEL_TO_MOVEONJOY
// ============================================================================

interface MoveonjoyResult {
  success: boolean;
  m3u8Url?: string;
  error?: string;
}


// ============================================================================
// CLIENT-SIDE WHITELIST — reCAPTCHA v3 HTTP-only solve
// ============================================================================
// Flow that whitelists the USER's IP without loading any Google scripts,
// tracking pixels, or DLHD page content in their browser.
//
// Step 1: GET /whitelist/token?channel=premium51
//   → CF worker solves reCAPTCHA v3 via HTTP-only anchor/reload flow
//   → Returns { token, channel_id } to the client
//
// Step 2: Client POSTs directly to chevy.soyspace.cyou/verify
//   → Upstream has Access-Control-Allow-Origin: *, so browser can POST
//   → The upstream whitelists the client's IP for ~30 minutes
//
// After whitelist, the client's browser can fetch keys directly from
// key.keylocking.ru/key/... or chevy.soyspace.cyou/key/... — needs reCAPTCHA whitelist.
// ============================================================================

const RECAPTCHA_SITE_KEY = '6LfJv4AsAAAAALTLEHKaQ7LN_VYfFqhLPrB2Tvgj';

/** Extract reCAPTCHA JS version string from the API loader */
async function getRecaptchaVersion(): Promise<string> {
  const resp = await fetch('https://www.google.com/recaptcha/api.js?render=explicit', {
    headers: { 'Referer': `https://${PLAYER_DOMAIN}/` },
  });
  const body = await resp.text();
  const idx = body.indexOf('releases/');
  if (idx !== -1) {
    const rest = body.substring(idx + 9);
    const end = rest.search(/[/"']/);
    if (end > 0) return rest.substring(0, end);
  }
  throw new Error('Could not extract reCAPTCHA version');
}

/** Solve reCAPTCHA v3 via HTTP-only anchor/reload — no browser needed */
async function solveRecaptchaV3(pageUrl: string, action: string): Promise<string> {
  const version = await getRecaptchaVersion();

  const origin = new URL(pageUrl).origin;
  const originWithPort = origin.includes(':443') ? origin : `${origin}:443`;
  const co = btoa(originWithPort).replace(/=+$/, '') + '.';

  const cb = `cb_${Date.now()}`;
  const anchorUrl = `https://www.google.com/recaptcha/api2/anchor?ar=1&k=${RECAPTCHA_SITE_KEY}&co=${co}&hl=en&v=${version}&size=invisible&cb=${cb}`;

  const anchorResp = await fetch(anchorUrl, {
    headers: { 'User-Agent': USER_AGENT, 'Referer': pageUrl },
  });
  const anchorHtml = await anchorResp.text();

  const tokenMatch = anchorHtml.match(/id="recaptcha-token"\s+value="([^"]+)"/);
  if (!tokenMatch) throw new Error('No recaptcha-token in anchor page');

  const reloadUrl = `https://www.google.com/recaptcha/api2/reload?k=${RECAPTCHA_SITE_KEY}`;
  const formBody = new URLSearchParams([
    ['v', version], ['reason', 'q'], ['k', RECAPTCHA_SITE_KEY],
    ['c', tokenMatch[1]], ['sa', action], ['co', co],
  ]);

  const reloadResp = await fetch(reloadUrl, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Referer': anchorUrl,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody.toString(),
  });
  const reloadBody = await reloadResp.text();

  const rrespMatch = reloadBody.match(/\["rresp","([^"]+)"/);
  if (!rrespMatch) throw new Error('No rresp in reload response');

  return rrespMatch[1];
}

/**
 * GET /whitelist/token?channel=premium51
 * Solves reCAPTCHA v3 server-side and returns the token to the client.
 * No Google scripts or tracking ever reach the user's browser.
 *
 * SECURITY: Rate limited to prevent reCAPTCHA solve abuse.
 * Each IP gets max 5 token requests per 60 seconds.
 */
// In-memory rate limit for whitelist token requests (per-isolate, resets on deploy)
const whitelistTokenRateLimit = new Map<string, { count: number; resetAt: number }>();
const WHITELIST_TOKEN_RATE_LIMIT = 5;       // max requests per window
const WHITELIST_TOKEN_RATE_WINDOW_MS = 60_000; // 60 second window

async function handleWhitelistToken(
  url: URL, logger: any, origin: string | null, request?: Request
): Promise<Response> {
  const channel = url.searchParams.get('channel');
  if (!channel || !/^premium\d+$/.test(channel)) {
    return jsonResponse({ error: 'Missing or invalid channel (e.g. premium51)' }, 400, origin);
  }

  // Rate limit per IP
  const clientIP = request?.headers.get('cf-connecting-ip') || 'unknown';
  const now = Date.now();
  const rl = whitelistTokenRateLimit.get(clientIP);
  if (rl && now < rl.resetAt) {
    if (rl.count >= WHITELIST_TOKEN_RATE_LIMIT) {
      logger.warn('Whitelist token rate limit exceeded', { ip: clientIP, count: rl.count });
      return jsonResponse({ error: 'Rate limit exceeded', retryAfter: Math.ceil((rl.resetAt - now) / 1000) }, 429, origin);
    }
    rl.count++;
  } else {
    whitelistTokenRateLimit.set(clientIP, { count: 1, resetAt: now + WHITELIST_TOKEN_RATE_WINDOW_MS });
  }
  // Periodic cleanup of stale entries (every ~100 requests)
  if (Math.random() < 0.01) {
    for (const [ip, entry] of whitelistTokenRateLimit) {
      if (now >= entry.resetAt) whitelistTokenRateLimit.delete(ip);
    }
  }

  const channelNum = channel.replace('premium', '');
  const pageUrl = `https://${PLAYER_DOMAIN}/premiumtv/daddyhd.php?id=${channelNum}`;

  try {
    logger.info('Solving reCAPTCHA for client whitelist', { channel });
    const token = await solveRecaptchaV3(pageUrl, 'player_access');
    logger.info('reCAPTCHA solved', { channel, tokenLen: token.length });

    return jsonResponse({
      success: true,
      token,
      channel_id: channel,
      verify_url: `https://${M3U8_SERVER}/verify`,
    }, 200, origin);
  } catch (err) {
    logger.error('reCAPTCHA solve failed', { channel, error: (err as Error).message });
    return jsonResponse({
      success: false,
      error: 'reCAPTCHA solve failed',
      details: (err as Error).message,
    }, 502, origin);
  }
}

/**
 * GET /whitelist/verify?channel=premium51
 * Routes through the RPI proxy's /dlhd-whitelist endpoint which uses
 * rust-fetch via ProxyJet residential SOCKS5 to:
 *   1. Solve reCAPTCHA v3
 *   2. POST token to chevy.embedkclx.sbs/verify
 *   3. Whitelist the residential proxy IP (same IP used for key fetches)
 *
 * March 24, 2026: The verify MUST come from the same IP that fetches keys.
 * CF worker IPs are useless — DLHD whitelists the caller's IP, and CF workers
 * have rotating IPs. The RPI's ProxyJet sticky session ensures the same
 * residential IP is used for both verify and key fetches.
 */
const whitelistVerifyRateLimit = new Map<string, { count: number; resetAt: number }>();

async function handleWhitelistVerify(
  url: URL, logger: any, origin: string | null, request?: Request, env?: Env
): Promise<Response> {
  const channel = url.searchParams.get('channel');
  if (!channel || !/^premium\d+$/.test(channel)) {
    return jsonResponse({ error: 'Missing or invalid channel (e.g. premium51)' }, 400, origin);
  }

  // Rate limit per IP
  const clientIP = request?.headers.get('cf-connecting-ip') || 'unknown';
  const now = Date.now();
  const rl = whitelistVerifyRateLimit.get(clientIP);
  if (rl && now < rl.resetAt) {
    if (rl.count >= WHITELIST_TOKEN_RATE_LIMIT) {
      logger.warn('Whitelist verify rate limit exceeded', { ip: clientIP, count: rl.count });
      return jsonResponse({ error: 'Rate limit exceeded', retryAfter: Math.ceil((rl.resetAt - now) / 1000) }, 429, origin);
    }
    rl.count++;
  } else {
    whitelistVerifyRateLimit.set(clientIP, { count: 1, resetAt: now + WHITELIST_TOKEN_RATE_WINDOW_MS });
  }

  // Route through RPI proxy — it uses rust-fetch via ProxyJet SOCKS5
  // so the residential IP gets whitelisted (same IP used for key fetches)
  if (!env?.RPI_PROXY_URL || !env?.RPI_PROXY_KEY) {
    logger.error('RPI proxy not configured for whitelist verify');
    return jsonResponse({ error: 'Proxy not configured', hint: 'RPI_PROXY_URL and RPI_PROXY_KEY required' }, 503, origin);
  }

  try {
    const rpiUrl = `${env.RPI_PROXY_URL}/dlhd-whitelist?channel=${channel}&key=${env.RPI_PROXY_KEY}`;
    logger.info('Calling RPI /dlhd-whitelist via ProxyJet', { channel });

    const rpiResp = await fetch(rpiUrl, {
      headers: { 'X-API-Key': env.RPI_PROXY_KEY },
      signal: AbortSignal.timeout(30000),
    });

    const rpiText = await rpiResp.text();
    logger.info('RPI whitelist response', { status: rpiResp.status, body: rpiText.substring(0, 200) });

    let rpiData: any = {};
    try { rpiData = JSON.parse(rpiText); } catch { /* not JSON */ }

    if (rpiData.success) {
      return jsonResponse({
        success: true,
        ip: rpiData.ip || 'residential-proxy',
        message: rpiData.message,
      }, 200, origin);
    }

    return jsonResponse({
      success: false,
      error: rpiData.error || 'whitelist_failed',
      message: rpiData.message || rpiText.substring(0, 200),
    }, 200, origin);
  } catch (err) {
    logger.error('Whitelist verify failed', { channel, error: (err as Error).message });
    return jsonResponse({
      success: false,
      error: 'whitelist_verify_failed',
      details: (err as Error).message,
    }, 502, origin);
  }
}
// (upstream has Access-Control-Allow-Origin: *, so browser can POST without proxy)


// ============================================================================
// MAIN HANDLER
// ============================================================================
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const logLevel = (env.LOG_LEVEL || 'debug') as LogLevel;
    const logger = createLogger(request, logLevel);
    const origin = request.headers.get('origin');
    const referer = request.headers.get('referer');

    const url = new URL(request.url);
    const path = url.pathname;

    // Geo-detection: check if client is in a region where DLHD blocks datacenter IPs.
    // When forceRPI is true, ALL upstream requests route through residential proxy
    // instead of trying direct CF fetches that would fail.
    const clientCountry = (request as any).cf?.country || '';
    const forceRPI = BLOCKED_REGIONS.has(clientCountry.toUpperCase());
    logger.info('Region check', { clientCountry, forceRPI });

    logger.info('TV Proxy request', {
      path,
      search: url.search,
      channel: url.searchParams.get('channel'),
      fullUrl: request.url
    });

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: corsHeaders(origin) });
    }

    // Only allow GET/HEAD — whitelist verify is done client-side directly to upstream
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }

    if (!isAllowedOrigin(origin, referer)) {
      // SECURITY: Strict origin validation for all endpoints
      // Segments MUST also be protected - they consume bandwidth and are the main leech target
      // Modern HLS.js DOES send proper Referer headers
      logger.warn('Origin validation failed', { 
        origin, 
        referer, 
        path,
        ip: request.headers.get('cf-connecting-ip') 
      });
      return jsonResponse({ error: 'Access denied' }, 403, origin);
    }

    try {
      if (path === '/health' || path === '/' && !url.searchParams.has('channel')) {
        const health = {
          status: 'healthy',
          domain: CDN_DOMAIN,
          m3u8Server: M3U8_SERVER,
          playerDomain: PLAYER_DOMAIN,
          geo: {
            clientCountry,
            forceRPI,
            blockedRegions: Array.from(BLOCKED_REGIONS),
          },
          rpiConfigured: !!(env.RPI_PROXY_URL && env.RPI_PROXY_KEY),
          timestamp: Date.now(),
        };
        return jsonResponse(health, 200, origin);
      }
      if (path === '/whitelist/token') return handleWhitelistToken(url, logger, origin, request);
      if (path === '/whitelist/verify') return handleWhitelistVerify(url, logger, origin, request, env);
      if (path === '/key') return handleKeyProxy(url, logger, origin, env);
      if (path === '/segment') {
        // Pass client IP for rate limiting
        const clientIP = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
        url.searchParams.set('_ip', clientIP);
        return handleSegmentProxy(url, logger, origin, env);
      }
      
      // CRITICAL: When accessed via /tv route from index.ts, url.origin is the media-proxy domain
      // but we need to include /tv in the proxy URLs so they route back to this worker
      // Check if we're being accessed through the /tv route by looking at the original URL
      // The proxyBase should be the full path prefix that routes to this worker
      const proxyBase = `${url.origin}/tv`;
      
      if (path === '/cdnlive') return handleCdnLiveM3U8Proxy(url, logger, origin, proxyBase, env);

      const channel = url.searchParams.get('channel');
      const skipBackends = url.searchParams.get('skip')?.split(',').filter(Boolean) || [];
      logger.info('Channel param', { channel, hasChannel: !!channel, skipBackends });
      
      if (!channel || !/^\d+$/.test(channel)) {
        return jsonResponse({ 
          error: 'Missing or invalid channel parameter',
          path,
          search: url.search,
          receivedChannel: channel 
        }, 400, origin);
      }
      return handlePlaylistRequest(channel, proxyBase, logger, origin, env, request, skipBackends, forceRPI);
    } catch (error) {
      logger.error('TV Proxy error', error as Error);
      return jsonResponse({ error: 'Proxy error', details: (error as Error).message }, 500, origin);
    }
  },
};

// ============================================================================
// PARALLEL BACKEND HELPERS - Fast startup optimization
// All M3U8 fetches go through RPI proxy for residential IP
// ============================================================================

async function fetchViaRpiProxy(
  url: string,
  referer: string,
  env: Env | undefined,
  logger: any,
  signal?: AbortSignal,
  origin?: string
): Promise<Response> {
  if (!env?.RPI_PROXY_URL || !env?.RPI_PROXY_KEY) {
    // Fallback to direct fetch if RPI not configured
    logger.warn('RPI proxy not configured, falling back to direct fetch');
    return fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': referer,
        ...(origin ? { 'Origin': origin } : {}),
      },
      signal,
    });
  }
  
  // Pass both referer AND origin for DLHD CDN requests
  const originParam = origin ? `&origin=${encodeURIComponent(origin)}` : '';
  const rpiUrl = `${env.RPI_PROXY_URL}/dlhd/stream?url=${encodeURIComponent(url)}&key=${env.RPI_PROXY_KEY}&referer=${encodeURIComponent(referer)}${originParam}`;
  return fetch(rpiUrl, { signal });
}

async function tryMoveonjoyBackend(
  channel: string, 
  moveonjoyUrl: string, 
  proxyOrigin: string, 
  logger: any, 
  origin: string | null,
  env?: Env
): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000); // 20 sec timeout for RPI proxy
  
  try {
    const m3u8Res = await fetchViaRpiProxy(
      moveonjoyUrl,
      'https://tv-bu1.blogspot.com/',
      env,
      logger,
      controller.signal
    );
    
    clearTimeout(timeout);
    
    if (!m3u8Res.ok) return null;
    
    const content = await m3u8Res.text();
    if (!content.includes('#EXTM3U') || (!content.includes('#EXTINF') && !content.includes('.ts'))) {
      return null;
    }
    
    logger.info('FAST: moveonjoy.com succeeded', { channel });
    const proxied = rewriteMoveonjoyM3U8(content, proxyOrigin, moveonjoyUrl);
    
    return new Response(proxied, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        ...corsHeaders(origin),
        'Cache-Control': 'no-store',
        'X-DLHD-Channel': channel,
        'X-DLHD-Backend': 'moveonjoy.com',
        'X-Fast-Path': 'true',
      },
    });
  } catch (e) {
    clearTimeout(timeout);
    return null;
  }
}

async function tryCdnLiveBackend(
  channel: string,
  mapping: { name: string; code: string },
  proxyOrigin: string,
  logger: any,
  origin: string | null,
  env?: Env
): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30 sec timeout
  
  try {
    const cdnResult = await fetchCdnLiveStream(mapping.name, mapping.code, logger, env);
    
    if (!cdnResult.success || !cdnResult.m3u8Url) {
      return null;
    }
    
    // Pass both referer AND origin - cdn-live-tv.ru may require both like DLHD CDN
    const m3u8Res = await fetchViaRpiProxy(
      cdnResult.m3u8Url,
      'https://cdn-live.tv/',
      env,
      logger,
      controller.signal,
      'https://cdn-live.tv' // Origin header
    );
    
    clearTimeout(timeout);
    
    if (!m3u8Res.ok) {
      return null;
    }
    
    const content = await m3u8Res.text();
    if (!content.includes('#EXTM3U') || (!content.includes('#EXTINF') && !content.includes('.ts') && !content.includes('#EXT-X-STREAM-INF'))) {
      return null;
    }
    
    const proxied = rewriteCdnLiveM3U8(content, proxyOrigin, cdnResult.m3u8Url);
    
    return new Response(proxied, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        ...corsHeaders(origin),
        'Cache-Control': 'no-store',
        'X-DLHD-Channel': channel,
        'X-DLHD-Backend': 'cdn-live-tv.ru',
        'X-Fast-Path': 'true',
      },
    });
  } catch (e) {
    clearTimeout(timeout);
    return null;
  }
}

/**
 * Try to fetch M3U8 from a specific server/channelKey combination
 * Returns the content if successful, null otherwise
 * 
 * CRITICAL: DLHD CDN requires:
 * - Origin: https://www.ksohls.ru
 * - Referer: https://www.ksohls.ru/
 * - Authorization: Bearer <JWT> (optional - not always needed)
 */
async function tryDvalnaServer(
  serverKey: string,
  channelKey: string,
  jwt: string | null,
  env: Env | undefined,
  logger: any,
  timeoutMs: number = 8000,
  forceRPI: boolean = false
): Promise<{ content: string; m3u8Url: string } | null> {
  const m3u8Url = constructM3U8Url(serverKey, channelKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let m3u8Res: Response | null = null;

    // When forceRPI is true (blocked region), skip direct fetch entirely —
    // datacenter IPs are known to be blocked, so save time and go straight to RPI.
    if (!forceRPI) {
      try {
        m3u8Res = await fetch(m3u8Url, {
          headers: {
            'User-Agent': USER_AGENT,
            'Origin': `https://${PLAYER_DOMAIN}`,
            'Referer': `https://${PLAYER_DOMAIN}/`,
          },
          signal: AbortSignal.timeout(4000),
        });
        if (!m3u8Res.ok || !(await m3u8Res.clone().text()).includes('#EXTM3U')) {
          m3u8Res = null; // fall through to RPI
        }
      } catch {
        m3u8Res = null;
      }
    } else {
      logger.info('dvalna: skipping direct fetch (region blocked), using RPI proxy');
    }

    // Fallback (or primary in blocked regions): RPI proxy
    if (!m3u8Res) {
      const rpiUrl = env?.RPI_PROXY_URL && env?.RPI_PROXY_KEY
        ? `${env.RPI_PROXY_URL}/dlhd/stream?url=${encodeURIComponent(m3u8Url)}&key=${env.RPI_PROXY_KEY}&referer=${encodeURIComponent(`https://${PLAYER_DOMAIN}/`)}`
        : null;
      if (!rpiUrl) {
        logger.warn('RPI proxy not configured for dvalna');
        return null;
      }
      logger.info('dvalna: routing through RPI', { serverKey, channelKey });
      m3u8Res = await fetch(rpiUrl, { signal: controller.signal });
    }

    clearTimeout(timeout);
    
    if (!m3u8Res.ok) {
      const text = await m3u8Res.text().catch(() => '');
      logger.debug('dvalna server failed', { serverKey, channelKey, status: m3u8Res.status, body: text.substring(0, 100) });
      return null;
    }
    
    const content = await m3u8Res.text();
    
    // Check for error responses (E9 = missing headers, E2 = no session, etc.)
    // DLHD CDN returns JSON errors like: {"error":"E9","message":"Missing headers"}
    // Be more specific to avoid false positives with valid M3U8 content
    if (content.startsWith('{') && (content.includes('"error"') || content.includes('"E'))) {
      logger.debug('dvalna returned error', { serverKey, channelKey, error: content.substring(0, 100) });
      return null;
    }
    
    // Also check for plain text error codes (E2, E9, etc.)
    if (/^E\d+$/.test(content.trim())) {
      logger.debug('dvalna returned error code', { serverKey, channelKey, error: content.trim() });
      return null;
    }
    
    // Validate it's a real M3U8 with actual content
    if (!content.includes('#EXTM3U') || (!content.includes('#EXTINF') && !content.includes('.ts'))) {
      return null;
    }
    
    return { content, m3u8Url };
  } catch (e) {
    clearTimeout(timeout);
    logger.debug('dvalna server exception', { serverKey, channelKey, error: (e as Error).message });
    return null;
  }
}

async function tryDvalnaBackend(
  channel: string,
  jwtPromise: Promise<string | null>,
  proxyOrigin: string,
  logger: any,
  origin: string | null,
  env?: Env,
  errors?: string[],
  forceRPI: boolean = false
): Promise<Response | null> {
  // JWT is optional now - M3U8 works without it through RPI proxy
  const jwt = await jwtPromise;
  
  // Build list of channel keys to try
  const channelKeysToTry: string[] = [];
  
  // 1. Channel key from JWT 'sub' field (if available)
  if (jwt) {
    try {
      const payloadB64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(payloadB64));
      if (payload.sub && !channelKeysToTry.includes(payload.sub)) {
        channelKeysToTry.push(payload.sub);
      }
    } catch {}
  }
  
  // 2. Premium key format (from hitsplay.fun - simplified Jan 2026)
  const premiumKey = getChannelKey(channel);
  if (!channelKeysToTry.includes(premiumKey)) {
    channelKeysToTry.push(premiumKey);
  }
  
  logger.info('dvalna: trying channel keys', { channel, keys: channelKeysToTry });
  
  // Common servers to try as fallback if lookup fails
  const FALLBACK_SERVERS = ['nfs', 'zeko', 'wiki', 'hzt', 'x4', 'dokko1', 'top2'];
  
  // For each channel key, use server_lookup to get the correct server
  for (const channelKey of channelKeysToTry) {
    // Use server_lookup API to get the correct server for this channel
    const serverKey = await getServerKey(channelKey, logger, env);
    
    logger.info('dvalna: using server from lookup', { channelKey, server: serverKey });
    
    // Build list of servers to try: lookup result first, then fallbacks
    const serversToTry = [serverKey, ...FALLBACK_SERVERS.filter(s => s !== serverKey)];
    
    for (const server of serversToTry) {
      // Try the server
      const result = await tryDvalnaServer(server, channelKey, jwt, env, logger, 8000, forceRPI);
      
      if (result) {
        logger.info('dvalna: SUCCESS', { channel, channelKey, server });
        
        // Cache the working server
        serverKeyCache.set(channelKey, { serverKey: server, fetchedAt: Date.now() });
        
        const proxied = rewriteM3U8(result.content, proxyOrigin, result.m3u8Url);
        
        return new Response(proxied, {
          status: 200,
          headers: {
            'Content-Type': 'application/vnd.apple.mpegurl',
            ...corsHeaders(origin),
            'Cache-Control': 'no-store',
            'X-DLHD-Channel': channel,
            'X-DLHD-ChannelKey': channelKey,
            'X-DLHD-Server': server,
            'X-DLHD-Backend': 'dlhd-cdn',
            'X-Fast-Path': 'true',
          },
        });
      }
      
      logger.debug('dvalna: server failed', { channelKey, server });
    }
    
    // Log failure for this channel key
    if (errors) {
      errors.push(`dvalna/${channelKey}: all servers failed`);
    }
    
    logger.warn('dvalna: all servers failed for key', { channelKey });
  }
  
  if (errors) errors.push(`dvalna: all ${channelKeysToTry.length} channel keys failed`);
  return null;
}

async function handlePlaylistRequest(channel: string, proxyOrigin: string, logger: any, origin: string | null, env?: Env, request?: Request, skipBackends: string[] = [], forceRPI: boolean = false): Promise<Response> {
  const errors: string[] = [];

  // ============================================================================
  // BACKEND PRIORITY ORDER: moveonjoy → cdn-live → dvalna
  // Try fastest/simplest backends first, fall back to slower ones
  // ============================================================================

  // JWT is OPTIONAL — M3U8 works without it. Race JWT fetch against a 3s timeout
  // so we never block playlist delivery waiting for dead JWT sources.
  const jwtPromise = !skipBackends.includes('dvalna')
    ? Promise.race([
        fetchPlayerJWT(channel, logger, env),
        new Promise<null>(r => setTimeout(() => { logger.info('JWT fetch timeout (3s) — proceeding without'); r(null); }, 3000)),
      ])
    : Promise.resolve(null);



  // ============================================================================
  // BACKEND 3: DLHD CDN (needs JWT + PoW - uses ddy6 server ONLY)
  // ============================================================================
  if (!skipBackends.includes('dvalna')) {
    try {
      const result = await tryDvalnaBackend(channel, jwtPromise, proxyOrigin, logger, origin, env, errors, forceRPI);
      if (result && result.status === 200) {
        return result;
      }
    } catch (e) {
      errors.push(`dvalna: ${(e as Error).message}`);
    }
  }

  // ============================================================================
  // ALL BACKENDS FAILED
  // ============================================================================
  const offlineErrors = errors.filter(e => e.includes('offline') || e.includes('empty'));
  const hasOfflineChannel = offlineErrors.length > 0;
  
  if (hasOfflineChannel) {
    return jsonResponse({ 
      error: 'Channel offline', 
      message: 'This channel exists but is not currently streaming.',
      channel,
      offlineOn: offlineErrors.map(e => e.split(':')[0]),
      hint: 'US broadcast channels are often only available during live sports events. Try again later.'
    }, 503, origin);
  }
  
  return jsonResponse({ 
    error: 'All backends failed', 
    channel,
    errors: errors.slice(0, 10),
    backendsTriedCount: 3,
    hint: 'moveonjoy.com, cdn-live-tv.ru, and DLHD CDN all failed'
  }, 502, origin);
}

// ============================================================================
// M3U8 REWRITERS FOR DIFFERENT BACKENDS
// ============================================================================

/**
 * Rewrite M3U8 for cdn-live-tv.ru backend
 * This backend uses token-based auth, segments include the token
 * 
 * CRITICAL: All URLs must be proxied through appropriate endpoints because
 * cdn-live-tv.ru blocks direct browser requests (CORS/geo-blocking)
 * 
 * ROUTING STRATEGY (January 2026 Fix):
 * - .m3u8 manifests → /tv/cdnlive?url=... (through Next.js /tv route)
 * - .ts segments → /segment?url=... (DIRECTLY to worker, bypassing /tv)
 * - Keys (URI= in EXT-X-KEY) → /segment?url=... (DIRECTLY to worker)
 * - Audio/subtitle tracks (URI= in EXT-X-MEDIA) → /tv/cdnlive?url=... (m3u8 manifests)
 * 
 * This ensures segments are served from edge worker for performance,
 * while manifests can be processed through Next.js if needed.
 */
function rewriteCdnLiveM3U8(content: string, proxyOrigin: string, m3u8BaseUrl: string): string {
  const baseUrl = new URL(m3u8BaseUrl);
  const basePath = baseUrl.pathname.replace(/\/[^/]*$/, '/');
  const token = baseUrl.searchParams.get('token') || '';
  
  const lines = content.split('\n').map(line => {
    const trimmed = line.trim();
    
    // Handle URI attributes (EXT-X-KEY for keys, EXT-X-MEDIA for audio/subtitle tracks)
    if (trimmed.includes('URI="')) {
      return trimmed.replace(/URI="([^"]+)"/, (_, uri: string) => {
        // Skip if already proxied
        if (uri.includes('/segment?url=') || uri.includes('/key?url=') || uri.includes('/cdnlive?url=')) {
          return `URI="${uri}"`;
        }
        const fullUrl = uri.startsWith('http') ? uri : `${baseUrl.origin}${basePath}${uri}`;
        const workerOrigin = proxyOrigin.replace(/\/tv$/, '');
        
        // Route based on file type:
        // - .m3u8 files (audio/subtitle tracks) → /tv/cdnlive for manifest handling
        // - Keys and other files → /segment for direct proxying
        if (fullUrl.includes('.m3u8')) {
          return `URI="${proxyOrigin}/cdnlive?url=${encodeURIComponent(fullUrl)}"`;
        } else {
          return `URI="${workerOrigin}/segment?url=${encodeURIComponent(fullUrl)}"`;
        }
      });
    }
    
    if (!trimmed || trimmed.startsWith('#')) return line;
    
    // Skip if already proxied
    if (trimmed.includes('/segment?url=') || trimmed.includes('/cdnlive?url=')) return line;
    
    let absoluteUrl: string;
    
    // Make relative URLs absolute
    if (!trimmed.startsWith('http')) {
      absoluteUrl = `${baseUrl.origin}${basePath}${trimmed}`;
    } else {
      absoluteUrl = trimmed;
    }
    
    // Ensure token is included
    if (!absoluteUrl.includes('token=') && token) {
      absoluteUrl += (absoluteUrl.includes('?') ? '&' : '?') + `token=${token}`;
    }
    
    // Route based on file type:
    // CRITICAL FIX: Segments must go DIRECTLY to worker, NOT through /tv route!
    // - .m3u8 files → /tv/cdnlive (through Next.js /tv route for manifest handling)
    // - .ts segments → /segment (DIRECTLY to worker, bypassing Next.js)
    if (absoluteUrl.includes('.m3u8')) {
      // Manifests go through /tv route
      return `${proxyOrigin}/cdnlive?url=${encodeURIComponent(absoluteUrl)}`;
    } else {
      // Segments go DIRECTLY to worker (strip /tv prefix from proxyOrigin)
      const workerOrigin = proxyOrigin.replace(/\/tv$/, '');
      return `${workerOrigin}/segment?url=${encodeURIComponent(absoluteUrl)}`;
    }
  });
  
  return lines.join('\n');
}

/**
 * Handle /cdnlive proxy requests for cdn-live-tv.ru M3U8 files
 * This proxies nested M3U8 playlists (variant/level playlists) and rewrites their URLs
 * CRITICAL: All fetches go through RPI proxy - cdn-live blocks CF IPs
 */
async function handleCdnLiveM3U8Proxy(url: URL, logger: any, origin: string | null, proxyOrigin: string, env?: Env): Promise<Response> {
  const m3u8Url = url.searchParams.get('url');
  if (!m3u8Url) {
    return jsonResponse({ error: 'Missing url parameter' }, 400, origin);
  }

  // SECURITY: Validate URL format before decoding
  let decodedUrl: string;
  try {
    decodedUrl = decodeURIComponent(m3u8Url);
  } catch {
    logger.warn('Invalid URL encoding', { url: m3u8Url.substring(0, 50) });
    return jsonResponse({ error: 'Invalid URL encoding' }, 400, origin);
  }

  logger.info('CDN-Live M3U8 proxy', { url: decodedUrl.substring(0, 100) });

  try {
    // SECURITY: Strict domain validation to prevent SSRF
    // Only allow exact CDN-Live domains, not substrings
    const urlObj = new URL(decodedUrl);
    const allowedDomains = [
      'cdn-live-tv.ru',
      'cdn-live-tv.cfd',
      'cdn-live.tv',
      'edge.cdn-live-tv.ru',
    ];
    
    const hostname = urlObj.hostname.toLowerCase();
    const isAllowedDomain = allowedDomains.some(domain => 
      hostname === domain || hostname.endsWith(`.${domain}`)
    );
    
    if (!isAllowedDomain) {
      logger.warn('CDN-Live domain validation failed', { hostname });
      return jsonResponse({ error: 'Invalid domain' }, 400, origin);
    }
    
    // SECURITY: Only allow HTTPS
    if (urlObj.protocol !== 'https:') {
      return jsonResponse({ error: 'HTTPS required' }, 400, origin);
    }

    // SECURITY: Add timeout to prevent slow-loris attacks
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout

    // Try RPI proxy first, then fallback to direct fetch
    const referer = 'https://cdn-live.tv/';
    let response: Response | null = null;
    let fetchedVia = 'direct';
    
    if (env?.RPI_PROXY_URL && env?.RPI_PROXY_KEY) {
      logger.info('Trying RPI proxy for CDN-Live M3U8');
      try {
        const rpiUrl = `${env.RPI_PROXY_URL}/dlhd/stream?url=${encodeURIComponent(decodedUrl)}&key=${env.RPI_PROXY_KEY}&referer=${encodeURIComponent(referer)}`;
        const rpiRes = await fetch(rpiUrl, { signal: controller.signal });
        if (rpiRes.ok) {
          response = rpiRes;
          fetchedVia = 'rpi';
        } else {
          logger.warn('RPI M3U8 fetch failed, trying direct', { status: rpiRes.status });
        }
      } catch (rpiErr) {
        logger.warn('RPI proxy error, trying direct', { error: (rpiErr as Error).message });
      }
    }
    
    // Direct fetch (either as fallback or if RPI not configured)
    if (!response) {
      logger.info('Using direct fetch for CDN-Live M3U8');
      response = await fetch(decodedUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Referer': referer,
          'Origin': 'https://cdn-live.tv',
        },
        signal: controller.signal,
      });
      fetchedVia = 'direct';
    }
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      logger.error('CDN-Live upstream error', { status: response.status, via: fetchedVia });
      return jsonResponse({ error: `Upstream error: ${response.status}` }, response.status, origin);
    }

    const content = await response.text();
    
    if (!content.includes('#EXTM3U')) {
      return jsonResponse({ error: 'Invalid M3U8' }, 502, origin);
    }

    const rewritten = rewriteCdnLiveM3U8(content, proxyOrigin, decodedUrl);

    return new Response(rewritten, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
        ...corsHeaders(origin),
        'X-Fetched-Via': fetchedVia,
      },
    });
  } catch (error) {
    logger.error('CDN-Live proxy error', { error: (error as Error).message });
    return jsonResponse({ error: 'Proxy failed', details: (error as Error).message }, 502, origin);
  }
}

/**
 * Rewrite M3U8 for moveonjoy.com backend
 * This backend has no auth, just make URLs absolute
 */
function rewriteMoveonjoyM3U8(content: string, proxyOrigin: string, m3u8BaseUrl: string): string {
  const baseUrl = new URL(m3u8BaseUrl);
  const basePath = baseUrl.pathname.replace(/\/[^/]*$/, '/');
  
  const lines = content.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    
    // Make relative URLs absolute
    if (!trimmed.startsWith('http')) {
      return `${baseUrl.origin}${basePath}${trimmed}`;
    }
    return line;
  });
  
  return lines.join('\n');
}

/**
 * Rewrite M3U8 for lovecdn.ru backend
 * This backend uses token-based auth, segments include the token
 */
function rewriteLovecdnM3U8(content: string, proxyOrigin: string, m3u8BaseUrl: string): string {
  const baseUrl = new URL(m3u8BaseUrl);
  const basePath = baseUrl.pathname.replace(/\/[^/]*$/, '/');
  const token = baseUrl.searchParams.get('token') || '';
  
  const lines = content.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    
    // Make relative URLs absolute
    if (!trimmed.startsWith('http')) {
      let absoluteUrl = `${baseUrl.origin}${basePath}${trimmed}`;
      // Ensure token is included for segments
      if (!absoluteUrl.includes('token=') && token) {
        absoluteUrl += (absoluteUrl.includes('?') ? '&' : '?') + `token=${token}`;
      }
      return absoluteUrl;
    }
    return line;
  });
  
  return lines.join('\n');
}

// In-memory key cache — per CF Worker isolate, instant lookups
const keyMemCache = new Map<string, { data: ArrayBuffer; expiresAt: number }>();
const KEY_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes (keys rotate every ~3-5 min)

const FAKE_KEYS = new Set([
  '45db13cfa0ed393fdb7da4dfe9b5ac81',
  '455806f8bc592fdacb6ed5e071a517b1',
  '4542956ed8680eaccb615f7faad4da8f',
  '45a542173e0b81d2a9c13cbc2bdcfd8c',
]);

function toHexStr(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Key proxy handler — clean cache-first flow.
 *
 * March 25, 2026 — EPlayerAuth is GONE from DLHD. No auth headers needed.
 *
 * Flow:
 *   1. Check in-memory cache for this key path → return if valid
 *   2. Cache miss → call RPI /dlhd-key-v6 (ProxyJet sticky session)
 *      RPI handles: create session → whitelist via reCAPTCHA → fetch key → return
 *   3. Validate key (16 bytes, not fake) → cache + return to user
 */
async function handleKeyProxy(url: URL, logger: any, origin: string | null, env?: Env): Promise<Response> {
  const startTime = Date.now();

  const keyUrlParam = url.searchParams.get('url');
  if (!keyUrlParam) return jsonResponse({ error: 'Missing url parameter' }, 400, origin);

  const keyUrl = decodeURIComponent(keyUrlParam);
  const keyPathMatch = keyUrl.match(/\/key\/([^/]+)\/(\d+)/);
  if (!keyPathMatch) return jsonResponse({ error: 'Could not extract channel key from URL' }, 400, origin);

  const channelKey = keyPathMatch[1];
  const keyNumber = keyPathMatch[2];
  const keyPath = `/key/${channelKey}/${keyNumber}`;

  // ─── Step 1: Check cache ──────────────────────────────────────────
  const cached = keyMemCache.get(keyPath);
  if (cached && Date.now() < cached.expiresAt) {
    logger.info('Key cache hit', { keyPath, ms: Date.now() - startTime });
    return new Response(cached.data, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '16',
        ...corsHeaders(origin),
        'Cache-Control': 'no-store',
        'X-Fetched-Via': 'cache',
        'X-Cache-Remaining': String(Math.round((cached.expiresAt - Date.now()) / 1000)) + 's',
      },
    });
  }

  // ─── Step 2: Fetch from RPI (ProxyJet sticky session) ─────────────
  if (!env?.RPI_PROXY_URL || !env?.RPI_PROXY_KEY) {
    return jsonResponse({ error: 'RPI proxy not configured' }, 502, origin);
  }

  // Send the primary key URL — RPI will try multiple servers internally
  const primaryKeyUrl = `https://chevy.${CDN_DOMAIN}${keyPath}`;
  const rpiUrl = `${env.RPI_PROXY_URL}/dlhd-key-v6?url=${encodeURIComponent(primaryKeyUrl)}&key=${env.RPI_PROXY_KEY}`;

  logger.info('Fetching key via RPI', { channelKey, keyNumber });

  let rpiRes: Response;
  try {
    rpiRes = await fetch(rpiUrl, { signal: AbortSignal.timeout(30000) });
  } catch (e) {
    const ms = Date.now() - startTime;
    if ((e as Error).name === 'AbortError') {
      logger.warn('RPI timeout', { ms });
      return jsonResponse({ error: 'Key fetch timeout', ms }, 504, origin);
    }
    throw e;
  }

  if (!rpiRes.ok) {
    const errText = await rpiRes.text();
    logger.warn('RPI error', { status: rpiRes.status, error: errText.substring(0, 200) });
    return jsonResponse({ error: 'RPI key fetch failed', rpiStatus: rpiRes.status, details: errText.substring(0, 200) }, 502, origin);
  }

  const data = await rpiRes.arrayBuffer();

  // ─── Step 3: Validate + cache + return ────────────────────────────
  if (data.byteLength === 16) {
    const hex = toHexStr(data);
    if (FAKE_KEYS.has(hex)) {
      logger.warn('RPI returned fake key', { hex: hex.substring(0, 16) });
      return jsonResponse({ error: 'Fake key — ProxyJet IP not whitelisted', channelKey, keyNumber }, 502, origin);
    }

    // Cache the valid key
    keyMemCache.set(keyPath, { data, expiresAt: Date.now() + KEY_CACHE_TTL_MS });

    // Evict expired entries if cache grows large
    if (keyMemCache.size > 500) {
      const now = Date.now();
      for (const [k, v] of keyMemCache) { if (now >= v.expiresAt) keyMemCache.delete(k); }
    }

    const ms = Date.now() - startTime;
    const fetchedVia = rpiRes.headers.get('X-Fetched-By') || 'rpi-v6';
    logger.info('Key fetched + cached', { channelKey, keyNumber, hex: hex.substring(0, 16), ms, fetchedVia });
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '16',
        ...corsHeaders(origin),
        'Cache-Control': 'no-store',
        'X-Fetched-Via': fetchedVia,
        'X-Total-Ms': String(ms),
      },
    });
  }

  // Non-16-byte response from RPI
  const text = new TextDecoder().decode(data);
  logger.warn('Invalid key response from RPI', { size: data.byteLength, preview: text.substring(0, 100) });
  return jsonResponse({ error: 'Invalid key response', size: data.byteLength }, 502, origin);
}

// Known DLHD CDN domains that block Cloudflare IPs
const DLHD_DOMAINS = ['soyspace.cyou', 'keylocking.ru', 'the-sunmoon.site', 'arbitrageai.cc', 'r2.cloudflarestorage.com', 'embedkclx.sbs', 'enviromentalanimal.horse', 'aivideox.site'];

/**
 * Check if a URL is from a DLHD CDN domain that blocks CF IPs
 */
function isDLHDDomain(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return DLHD_DOMAINS.some(domain => url.hostname.endsWith(domain));
  } catch {
    return false;
  }
}

async function handleSegmentProxy(url: URL, logger: any, origin: string | null, env?: Env): Promise<Response> {
  const segmentUrl = url.searchParams.get('url');
  if (!segmentUrl) return jsonResponse({ error: 'Missing url parameter' }, 400, origin);

  // SECURITY: Rate limiting to prevent bandwidth abuse
  // Each IP gets limited requests per minute
  const clientIP = url.searchParams.get('_ip') || 'unknown'; // Set by CF worker
  if (env?.RATE_LIMIT_KV) {
    const rateLimitKey = `segment_rate:${clientIP}`;
    const currentCount = parseInt(await env.RATE_LIMIT_KV.get(rateLimitKey) || '0');
    const SEGMENT_RATE_LIMIT = 300; // 300 segments per minute (5 per second)
    
    if (currentCount >= SEGMENT_RATE_LIMIT) {
      logger.warn('Rate limit exceeded for segment requests', { ip: clientIP, count: currentCount });
      return jsonResponse({ error: 'Rate limit exceeded' }, 429, origin);
    }
    
    // Increment counter with 60 second TTL
    await env.RATE_LIMIT_KV.put(rateLimitKey, String(currentCount + 1), { expirationTtl: 60 });
  } else {
    // SECURITY WARNING: Rate limiting disabled - KV namespace not configured
    // This allows unlimited bandwidth consumption per IP
    logger.warn('RATE_LIMIT_KV not configured - bandwidth abuse possible');
  }

  // SECURITY: Strict URL validation to prevent SSRF attacks
  let decodedUrl: string;
  try {
    decodedUrl = decodeURIComponent(segmentUrl);
  } catch {
    logger.warn('Invalid URL encoding in segment request');
    return jsonResponse({ error: 'Invalid URL encoding' }, 400, origin);
  }

  // SECURITY: Validate domain whitelist to prevent proxying arbitrary URLs
  const allowedDomains = [
    'soyspace.cyou',
    'keylocking.ru',
    'the-sunmoon.site',
    'arbitrageai.cc',
    'r2.cloudflarestorage.com',
    'embedkclx.sbs',
    'enviromentalanimal.horse',
    'aivideox.site',
    'cdn-live-tv.ru',
    'cdn-live-tv.cfd',
    'cdn-live.tv',
    'edge.cdn-live-tv.ru',
    'edge.cdn-live-tv.cfd',
    'moveonjoy.com',
    'lovecdn.ru',
    'popcdn.day',
    'beautifulpeople.lovecdn.ru',
  ];

  try {
    const urlObj = new URL(decodedUrl);
    const hostname = urlObj.hostname.toLowerCase();
    const isAllowed = allowedDomains.some(domain =>
      hostname === domain || hostname.endsWith(`.${domain}`)
    );

    if (!isAllowed) {
      logger.warn('SSRF attempt - unauthorized domain', { hostname, origin });
      return jsonResponse({ error: 'Unauthorized domain' }, 403, origin);
    }
  } catch (e) {
    logger.warn('Invalid URL format in segment request', { url: decodedUrl.substring(0, 50) });
    return jsonResponse({ error: 'Invalid URL format' }, 400, origin);
  }

  // Determine correct Referer based on domain
  let referer = `https://${PLAYER_DOMAIN}/`;
  let requestOrigin = `https://${PLAYER_DOMAIN}`;
  try {
    const urlHost = new URL(decodedUrl).hostname;
    if (urlHost.includes('cdn-live-tv.ru') || urlHost.includes('cdn-live-tv.cfd') || urlHost.includes('cdn-live.tv')) {
      referer = 'https://cdn-live.tv/';
      requestOrigin = 'https://cdn-live.tv';
    } else if (urlHost.includes('moveonjoy.com')) {
      referer = 'https://tv-bu1.blogspot.com/';
      requestOrigin = 'https://tv-bu1.blogspot.com';
    } else if (urlHost.includes('soyspace.cyou') || urlHost.includes('keylocking.ru') || urlHost.includes('the-sunmoon.site') || urlHost.includes('ai-hls.site') || urlHost.includes('r2.cloudflarestorage.com') || urlHost.includes('arbitrageai.cc') || urlHost.includes('embedkclx.sbs') || urlHost.includes('enviromentalanimal.horse') || urlHost.includes('aivideox.site')) {
      // DLHD CDN requires www.ksohls.ru referer (updated Mar 27, 2026)
      referer = `https://${PLAYER_DOMAIN}/`;
      requestOrigin = `https://${PLAYER_DOMAIN}`;
    }
  } catch {}
  
  logger.info('Segment proxy request', { url: decodedUrl.substring(0, 80), referer });

  try {
    let data: ArrayBuffer;
    let fetchedVia = 'direct';
    
    // Try RPI proxy first, then fallback to direct fetch
    // cdn-live-tv.ru may work from CF IPs, so we try both
    // DLHD CDN REQUIRES residential IP - direct fetch will fail
    if (env?.RPI_PROXY_URL && env?.RPI_PROXY_KEY) {
      logger.info('Trying RPI proxy for segment');
      try {
        // Pass both referer AND origin for DLHD CDN segments
        const rpiUrl = `${env.RPI_PROXY_URL}/dlhd/stream?url=${encodeURIComponent(decodedUrl)}&key=${env.RPI_PROXY_KEY}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(requestOrigin)}`;
        logger.info('RPI URL', { rpiUrl: rpiUrl.substring(0, 150) });
        
        const rpiRes = await fetch(rpiUrl, {
          signal: AbortSignal.timeout(25000), // 25 second timeout
        });
        
        logger.info('RPI response', { status: rpiRes.status, contentType: rpiRes.headers.get('content-type') });
        
        if (rpiRes.ok) {
          data = await rpiRes.arrayBuffer();
          fetchedVia = 'rpi';
          logger.info('RPI segment fetched', { size: data.byteLength });
        } else {
          const errText = await rpiRes.text();
          logger.warn('RPI segment fetch failed, trying direct', { status: rpiRes.status, error: errText.substring(0, 200) });
          // Fall through to direct fetch
        }
      } catch (rpiErr) {
        logger.warn('RPI proxy error, trying direct', { error: (rpiErr as Error).message });
        // Fall through to direct fetch
      }
    }
    
    // Direct fetch (either as fallback or if RPI not configured)
    if (!data!) {
      logger.info('Using direct fetch for segment');
      const directRes = await fetch(decodedUrl, {
        headers: { 
          'User-Agent': USER_AGENT, 
          'Referer': referer,
          'Origin': requestOrigin,
        },
      });
      
      if (!directRes.ok) {
        logger.warn('Direct segment fetch HTTP error', { 
          status: directRes.status, 
          statusText: directRes.statusText,
          url: decodedUrl.substring(0, 100)
        });
        return jsonResponse({ 
          error: 'Segment fetch failed', 
          status: directRes.status,
        }, 502, origin);
      }
      
      data = await directRes.arrayBuffer();
      fetchedVia = 'direct';
    }
    
    // Log segment info but DON'T reject based on format
    // DLHD segments may be encrypted or have non-standard headers
    const firstBytes = new Uint8Array(data.slice(0, 8));
    const isValidTS = firstBytes[0] === 0x47; // TS sync byte
    const firstChars = new TextDecoder().decode(firstBytes);
    const isValidFMP4 = firstChars.includes('ftyp') || firstChars.includes('moof') || firstChars.includes('mdat');
    
    // Only reject if it looks like an error response (JSON/HTML)
    if (!isValidTS && !isValidFMP4 && data.byteLength < 1000) {
      const preview = new TextDecoder().decode(data.slice(0, 500));
      // Check if it's actually an error response
      if (preview.startsWith('{') || preview.startsWith('<') || preview.includes('"error"')) {
        logger.warn('Segment response looks like error', { 
          size: data.byteLength, 
          preview: preview.substring(0, 200),
          url: decodedUrl.substring(0, 80)
        });
        return jsonResponse({ 
          error: 'Segment fetch returned error response', 
          preview: preview.substring(0, 100),
        }, 502, origin);
      }
    }
    
    logger.info('Segment fetch succeeded', { size: data.byteLength, isTS: isValidTS, isFMP4: isValidFMP4, via: fetchedVia });

    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': 'video/mp2t',
        ...corsHeaders(origin),
        'Cache-Control': 'public, max-age=300',
        'X-Fetched-Via': fetchedVia,
      },
    });
  } catch (error) {
    logger.error('Segment proxy error', { error: (error as Error).message });
    return jsonResponse({ error: 'Segment fetch failed', details: (error as Error).message }, 502, origin);
  }
}

function rewriteM3U8(content: string, proxyOrigin: string, m3u8BaseUrl: string): string {
  let modified = content;

  // March 25, 2026: Route keys through /tv/key proxy.
  // Keys require reCAPTCHA IP whitelist — CF edge IPs get fake/poison keys.
  // Worker tries direct fetch first (fast path), falls back to RPI residential proxy.
  // EPlayerAuth is gone — no auth headers needed, only IP whitelist.
  modified = modified.replace(/URI="([^"]+)"/g, (_, originalKeyUrl) => {
    let absoluteKeyUrl = originalKeyUrl;
    if (!absoluteKeyUrl.startsWith('http')) {
      const base = new URL(m3u8BaseUrl);
      absoluteKeyUrl = new URL(originalKeyUrl, base.origin + base.pathname.replace(/\/[^/]*$/, '/')).toString();
    }
    return `URI="${proxyOrigin}/key?url=${encodeURIComponent(absoluteKeyUrl)}"`;
  });

  modified = modified.replace(/\n?#EXT-X-ENDLIST\s*$/m, '');

  // Fix: DLHD now splits long segment URLs across multiple lines
  // Join lines that are continuations of URLs (don't start with # or http)
  const rawLines = modified.split('\n');
  const joinedLines: string[] = [];
  let currentLine = '';
  
  for (const line of rawLines) {
    const trimmed = line.trim();
    
    // If line starts with # or is empty, flush current and add this line
    if (!trimmed || trimmed.startsWith('#')) {
      if (currentLine) {
        joinedLines.push(currentLine);
        currentLine = '';
      }
      joinedLines.push(line);
    }
    // If line starts with http, it's a new URL
    else if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      if (currentLine) {
        joinedLines.push(currentLine);
      }
      currentLine = trimmed;
    }
    // Otherwise it's a continuation of the previous URL
    else {
      currentLine += trimmed;
    }
  }
  
  // Don't forget the last line
  if (currentLine) {
    joinedLines.push(currentLine);
  }

  // Proxy segment URLs through our worker
  // DLHD CDN blocks direct browser requests (CORS/geo-blocking)
  // so we MUST proxy segments through the worker
  const lines = joinedLines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    
    // Skip if already proxied
    if (trimmed.includes('/segment?url=') || trimmed.includes('/key?url=')) return line;
    
    // Proxy segment URLs through our worker
    // Strip /tv from proxyOrigin to get the worker origin for /segment endpoint
    const workerOrigin = proxyOrigin.replace(/\/tv$/, '');
    return `${workerOrigin}/segment?url=${encodeURIComponent(trimmed)}`;
  });

  return lines.join('\n');
}

function isAllowedOrigin(origin: string | null, referer: string | null): boolean {
  // SECURITY FIX: Do NOT allow requests without origin/referer!
  // Previous assumption that "media players don't send headers" is FALSE and exploitable.
  // Modern HLS.js and video players DO send Referer headers.
  // Attackers can trivially strip headers using curl/wget/scripts.
  // 
  // If you need to support legacy players, use signed tokens instead (see anti-leech-proxy.ts)
  if (!origin && !referer) {
    // TEMPORARY: Log these requests to identify legitimate vs malicious traffic
    console.warn('[SECURITY] Request without Origin/Referer - potential leech attempt');
    return false; // DENY by default
  }
  
  const check = (o: string) => ALLOWED_ORIGINS.some(a => {
    if (a.includes('localhost')) return o.includes('localhost');
    // Handle domain suffix patterns (e.g., '.pages.dev', '.workers.dev')
    if (a.startsWith('.')) {
      try {
        const originHost = new URL(o).hostname;
        return originHost.endsWith(a);
      } catch {
        return false;
      }
    }
    try {
      const allowedHost = new URL(a).hostname;
      const originHost = new URL(o).hostname;
      return originHost === allowedHost || originHost.endsWith(`.${allowedHost}`);
    } catch {
      return false;
    }
  });
  if (origin && check(origin)) return true;
  if (referer) try { return check(new URL(referer).origin); } catch {}
  
  // SECURITY: Do NOT allow all origins - this defeats anti-leech protection
  // If origin/referer is provided but doesn't match, DENY access
  return false;
}

function corsHeaders(origin?: string | null): Record<string, string> {
  // SECURITY: Only return specific origin if it's in our allowed list
  // Using '*' allows any site to embed our streams
  const allowedOrigin = origin && ALLOWED_ORIGINS.some(a => {
    if (a.includes('localhost')) return origin.includes('localhost');
    if (a.startsWith('.')) {
      try {
        return new URL(origin).hostname.endsWith(a);
      } catch { return false; }
    }
    try {
      const allowedHost = new URL(a).hostname;
      const originHost = new URL(origin).hostname;
      return originHost === allowedHost || originHost.endsWith(`.${allowedHost}`);
    } catch { return false; }
  }) ? origin : null;
  
  return {
    'Access-Control-Allow-Origin': allowedOrigin || 'https://flyx.tv', // Default to main domain, not '*'
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Allow-Credentials': 'true',
  };
}

function jsonResponse(data: object, status: number, origin?: string | null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
