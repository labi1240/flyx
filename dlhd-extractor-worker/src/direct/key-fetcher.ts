/**
 * DLHD Key Fetcher — April 10, 2026
 *
 * Fetches encryption keys from DLHD key servers.
 *
 * Keys require ZERO auth headers — reCAPTCHA enforcement appears disabled.
 *
 * Key servers (CORS *, all chevy.{domain} pattern):
 *   - chevy.embedkclx.sbs (primary — Apr 10 2026)
 *   - chevy.enviromentalanimal.horse (new fallback)
 *   - chevy.soyspace.cyou (fallback)
 *
 * DEAD: sec.ai-hls.site (403 blocked as of Apr 10 2026)
 *
 * SECURITY FEATURES:
 * - Rate limiting per channel (prevents abuse)
 * - Fake key detection (identifies non-whitelisted IPs)
 */

import {
  DLHDAuthDataV5,
} from './dlhd-auth-v5';

export type { DLHDAuthDataV5 as DLHDAuthData } from './dlhd-auth-v5';

// Rate limiting: Track requests per channel
const channelRequestCache = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10; // Max 10 key requests per channel per minute

// Key servers to try (ordered by reliability for server-side fetching)
// UPDATED May 27 2026: embedkclx.sbs DEAD, vovlacosa.sbs SSL broken. newkso.ru is new primary.
const KEY_SERVERS = ['chevy.newkso.ru', 'chevy.enviromentalanimal.horse', 'chevy.soyspace.cyou'] as const;

export interface KeyFetchResult {
  success: boolean;
  data?: ArrayBuffer;
  error?: string;
  statusCode?: number;
  isFakeKey?: boolean;
  retryAfter?: number; // Milliseconds to wait before retry
}

/**
 * Parse key URL to extract resource and key number
 */
export function parseKeyUrl(keyUrl: string): { resource: string; keyNumber: string } | null {
  const match = keyUrl.match(/\/key\/([^/]+)\/(\d+)/);
  if (!match) return null;
  return { resource: match[1], keyNumber: match[2] };
}

/**
 * Extract channel ID from key URL
 */
export function extractChannelFromKeyUrl(keyUrl: string): string | null {
  const match = keyUrl.match(/premium(\d+)/);
  return match ? match[1] : null;
}

/**
 * Check rate limit for channel
 * Returns true if rate limit exceeded
 */
function checkRateLimit(channel: string): { limited: boolean; retryAfter?: number } {
  const now = Date.now();
  const key = `channel:${channel}`;
  
  let record = channelRequestCache.get(key);
  
  // Reset if window expired
  if (!record || now >= record.resetAt) {
    record = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    channelRequestCache.set(key, record);
  }
  
  // Check limit
  if (record.count >= MAX_REQUESTS_PER_WINDOW) {
    const retryAfter = record.resetAt - now;
    console.log(`[Key-Fetch] Rate limit exceeded for channel ${channel}, retry in ${retryAfter}ms`);
    return { limited: true, retryAfter };
  }
  
  // Increment counter
  record.count++;
  return { limited: false };
}

/**
 * Validate key data for known fake patterns
 */
function isFakeKey(keyHex: string): boolean {
  // Known fake/poison keys returned to non-whitelisted IPs
  // UPDATED Mar 25 2026: Added full keys discovered via E2E testing
  const FAKE_KEYS = new Set([
    '45db13cfa0ed393fdb7da4dfe9b5ac81',
    '455806f8bc592fdacb6ed5e071a517b1',
    '4542956ed8680eaccb615f7faad4da8f',
    '45a542173e0b81d2a9c13cbc2bdcfd8c',
  ]);

  if (FAKE_KEYS.has(keyHex)) return true;

  // Also check prefix patterns
  const fakePatterns = ['00000000', 'ffffffff'];
  return fakePatterns.some(pattern => keyHex.startsWith(pattern));
}

/**
 * Fetch key from DLHD key servers.
 *
 * UPDATED Mar 25 2026: EPlayerAuth is completely removed from DLHD.
 * Keys require NO auth headers — only reCAPTCHA IP whitelist.
 * The authData parameter is kept for API compatibility but ignored.
 *
 * Tries multiple key servers (chevy.embedkclx.sbs, chevy.soyspace.cyou, etc).
 * Returns fake key detection so callers can trigger reCAPTCHA whitelist.
 */
export async function fetchKeyWithAuth(
  keyUrl: string,
  authData?: DLHDAuthDataV5
): Promise<KeyFetchResult> {
  const parsed = parseKeyUrl(keyUrl);
  if (!parsed) {
    return { success: false, error: 'Invalid key URL format' };
  }

  const { resource, keyNumber } = parsed;

  // Extract channel for rate limiting
  const channel = extractChannelFromKeyUrl(keyUrl);
  if (!channel) {
    return { success: false, error: 'Cannot extract channel from key URL' };
  }

  // SECURITY: Check rate limit
  const rateLimitCheck = checkRateLimit(channel);
  if (rateLimitCheck.limited) {
    return {
      success: false,
      error: 'Rate limit exceeded',
      retryAfter: rateLimitCheck.retryAfter
    };
  }

  // Mar 27 2026: No auth headers needed — just Referer/Origin for CORS
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Referer': 'https://www.newkso.ru/',
    'Origin': 'https://www.newkso.ru',
  };

  console.log(`[Key-Fetch] ${resource}/${keyNumber} (no auth headers — IP whitelist only)`);

  // Try the provided URL first, then fallback servers
  const keyPath = `/key/${resource}/${keyNumber}`;
  const urlsToTry = [keyUrl];
  for (const server of KEY_SERVERS) {
    const alt = `https://${server}${keyPath}`;
    if (!urlsToTry.includes(alt)) urlsToTry.push(alt);
  }

  for (const url of urlsToTry) {
    try {
      const response = await fetch(url, { headers });

      if (response.ok) {
        const data = await response.arrayBuffer();

        if (data.byteLength === 16) {
          const bytes = new Uint8Array(data);
          const keyHex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

          // SECURITY: Check for fake key patterns (returned to non-whitelisted IPs)
          if (isFakeKey(keyHex)) {
            console.log(`[Key-Fetch] FAKE key from ${new URL(url).hostname}: ${keyHex} — IP not whitelisted`);
            return {
              success: false,
              error: 'Received fake key — IP not whitelisted (reCAPTCHA verify needed)',
              isFakeKey: true
            };
          }

          console.log(`[Key-Fetch] REAL key: ${keyHex}`);
          return { success: true, data };
        } else {
          console.log(`[Key-Fetch] Invalid key size: ${data.byteLength} bytes from ${new URL(url).hostname}`);
          continue;
        }
      } else if (response.status === 403) {
        console.log(`[Key-Fetch] 403 from ${new URL(url).hostname} — trying next server`);
        continue;
      } else {
        console.log(`[Key-Fetch] HTTP ${response.status} from ${new URL(url).hostname}`);
        continue;
      }
    } catch (e) {
      console.log(`[Key-Fetch] Error from ${url}: ${e}`);
      continue;
    }
  }

  return { success: false, error: 'All key servers failed' };
}

/**
 * Fetch key with pre-fetched auth data (for when auth is already available).
 * NOTE: authData is ignored as of Mar 25 2026 — kept for API compatibility.
 */
export async function fetchKeyDirect(
  keyUrl: string,
  authData: DLHDAuthDataV5
): Promise<KeyFetchResult> {
  return fetchKeyWithAuth(keyUrl, authData);
}
