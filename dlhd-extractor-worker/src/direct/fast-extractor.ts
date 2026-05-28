/**
 * DLHD Fast Stream Extractor - INSTANT VERSION with Dynamic Server Lookup
 * 
 * DISCOVERY: M3U8 doesn't require auth! Only keys do.
 * This means we can extract streams in <500ms!
 * 
 * Flow (updated Feb 28, 2026):
 * 1. Look up server via LIVE server_lookup API (with in-memory cache) (~0-200ms)
 * 2. Fall back to pre-computed map if API fails (0ms)
 * 3. Construct M3U8 URL (0ms)  
 * 4. Fetch M3U8 with just Referer header (~100-400ms)
 * 5. If primary fails, try fallback servers
 * 
 * Auth is only needed when fetching keys, which happens on-demand.
 * 
 * Updated January 2026: Uses EPlayerAuth (V5) - no more JWT!
 * Updated February 2026: Added multi-server fallback for reliability
 * Updated February 28, 2026: Dynamic server_lookup API replaces stale hardcoded map
 *   - New lookup domain: chevy.vovlacosa.sbs
 *   - Channel range extended to 950+
 *   - In-memory cache for server lookups (2 min TTL)
 *   - Hardcoded map kept as fallback only
 */

import { Env, ExtractedStream } from '../types';
import { fetchAuthData, DLHDAuthDataV5 } from './dlhd-auth-v5';
import { discoverAllServers, findAnyWorkingServer, getOrderedServerList, MultiServerResult } from './multi-server';
import {
  ALL_SERVERS, BACKEND_DOMAINS,
  serverLookupUrl, m3u8Url as buildM3u8Url, upstreamHeaders,
} from './dlhd-config';

export { ALL_SERVERS, BACKEND_DOMAINS as ALL_DOMAINS } from './dlhd-config';

// Maximum valid channel ID
const MAX_CHANNEL_ID = 1000;

// Fallback limits for extractWithFallback
const MAX_FALLBACK_ATTEMPTS = 6;
const FALLBACK_REQUEST_TIMEOUT = 8000;

// =============================================================================
// DYNAMIC SERVER LOOKUP (with in-memory cache)
// =============================================================================

const serverLookupCache = new Map<number, { server: string; expires: number }>();
const LOOKUP_CACHE_TTL_MS = 2 * 60 * 1000;

/**
 * Look up the correct server for a channel via the live API.
 * Uses chevy.{domain}/server_lookup?channel_id=premium{ch}
 */
export async function lookupServer(channelId: number): Promise<string | null> {
  const cached = serverLookupCache.get(channelId);
  if (cached && cached.expires > Date.now()) return cached.server;

  const channelKey = `premium${channelId}`;

  try {
    const result = await Promise.any(
      BACKEND_DOMAINS.map(async (domain) => {
        const lookupUrl = serverLookupUrl(domain, channelKey);
        const resp = await fetch(lookupUrl, {
          headers: upstreamHeaders(),
          signal: AbortSignal.timeout(2500),
        });
        if (!resp.ok) throw new Error(`${resp.status}`);
        const data = await resp.json() as { server_key?: string };
        if (!data.server_key) throw new Error('no server_key');
        return { server: data.server_key, domain };
      })
    );

    serverLookupCache.set(channelId, { server: result.server, expires: Date.now() + LOOKUP_CACHE_TTL_MS });
    if (serverLookupCache.size > 500) {
      const now = Date.now();
      for (const [key, val] of serverLookupCache.entries()) {
        if (val.expires < now) serverLookupCache.delete(key);
      }
    }
    console.log(`[ServerLookup] ch${channelId} -> ${result.server} (via ${result.domain})`);
    return result.server;
  } catch {
    console.log(`[ServerLookup] API failed for ch${channelId}, falling back to static map`);
    return null;
  }
}

// Pre-computed server mappings from discovery scan
// Maps channel ID to PRIMARY server (first to try)
const SERVER_MAP: Record<number, string> = {};

// Initialize server map
// UPDATED Mar 30, 2026: Full rescan of all 850 channels via server_lookup API
// New server 'x4' discovered (channels 29, 55, 75, 128, 310, etc.)
// Multiple channels reshuffled between servers
const SERVER_CHANNELS: Record<string, number[]> = {
  'ddy6': [40,69,73,78,79,83,85,98,100,101,102,105,106,107,108,109,110,120,127,135,136,137,138,139,148,149,151,152,154,160,165,166,167,170,172,173,174,179,201,202,203,204,205,206,207,209,210,211,212,215,216,217,218,223,268,269,281,282,285,286,287,289,290,291,295,296,297,298,299,323,342,353,356,358,361,362,363,369,388,393,414,415,418,426,428,432,434,449,450,454,455,461,462,474,482,486,487,488,489,490,494,495,496,497,498,499,500,511,512,513,514,515,516,517,518,519,520,525,540,542,553,557,558,559,573,574,576,611,612,613,614,615,616,617,618,641,653,654,655,662,666,681,687,716,717,718,719,720,721,722,723,724,725,726,727,728,729,730,731,732,733,734,735,736,737,738,739,740,741,744,746,748,749,756,770,771,772,773,774,809,817,818,819,826,827,828,830,850],
  'zeko': [35,36,38,39,44,51,54,56,62,63,64,67,81,90,111,112,113,114,115,116,117,118,119,123,125,126,140,141,142,143,144,145,146,147,213,214,255,257,261,262,263,264,265,266,267,271,272,273,277,278,293,300,301,302,305,306,308,309,311,312,313,314,315,316,317,318,320,321,328,335,336,338,344,346,347,351,352,355,364,365,367,368,370,372,373,374,375,378,379,381,382,383,384,385,386,394,398,404,405,409,411,412,413,416,419,421,422,423,424,425,430,433,435,436,437,438,446,447,448,501,502,503,504,505,506,507,508,509,510,524,543,544,546,547,555,597,598,602,646,699,702,703,704,705,706,707,745,757,758,759,760,763,765,766,767,768,769,775,777,791,792,793,799,820,821,822,848],
  'wind': [41,42,43,45,46,47,49,50,53,57,58,59,60,61,66,68,70,71,72,76,80,82,84,87,88,89,121,122,124,129,131,134,150,155,161,162,163,164,168,169,171,175,176,177,178,230,231,232,233,234,235,236,237,238,239,245,246,247,259,260,274,275,276,324,325,326,327,329,330,331,332,333,337,340,354,360,376,377,387,390,396,399,406,407,408,410,417,420,429,431,443,445,451,453,456,457,458,459,463,464,465,466,467,468,469,470,471,472,473,475,476,477,478,479,480,481,483,484,485,521,522,541,550,554,569,570,578,579,580,581,599,600,671,672,673,674,675,676,677,678,679,680,682,683,684,685,686,688,715,750,753,754,755,776,786,787,788,823,824,825,844,846,847,849],
  'dokko1': [65,74,86,91,92,93,94,95,96,97,130,153,156,157,158,159,219,220,221,242,243,244,248,249,250,251,252,253,254,256,258,270,341,348,349,350,357,359,380,392,444,452,460,523,526,527,528,529,530,531,532,533,534,535,536,537,538,539,556,560,561,562,563,564,565,566,567,568,571,584,587,588,589,590,591,592,593,594,595,596,601,603,604,605,606,607,608,609,610,619,620,621,622,623,624,625,626,627,628,629,630,631,632,633,634,635,636,637,638,640,642,643,645,647,648,649,651,657,658,659,660,661,663,664,665,668,669,670,697,698,751,752,778,779,780,781,782,783,784,785,797,798,800,801,802,803,804,805,806,807,808,810,811,813,832,833,834,835,836,837,839,840,841,842,845],
  'nfs': [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,30,31,32,33,34,37,48,52,77,103,104,132,133,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,208,222,224,225,226,227,228,229,240,241,279,280,283,284,288,292,294,303,304,307,322,334,345,389,391,400,401,402,403,575,583,585,586,644,652,656,667,689,690,691,692,693,694,695,696,708,709,710,712,713,714,742,743,747,762,764,789,790,794,795,796,816,829,831,838],
  'wiki': [439,440,843],
  'x4': [29,55,75,128,310,319,339,343,366,371,395,397,427,577,650,700,814],
};

// Build reverse lookup map
for (const [server, channels] of Object.entries(SERVER_CHANNELS)) {
  for (const ch of channels) {
    SERVER_MAP[ch] = server;
  }
}

/**
 * Get the ordered list of servers to try for a channel.
 * Uses LIVE server_lookup API first (cached), falls back to static map.
 * Primary server first, then all others as fallbacks.
 */
export async function getServersForChannelDynamic(channelId: number): Promise<string[]> {
  // Try live lookup first (uses cache, very fast on repeat calls)
  const liveServer = await lookupServer(channelId);
  if (liveServer) {
    // Return live result first, then all known servers as fallbacks
    return [liveServer, ...ALL_SERVERS.filter(s => s !== liveServer)];
  }
  
  // Fall back to static map
  return getServersForChannel(channelId);
}

/**
 * Discover ALL working servers for a channel by probing every server×domain combo.
 * This bypasses the server_lookup API limitation (which only returns ONE server).
 * Most channels are mirrored on 2-4 servers simultaneously.
 *
 * Results are cached in-memory for 5 minutes.
 */
export async function getAllWorkingServersForChannel(channelId: number): Promise<MultiServerResult> {
  return discoverAllServers(String(channelId));
}

/**
 * Fast check: find ANY working server for a channel.
 * Returns as soon as the first probe succeeds — much faster than full enumeration.
 */
export async function findWorkingServerQuick(channelId: number): Promise<{ server: string; domain: string } | null> {
  return findAnyWorkingServer(String(channelId));
}

/**
 * Get the ordered list of servers to try for a channel, using multi-server
 * discovery when available. Falls back to static map + server_lookup.
 */
export async function getServersForChannelMultiServer(channelId: number): Promise<string[]> {
  try {
    const ordered = await getOrderedServerList(String(channelId));
    if (ordered.length > 0) return ordered;
  } catch {
    // Fall through to static map
  }
  return getServersForChannel(channelId);
}

/**
 * Get the ordered list of servers to try for a channel (static map only).
 * Primary server first, then all others as fallbacks.
 */
export function getServersForChannel(channelId: number): string[] {
  const primary = SERVER_MAP[channelId];
  if (primary) {
    // Return primary first, then all others
    return [primary, ...ALL_SERVERS.filter(s => s !== primary)];
  }
  // No primary mapping, try all servers
  return [...ALL_SERVERS];
}

/**
 * Get server for a channel from pre-computed map (primary only)
 */
export function getServerForChannel(channelId: number): string | null {
  return SERVER_MAP[channelId] || null;
}

/**
 * Build M3U8 URL for a channel on a specific server/domain
 * UPDATED Apr 10 2026: M3U8 served via chevy.embedkclx.sbs (primary) or chevy.soyspace.cyou (fallback)
 * UPDATED Mar 30 2026: Handle 'top1/cdn' server key (slash in path, forward-deployed by DLHD)
 * Pattern: https://{m3u8Server}/proxy/{server}/premium{ch}/mono.css
 * DLHD's own player uses M3U8_SERVER directly — confirmed via page source extraction.
 */
function buildM3U8UrlLocal(channelId: string, server: string, domain?: string): string {
  return buildM3u8Url(server, domain || BACKEND_DOMAINS[0], channelId);
}

/**
 * Fast stream extraction - INSTANT! No auth needed for M3U8!
 * Updated Feb 28, 2026: Uses dynamic server_lookup API with static map fallback.
 * 
 * @param channelId - Channel ID (1-1000)
 * @returns ExtractedStream or null if channel not found
 */
export async function extractFast(channelId: string): Promise<ExtractedStream | null> {
  const startTime = Date.now();
  console.log(`[FastExtract] Starting instant extraction for channel ${channelId}`);
  
  const chNum = parseInt(channelId, 10);
  if (isNaN(chNum) || chNum < 1 || chNum > MAX_CHANNEL_ID) {
    console.log(`[FastExtract] Invalid channel ID: ${channelId}`);
    return null;
  }

  // Step 1: Get server - try live API first, then static map
  let server = await lookupServer(chNum);
  if (!server) {
    server = getServerForChannel(chNum);
  }
  if (!server) {
    console.log(`[FastExtract] No server found for channel ${channelId}`);
    return null;
  }

  // Step 2: Construct M3U8 URL (instant - 0ms)
  const m3u8UrlResult = buildM3U8UrlLocal(channelId, server);

  // Step 3: Build headers - NO AUTH NEEDED for M3U8!
  const headers = upstreamHeaders();

  const elapsed = Date.now() - startTime;
  console.log(`[FastExtract] SUCCESS in ${elapsed}ms: Channel ${channelId} -> ${server}.${BACKEND_DOMAINS[0]}`);

  return {
    m3u8Url: m3u8UrlResult,
    headers,
    referer: headers.Referer || 'https://www.newkso.ru/',
    origin: headers.Origin || 'https://www.newkso.ru',
    quality: undefined,
    isEncrypted: true,
  };
}

/**
 * Extract stream with multi-server fallback
 * Tries primary server first, then falls back to other servers if it fails
 * 
 * SECURITY:
 * - Validates all inputs before use
 * - Limits fallback attempts to prevent DoS amplification
 * - Uses timeouts to prevent hanging requests
 * - Sanitizes log output to avoid leaking infrastructure details
 * 
 * @param channelId - Channel ID (1-850)
 * @param token - Auth token for the request (must be non-empty)
 * @param rpiProxyUrl - RPI proxy URL (must be valid HTTPS URL)
 * @param rpiApiKey - RPI proxy API key (must be non-empty)
 * @returns ExtractedStream with working server, or null if all fail
 */
export async function extractWithFallback(
  channelId: string,
  token: string,
  rpiProxyUrl: string,
  rpiApiKey: string
): Promise<{ stream: ExtractedStream; server: string; domain: string } | null> {
  const startTime = Date.now();
  
  // SECURITY: Validate all inputs
  if (!token || token.length < 10) {
    console.log(`[FastExtract] Invalid or missing auth token`);
    return null;
  }
  
  if (!rpiProxyUrl || !rpiApiKey) {
    console.log(`[FastExtract] Missing RPI proxy configuration`);
    return null;
  }
  
  // Validate RPI proxy URL format
  try {
    const proxyUrl = new URL(rpiProxyUrl);
    if (proxyUrl.protocol !== 'https:' && !proxyUrl.hostname.includes('localhost')) {
      console.log(`[FastExtract] RPI proxy must use HTTPS`);
      return null;
    }
  } catch {
    console.log(`[FastExtract] Invalid RPI proxy URL format`);
    return null;
  }
  
  const chNum = parseInt(channelId, 10);
  
  if (isNaN(chNum) || chNum < 1 || chNum > MAX_CHANNEL_ID) {
    console.log(`[FastExtract] Invalid channel ID: ${channelId}`);
    return null;
  }

  // Use dynamic lookup for server list
  const servers = await getServersForChannelDynamic(chNum);
  // SECURITY: Don't log server names - could leak infrastructure
  console.log(`[FastExtract] Trying fallback for channel ${channelId}`);

  let attempts = 0;
  
  // Try each server in order, but limit total attempts
  for (const server of servers) {
    for (const domain of BACKEND_DOMAINS) {
      // SECURITY: Limit total fallback attempts to prevent DoS amplification
      if (attempts >= MAX_FALLBACK_ATTEMPTS) {
        console.log(`[FastExtract] Max fallback attempts (${MAX_FALLBACK_ATTEMPTS}) reached`);
        break;
      }
      attempts++;
      
      const m3u8Url = buildM3U8UrlLocal(channelId, server, domain);
      
      try {
        // Fetch via RPI proxy with timeout
        const rpiUrl = new URL('/dlhdprivate', rpiProxyUrl);
        rpiUrl.searchParams.set('url', m3u8Url);
        // SECURITY: Pass auth in headers object, not as separate param
        rpiUrl.searchParams.set('headers', JSON.stringify({
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
          'Referer': 'https://www.newkso.ru/',
          'Origin': 'https://www.newkso.ru',
          'Authorization': `Bearer ${token}`,
        }));

        // SECURITY: Add timeout to prevent hanging requests
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FALLBACK_REQUEST_TIMEOUT);

        try {
          const response = await fetch(rpiUrl.toString(), {
            headers: { 'X-API-Key': rpiApiKey },
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (response.ok) {
            const text = await response.text();
            // Check if it's a valid M3U8
            if (text.includes('#EXTM3U') || text.includes('#EXT-X-')) {
              const elapsed = Date.now() - startTime;
              // SECURITY: Don't log server/domain in success message
              console.log(`[FastExtract] SUCCESS in ${elapsed}ms for channel ${channelId}`);

              return {
                stream: {
                  m3u8Url,
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': '*/*',
                    'Referer': 'https://www.ksohls.ru/',
                    'Origin': 'https://www.ksohls.ru',
                    'Authorization': `Bearer ${token}`,
                  },
                  referer: 'https://www.ksohls.ru/',
                  origin: 'https://www.ksohls.ru',
                  quality: undefined,
                  isEncrypted: true,
                },
                server,
                domain,
              };
            }
          }
        } catch (fetchError) {
          clearTimeout(timeoutId);
          if (fetchError instanceof Error && fetchError.name === 'AbortError') {
            console.log(`[FastExtract] Timeout on attempt ${attempts}`);
          } else {
            throw fetchError;
          }
        }
        
        // SECURITY: Don't log which server failed
        console.log(`[FastExtract] Attempt ${attempts} failed for channel ${channelId}`);
      } catch (e) {
        // SECURITY: Don't log error details that might expose infrastructure
        console.log(`[FastExtract] Error on attempt ${attempts}`);
      }
    }
    
    if (attempts >= MAX_FALLBACK_ATTEMPTS) break;
  }

  const elapsed = Date.now() - startTime;
  console.log(`[FastExtract] All attempts failed for channel ${channelId} after ${elapsed}ms`);
  return null;
}

/**
 * Get stats for debugging
 */
export function getCacheStats(): { serverMapSize: number; totalServers: number; totalDomains: number } {
  return {
    serverMapSize: Object.keys(SERVER_MAP).length,
    totalServers: ALL_SERVERS.length,
    totalDomains: BACKEND_DOMAINS.length,
  };
}

/**
 * Check if a channel exists in the server map (static check only).
 * For dynamic check, use lookupServer() which queries the live API.
 */
export function channelExists(channelId: number): boolean {
  return SERVER_MAP[channelId] !== undefined;
}

/**
 * Check if a channel exists (dynamic + static).
 * Tries live API first, then falls back to static map.
 */
export async function channelExistsDynamic(channelId: number): Promise<boolean> {
  if (SERVER_MAP[channelId] !== undefined) return true;
  const server = await lookupServer(channelId);
  return server !== null;
}

/**
 * Get all valid channel IDs
 */
export function getAllChannels(): number[] {
  return Object.keys(SERVER_MAP).map(Number).sort((a, b) => a - b);
}

/**
 * Get all available servers (INTERNAL USE ONLY)
 * WARNING: Do not expose this list in public API responses
 */
export function getAllServers(): readonly string[] {
  return ALL_SERVERS;
}

/**
 * Get all available domains (INTERNAL USE ONLY)
 * WARNING: Do not expose this list in public API responses
 */
export function getAllDomains(): readonly string[] {
  return BACKEND_DOMAINS;
}


/**
 * Generate auth token for a channel (V5 EPlayerAuth)
 * 
 * This fetches the authToken from the player page which is MUCH faster
 * than hitsplay.fun (~300ms vs ~14000ms).
 * 
 * The authToken is a pipe-delimited string:
 * channelKey|country|timestamp|expiry|signature
 * 
 * @param channelId - Channel ID (e.g., "51")
 * @returns Object with token and channelKey
 */
export async function generateJWT(channelId: string): Promise<{ token: string; channelKey: string; channelSalt?: string }> {
  const chNum = parseInt(channelId, 10);
  const channelKey = `premium${chNum}`;
  
  // Fetch auth data from player page (ksohls.ru primary, enviromentalspace.sbs fallback)
  const authData = await fetchAuthData(channelId);
  
  if (authData && authData.authToken) {
    console.log(`[generateJWT] Got V5 auth token for channel ${channelId}`);
    return {
      token: authData.authToken,
      channelKey: authData.channelKey || channelKey,
      channelSalt: authData.channelSalt, // CRITICAL: Pass channelSalt for key fetching
    };
  }
  
  // Fallback: Generate a minimal token if fetch fails
  // This won't work for key fetching but allows M3U8 to be fetched
  console.log(`[generateJWT] Auth fetch failed, using fallback token for channel ${channelId}`);
  const timestamp = Math.floor(Date.now() / 1000);
  const expiry = timestamp + 86400; // 24 hours
  const fallbackToken = `${channelKey}|US|${timestamp}|${expiry}|fallback`;
  
  return {
    token: fallbackToken,
    channelKey,
  };
}

/**
 * Get the server lookup cache stats for debugging
 */
export function getLookupCacheStats(): { size: number; entries: Array<{ channel: number; server: string; expiresIn: number }> } {
  const now = Date.now();
  const entries: Array<{ channel: number; server: string; expiresIn: number }> = [];
  for (const [ch, val] of serverLookupCache.entries()) {
    entries.push({ channel: ch, server: val.server, expiresIn: Math.max(0, val.expires - now) });
  }
  return { size: serverLookupCache.size, entries: entries.slice(0, 20) };
}
