/**
 * Pure JS Flixer/Hexa Extraction Pipeline
 *
 * Replaces the WASM-based key generation and decryption with pure JavaScript,
 * eliminating the WebAssembly dependency entirely.
 *
 * Key Architectural Decision:
 * The server uses the X-Api-Key value directly as both the HMAC signing secret
 * and the AES-256-CTR encryption key for response payloads. Since the server
 * receives the key via the X-Api-Key header on every request, it does NOT need
 * to independently regenerate the key from fingerprint data. This means we can
 * use ANY 64-char hex string as the API key, eliminating the need for the
 * canvas-fingerprinting WASM module.
 *
 * Requirements for production:
 * - A valid Cap.js PoW token (solved every ~2.5 hours)
 * - Server time synchronization (/api/time endpoint)
 * - HMAC-SHA256 request signing
 * - AES-256-CTR response decryption
 *
 * @module flixer-pure-js
 */

import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FlixerConfig {
  /** API base URL (e.g. https://theemoviedb.hexa.su or https://plsdontscrapemelove.flixer.su) */
  apiBase: string;
  /** Cap.js challenge base URL */
  capBase: string;
  /** User agent for requests */
  userAgent: string;
  /** X-Client-Fingerprint lite value (hardcoded in WASM, hex string) */
  fingerprintLite: string;
}

export interface StreamSource {
  quality: string;
  url: string;
  type: 'hls' | 'mp4';
  referer: string;
  server: string;
}

export interface ExtractionResult {
  success: boolean;
  sources: StreamSource[];
  error?: string;
}

// ── Defaults ───────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: FlixerConfig = {
  apiBase: 'https://theemoviedb.hexa.su',
  capBase: 'https://cap.hexa.su/15d2cf0395',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  fingerprintLite: 'e9136c41504646444',
};

export const SERVER_NAMES: Record<string, string> = {
  alpha: 'Ares', bravo: 'Balder', charlie: 'Circe', delta: 'Dionysus',
  echo: 'Eros', foxtrot: 'Freya', golf: 'Gaia', hotel: 'Hades',
  india: 'Isis', juliet: 'Juno', kilo: 'Kronos', lima: 'Loki',
  mike: 'Medusa', november: 'Nyx', oscar: 'Odin', papa: 'Persephone',
  quebec: 'Quirinus', romeo: 'Ra', sierra: 'Selene', tango: 'Thor',
  uniform: 'Uranus', victor: 'Vulcan', whiskey: 'Woden', xray: 'Xolotl',
  yankee: 'Ymir', zulu: 'Zeus',
};

// ── API Key Generation (replaces WASM get_img_key) ──────────────────────────────

/**
 * Generate a random 64-char hex API key.
 *
 * The WASM originally derived this from canvas fingerprinting, but the API
 * server does not independently validate the key against the fingerprint — it
 * uses whatever key we send in X-Api-Key for HMAC verification and AES
 * response encryption. A random 32-byte key works identically.
 */
export function generateApiKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Generate the X-Client-Fingerprint header value.
 *
 * This is a separate value from the API key. It's sent as an additional
 * header for the server's analytics/fingerprinting but is NOT used for
 * authentication. We use a hash of plausible browser attributes.
 */
export function generateClientFingerprint(
  screenWidth = 1920,
  screenHeight = 1080,
  colorDepth = 24,
  platform = 'Win32',
  language = 'en-US',
  ua?: string,
  tzOffset?: number,
): string {
  const userAgent = (ua || DEFAULT_CONFIG.userAgent).substring(0, 50);
  const tz = tzOffset ?? new Date().getTimezoneOffset();
  const fpString = `${screenWidth}x${screenHeight}:${colorDepth}:${userAgent}:${platform}:${language}:${tz}:FP`;
  let hash = 0;
  for (let i = 0; i < fpString.length; i++) {
    hash = (hash << 5) - hash + fpString.charCodeAt(i);
    hash &= hash;
  }
  return Math.abs(hash).toString(36);
}

// ── Request Signing (HMAC-SHA256) ──────────────────────────────────────────────

export function generateNonce(): string {
  return randomBytes(16).toString('base64').replace(/[/+=]/g, '').substring(0, 22);
}

/**
 * Build the HMAC-SHA256 signature for a Flixer API request.
 *
 * Format: HMAC-SHA256(key, "key:timestamp:nonce:path")
 * Output: base64-encoded signature
 */
export function signRequest(
  apiKey: string,
  timestamp: number,
  nonce: string,
  path: string,
): string {
  const hmac = createHmac('sha256', apiKey);
  hmac.update(`${apiKey}:${timestamp}:${nonce}:${path}`);
  return hmac.digest('base64');
}

/**
 * Fetch the server's current timestamp for clock drift compensation.
 */
export async function fetchServerTime(
  apiBase: string = DEFAULT_CONFIG.apiBase,
  signal?: AbortSignal,
): Promise<number> {
  const url = `${apiBase}/api/time?t=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': DEFAULT_CONFIG.userAgent,
      'Cache-Control': 'no-cache',
    },
    signal: signal ?? AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Time sync failed: ${res.status}`);
  const data = await res.json() as { timestamp: number };
  return data.timestamp;
}

/**
 * Build all required headers for a Flixer API request.
 */
export async function buildHeaders(
  apiKey: string,
  fullUrl: string,
  capToken?: string,
): Promise<Record<string, string>> {
  const apiPath = new URL(fullUrl).pathname;
  const timestamp = await fetchServerTime();
  const nonce = generateNonce();
  const signature = signRequest(apiKey, timestamp, nonce, apiPath);
  const fingerprint = generateClientFingerprint();

  const headers: Record<string, string> = {
    'X-Api-Key': apiKey,
    'X-Request-Timestamp': timestamp.toString(),
    'X-Request-Nonce': nonce,
    'X-Request-Signature': signature,
    'X-Client-Fingerprint': fingerprint,
    'x-fingerprint-lite': DEFAULT_CONFIG.fingerprintLite,
    'User-Agent': DEFAULT_CONFIG.userAgent,
    'Origin': 'https://hexa.su',
    'Referer': 'https://hexa.su/',
    'Accept': 'text/plain',
  };

  if (capToken) {
    headers['x-cap-token'] = capToken;
  }

  return headers;
}

// ── Response Decryption (replaces WASM process_img_data) ────────────────────────

/**
 * Manual Ctr32BE keystream generation for compatibility with Rust's ctr crate.
 *
 * The Rust `ctr-0.9.2` crate uses the Ctr32BE flavor (confirmed via WAT
 * decompilation of the flixer.wasm data section). Ctr32BE splits the 16-byte
 * IV into a 12-byte fixed nonce and a 4-byte big-endian counter. Only the
 * last 4 bytes are incremented per block — the nonce stays constant.
 *
 * Standard Node.js aes-256-ctr increments the full 128-bit IV, which diverges
 * from Ctr32BE for multi-block plaintext (>16 bytes). This function implements
 * AES-ECB keystream generation with manual XOR and Ctr32BE counter increment
 * to match the Rust implementation exactly.
 *
 * @param ciphertext - Raw ciphertext bytes (after IV extraction)
 * @param key - 32-byte AES-256 key
 * @param iv - 16-byte IV (first 12 bytes nonce, last 4 bytes BE counter seed)
 * @returns Decrypted plaintext bytes
 */
function decryptCtr32BE(ciphertext: Buffer, key: Buffer, iv: Buffer): Buffer {
  const nonce = iv.subarray(0, 12);
  const counter = Buffer.from(iv.subarray(12, 16)); // Copy — mutated below
  const numBlocks = Math.ceil(ciphertext.length / 16);

  const plaintext = Buffer.alloc(ciphertext.length);
  const cipher = createCipheriv('aes-256-ecb', key, null);
  cipher.setAutoPadding(false);

  for (let b = 0; b < numBlocks; b++) {
    // Build counter block: [12 bytes nonce || 4 bytes counter (BE)]
    const counterBlock = Buffer.concat([nonce, counter]);

    // AES(key, counter_block) → keystream block
    const keystream = cipher.update(counterBlock);

    // XOR keystream with ciphertext for this block
    const start = b * 16;
    const end = Math.min(start + 16, ciphertext.length);
    for (let i = start; i < end; i++) {
      plaintext[i] = ciphertext[i] ^ keystream[i - start];
    }

    // Increment 32-bit big-endian counter (Rust Ctr32BE behaviour)
    for (let i = 3; i >= 0; i--) {
      counter[i]++;
      if (counter[i] !== 0) break;
    }
  }

  return plaintext;
}

/**
 * Decrypt a Flixer API response using AES-256-CTR (Ctr32BE).
 *
 * The server encrypts its JSON response payloads with AES-256-CTR using the
 * API key (hex-decoded to 32 bytes) and a random 16-byte IV prepended to the
 * ciphertext. The AES mode is Ctr32BE (Rust ctr crate flavor).
 *
 * Encrypted payload format:
 *   [16 bytes IV (random, per-request)][ciphertext bytes]
 *
 * The plaintext after decryption is a UTF-8 JSON string.
 *
 * @param encryptedBase64 - Base64-encoded encrypted data from the API
 * @param apiKey - 64-char hex API key (32 bytes when decoded)
 * @returns Decrypted JSON string
 */
export function decryptResponse(encryptedBase64: string, apiKey: string): string {
  try {
    const key = Buffer.from(apiKey, 'hex');
    if (key.length !== 32) {
      throw new Error(`Invalid key length: ${key.length} bytes (expected 32)`);
    }

    const data = Buffer.from(encryptedBase64, 'base64');
    if (data.length < 17) {
      // Too small to contain IV (16 bytes) + any ciphertext
      throw new Error(`Encrypted data too short: ${data.length} bytes`);
    }

    // Extract IV (first 16 bytes) and ciphertext (remainder)
    const iv = data.subarray(0, 16);
    const ciphertext = data.subarray(16);

    // Manual Ctr32BE decryption (compatible with Rust ctr crate)
    const decrypted = decryptCtr32BE(ciphertext, key, iv);

    return decrypted.toString('utf-8');
  } catch (err) {
    throw new Error(
      `Decryption failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Attempt decryption with GCM mode as fallback.
 *
 * Some Flixer API versions use AES-256-GCM instead of CTR. The GCM format
 * appends a 16-byte authentication tag to the ciphertext:
 *   [16 bytes IV][ciphertext][16 bytes GCM tag]
 */
export function decryptResponseGcm(encryptedBase64: string, apiKey: string): string {
  try {
    const key = Buffer.from(apiKey, 'hex');
    const data = Buffer.from(encryptedBase64, 'base64');

    // GCM format: [12-byte nonce][ciphertext][16-byte tag]
    const nonce = data.subarray(0, 12);
    const tag = data.subarray(data.length - 16);
    const ciphertext = data.subarray(12, data.length - 16);

    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf-8');
  } catch (err) {
    throw new Error(
      `GCM decryption failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── API Interaction ────────────────────────────────────────────────────────────

interface ApiImageData {
  sources?: Array<{ server: string; url?: string; file?: string }>;
  servers?: Record<string, unknown> | Array<string>;
  skipTime?: unknown;
  error?: string;
}

/**
 * Get the list of available servers for a given content item.
 */
export async function getServerList(
  tmdbId: string,
  type: 'movie' | 'tv',
  apiKey: string,
  season?: number,
  episode?: number,
  capToken?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiPath = type === 'movie'
    ? `/api/tmdb/movie/${tmdbId}/images`
    : `/api/tmdb/tv/${tmdbId}/season/${season}/episode/${episode}/images`;

  const fullUrl = `${DEFAULT_CONFIG.apiBase}${apiPath}`;
  const headers = await buildHeaders(apiKey, fullUrl, capToken);
  const res = await fetch(fullUrl, { headers, signal: signal ?? AbortSignal.timeout(15000) });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Server list: ${res.status} ${body.substring(0, 200)}`);
  }

  const encrypted = await res.text();
  const decrypted = decryptResponse(encrypted, apiKey);
  const data = JSON.parse(decrypted) as ApiImageData;

  // Extract server names
  const servers: string[] = [];
  if (data.sources && Array.isArray(data.sources)) {
    for (const s of data.sources) {
      if (s.server) servers.push(s.server);
    }
  } else if (data.servers) {
    if (Array.isArray(data.servers)) {
      servers.push(...data.servers.map(String));
    } else {
      servers.push(...Object.keys(data.servers));
    }
  }

  return servers;
}

/**
 * Extract stream URL from a specific server.
 */
export async function extractFromServer(
  tmdbId: string,
  type: 'movie' | 'tv',
  server: string,
  apiKey: string,
  season?: number,
  episode?: number,
  capToken?: string,
  signal?: AbortSignal,
): Promise<StreamSource | null> {
  const apiPath = type === 'movie'
    ? `/api/tmdb/movie/${tmdbId}/images`
    : `/api/tmdb/tv/${tmdbId}/season/${season}/episode/${episode}/images`;

  const fullUrl = `${DEFAULT_CONFIG.apiBase}${apiPath}`;
  const headers = await buildHeaders(apiKey, fullUrl, capToken);
  headers['Accept'] = 'text/plain';
  headers['X-Only-Sources'] = '1';
  headers['X-Server'] = server;

  const res = await fetch(fullUrl, { headers, signal: signal ?? AbortSignal.timeout(15000) });
  if (!res.ok) return null;

  const encrypted = await res.text();
  let decrypted: string;
  try {
    decrypted = decryptResponse(encrypted, apiKey);
  } catch {
    // Try GCM fallback
    try {
      decrypted = decryptResponseGcm(encrypted, apiKey);
    } catch {
      return null;
    }
  }

  const data = JSON.parse(decrypted) as ApiImageData;

  // Extract URL from response
  let url: string | null = null;
  if (data.sources && Array.isArray(data.sources)) {
    const src = data.sources.find(s => s.server === server) || data.sources[0];
    url = src?.url || src?.file || null;
  }

  if (!url || !url.trim()) return null;

  return {
    quality: 'auto',
    url: url.trim(),
    type: url.includes('.m3u8') ? 'hls' : 'mp4',
    referer: 'https://hexa.su/',
    server,
  };
}

// ── Full Extraction ────────────────────────────────────────────────────────────

/**
 * Extract all available stream sources for a given content item.
 *
 * This is the main entry point that orchestrates the full Flixer extraction
 * pipeline without any WASM dependency.
 *
 * @param tmdbId - TMDB content ID
 * @param type - Content type ('movie' or 'tv')
 * @param capToken - Valid Cap.js PoW token (required for API access)
 * @param season - Season number (required for TV)
 * @param episode - Episode number (required for TV)
 * @returns Extraction result with all working sources
 */
export async function extractAll(
  tmdbId: string,
  type: 'movie' | 'tv',
  capToken: string,
  season?: number,
  episode?: number,
  signal?: AbortSignal,
): Promise<ExtractionResult> {
  try {
    // Validate TV inputs
    if (type === 'tv' && (!season || !episode)) {
      return { success: false, sources: [], error: 'Season and episode required for TV' };
    }

    // Step 1: Generate API key (pure JS, no WASM)
    const apiKey = generateApiKey();
    console.log(`[Flixer] API key generated: ${apiKey.substring(0, 16)}...`);

    // Step 2: Get server list
    console.log(`[Flixer] Fetching server list for ${type} ${tmdbId}...`);
    const servers = await getServerList(tmdbId, type, apiKey, season, episode, capToken, signal);
    console.log(`[Flixer] Available servers: ${servers.join(', ')}`);

    if (servers.length === 0) {
      return { success: false, sources: [], error: 'No servers available' };
    }

    // Step 3: Extract from priority servers
    const priority = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    const toTry = priority.filter(s => servers.includes(s));
    if (toTry.length === 0) toTry.push(...servers.slice(0, 6));

    const sources: StreamSource[] = [];
    const errors: string[] = [];

    for (const server of toTry) {
      try {
        const source = await extractFromServer(
          tmdbId, type, server, apiKey,
          season, episode, capToken, signal,
        );
        if (source) {
          sources.push(source);
          console.log(`[Flixer]  + ${server}: ${source.url.substring(0, 80)}...`);
        } else {
          console.log(`[Flixer]  - ${server}: no source returned`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${server}: ${msg}`);
        console.log(`[Flixer]  ! ${server}: ${msg}`);
      }
    }

    return {
      success: sources.length > 0,
      sources,
      error: sources.length === 0
        ? `No working sources: ${errors.join('; ')}`
        : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Flixer] Extraction failed:`, msg);
    return { success: false, sources: [], error: msg };
  }
}
