/**
 * HiAnime Extraction + Stream Proxy
 * 
 * ALL extraction and decryption happens HERE on the Cloudflare Worker.
 * The frontend just calls /hianime/extract and gets back proxied HLS URLs.
 * 
 * Routes:
 *   GET /hianime/extract?malId=X&title=Y&episode=Z  - Full extraction pipeline
 *   GET /hianime/stream?url=<encoded_url>            - Proxy HLS stream/segment
 *   GET /hianime/health                              - Health check
 * 
 * Extraction pipeline:
 *   1. Search HiAnime by title → match MAL ID via syncData
 *   2. Get episode list → find target episode
 *   3. Get servers → pick VidStreaming (serverId=4) for sub/dub
 *   4. Get source link → MegaCloud embed URL
 *   5. Extract client key from embed page
 *   6. Fetch megacloud decryption key from GitHub
 *   7. Call getSources v3 → decrypt if encrypted
 *   8. Return proxied HLS URLs + subtitles + skip markers
 * 
 * Pure fetch + local decryption. No external dependencies.
 */

import { createLogger, type LogLevel } from './logger';
import {
  corsHeaders,
  jsonResponse,
  rewritePlaylistUrls as sharedRewritePlaylistUrls,
  buildStreamResponse,
  buildStreamResponseFromFetch,
} from './shared';

export interface Env {
  LOG_LEVEL?: string;
  RPI_PROXY_URL?: string;
  RPI_PROXY_KEY?: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const HIANIME_DOMAIN = 'aniwatchtv.to';
// Multiple key sources for resilience — try each in order
const MEGACLOUD_KEYS_URLS = [
  'https://raw.githubusercontent.com/yogesh-hacker/MegacloudKeys/refs/heads/main/keys.json',
  'https://raw.githubusercontent.com/CattoFish/MegacloudKeys/refs/heads/main/keys.json',
  'https://raw.githubusercontent.com/ghoshRitesh12/aniwatch/refs/heads/main/src/extractors/megacloud-keys.json',
];

// ============================================================================
// Retry Utility
// ============================================================================

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<Response> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      
      // Don't retry on 4xx errors (client errors)
      if (response.status >= 400 && response.status < 500) {
        return response;
      }
      
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error as Error;
    }
    
    // Exponential backoff: 1s, 2s, 4s
    if (attempt < maxRetries - 1) {
      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError || new Error('Fetch failed after retries');
}

// ============================================================================
// MegaCloud Decryption Engine (pure JS, no dependencies)
// ============================================================================

function keygen2(megacloudKey: string, clientKey: string): string {
  const keygenHashMultVal = 31n;
  const keygenXORVal = 247;
  const keygenShiftVal = 5;
  let tempKey = megacloudKey + clientKey;

  let hashVal = 0n;
  for (let i = 0; i < tempKey.length; i++) {
    hashVal = BigInt(tempKey.charCodeAt(i)) + hashVal * keygenHashMultVal + (hashVal << 7n) - hashVal;
  }
  hashVal = hashVal < 0n ? -hashVal : hashVal;
  const lHash = Number(hashVal % 0x7fffffffffffffffn);

  tempKey = tempKey.split('').map(c => String.fromCharCode(c.charCodeAt(0) ^ keygenXORVal)).join('');
  const pivot = (lHash % tempKey.length) + keygenShiftVal;
  tempKey = tempKey.slice(pivot) + tempKey.slice(0, pivot);

  const leafStr = clientKey.split('').reverse().join('');
  let returnKey = '';
  for (let i = 0; i < Math.max(tempKey.length, leafStr.length); i++) {
    returnKey += (tempKey[i] || '') + (leafStr[i] || '');
  }
  returnKey = returnKey.substring(0, 96 + (lHash % 33));
  returnKey = [...returnKey].map(c => String.fromCharCode((c.charCodeAt(0) % 95) + 32)).join('');
  return returnKey;
}

function seedShuffle2(charArray: string[], iKey: string): string[] {
  let hashVal = 0n;
  for (let i = 0; i < iKey.length; i++) {
    hashVal = (hashVal * 31n + BigInt(iKey.charCodeAt(i))) & 0xffffffffn;
  }
  let shuffleNum = hashVal;
  const psudoRand = (arg: number) => {
    shuffleNum = (shuffleNum * 1103515245n + 12345n) & 0x7fffffffn;
    return Number(shuffleNum % BigInt(arg));
  };
  const retStr = [...charArray];
  for (let i = retStr.length - 1; i > 0; i--) {
    const swapIndex = psudoRand(i + 1);
    [retStr[i], retStr[swapIndex]] = [retStr[swapIndex], retStr[i]];
  }
  return retStr;
}

function columnarCipher2(src: string, ikey: string): string {
  const columnCount = ikey.length;
  const rowCount = Math.ceil(src.length / columnCount);
  const cipherArry = Array(rowCount).fill(null).map(() => Array(columnCount).fill(' '));
  const keyMap = ikey.split('').map((char, index) => ({ char, idx: index }));
  const sortedMap = [...keyMap].sort((a, b) => a.char.charCodeAt(0) - b.char.charCodeAt(0));

  let srcIndex = 0;
  sortedMap.forEach(({ idx: index }) => {
    for (let i = 0; i < rowCount; i++) {
      cipherArry[i][index] = src[srcIndex++];
    }
  });

  let returnStr = '';
  for (let x = 0; x < rowCount; x++) {
    for (let y = 0; y < columnCount; y++) {
      returnStr += cipherArry[x][y];
    }
  }
  return returnStr;
}

function decryptSrc2(src: string, clientKey: string, megacloudKey: string): string {
  const layers = 3;
  const genKey = keygen2(megacloudKey, clientKey);
  let decSrc = atob(src);
  const charArray = [...Array(95)].map((_, index) => String.fromCharCode(32 + index));

  const reverseLayer = (iteration: number) => {
    const layerKey = genKey + iteration;
    let hashVal = 0n;
    for (let i = 0; i < layerKey.length; i++) {
      hashVal = (hashVal * 31n + BigInt(layerKey.charCodeAt(i))) & 0xffffffffn;
    }
    let seed = hashVal;
    const seedRand = (arg: number) => {
      seed = (seed * 1103515245n + 12345n) & 0x7fffffffn;
      return Number(seed % BigInt(arg));
    };

    decSrc = decSrc.split('').map((char) => {
      const cArryIndex = charArray.indexOf(char);
      if (cArryIndex === -1) return char;
      const randNum = seedRand(95);
      const newCharIndex = (cArryIndex - randNum + 95) % 95;
      return charArray[newCharIndex];
    }).join('');

    decSrc = columnarCipher2(decSrc, layerKey);
    const subValues = seedShuffle2(charArray, layerKey);
    const charMap: Record<string, string> = {};
    subValues.forEach((char, index) => { charMap[char] = charArray[index]; });
    decSrc = decSrc.split('').map(char => charMap[char] || char).join('');
  };

  for (let i = layers; i > 0; i--) {
    reverseLayer(i);
  }
  const dataLen = parseInt(decSrc.substring(0, 4), 10);
  return decSrc.substring(4, 4 + dataLen);
}

// ============================================================================
// MegaCloud Client Key Extraction
// ============================================================================

async function getMegaCloudClientKey(sourceId: string): Promise<string> {
  // Route through RPI — CF Worker IPs are blocked by MegaCloud
  const res = await rpiFetch(`https://megacloud.blog/embed-2/v3/e-1/${sourceId}`, {
    'User-Agent': UA, 'Referer': `https://${HIANIME_DOMAIN}/`,
  });
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`MegaCloud embed page returned HTTP ${res.status} (size: ${text.length})`);
  }

  const regexes = [
    /<meta name="_gg_fb" content="[a-zA-Z0-9]+">/,
    /<!--\s+_is_th:[0-9a-zA-Z]+\s+-->/,
    /<script>window\._lk_db\s+=\s+\{[xyz]:\s+["'][a-zA-Z0-9]+["'],\s+[xyz]:\s+["'][a-zA-Z0-9]+["'],\s+[xyz]:\s+["'][a-zA-Z0-9]+["']\};<\/script>/,
    /<div\s+data-dpi="[0-9a-zA-Z]+"\s+.*><\/div>/,
    /<script nonce="[0-9a-zA-Z]+">/,
    /<script>window\._xy_ws = ['"`][0-9a-zA-Z]+['"`];<\/script>/,
  ];
  const keyRegex = /"[a-zA-Z0-9]+"/;
  const lkDbRegex = [/x:\s+"[a-zA-Z0-9]+"/, /y:\s+"[a-zA-Z0-9]+"/, /z:\s+"[a-zA-Z0-9]+"/];

  let pass: RegExpMatchArray | null = null;
  let count = 0;
  for (let i = 0; i < regexes.length; i++) {
    pass = text.match(regexes[i]);
    if (pass !== null) { count = i; break; }
  }
  if (!pass) throw new Error('Failed extracting MegaCloud client key');

  let clientKey = '';
  if (count === 2) {
    const x = pass[0].match(lkDbRegex[0]);
    const y = pass[0].match(lkDbRegex[1]);
    const z = pass[0].match(lkDbRegex[2]);
    if (!x || !y || !z) throw new Error('Failed building client key (xyz)');
    const p1 = x[0].match(keyRegex), p2 = y[0].match(keyRegex), p3 = z[0].match(keyRegex);
    if (!p1 || !p2 || !p3) throw new Error('Failed building client key (xyz)');
    clientKey = p1[0].replace(/"/g, '') + p2[0].replace(/"/g, '') + p3[0].replace(/"/g, '');
  } else if (count === 1) {
    const keytest = pass[0].match(/:[a-zA-Z0-9]+ /);
    if (!keytest) throw new Error('Failed extracting client key (comment)');
    clientKey = keytest[0].replace(/:/g, '').replace(/ /g, '');
  } else {
    const keytest = pass[0].match(keyRegex);
    if (!keytest) throw new Error('Failed extracting client key');
    clientKey = keytest[0].replace(/"/g, '');
  }
  return clientKey;
}

async function getMegaCloudKey(): Promise<string> {
  const errors: string[] = [];
  for (const url of MEGACLOUD_KEYS_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        errors.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      const keys = await res.json() as Record<string, string>;
      const key = keys.mega || keys.key || Object.values(keys)[0];
      if (key && typeof key === 'string' && key.length > 0) {
        return key;
      }
      errors.push(`${url}: no valid key in response (keys: ${Object.keys(keys).join(',')})`);
    } catch (e) {
      errors.push(`${url}: ${(e as Error).message}`);
    }
  }
  throw new Error(`Failed to fetch MegaCloud key from all sources: ${errors.join('; ')}`);
}

// ============================================================================
// RPI Proxy Helper — route requests through residential IP
// HiAnime blocks CF Worker IPs (Cloudflare challenge), so we route scraping
// calls through the RPI proxy's /hianime/stream endpoint which has a residential IP.
// ============================================================================

let _rpiConfig: { baseUrl: string; key: string } | null = null;

function setRpiConfig(env: Env): void {
  if (env.RPI_PROXY_URL && env.RPI_PROXY_KEY) {
    let baseUrl = env.RPI_PROXY_URL;
    if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
      baseUrl = `https://${baseUrl}`;
    }
    _rpiConfig = { baseUrl: baseUrl.replace(/\/+$/, ''), key: env.RPI_PROXY_KEY };
  }
}

/**
 * Fetch a URL — Races CF-direct against RPI proxy.
 *
 * CF-direct is tried first with a short 2s timeout (pirate sites block
 * datacenter IPs so CF-direct almost never works for extraction). RPI is
 * fired simultaneously when configured and wins the race for blocked sites.
 */
async function rpiFetch(url: string, headers: Record<string, string> = {}): Promise<Response> {
  // Fire CF-direct with a short fuse — if the site is reachable from CF
  // (rare for pirate sites), we get a fast win. Otherwise RPI takes over.
  const directPromise = fetch(url, { headers, signal: AbortSignal.timeout(2000) });

  if (!_rpiConfig) {
    // No RPI configured — CF-direct is the only path
    try {
      const directRes = await directPromise;
      if (directRes.ok) return directRes;
      console.log(`[rpiFetch] Direct fetch returned ${directRes.status}, no RPI fallback available`);
    } catch (e) {
      console.log(`[rpiFetch] Direct fetch error (no RPI): ${(e as Error).message}`);
    }
    // One more attempt with longer timeout
    return fetch(url, { headers, signal: AbortSignal.timeout(12000) });
  }

  // Race CF-direct against RPI. RPI typically wins for pirate sites since
  // CF-direct either hangs (TCP timeout) or returns 403/503.
  const rpiParams = new URLSearchParams({ url, key: _rpiConfig.key });
  if (headers['User-Agent']) rpiParams.set('ua', headers['User-Agent']);
  const rpiUrl = `${_rpiConfig.baseUrl}/hianime/stream?${rpiParams.toString()}`;
  const rpiPromise = fetch(rpiUrl, { signal: AbortSignal.timeout(20000) });

  try {
    const winner = await Promise.race([
      directPromise.then(r => r.ok ? r : Promise.reject(`direct_${r.status}`)),
      rpiPromise.then(r => r.ok ? r : Promise.reject(`rpi_${r.status}`)),
    ]);
    console.log(`[rpiFetch] Race winner: ${winner.url?.substring(0, 40) || 'unknown'}`);
    return winner;
  } catch (e) {
    const errMsg = (e as Error).message || String(e);
    console.log(`[rpiFetch] Race failed (${errMsg}), awaiting RPI...`);
    // Both failed — wait for RPI as last resort (it may still succeed)
    try {
      const rpiRes = await rpiPromise.catch(() => null);
      if (rpiRes && rpiRes.ok) return rpiRes;
    } catch {}
    // Absolute last resort: direct with longer timeout
    console.log(`[rpiFetch] All strategies failed, final direct attempt`);
    return fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  }
}

// ============================================================================
// HiAnime API (pure fetch via RPI proxy, regex HTML parsing)
// ============================================================================

async function hianimeSearch(query: string): Promise<Array<{ id: string; name: string; hianimeId: string | null }>> {
  // Use AJAX search suggestion endpoint — the /search page requires JS rendering
  // Use + for spaces instead of %20 — rpiFetch goes through URLSearchParams + decodeURIComponent
  // on the RPI proxy, which double-decodes %20 into literal spaces (breaking the URL).
  const searchUrl = `https://${HIANIME_DOMAIN}/ajax/search/suggest?keyword=${query.replace(/ /g, '+')}`;
  console.log(`[hianimeSearch] Searching: ${searchUrl}`);
  const res = await rpiFetch(
    searchUrl,
    { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Referer': `https://${HIANIME_DOMAIN}/` },
  );
  const results: Array<{ id: string; name: string; hianimeId: string | null }> = [];

  try {
    // Read as text first then parse — res.json() fails silently on octet-stream responses
    const rawText = await res.text();
    console.log(`[hianimeSearch] Raw response: ${rawText.length} bytes, starts: ${rawText.substring(0, 50)}`);
    const json = JSON.parse(rawText) as { status: boolean; html: string };
    console.log(`[hianimeSearch] JSON status: ${json.status}, html length: ${json.html?.length || 0}`);
    if (!json.status || !json.html) return results;

    // Parse suggestion results — links like <a href="/one-punch-man-63?ref=search">
    const itemRegex = /<a[^>]*href="\/([^"?]+)(?:\?[^"]*)?"[^>]*class="[^"]*nav-item[^"]*"[^>]*>/g;
    const nameRegex = /<h3[^>]*class="[^"]*film-name[^"]*"[^>]*>([^<]*)<\/h3>/g;
    
    // Extract all links first
    const links: string[] = [];
    let linkMatch;
    while ((linkMatch = itemRegex.exec(json.html)) !== null) {
      links.push(linkMatch[1]);
    }
    
    // Extract all names
    const names: string[] = [];
    let nameMatch;
    while ((nameMatch = nameRegex.exec(json.html)) !== null) {
      names.push(nameMatch[1].trim());
    }

    for (let i = 0; i < links.length; i++) {
      const id = links[i];
      const name = names[i] || id;
      const numId = id.match(/-(\d+)$/)?.[1] || null;
      results.push({ id, name, hianimeId: numId });
    }
  } catch {
    // Fallback: try parsing as HTML search page
    const html = typeof res.body === 'string' ? res.body : '';
    const itemRegex = /<a[^>]*href="\/([^"?]+)"[^>]*class="[^"]*dynamic-name[^"]*"[^>]*data-jname="([^"]*)"[^>]*>([^<]*)<\/a>/g;
    let match;
    while ((match = itemRegex.exec(html)) !== null) {
      const id = match[1];
      const name = match[3].trim();
      const numId = id.match(/-(\d+)$/)?.[1] || null;
      results.push({ id, name, hianimeId: numId });
    }
  }
  return results;
}

async function getHiAnimeMalId(animeSlug: string): Promise<number | null> {
  const res = await rpiFetch(
    `https://${HIANIME_DOMAIN}/${animeSlug}`,
    { 'User-Agent': UA },
  );
  const html = await res.text();
  console.log(`[getHiAnimeMalId] ${animeSlug}: status=${res.status}, size=${html.length}, hasSyncData=${html.includes('syncData')}`);
  // Try both <script> (current) and <div> (legacy) patterns for syncData
  const syncMatch = html.match(/<script[^>]*id="syncData"[^>]*>([\s\S]*?)<\/script>/) ||
                    html.match(/<div[^>]*id="syncData"[^>]*>([^<]*)<\/div>/);
  if (!syncMatch) {
    console.log(`[getHiAnimeMalId] ${animeSlug}: No syncData found`);
    return null;
  }
  try {
    const syncData = JSON.parse(syncMatch[1]);
    console.log(`[getHiAnimeMalId] ${animeSlug}: mal_id=${syncData.mal_id}`);
    return syncData.mal_id ? parseInt(syncData.mal_id) : null;
  } catch (e) {
    console.log(`[getHiAnimeMalId] ${animeSlug}: JSON parse error: ${(e as Error).message}`);
    return null;
  }
}

interface HiAnimeEpisode { number: number; dataId: string; href: string; }
interface HiAnimeServer { dataId: string; type: 'sub' | 'dub' | 'raw'; serverId: string; }

async function getEpisodeList(animeId: string): Promise<HiAnimeEpisode[]> {
  const res = await rpiFetch(
    `https://${HIANIME_DOMAIN}/ajax/v2/episode/list/${animeId}`,
    { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Referer': `https://${HIANIME_DOMAIN}/` },
  );
  const json = await res.json() as { html: string };
  const episodes: HiAnimeEpisode[] = [];
  const epRegex = /<a[^>]*data-number="(\d+)"[^>]*data-id="(\d+)"[^>]*href="([^"]*)"[^>]*>/g;
  let m;
  while ((m = epRegex.exec(json.html)) !== null) {
    episodes.push({ number: parseInt(m[1]), dataId: m[2], href: m[3] });
  }
  return episodes;
}

async function getServers(episodeId: string): Promise<HiAnimeServer[]> {
  const res = await rpiFetch(
    `https://${HIANIME_DOMAIN}/ajax/v2/episode/servers?episodeId=${episodeId}`,
    { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Referer': `https://${HIANIME_DOMAIN}/` },
  );
  const json = await res.json() as { html: string };
  const servers: HiAnimeServer[] = [];
  // Attributes span multiple lines — use [\s\S] to match across newlines
  const serverRegex = /<div[\s\S]*?class="[^"]*server-item[^"]*"[\s\S]*?>/g;
  let m;
  while ((m = serverRegex.exec(json.html)) !== null) {
    const block = m[0];
    const dataId = block.match(/data-id="(\d+)"/)?.[1];
    const type = block.match(/data-type="(sub|dub|raw)"/)?.[1] as 'sub' | 'dub' | 'raw' | undefined;
    const serverId = block.match(/data-server-id="(\d+)"/)?.[1];
    if (dataId && type && serverId) servers.push({ dataId, type, serverId });
  }
  return servers;
}

async function getSourceLink(serverId: string): Promise<string | null> {
  const res = await rpiFetch(
    `https://${HIANIME_DOMAIN}/ajax/v2/episode/sources?id=${serverId}`,
    { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Referer': `https://${HIANIME_DOMAIN}/` },
  );
  const json = await res.json() as { link?: string };
  return json.link || null;
}

// ============================================================================
// MegaCloud Stream Extraction
// ============================================================================

interface MegaCloudSource { file: string; type: string; }
interface MegaCloudTrack { file: string; kind: string; label?: string; default?: boolean; }
interface MegaCloudResult {
  sources: Array<{ url: string; type: string }>;
  subtitles: Array<{ url: string; lang: string; default: boolean }>;
  intro: { start: number; end: number };
  outro: { start: number; end: number };
}

async function extractMegaCloudStream(embedUrl: string): Promise<MegaCloudResult> {
  const url = new URL(embedUrl);
  const sourceId = url.pathname.split('/').pop()!;

  // Step 1: Get client key from embed page (route through RPI — CF IPs blocked)
  const clientKey = await getMegaCloudClientKey(sourceId);

  // Step 2: Fetch sources (route through RPI)
  const srcRes = await rpiFetch(
    `https://megacloud.blog/embed-2/v3/e-1/getSources?id=${sourceId}&_k=${clientKey}`,
    { 'User-Agent': UA, 'Referer': embedUrl }
  );
  const srcText = await srcRes.text();
  console.log(`[MegaCloud] getSources response: ${srcText.length} bytes`);
  const srcData = JSON.parse(srcText) as {
    sources: string | MegaCloudSource[];
    tracks?: MegaCloudTrack[];
    encrypted?: boolean;
    intro?: { start: number; end: number };
    outro?: { start: number; end: number };
  };

  let sources: MegaCloudSource[];
  if (!srcData.encrypted && Array.isArray(srcData.sources)) {
    // Unencrypted — no key needed (current MegaCloud behavior as of Mar 2026)
    sources = srcData.sources;
    console.log(`[MegaCloud] Sources unencrypted: ${sources.length} streams`);
  } else {
    // Encrypted — need MegaCloud key for decryption
    console.log(`[MegaCloud] Sources encrypted, fetching key...`);
    const megacloudKey = await getMegaCloudKey();
    const decrypted = decryptSrc2(srcData.sources as string, clientKey, megacloudKey);
    sources = JSON.parse(decrypted);
  }

  const subtitles = (srcData.tracks || [])
    .filter(t => t.kind === 'captions')
    .map(t => ({ url: t.file, lang: t.label || t.kind, default: t.default || false }));

  return {
    sources: sources.map(s => ({ url: s.file, type: s.type })),
    subtitles,
    intro: srcData.intro || { start: 0, end: 0 },
    outro: srcData.outro || { start: 0, end: 0 },
  };
}

// ============================================================================
// Find anime on HiAnime by MAL ID
// ============================================================================

async function findHiAnimeByMalId(
  malId: number,
  title: string,
): Promise<{ hianimeId: string; slug: string } | null> {
  // Try original title first
  let results = await hianimeSearch(title);
  console.log(`[findHiAnimeByMalId] Search "${title}" returned ${results.length} results`);
  
  // If no results, try with common title variations
  if (results.length === 0) {
    const cleanTitle = title
      .replace(/\s*\(TV\)\s*/gi, '')
      .replace(/\s*Season\s*\d+\s*/gi, '')
      .replace(/\s*\d+(?:st|nd|rd|th)\s+Season\s*/gi, '')
      .trim();
    if (cleanTitle !== title) {
      results = await hianimeSearch(cleanTitle);
      console.log(`[findHiAnimeByMalId] Clean search "${cleanTitle}" returned ${results.length} results`);
    }
  }

  // Check each result's syncData for MAL ID match
  for (const result of results.slice(0, 8)) {
    console.log(`[findHiAnimeByMalId] Checking ${result.id} (hianimeId: ${result.hianimeId})...`);
    const malIdFromPage = await getHiAnimeMalId(result.id);
    console.log(`[findHiAnimeByMalId] ${result.id} → MAL ID: ${malIdFromPage} (looking for ${malId})`);
    if (malIdFromPage === malId) {
      return { hianimeId: result.hianimeId!, slug: result.id };
    }
  }
  // Fallback: single result
  if (results.length === 1 && results[0].hianimeId) {
    return { hianimeId: results[0].hianimeId, slug: results[0].id };
  }
  return null;
}

// ============================================================================
// Helpers
// ============================================================================

/** Local wrapper that injects /hianime/stream as proxy path */
function rewritePlaylistUrls(playlist: string, baseUrl: string, proxyOrigin: string): string {
  return sharedRewritePlaylistUrls(playlist, baseUrl, proxyOrigin, '/hianime/stream');
}

// ============================================================================
// Request Handler
// ============================================================================

export async function handleHiAnimeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const logLevel = (env.LOG_LEVEL || 'info') as LogLevel;
  const logger = createLogger(request, logLevel);

  // Initialize RPI proxy config for this request
  setRpiConfig(env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // Health check
  if (path === '/hianime/health' || path.endsWith('/health')) {
    const hasRpi = !!(env.RPI_PROXY_URL && env.RPI_PROXY_KEY);
    return jsonResponse({
      status: 'ok',
      provider: 'hianime',
      rpiProxy: {
        configured: hasRpi,
        url: env.RPI_PROXY_URL ? env.RPI_PROXY_URL.substring(0, 30) + '...' : 'not set',
      },
      rpiConfigSet: !!_rpiConfig,
      timestamp: new Date().toISOString(),
    }, 200);
  }

  // Debug endpoint — test rpiFetch directly
  if (path === '/hianime/debug') {
    setRpiConfig(env);
    // Use query param keyword or default, and optionally mirror hianimeSearch headers
    const keyword = url.searchParams.get('q') || 'Solo+Leveling';
    const useAjax = url.searchParams.get('ajax') === '1';
    const testUrl = `https://${HIANIME_DOMAIN}/ajax/search/suggest?keyword=${keyword}`;
    const testHeaders: Record<string, string> = { 'User-Agent': UA };
    if (useAjax) {
      testHeaders['X-Requested-With'] = 'XMLHttpRequest';
      testHeaders['Referer'] = `https://${HIANIME_DOMAIN}/`;
    }
    try {
      const res = await rpiFetch(testUrl, testHeaders);
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { /* not json */ }
      return jsonResponse({
        rpiConfigSet: !!_rpiConfig,
        fetchStatus: res.status,
        contentType: res.headers.get('content-type'),
        size: text.length,
        isJson: parsed !== null,
        hasHtml: typeof (parsed as { html?: string })?.html === 'string',
        htmlLength: (parsed as { html?: string })?.html?.length || 0,
        first200: text.substring(0, 200),
        // Also test hianimeSearch directly
        searchResults: await hianimeSearch(keyword.replace(/\+/g, ' ')),
      }, 200);
    } catch (e) {
      return jsonResponse({ error: (e as Error).message, rpiConfigSet: !!_rpiConfig }, 500);
    }
  }

  // ── EXTRACT endpoint ──────────────────────────────────────────────
  if (path === '/hianime/extract') {
    const malId = url.searchParams.get('malId');
    const title = url.searchParams.get('title');
    const episode = url.searchParams.get('episode');

    if (!malId || !title) {
      return jsonResponse({
        error: 'Missing parameters',
        usage: '/hianime/extract?malId=<mal_id>&title=<anime_title>&episode=<number>',
      }, 400);
    }

    logger.info('HiAnime extract request', { malId, title, episode });
    const startTime = Date.now();

    try {
      // Step 1: Find anime
      logger.info('Step 1: Searching HiAnime', { malId, title });
      const anime = await findHiAnimeByMalId(parseInt(malId), title);
      if (!anime) {
        // Debug: also return search results for troubleshooting
        const debugResults = await hianimeSearch(title);
        return jsonResponse({ 
          success: false, 
          error: `Anime not found on HiAnime (searched: "${title}", malId: ${malId})`,
          debug: {
            searchResults: debugResults.map(r => ({ id: r.id, name: r.name, hianimeId: r.hianimeId })),
            rpiConfigured: !!_rpiConfig,
          },
        }, 404);
      }
      logger.info('Found anime', { hianimeId: anime.hianimeId, slug: anime.slug });

      // Step 2: Get episodes
      logger.info('Step 2: Getting episode list', { hianimeId: anime.hianimeId });
      const episodes = await getEpisodeList(anime.hianimeId);
      const targetEp = episode ? parseInt(episode) : 1;
      const ep = episodes.find(e => e.number === targetEp);
      if (!ep) {
        return jsonResponse({
          success: false,
          error: `Episode ${targetEp} not found (${episodes.length} episodes available)`,
        }, 404);
      }
      logger.info('Found episode', { targetEp, dataId: ep.dataId, totalEpisodes: episodes.length });

      // Step 3: Get servers
      logger.info('Step 3: Getting servers', { episodeDataId: ep.dataId });
      const servers = await getServers(ep.dataId);
      logger.info('Found servers', { 
        count: servers.length, 
        types: servers.map(s => `${s.type}:srv${s.serverId}`).join(', ') 
      });
      
      const subServer = servers.find(s => s.type === 'sub' && s.serverId === '4')
        || servers.find(s => s.type === 'sub');
      const dubServer = servers.find(s => s.type === 'dub' && s.serverId === '4')
        || servers.find(s => s.type === 'dub');

      if (!subServer && !dubServer) {
        return jsonResponse({
          success: false,
          error: `No sub or dub servers found (${servers.length} servers: ${servers.map(s => `${s.type}:srv${s.serverId}`).join(', ')})`,
        }, 404);
      }

      // Step 4: Extract streams (sub + dub in parallel)
      logger.info('Step 4: Extracting streams', { 
        sub: subServer ? `srv${subServer.serverId}` : 'none',
        dub: dubServer ? `srv${dubServer.serverId}` : 'none',
      });
      const extractStream = async (server: HiAnimeServer | undefined, label: string) => {
        if (!server) return null;
        try {
          const link = await getSourceLink(server.dataId);
          if (!link) {
            logger.warn(`No source link for ${label} server`, { dataId: server.dataId });
            return null;
          }
          logger.info(`Extracting ${label} stream from MegaCloud`, { embedUrl: link.substring(0, 80) });
          const result = await extractMegaCloudStream(link);
          logger.info(`${label} extraction success`, { sources: result.sources.length, subtitles: result.subtitles.length });
          return { label, ...result };
        } catch (e) {
          logger.error(`${label} extraction failed`, e as Error);
          return null;
        }
      };

      const [subResult, dubResult] = await Promise.all([
        extractStream(subServer, 'sub'),
        extractStream(dubServer, 'dub'),
      ]);

      // Step 5: Build response with proxied URLs
      const proxyOrigin = url.origin;
      interface SourceEntry {
        quality: string;
        title: string;
        url: string;
        type: 'hls';
        language: string;
        skipIntro?: [number, number];
        skipOutro?: [number, number];
      }
      const sources: SourceEntry[] = [];
      const allSubtitles: Array<{ label: string; url: string; language: string }> = [];

      for (const result of [subResult, dubResult]) {
        if (!result) continue;
        for (const src of result.sources) {
          // Proxy the m3u8 URL through our /hianime/stream endpoint
          // This rewrites playlist URLs so segments also go through the proxy
          const proxiedUrl = `${proxyOrigin}/hianime/stream?url=${encodeURIComponent(src.url)}`;
          sources.push({
            quality: 'auto',
            title: `HiAnime (${result.label === 'sub' ? 'Sub' : 'Dub'})`,
            url: proxiedUrl,
            type: 'hls',
            language: result.label === 'sub' ? 'ja' : 'en',
            skipIntro: result.intro.end > 0 ? [result.intro.start, result.intro.end] : undefined,
            skipOutro: result.outro.end > 0 ? [result.outro.start, result.outro.end] : undefined,
          });
        }
        if (result.label === 'sub') {
          for (const sub of result.subtitles) {
            allSubtitles.push({ label: sub.lang, url: sub.url, language: sub.lang });
          }
        }
      }

      const elapsed = Date.now() - startTime;
      logger.info('Extraction complete', { sources: sources.length, subtitles: allSubtitles.length, elapsed });

      return jsonResponse({
        success: sources.length > 0,
        sources,
        subtitles: allSubtitles,
        provider: 'hianime',
        totalEpisodes: episodes.length,
        executionTime: elapsed,
      }, sources.length > 0 ? 200 : 404);

    } catch (error) {
      const err = error as Error;
      logger.error('HiAnime extraction error', err);
      return jsonResponse({
        success: false,
        error: err.message || 'Extraction failed',
        executionTime: Date.now() - startTime,
      }, 500);
    }
  }

  // ── STREAM proxy endpoint ─────────────────────────────────────────
  // MegaCloud CDN is behind Cloudflare. CF Workers can often fetch
  // Cloudflare-protected sites directly (intra-network). Try direct first,
  // then fall back to RPI residential proxy.
  // Flow: Client → CF Worker → MegaCloud CDN (direct) or → RPI → CDN
  if (path === '/hianime/stream') {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return jsonResponse({ error: 'Missing url parameter' }, 400);
    }

    // searchParams.get() already decodes the URL — do NOT double-decode
    const decodedUrl = targetUrl;
    const proxyOrigin = url.origin;
    logger.debug('HiAnime stream proxy', { url: decodedUrl.substring(0, 100) });

    const hasRpi = !!(env.RPI_PROXY_URL && env.RPI_PROXY_KEY);

    // All HiAnime stream URLs are CDN URLs that need megacloud.blog headers.
    // Domains rotate constantly (stormshade84, windytrail24, etc.) so match broadly.
    const isMegaCloudCdn = true;

    // Build RPI base URL once for reuse across strategies
    let rpiBaseUrl = '';
    if (hasRpi) {
      rpiBaseUrl = env.RPI_PROXY_URL!;
      if (!rpiBaseUrl.startsWith('http://') && !rpiBaseUrl.startsWith('https://')) {
        rpiBaseUrl = `https://${rpiBaseUrl}`;
      }
      rpiBaseUrl = rpiBaseUrl.replace(/\/+$/, '');
    }

    // Strategy 1: Direct fetch from CF Worker (intra-Cloudflare network)
    // MegaCloud CDN requires Referer+Origin headers from megacloud.blog — without them → 403
    let strategy1Status = 0;
    let strategy2Status = 0;
    let strategy3Status = 0;
    try {
      // Always send megacloud.blog Referer/Origin — required by all HiAnime CDN domains
      // (stormshade, netmagcdn, and classic _v7/_v8 CDN paths)
      const fetchHeaders: Record<string, string> = {
        'User-Agent': UA,
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
        'Referer': 'https://megacloud.blog/',
        'Origin': 'https://megacloud.blog',
      };
      const response = await fetch(decodedUrl, {
        headers: fetchHeaders,
        signal: AbortSignal.timeout(10000),
      });
      strategy1Status = response.status;

      if (response.ok) {
        return await buildStreamResponseFromFetch(response, decodedUrl, proxyOrigin, '/hianime/stream', 'cf-direct');
      }
      logger.warn('Direct fetch failed', { status: response.status });
      // Fall through to RPI
    } catch (error) {
      logger.warn('Direct fetch error, trying RPI', { error: (error as Error).message });
      strategy1Status = -1;
    }

    // Strategy 2: RPI residential proxy fallback
    if (hasRpi) {
      try {
        const rpiParams = new URLSearchParams({
          url: decodedUrl,
          key: env.RPI_PROXY_KEY!,
        });
        const rpiUrl = `${rpiBaseUrl}/hianime/stream?${rpiParams.toString()}`;
        logger.debug('Forwarding to RPI /hianime/stream', { rpiUrl: rpiUrl.substring(0, 80) });

        console.log(`[HiAnime Stream] Strategy 2 RPI URL: ${rpiUrl.substring(0, 150)}`);
        const rpiResponse = await fetchWithRetry(rpiUrl, {
          signal: AbortSignal.timeout(isMegaCloudCdn ? 20000 : 45000),
        }, isMegaCloudCdn ? 2 : 3, 1000); // Fewer retries for CDN to fail fast to Strategy 3
        strategy2Status = rpiResponse.status;

        if (rpiResponse.ok) {
          return await buildStreamResponseFromFetch(rpiResponse, decodedUrl, proxyOrigin, '/hianime/stream', 'rpi');
        }
        // Log the error body for debugging
        const errBody = await rpiResponse.text().catch(() => '');
        console.log(`[HiAnime Stream] Strategy 2 failed: ${rpiResponse.status}, body: ${errBody.substring(0, 200)}`);
        logger.warn('RPI proxy returned error', { status: rpiResponse.status });
      } catch (error) {
        logger.warn('RPI proxy error', { error: (error as Error).message });
        strategy2Status = -1;
      }

      // Strategy 3: If /hianime/stream failed for MegaCloud CDN, try /fetch-rust endpoint
      // The /fetch-rust endpoint uses curl-impersonate for Chrome TLS fingerprint mimicry
      if (isMegaCloudCdn) {
        try {
          const rustParams = new URLSearchParams({
            url: decodedUrl,
            key: env.RPI_PROXY_KEY!,
            solve: 'true',
          });
          const rustUrl = `${rpiBaseUrl}/fetch-rust?${rustParams.toString()}`;
          logger.debug('Trying /fetch-rust fallback for MegaCloud CDN', { url: rustUrl.substring(0, 80) });

          const fallbackResponse = await fetchWithRetry(rustUrl, {
            signal: AbortSignal.timeout(30000),
          }, 2, 1000);

          if (fallbackResponse.ok) {
            return await buildStreamResponseFromFetch(fallbackResponse, decodedUrl, proxyOrigin, '/hianime/stream', 'rpi-fetch-rust-fallback');
          }
          logger.warn('RPI /fetch-rust fallback also failed', { status: fallbackResponse.status });
          strategy3Status = fallbackResponse.status;
        } catch (error) {
          logger.warn('RPI /fetch-rust fallback error', { error: (error as Error).message });
          strategy3Status = -1;
        }
      }
    }

    return jsonResponse({
      error: 'Stream fetch failed from all sources',
      hint: hasRpi ? 'Both direct and RPI proxy failed' : 'RPI proxy not configured',
      debug: { strategy1Status, strategy2Status, strategy3Status, isMegaCloudCdn, hasRpi },
    }, 502);
  }

  return jsonResponse({ error: 'Unknown HiAnime route', path }, 404);
}

export default {
  fetch: handleHiAnimeRequest,
};
