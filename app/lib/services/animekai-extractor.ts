/**
 * AnimeKai Extractor
 * Primary source for anime content
 * 
 * *** MAL ID FOCUSED APPROACH ***
 * The extractor now prioritizes MAL ID matching over title-based search.
 * This is more reliable because:
 * - AnimeKai stores MAL IDs in their syncData
 * - MAL IDs are unique identifiers that don't change
 * - Avoids issues with title variations (e.g., "JJK" vs "Jujutsu Kaisen")
 * 
 * *** Native decryption throughout ***
 * - AnimeKai crypto: Native implementation (183 substitution tables)
 * - MegaUp decryption: Native XOR with pre-computed keystream (no external API)
 * 
 * Flow:
 * 1. Determine MAL ID (from parameter or TMDB → MAL lookup via ARM API)
 * 2. Search AnimeKai with title, check each result's syncData.mal_id
 * 3. Return the anime that matches the MAL ID
 * 4. Encrypt content_id (native) → fetch episodes list
 * 5. Find episode token (episode number is relative to MAL entry)
 * 6. Encrypt token (native) → fetch servers list
 * 7. Encrypt lid (native) → fetch embed (encrypted)
 * 8. Decrypt (native) → get stream URL
 * 
 * All encryption/decryption is done natively using reverse-engineered algorithms.
 * HTML parsing is done with regex - no external API calls needed.
 */

// Re-use the canonical types from the provider layer
import type { StreamSource, SubtitleTrack } from '../providers/types';

interface ExtractionResult {
  success: boolean;
  sources: StreamSource[];
  subtitles?: SubtitleTrack[];
  error?: string;
}

interface ParsedEpisodeEntry {
  token: string;
  [key: string]: any;
}

// Episodes structure: { "1": { "1": { token: "..." } }, "2": { "1": { token: "..." } } }
type ParsedEpisodes = Record<string, Record<string, ParsedEpisodeEntry>>;

interface ParsedServerEntry {
  lid: string;
  name?: string;
  [key: string]: any;
}

// Servers structure: { sub: { "1": { lid: "...", name: "..." } }, dub: { ... }, softsub: { ... } }
interface ParsedServers {
  sub?: Record<string, ParsedServerEntry>;
  dub?: Record<string, ParsedServerEntry>;
  softsub?: Record<string, ParsedServerEntry>;
}

// API Configuration
// All crypto is native - no external API dependencies!
// Support both animekai.to and anikai.to (domain migration)
const KAI_DOMAINS = ['https://animekai.to', 'https://anikai.to'];
let KAI_BASE = KAI_DOMAINS[0];
const ARM_API = 'https://arm.haglund.dev/api/v2/ids';

// Import cfFetch for routing through RPI proxy on Cloudflare Workers
import { cfFetch } from '../utils/cf-fetch';
import { isMegaUpCdnUrl } from '../proxy-config';

// ============================================================================
// IN-MEMORY CACHES — avoid redundant network calls across requests
// ============================================================================
const searchCache = new Map<string, { result: { content_id: string; title: string } | null; ts: number }>();
const armCache = new Map<string, { mal_id: number | null; anilist_id: number | null; ts: number }>();
const tmdbTitleCache = new Map<string, { title: string; year: string; ts: number }>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function getCached<T>(cache: Map<string, T & { ts: number }>, key: string): (T & { ts: number }) | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry;
  if (entry) cache.delete(key);
  return null;
}

/**
 * Get the current AJAX base URL (supports domain fallback)
 */
function getKaiAjax(): string {
  return `${KAI_BASE}/ajax`;
}

/**
 * Fetch a URL through Cloudflare Worker → RPI residential proxy
 * Used for MegaUp CDN which blocks datacenter IPs
 * 
 * Flow: Next.js → Cloudflare Worker (/animekai) → RPI Proxy → MegaUp CDN
 */
// @ts-ignore - Reserved for future use
async function _fetchViaCfAnimeKaiProxy(
  targetUrl: string,
  options?: { timeout?: number }
): Promise<Response> {
  // Use the Cloudflare stream proxy URL with /animekai route
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL;

  if (!cfProxyUrl) {
    console.log(`[AnimeKai] CF proxy not configured, falling back to direct fetch`);
    // Fall back to direct fetch (will likely fail with 403)
    return fetch(targetUrl, {
      headers: HEADERS,
      signal: AbortSignal.timeout(options?.timeout || 10000),
    });
  }

  // Strip /stream suffix if present and use /animekai route
  // Pass the User-Agent so RPI proxy uses the same one we'll use for decryption
  const baseUrl = cfProxyUrl.replace(/\/stream\/?$/, '');
  const proxyUrl = `${baseUrl}/animekai?url=${encodeURIComponent(targetUrl)}&ua=${encodeURIComponent(HEADERS['User-Agent'])}`;

  console.log(`[AnimeKai] Fetching via CF→RPI proxy: ${targetUrl.substring(0, 60)}...`);

  // Server-side requests (no Origin/Referer) are now allowed by the CF Worker
  return fetch(proxyUrl, {
    signal: AbortSignal.timeout(options?.timeout || 15000),
  });
}

// AJAX headers — for /ajax/ API endpoints
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://animekai.to/',
  'X-Requested-With': 'XMLHttpRequest',
  'Connection': 'keep-alive',
};

// Page headers — for fetching full HTML pages (watch pages, etc.)
// Must NOT include X-Requested-With or JSON Accept to avoid getting
// partial/AJAX responses instead of full HTML with syncData.
const PAGE_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Connection': 'keep-alive',
};


/**
 * Check if content is anime based on TMDB data
 */
const animeCheckCache = new Map<string, { isAnime: boolean; ts: number }>();

export async function isAnimeContent(tmdbId: string, type: 'movie' | 'tv'): Promise<boolean> {
  const cacheKey = `${tmdbId}-${type}`;
  const cached = animeCheckCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.isAnime;

  try {
    const apiKey = process.env.NEXT_PUBLIC_TMDB_API_KEY;
    if (!apiKey) return false;

    const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${apiKey}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(4000),
    });

    if (!response.ok) return false;

    const data = await response.json();
    
    // Check if it has Animation genre (16) AND is Japanese
    const hasAnimationGenre = data.genres?.some((g: { id: number }) => g.id === 16);
    const isJapanese = data.original_language === 'ja';
    
    const isAnime = !!(hasAnimationGenre && isJapanese);
    animeCheckCache.set(cacheKey, { isAnime, ts: Date.now() });
    return isAnime;
  } catch {
    return false;
  }
}

/**
 * Encrypt text using native AnimeKai cipher
 * No external API dependency - fully reverse engineered
 */
import { encryptAnimeKai, decryptAnimeKai } from '../animekai-crypto';

function encrypt(text: string): string | null {
  try {
    return encryptAnimeKai(text);
  } catch (error) {
    console.log(`[AnimeKai] Native encryption error:`, error);
    return null;
  }
}

/**
 * Decrypt text using native AnimeKai cipher
 * No external API dependency - fully reverse engineered
 */
function decrypt(text: string): string | null {
  try {
    return decryptAnimeKai(text);
  } catch (error) {
    console.log(`[AnimeKai] Native decryption error:`, error);
    return null;
  }
}

/**
 * Parse episodes HTML natively
 * Extracts episode tokens from AnimeKai HTML response
 * 
 * HTML structure: <a num="1" token="xxx" langs="3">...</a>
 * Returns: { "1": { "1": { token: "xxx" } } }
 */
function parseEpisodesHtml(html: string): ParsedEpisodes | null {
  try {
    const episodes: ParsedEpisodes = {};
    
    // Match all episode links with num and token attributes
    const episodeRegex = /<a[^>]*\bnum="(\d+)"[^>]*\btoken="([^"]+)"[^>]*>/gi;
    let match;
    
    while ((match = episodeRegex.exec(html)) !== null) {
      const [, num, token] = match;
      // AnimeKai uses season "1" for all episodes in the list
      if (!episodes['1']) episodes['1'] = {};
      episodes['1'][num] = { token };
    }
    
    // Also try alternate attribute order (token before num)
    const altRegex = /<a[^>]*\btoken="([^"]+)"[^>]*\bnum="(\d+)"[^>]*>/gi;
    while ((match = altRegex.exec(html)) !== null) {
      const [, token, num] = match;
      if (!episodes['1']) episodes['1'] = {};
      if (!episodes['1'][num]) {
        episodes['1'][num] = { token };
      }
    }
    
    return Object.keys(episodes).length > 0 ? episodes : null;
  } catch (error) {
    console.log(`[AnimeKai] Native episodes parse error:`, error);
    return null;
  }
}

/**
 * Parse servers HTML natively
 * Extracts server lids from AnimeKai HTML response
 * 
 * HTML structure: 
 * <div data-id="sub">
 *   <span class="server" data-sid="3" data-lid="xxx">Server 1</span>
 * </div>
 * 
 * Returns: { sub: { "1": { lid: "xxx", name: "Server 1" } }, dub: { ... } }
 */
function parseServersHtml(html: string): ParsedServers | null {
  try {
    const servers: ParsedServers = {};

    // Parse sub servers
    const subMatch = html.match(/<div[^>]*data-id="sub"[^>]*>([\s\S]*?)<\/div>/i);
    if (subMatch) {
      servers.sub = parseServerGroup(subMatch[1]);
    }

    // Parse dub servers
    const dubMatch = html.match(/<div[^>]*data-id="dub"[^>]*>([\s\S]*?)<\/div>/i);
    if (dubMatch) {
      servers.dub = parseServerGroup(dubMatch[1]);
    }

    // Parse softsub servers (soft subtitles - may be embedded in sub section)
    const softsubMatch = html.match(/<div[^>]*data-id="softsub"[^>]*>([\s\S]*?)<\/div>/i);
    if (softsubMatch) {
      servers.softsub = parseServerGroup(softsubMatch[1]);
    }

    return (servers.sub || servers.dub || servers.softsub) ? servers : null;
  } catch (error) {
    console.log(`[AnimeKai] Native servers parse error:`, error);
    return null;
  }
}

/**
 * Parse a server group (sub or dub section)
 */
function parseServerGroup(html: string): Record<string, ParsedServerEntry> {
  const result: Record<string, ParsedServerEntry> = {};
  
  // Match server spans with data-lid attribute
  const serverRegex = /<span[^>]*class="server"[^>]*data-lid="([^"]+)"[^>]*>([^<]*)<\/span>/gi;
  let match;
  let index = 1;
  
  while ((match = serverRegex.exec(html)) !== null) {
    const [, lid, name] = match;
    result[String(index)] = { 
      lid, 
      name: name.trim() || `Server ${index}` 
    };
    index++;
  }
  
  return result;
}

/**
 * Fetch JSON from AnimeKai AJAX endpoint with domain fallback
 */
async function getJson(url: string): Promise<any | null> {
  // Try current domain first
  const result = await _fetchJson(url);
  if (result !== null) return result;
  
  // If failed and we're on the primary domain, try fallback
  if (KAI_BASE === KAI_DOMAINS[0] && KAI_DOMAINS.length > 1) {
    const fallbackUrl = url.replace(KAI_DOMAINS[0], KAI_DOMAINS[1]);
    console.log(`[AnimeKai] Primary domain failed, trying fallback: ${KAI_DOMAINS[1]}`);
    const fallbackResult = await _fetchJson(fallbackUrl);
    if (fallbackResult !== null) {
      // Switch to working domain for subsequent requests
      KAI_BASE = KAI_DOMAINS[1];
      console.log(`[AnimeKai] Switched to fallback domain: ${KAI_BASE}`);
      return fallbackResult;
    }
  }
  
  return null;
}

async function _fetchJson(url: string): Promise<any | null> {
  try {
    const response = await cfFetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.log(`[AnimeKai] Fetch failed: HTTP ${response.status} for ${url}`);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.log(`[AnimeKai] Fetch error for ${url}:`, error);
    return null;
  }
}


/**
 * Get anime IDs from TMDB ID using ARM mapping API
 * 
 * ARM API requires specifying the media type:
 * - For movies: source=themoviedb (default)
 * - For TV shows: source=tmdb (different endpoint!)
 */
async function getAnimeIds(tmdbId: string, type: 'movie' | 'tv' = 'tv'): Promise<{ mal_id: number | null; anilist_id: number | null }> {
  // Check cache first
  const cacheKey = `${tmdbId}-${type}`;
  const cached = getCached(armCache, cacheKey);
  if (cached) {
    console.log(`[AnimeKai] ARM cache hit for TMDB ${tmdbId}: MAL=${cached.mal_id}`);
    return { mal_id: cached.mal_id, anilist_id: cached.anilist_id };
  }

  try {
    console.log(`[AnimeKai] Looking up anime IDs for TMDB ${tmdbId} (type: ${type})...`);

    // ARM API uses different source names:
    // - "themoviedb" for movies
    // - "tmdb" for TV shows (yes, they're different!)
    const source = type === 'movie' ? 'themoviedb' : 'tmdb';
    
    let response = await fetch(`${ARM_API}?source=${source}&id=${tmdbId}`, {
      signal: AbortSignal.timeout(4000),
    });

    // If TV lookup fails, try the movie endpoint as fallback
    if (!response.ok && type === 'tv') {
      console.log(`[AnimeKai] ARM tmdb lookup failed, trying themoviedb...`);
      response = await fetch(`${ARM_API}?source=themoviedb&id=${tmdbId}`, {
        signal: AbortSignal.timeout(4000),
      });
    }

    if (!response.ok) {
      console.log(`[AnimeKai] ARM lookup failed: HTTP ${response.status}`);
      const result = { mal_id: null, anilist_id: null };
      armCache.set(cacheKey, { ...result, ts: Date.now() });
      return result;
    }

    const data = await response.json();
    console.log(`[AnimeKai] ARM result: MAL=${data.mal}, AniList=${data.anilist}`);
    
    const result = {
      mal_id: data.mal || null,
      anilist_id: data.anilist || null,
    };
    armCache.set(cacheKey, { ...result, ts: Date.now() });
    return result;
  } catch (error) {
    console.log(`[AnimeKai] ARM lookup error:`, error);
    return { mal_id: null, anilist_id: null };
  }
}

/**
 * Get anime title from TMDB for fallback search
 */
async function getTmdbAnimeInfo(tmdbId: string, type: 'movie' | 'tv'): Promise<{ title: string; year: string } | null> {
  // Check cache first
  const cacheKey = `${tmdbId}-${type}`;
  const cached = getCached(tmdbTitleCache, cacheKey);
  if (cached) {
    return { title: cached.title, year: cached.year };
  }

  try {
    const apiKey = process.env.NEXT_PUBLIC_TMDB_API_KEY;
    if (!apiKey) return null;

    const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${apiKey}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(4000),
    });

    if (!response.ok) return null;

    const data = await response.json();
    
    const title = type === 'movie' ? data.title : data.name;
    const dateStr = type === 'movie' ? data.release_date : data.first_air_date;
    const year = dateStr ? dateStr.split('-')[0] : '';

    tmdbTitleCache.set(cacheKey, { title, year, ts: Date.now() });
    return { title, year };
  } catch {
    return null;
  }
}

/**
 * Helper to normalize title for comparison
 * Removes special characters, normalizes spaces, and handles common variations
 */
function normalizeTitle(title: string): string {
  return title.toLowerCase()
    .replace(/[-_:;,./\\|]+/g, ' ') // Replace separators with spaces BEFORE stripping
    .replace(/[^a-z0-9\s]/g, '')    // Remove remaining special chars
    .replace(/\s+/g, ' ')           // Normalize spaces
    .replace(/\bpart\s+(\d+)\b/g, 'part$1') // "Part 1" → "part1" for consistent matching
    .replace(/\bseason\s+(\d+)\b/g, 'season$1') // "Season 2" → "season2"
    .trim();
}

/**
 * Score how well a result matches the query
 * Higher score = better match
 */
function scoreMatch(resultTitle: string, query: string): number {
  const normalizedResult = normalizeTitle(resultTitle);
  const normalizedQuery = normalizeTitle(query);
  
  // Exact match (ignoring case/special chars)
  if (normalizedResult === normalizedQuery) return 100;
  
  // Result starts with query (e.g., "Jujutsu Kaisen" matches "Jujutsu Kaisen Season 2")
  if (normalizedResult.startsWith(normalizedQuery)) return 90;
  
  // Query starts with result (e.g., "Jujutsu Kaisen Season 2" matches "Jujutsu Kaisen")
  if (normalizedQuery.startsWith(normalizedResult)) return 85;
  
  // Result contains query as a whole word sequence
  if (normalizedResult.includes(normalizedQuery)) return 70;
  
  // IMPORTANT: If query contains season indicator, prefer results with matching season
  const seasonMatch = query.match(/season\s*(\d+)|(\d+)(?:nd|rd|th)\s*season|part\s*(\d+)/i);
  if (seasonMatch) {
    const querySeason = seasonMatch[1] || seasonMatch[2] || seasonMatch[3];
    const resultSeasonMatch = resultTitle.match(/season\s*(\d+)|(\d+)(?:nd|rd|th)\s*season|part\s*(\d+)/i);
    
    if (resultSeasonMatch) {
      const resultSeason = resultSeasonMatch[1] || resultSeasonMatch[2] || resultSeasonMatch[3];
      if (querySeason === resultSeason) {
        return 95; // Strong match - same season number
      } else {
        return 20; // Wrong season - heavily penalize
      }
    } else {
      // Query has season but result doesn't - this is likely the base anime, not the season
      return 30;
    }
  }
  
  // Penalize results with extra words like "Movie", "Execution", "OVA", etc.
  const penaltyWords = ['movie', 'execution', 'ova', 'special', 'recap', 'summary'];
  let score = 50;
  for (const word of penaltyWords) {
    if (normalizedResult.includes(word) && !normalizedQuery.includes(word)) {
      score -= 20;
    }
  }
  
  return Math.max(score, 0);
}

/**
 * Search AnimeKai by MAL ID (PRIMARY METHOD)
 * 
 * This is the MAL ID focused approach:
 * 1. Search AnimeKai with the title
 * 2. For each result, fetch the watch page and check syncData.mal_id
 * 3. Return the one that matches the provided MAL ID
 * 
 * This is more reliable than title matching because:
 * - AnimeKai stores MAL IDs in their syncData
 * - MAL IDs are unique identifiers that don't change
 * - Avoids issues with title variations (e.g., "JJK" vs "Jujutsu Kaisen")
 */
async function searchAnimeKaiByMalId(malId: number, searchQuery: string): Promise<{ content_id: string; title: string } | null> {
  // Check cache first
  const cacheKey = `mal-${malId}-${searchQuery}`;
  const cached = getCached(searchCache, cacheKey);
  if (cached) {
    console.log(`[AnimeKai] Search cache hit for MAL ${malId}`);
    return cached.result;
  }

  try {
    console.log(`[AnimeKai] MAL ID SEARCH: Looking for MAL ID ${malId} using query "${searchQuery}"`);
    
    // Fetch search results (with domain fallback)
    let searchHtml: string | null = null;
    
    for (const domain of KAI_DOMAINS) {
      try {
        const searchResponse = await cfFetch(`${domain}/ajax/anime/search?keyword=${encodeURIComponent(searchQuery)}`, {
          headers: HEADERS,
          signal: AbortSignal.timeout(8000),
        });
        if (searchResponse.ok) {
          const searchData = await searchResponse.json();
          searchHtml = searchData.result?.html || null;
          if (searchHtml) {
            if (domain !== KAI_BASE) {
              KAI_BASE = domain;
              console.log(`[AnimeKai] Switched to domain: ${KAI_BASE}`);
            }
            break;
          }
        }
      } catch { /* try next domain */ }
    }

    if (!searchHtml) {
      console.log(`[AnimeKai] No search results HTML from any domain`);
      searchCache.set(cacheKey, { result: null, ts: Date.now() });
      return null;
    }

    // Parse search results
    const animeRegex = /<a[^>]*href="\/watch\/([^"]+)"[^>]*>[\s\S]*?<h6[^>]*class="title"[^>]*(?:data-jp="([^"]*)")?[^>]*>([^<]*)<\/h6>/gi;
    const results: Array<{ slug: string; jpTitle: string; enTitle: string }> = [];
    
    let match;
    while ((match = animeRegex.exec(searchHtml)) !== null) {
      const [, slug, jpTitle, enTitle] = match;
      results.push({ slug, jpTitle: jpTitle || '', enTitle: enTitle.trim() });
    }

    if (results.length === 0) {
      console.log(`[AnimeKai] No results found for "${searchQuery}"`);
      searchCache.set(cacheKey, { result: null, ts: Date.now() });
      return null;
    }

    // Score results by title similarity and only check top candidates (max 4)
    const scored = results.map(r => ({
      ...r,
      score: Math.max(scoreMatch(r.enTitle, searchQuery), r.jpTitle ? scoreMatch(r.jpTitle, searchQuery) : 0),
    })).sort((a, b) => b.score - a.score).slice(0, 4);

    console.log(`[AnimeKai] Found ${results.length} results, checking top ${scored.length} MAL IDs IN PARALLEL...`);

    // Check MAL IDs in PARALLEL — this is the key performance optimization
    // Previously sequential (5+ seconds), now parallel (~1-2 seconds)
    const watchResults = await Promise.allSettled(
      scored.map(async (result) => {
        const watchResp = await cfFetch(`${KAI_BASE}/watch/${result.slug}`, {
          headers: PAGE_HEADERS,
          redirect: 'follow',
          signal: AbortSignal.timeout(6000),
        });

        if (!watchResp.ok) {
          console.log(`[AnimeKai]   - "${result.enTitle}" → HTTP ${watchResp.status} (skipped)`);
          return null;
        }
        
        const watchHtml = await watchResp.text();
        const syncMatch = watchHtml.match(/<script[^>]*id="syncData"[^>]*>([\s\S]*?)<\/script>/);
        
        if (syncMatch) {
          const syncData = JSON.parse(syncMatch[1]);
          const pageMalId = parseInt(syncData.mal_id);
          const animeId = syncData.anime_id;
          
          console.log(`[AnimeKai]   - "${result.enTitle}" → mal_id: ${pageMalId}, anime_id: ${animeId}`);
          
          if (pageMalId === malId) {
            return { content_id: animeId, title: result.enTitle || result.jpTitle };
          }
        }
        return null;
      })
    );

    // Find the first successful match
    for (const wr of watchResults) {
      if (wr.status === 'fulfilled' && wr.value) {
        console.log(`[AnimeKai] ✓ MAL ID ${malId} MATCH! content_id: ${wr.value.content_id}`);
        searchCache.set(cacheKey, { result: wr.value, ts: Date.now() });
        return wr.value;
      }
    }
    
    console.log(`[AnimeKai] ✗ MAL ID ${malId} not found in ${scored.length} results`);
    searchCache.set(cacheKey, { result: null, ts: Date.now() });
    return null;
  } catch (error) {
    console.log(`[AnimeKai] MAL ID search error:`, error);
    return null;
  }
}

/**
 * Search AnimeKai by title (FALLBACK METHOD)
 * 
 * Used when:
 * - No MAL ID is available
 * - MAL ID search failed
 * 
 * Uses title scoring to find the best match.
 */
async function searchAnimeKaiByTitle(query: string): Promise<{ content_id: string; title: string } | null> {
  // Check cache first
  const cacheKey = `title-${query}`;
  const cached = getCached(searchCache, cacheKey);
  if (cached) {
    console.log(`[AnimeKai] Title search cache hit for "${query}"`);
    return cached.result;
  }

  try {
    console.log(`[AnimeKai] TITLE SEARCH: Looking for "${query}"`);
    
    // Fetch search results (with domain fallback)
    let searchData: any = null;
    
    for (const domain of KAI_DOMAINS) {
      try {
        const searchResponse = await cfFetch(`${domain}/ajax/anime/search?keyword=${encodeURIComponent(query)}`, {
          headers: HEADERS,
          signal: AbortSignal.timeout(8000),
        });
        if (searchResponse.ok) {
          searchData = await searchResponse.json();
          if (searchData.result?.html) {
            if (domain !== KAI_BASE) {
              KAI_BASE = domain;
              console.log(`[AnimeKai] Switched to domain: ${KAI_BASE}`);
            }
            break;
          }
        }
      } catch { /* try next domain */ }
    }

    if (!searchData?.result?.html) {
      console.log(`[AnimeKai] No search results from any domain`);
      searchCache.set(cacheKey, { result: null, ts: Date.now() });
      return null;
    }

    const searchHtml = searchData.result.html;

    // Parse search results - extract slug and title
    const animeRegex = /<a[^>]*href="\/watch\/([^"]+)"[^>]*>[\s\S]*?<h6[^>]*class="title"[^>]*(?:data-jp="([^"]*)")?[^>]*>([^<]*)<\/h6>/gi;
    const results: Array<{ slug: string; jpTitle: string; enTitle: string }> = [];
    
    let match;
    while ((match = animeRegex.exec(searchHtml)) !== null) {
      const [, slug, jpTitle, enTitle] = match;
      results.push({ slug, jpTitle: jpTitle || '', enTitle: enTitle.trim() });
    }

    if (results.length === 0) {
      console.log(`[AnimeKai] No results found for "${query}"`);
      return null;
    }

    console.log(`[AnimeKai] Found ${results.length} results, scoring by title...`);
    
    // Score results and pick best match
    let bestResult = results[0];
    let bestScore = -1;
    
    for (const result of results) {
      const score = scoreMatch(result.enTitle, query);
      const jpScore = result.jpTitle ? scoreMatch(result.jpTitle, query) : 0;
      const finalScore = Math.max(score, jpScore);
      
      console.log(`[AnimeKai]   - "${result.enTitle}" (score: ${finalScore})`);
      
      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestResult = result;
      }
    }

    console.log(`[AnimeKai] Best title match: "${bestResult.enTitle}" (score: ${bestScore})`);
    
    // If score is too low, reject the match
    if (bestScore < 30) {
      console.log(`[AnimeKai] Score too low (${bestScore} < 30), rejecting match`);
      searchCache.set(cacheKey, { result: null, ts: Date.now() });
      return null;
    }

    // Fetch the watch page to get kai_id
    const watchUrl = `${KAI_BASE}/watch/${bestResult.slug}`;
    console.log(`[AnimeKai] Fetching watch page: ${watchUrl}`);

    const watchResponse = await cfFetch(watchUrl, {
      headers: PAGE_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });

    if (!watchResponse.ok) {
      console.log(`[AnimeKai] Watch page fetch failed: HTTP ${watchResponse.status}`);
      return null;
    }

    const watchHtml = await watchResponse.text();

    // Extract anime_id from syncData
    let kaiId: string | null = null;
    const syncDataMatch = watchHtml.match(/<script[^>]*id="syncData"[^>]*>([\s\S]*?)<\/script>/i);
    if (syncDataMatch) {
      try {
        const syncData = JSON.parse(syncDataMatch[1]);
        if (syncData.anime_id) {
          kaiId = syncData.anime_id;
          console.log(`[AnimeKai] Found anime_id from syncData: ${kaiId}`);
        }
      } catch {
        // Ignore JSON parse errors
      }
    }

    // Fallback: Extract kai_id from data-id attribute
    if (!kaiId) {
      const dataIdMatches = watchHtml.match(/data-id="([a-zA-Z0-9_-]{4,10})"/g) || [];
      const reservedIds = ['signin', 'report', 'request', 'anime', 'episode', 'sub', 'dub'];
      
      for (const match of dataIdMatches) {
        const id = match.match(/data-id="([^"]+)"/)?.[1];
        if (id && !reservedIds.includes(id.toLowerCase()) && id.length >= 4) {
          kaiId = id;
          break;
        }
      }
    }

    if (!kaiId) {
      console.log(`[AnimeKai] Could not extract kai_id from watch page`);
      searchCache.set(cacheKey, { result: null, ts: Date.now() });
      return null;
    }

    console.log(`[AnimeKai] Found: "${bestResult.enTitle}" (kai_id: ${kaiId})`);
    const result = {
      content_id: kaiId,
      title: bestResult.enTitle || bestResult.jpTitle,
    };
    searchCache.set(cacheKey, { result, ts: Date.now() });
    return result;
  } catch (error) {
    console.log(`[AnimeKai] Title search error:`, error);
    return null;
  }
}

/**
 * Search AnimeKai - MAL ID focused with title fallback
 * 
 * Priority:
 * 1. If MAL ID provided → searchAnimeKaiByMalId (checks syncData.mal_id)
 * 2. If no MAL ID or MAL search fails → searchAnimeKaiByTitle (title scoring)
 */
async function searchAnimeKai(query: string, malId?: number | null): Promise<{ content_id: string; title: string; episodes?: ParsedEpisodes } | null> {
  // MAL ID FOCUSED: If we have a MAL ID, use it as the primary search method
  if (malId) {
    const malResult = await searchAnimeKaiByMalId(malId, query);
    if (malResult) {
      return malResult;
    }
    
    // Try a limited set of alternative search queries (max 3 to avoid excessive requests)
    const alternativeQueries = generateAlternativeSearchQueries(query).slice(0, 3);
    for (const altQuery of alternativeQueries) {
      console.log(`[AnimeKai] Trying alternative query: "${altQuery}"`);
      const altResult = await searchAnimeKaiByMalId(malId, altQuery);
      if (altResult) {
        return altResult;
      }
    }
    
    console.log(`[AnimeKai] MAL ID search exhausted, falling back to title search...`);
  }
  
  // FALLBACK: Title-based search
  return searchAnimeKaiByTitle(query);
}

/**
 * Generate alternative search queries for MAL ID search
 * Handles common naming variations between MAL and AnimeKai
 */
function generateAlternativeSearchQueries(originalQuery: string): string[] {
  const alternatives: string[] = [];
  
  // Remove common suffixes/prefixes
  const cleaned = originalQuery
    .replace(/:\s*Part\s*\d+/gi, '') // "Title: Part 1" → "Title"
    .replace(/\s*-\s*Part\s*\d+/gi, '') // "Title - Part 1" → "Title"
    .replace(/\s*Part\s*\d+$/gi, '') // "Title Part 1" → "Title"
    .trim();
  
  if (cleaned !== originalQuery) {
    alternatives.push(cleaned);
  }
  
  // Try just the first part before colon
  const colonSplit = originalQuery.split(':')[0].trim();
  if (colonSplit !== originalQuery && colonSplit.length > 3) {
    alternatives.push(colonSplit);
  }
  
  // Try removing "The" prefix
  if (originalQuery.toLowerCase().startsWith('the ')) {
    alternatives.push(originalQuery.substring(4));
  }
  
  // Try common title variations
  const variations: Record<string, string[]> = {
    'jujutsu kaisen': ['jjk', 'sorcery fight'],
    'attack on titan': ['shingeki no kyojin', 'aot'],
    'my hero academia': ['boku no hero academia', 'bnha'],
    'demon slayer': ['kimetsu no yaiba'],
    'spy x family': ['spy family'],
  };
  
  const lowerQuery = originalQuery.toLowerCase();
  for (const [key, alts] of Object.entries(variations)) {
    if (lowerQuery.includes(key)) {
      alternatives.push(...alts);
    }
  }
  
  // Remove duplicates and the original query
  return [...new Set(alternatives)].filter(q => q !== originalQuery);
}


/**
 * Get episodes list for an anime
 */
async function getEpisodes(contentId: string): Promise<ParsedEpisodes | null> {
  try {
    console.log(`[AnimeKai] Getting episodes for content_id: ${contentId}`);
    
    // Encrypt the content_id
    const encId = encrypt(contentId);
    if (!encId) {
      console.log(`[AnimeKai] Failed to encrypt content_id`);
      return null;
    }

    // Fetch episodes list
    const url = `${getKaiAjax()}/episodes/list?ani_id=${contentId}&_=${encId}`;
    const response = await getJson(url);
    
    if (!response || !response.result) {
      console.log(`[AnimeKai] No episodes response`);
      return null;
    }

    // Parse the HTML response using episodes-specific parser
    const parsed = parseEpisodesHtml(response.result);
    if (!parsed) {
      console.log(`[AnimeKai] Failed to parse episodes HTML`);
      return null;
    }

    console.log(`[AnimeKai] Got episodes:`, Object.keys(parsed));
    return parsed;
  } catch (error) {
    console.log(`[AnimeKai] Get episodes error:`, error);
    return null;
  }
}

/**
 * Get servers list for an episode
 */
async function getServers(token: string): Promise<ParsedServers | null> {
  try {
    console.log(`[AnimeKai] Getting servers for token: ${token.substring(0, 20)}...`);
    
    // Encrypt the token
    const encToken = encrypt(token);
    if (!encToken) {
      console.log(`[AnimeKai] Failed to encrypt token`);
      return null;
    }

    // Fetch servers list
    const url = `${getKaiAjax()}/links/list?token=${token}&_=${encToken}`;
    const response = await getJson(url);
    
    if (!response || !response.result) {
      console.log(`[AnimeKai] No servers response`);
      return null;
    }

    // Parse the HTML response using servers-specific parser
    const parsed = parseServersHtml(response.result);
    if (!parsed) {
      console.log(`[AnimeKai] Failed to parse servers HTML`);
      return null;
    }

    console.log(`[AnimeKai] Got servers - sub:`, parsed.sub ? Object.keys(parsed.sub) : 'none', 'dub:', parsed.dub ? Object.keys(parsed.dub) : 'none');
    return parsed;
  } catch (error) {
    console.log(`[AnimeKai] Get servers error:`, error);
    return null;
  }
}

/**
 * Decrypt MegaUp embed URL to get actual HLS stream
 * MegaUp embeds (/e/...) need to be decrypted to get the .m3u8 URL
 * 
 * Correct flow:
 * 1. Extract video ID from embed URL
 * 2. Call /media/{videoId} to get encrypted stream data
 * 3. Extract stream URL from page (no enc-dec.app dependency)
 */
async function decryptMegaUpEmbed(embedUrl: string): Promise<string | null> {
  // Use manual extraction directly - no enc-dec.app dependency
  return await extractMegaUpSourcesManually(embedUrl);
}

/**
 * Unpack p,a,c,k,e,d JavaScript
 * Many embed pages use this obfuscation
 */
// @ts-ignore - Reserved for future use
function _unpackPACKED(packed: string): string {
  // Match the packed function pattern - use [\s\S] instead of . with /s flag for compatibility
  const packedMatch = packed.match(/eval\(function\(p,a,c,k,e,[dr]\)\{[\s\S]*?\}?\('([^']+)',\s*(\d+),\s*(\d+),\s*'([^']+)'\.split\('\|'\)/);
  
  if (!packedMatch) {
    return packed;
  }
  
  const [, p, aStr, cStr, keywords] = packedMatch;
  const base = parseInt(aStr);
  const count = parseInt(cStr);
  const keywordList = keywords.split('|');
  
  // Build replacement function
  const unbaser = (n: number): string => {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (n < base) {
      return n < 36 ? chars[n] : String.fromCharCode(n + 29);
    }
    return unbaser(Math.floor(n / base)) + unbaser(n % base);
  };
  
  // Replace all encoded tokens
  let result = p;
  for (let i = count - 1; i >= 0; i--) {
    if (keywordList[i]) {
      const token = unbaser(i);
      result = result.replace(new RegExp(`\\b${token}\\b`, 'g'), keywordList[i]);
    }
  }
  
  return result;
}

/**
 * Manually extract sources from MegaUp embed page
 * Uses /media/ endpoint + native decryption (no enc-dec.app dependency)
 * 
 * IMPORTANT: MegaUp blocks datacenter IPs (Cloudflare, AWS, etc.)
 * We route the /media/ API call through the Cloudflare Worker -> RPI residential proxy
 */
async function extractMegaUpSourcesManually(embedUrl: string): Promise<string | null> {
  try {
    // Import native MegaUp decryption
    const { decryptMegaUp, MEGAUP_USER_AGENT } = await import('../megaup-crypto');
    
    // Extract video ID and base URL from embed URL
    // e.g., https://megaup22.online/e/jIrrLzj-WS2JcOLzF79O5xvpCQ
    const urlMatch = embedUrl.match(/https?:\/\/([^\/]+)\/e\/([^\/\?]+)/);
    if (!urlMatch) {
      console.log(`[AnimeKai] Invalid MegaUp embed URL format`);
      return null;
    }
    
    const [, host, videoId] = urlMatch;
    const baseUrl = `https://${host}`;
    const mediaUrl = `${baseUrl}/media/${videoId}`;
    
    console.log(`[AnimeKai] Fetching MegaUp /media/ endpoint: ${mediaUrl}`);

    const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL || process.env.CF_STREAM_PROXY_URL;

    let mediaResponse: Response;

    // Strategy 1: Direct fetch first — server runs on residential IP, should work
    // MegaUp only blocks datacenter IPs (CF Workers, AWS, etc.)
    console.log(`[AnimeKai] Trying direct fetch for MegaUp /media/...`);
    try {
      mediaResponse = await fetch(mediaUrl, {
        headers: {
          'User-Agent': MEGAUP_USER_AGENT,
          'Accept': 'application/json',
          'Referer': embedUrl,
          'Origin': `https://${host}`,
        },
        signal: AbortSignal.timeout(10000),
      });
    } catch (directError) {
      console.log(`[AnimeKai] Direct fetch error:`, directError);
      mediaResponse = null as any;
    }

    // Strategy 2: If direct fetch got blocked (403), try CF Worker proxy
    if ((!mediaResponse || !mediaResponse.ok) && cfProxyUrl) {
      const status = mediaResponse?.status;
      console.log(`[AnimeKai] Direct fetch failed (${status || 'network error'}), trying CF Worker proxy...`);
      const proxyBaseUrl = cfProxyUrl.replace(/\/stream\/?$/, '');
      const proxiedMediaUrl = `${proxyBaseUrl}/animekai?url=${encodeURIComponent(mediaUrl)}&ua=${encodeURIComponent(MEGAUP_USER_AGENT)}`;

      try {
        mediaResponse = await cfFetch(proxiedMediaUrl, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(15000),
        });
        console.log(`[AnimeKai] Proxy response status: ${mediaResponse.status}`);
      } catch (proxyError) {
        console.log(`[AnimeKai] Proxy fetch error:`, proxyError);
        return null;
      }
    }
    
    if (!mediaResponse.ok) {
      const statusCode = mediaResponse.status;
      console.log(`[AnimeKai] MegaUp /media/ failed: HTTP ${statusCode}`);
      // Log response body for debugging
      try {
        const errorText = await mediaResponse.text();
        console.log(`[AnimeKai] MegaUp error response (${statusCode}):`, errorText.substring(0, 500));
        
        // Check for common error patterns
        if (statusCode === 403) {
          console.log(`[AnimeKai] 403 Forbidden - likely datacenter IP blocking or missing RPI proxy config`);
        } else if (statusCode === 502 || statusCode === 504) {
          console.log(`[AnimeKai] ${statusCode} - proxy chain error, check CF Worker and RPI proxy logs`);
        }
      } catch {}
      return null;
    }
    
    // Try to parse as JSON
    let mediaData: any;
    try {
      mediaData = await mediaResponse.json();
    } catch (jsonError) {
      console.log(`[AnimeKai] MegaUp response is not valid JSON:`, jsonError);
      return null;
    }
    
    if (mediaData.status !== 200 || !mediaData.result) {
      console.log(`[AnimeKai] MegaUp /media/ returned no result:`, mediaData);
      return null;
    }
    
    console.log(`[AnimeKai] Got encrypted media data (${mediaData.result.length} chars), decrypting...`);
    
    // Decrypt using enc-dec.app API (keystream is video-specific, native XOR doesn't work)
    let decrypted: string;
    try {
      decrypted = await decryptMegaUp(mediaData.result);
    } catch (decryptError) {
      console.log(`[AnimeKai] MegaUp decryption failed:`, decryptError);
      return null;
    }
    
    // Parse the decrypted result
    let streamData: any;
    try {
      streamData = JSON.parse(decrypted);
    } catch (e) {
      console.log(`[AnimeKai] MegaUp decryption produced invalid JSON:`, decrypted.substring(0, 100));
      return null;
    }
    
    // Extract stream URL
    let streamUrl = '';
    if (streamData.sources && streamData.sources[0]) {
      streamUrl = streamData.sources[0].file || streamData.sources[0].url || '';
    } else if (streamData.file) {
      streamUrl = streamData.file;
    } else if (streamData.url) {
      streamUrl = streamData.url;
    }
    
    if (streamUrl) {
      console.log(`[AnimeKai] ✓ Got MegaUp stream URL (native decrypt):`, streamUrl.substring(0, 80));
      return streamUrl;
    }
    
    console.log(`[AnimeKai] No stream URL in decrypted data:`, streamData);
    return null;
  } catch (error) {
    console.log(`[AnimeKai] MegaUp extraction error:`, error);
    return null;
  }
}

/**
 * Decrypt RapidShare embed URL to get actual HLS stream
 * Uses manual extraction - no enc-dec.app dependency
 */
async function decryptRapidShareEmbed(embedUrl: string): Promise<string | null> {
  try {
    console.log(`[AnimeKai] Decrypting RapidShare embed: ${embedUrl}`);
    
    // Use manual extraction (same approach as MegaUp)
    return await extractMegaUpSourcesManually(embedUrl);
  } catch (error) {
    console.log(`[AnimeKai] RapidShare decrypt error:`, error);
    return null;
  }
}

/**
 * Get stream URL from a server
 * 
 * NEW FLOW (RPI does ALL the work):
 * 1. Encrypt lid → fetch encrypted embed from AnimeKai
 * 2. Send encrypted embed to CF Worker → RPI /animekai/extract
 * 3. RPI decrypts AnimeKai, fetches MegaUp /media/, decrypts MegaUp
 * 4. Returns final HLS stream URL
 */
async function getStreamFromServer(lid: string, serverName: string): Promise<StreamSource | null> {
  try {
    console.log(`[AnimeKai] Getting stream from server ${serverName} (lid: ${lid.substring(0, 20)}...)`);
    
    // Encrypt the lid
    const encLid = encrypt(lid);
    if (!encLid) {
      console.log(`[AnimeKai] Failed to encrypt lid`);
      return null;
    }

    // Fetch encrypted embed data from AnimeKai
    const url = `${getKaiAjax()}/links/view?id=${lid}&_=${encLid}`;
    const response = await getJson(url);
    
    if (!response || !response.result) {
      console.log(`[AnimeKai] No embed response`);
      return null;
    }

    const encryptedEmbed = response.result;
    console.log(`[AnimeKai] Got encrypted embed (${encryptedEmbed.length} chars)`);

    // Route to CF Worker → RPI for full extraction
    // RPI does ALL the work: decrypt AnimeKai, fetch MegaUp /media/, decrypt MegaUp
    const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL || process.env.CF_STREAM_PROXY_URL;
    
    if (!cfProxyUrl) {
      console.log(`[AnimeKai] CF proxy not configured, falling back to local extraction`);
      return await getStreamFromServerLocal(lid, serverName, encryptedEmbed);
    }
    
    const proxyBaseUrl = cfProxyUrl.replace(/\/stream\/?$/, '');
    const extractUrl = `${proxyBaseUrl}/animekai/extract?embed=${encodeURIComponent(encryptedEmbed)}`;
    
    console.log(`[AnimeKai] Routing to RPI for full extraction: ${extractUrl.substring(0, 80)}...`);
    
    try {
      // Use cfFetch to route through RPI when on CF Pages — CF Pages can't directly
      // fetch other CF Workers on the same account
      const extractResponse = await cfFetch(extractUrl, {
        signal: AbortSignal.timeout(20000),
      });
      
      const extractData = await extractResponse.json();
      
      if (!extractData.success || !extractData.streamUrl) {
        console.log(`[AnimeKai] RPI extraction failed:`, extractData);
        // Fall back to local extraction
        return await getStreamFromServerLocal(lid, serverName, encryptedEmbed);
      }
      
      const streamUrl = extractData.streamUrl;
      console.log(`[AnimeKai] ✓ Got URL from CF Worker:`, streamUrl.substring(0, 80));

      // If the CF worker returned an iframe URL (couldn't fetch it from datacenter IP),
      // try extracting locally via cfFetch (which may route through RPI or direct)
      let finalUrl = streamUrl;
      if (streamUrl.includes('animekai.to/iframe')) {
        console.log(`[AnimeKai] CF Worker returned iframe URL, trying local extraction...`);
        const extracted = await extractFromKaiIframe(streamUrl);
        if (extracted) {
          finalUrl = extracted;
          console.log(`[AnimeKai] Extracted from iframe:`, finalUrl.substring(0, 80));
        } else {
          console.log(`[AnimeKai] Iframe extraction failed — will try MegaUp handling chain`);
          // Don't fail — the URL will go through the embed/MegaUp handling below
        }
      }

      // Handle MegaUp embed URLs extracted from iframe
      if (finalUrl.includes('megaup') && finalUrl.includes('/e/')) {
        console.log(`[AnimeKai] Detected MegaUp embed URL, decrypting...`);
        const hlsUrl = await decryptMegaUpEmbed(finalUrl);
        if (hlsUrl) {
          finalUrl = hlsUrl;
          console.log(`[AnimeKai] ✓ Got HLS stream from MegaUp:`, finalUrl.substring(0, 100));
        }
      } else if (finalUrl.includes('/e/') && !finalUrl.includes('.m3u8') && !finalUrl.includes('.mp4')) {
        console.log(`[AnimeKai] Unknown embed type, trying generic extraction...`);
        const hlsUrl = await extractMegaUpSourcesManually(finalUrl);
        if (hlsUrl) finalUrl = hlsUrl;
      }

      // Extract skip intro/outro data if available
      const skipIntro = extractData.skip?.intro as [number, number] | undefined;
      const skipOutro = extractData.skip?.outro as [number, number] | undefined;

      if (skipIntro) {
        console.log(`[AnimeKai] Skip intro: ${skipIntro[0]}s - ${skipIntro[1]}s`);
      }
      if (skipOutro) {
        console.log(`[AnimeKai] Skip outro: ${skipOutro[0]}s - ${skipOutro[1]}s`);
      }

      // Extract the proper referer from the stream URL's origin
      let referer = `${KAI_BASE}/`;
      try {
        const streamOrigin = new URL(finalUrl).origin;
        referer = streamOrigin + '/';
      } catch {}

      return {
        quality: 'auto',
        title: `AnimeKai - ${serverName}`,
        url: finalUrl,
        type: 'hls',
        referer,
        requiresSegmentProxy: true,
        skipOrigin: isMegaUpCdnUrl(finalUrl),
        status: 'working',
        language: 'ja',
        skipIntro,
        skipOutro,
      };
      
    } catch (fetchError) {
      console.log(`[AnimeKai] RPI extraction fetch error:`, fetchError);
      // Fall back to local extraction
      return await getStreamFromServerLocal(lid, serverName, encryptedEmbed);
    }
    
  } catch (error) {
    console.log(`[AnimeKai] Get stream error:`, error);
    return null;
  }
}

/**
 * Clean decrypted AnimeKai embed data.
 * The decryptAnimeKai() cipher produces valid }XX-encoded JSON followed by
 * binary garbage bytes (cipher over-reads the plaintext). This function:
 *   1. Scans for valid }XX sequences and decodes them
 *   2. Passes through valid JSON structural chars
 *   3. Stops at the first non-}XX, non-JSON garbage byte
 *   4. Tracks brace/bracket depth to find where valid JSON ends
 *   5. Closes any unclosed brackets
 */
function cleanDecryptedJson(raw: string): string {
  // Step 1: Decode valid }XX sequences, pass through JSON chars, stop at garbage
  let decoded = '';
  let pos = 0;
  while (pos < raw.length) {
    if (raw[pos] === '}' && pos + 2 < raw.length) {
      const h1 = raw[pos + 1];
      const h2 = raw[pos + 2];
      if (/[0-9A-Fa-f]/.test(h1) && /[0-9A-Fa-f]/.test(h2)) {
        decoded += String.fromCharCode(parseInt(h1 + h2, 16));
        pos += 3;
        continue;
      }
    }
    const ch = raw[pos];
    if (/[{}\[\]:"\\\/\w\d.\-\s]/.test(ch)) {
      decoded += ch;
      pos++;
    } else {
      // Skip garbage byte (control chars, non-ASCII) — don't break,
      // the decryption may produce interspersed garbage in the data
      pos++;
    }
  }

  // Step 2: Find where valid JSON ends (balanced braces/brackets)
  let braceStack = 0;
  let bracketStack = 0;
  let inString = false;
  let escape = false;
  let jsonEnd = 0;

  for (let i = 0; i < decoded.length; i++) {
    const c = decoded[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') braceStack++;
    if (c === '}') braceStack--;
    if (c === '[') bracketStack++;
    if (c === ']') bracketStack--;
    if (braceStack === 0 && bracketStack === 0 && i > 0) {
      jsonEnd = i + 1;
    }
  }

  let json = decoded.substring(0, jsonEnd || decoded.length);
  // Strip trailing comma before closing brackets
  json = json.replace(/,+$/, '');
  while (braceStack > 0) { json += '}'; braceStack--; }
  while (bracketStack > 0) { json += ']'; bracketStack--; }

  return json;
}

/**
 * Fetch an animekai.to/iframe/... URL and extract the actual video source.
 * The iframe page typically contains a MegaUp embed URL or direct m3u8/mp4.
 */
async function extractFromKaiIframe(iframeUrl: string): Promise<string | null> {
  console.log(`[AnimeKai] Fetching iframe: ${iframeUrl}`);
  try {
    const res = await cfFetch(iframeUrl, {
      headers: {
        ...HEADERS,
        'Referer': `${KAI_BASE}/`,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.log(`[AnimeKai] Iframe fetch failed: ${res.status}`);
      return null;
    }
    const html = await res.text();
    console.log(`[AnimeKai] Iframe HTML length: ${html.length}`);

    // Try extracting MegaUp /e/ URL
    const megaupMatch = html.match(/https?:\/\/[^"'\s]*megaup[^"'\s]*\/e\/[^"'\s]+/i);
    if (megaupMatch) {
      console.log(`[AnimeKai] Found MegaUp URL in iframe: ${megaupMatch[0]}`);
      return megaupMatch[0];
    }

    // Try extracting any video source (m3u8/mp4)
    const srcMatch = html.match(/(?:src|file|url)\s*[=:]\s*["']([^"']*(?:m3u8|mp4)[^"']*)["']/i);
    if (srcMatch) {
      console.log(`[AnimeKai] Found video source in iframe: ${srcMatch[1]}`);
      return srcMatch[1];
    }

    // Try iframe src
    const iframeMatch = html.match(/<iframe[^>]*src=["']([^"']+)["']/i);
    if (iframeMatch) {
      console.log(`[AnimeKai] Found nested iframe: ${iframeMatch[1]}`);
      return iframeMatch[1];
    }

    console.log(`[AnimeKai] No video source found in iframe HTML`);
    return null;
  } catch (e) {
    console.log(`[AnimeKai] Iframe extraction error:`, e);
    return null;
  }
}

/**
 * Local extraction fallback (when RPI is not available)
 * This may fail due to datacenter IP blocking
 */
async function getStreamFromServerLocal(_lid: string, serverName: string, encryptedEmbed: string): Promise<StreamSource | null> {
  try {
    console.log(`[AnimeKai] Falling back to local extraction...`);

    // Decrypt the response locally
    const rawDecrypted = decrypt(encryptedEmbed);
    if (!rawDecrypted) {
      console.log(`[AnimeKai] Failed to decrypt embed`);
      return null;
    }

    // Clean decryption garbage and parse
    const cleanJson = cleanDecryptedJson(rawDecrypted);
    console.log(`[AnimeKai] Cleaned JSON (${cleanJson.length} chars):`, cleanJson.substring(0, 200));

    let streamData: any;
    try {
      streamData = JSON.parse(cleanJson);
    } catch {
      // JSON parse can fail if decryption produced mid-stream garbage.
      // Try regex-extracting the URL from the cleaned data — it's usually intact.
      const urlMatch = cleanJson.match(/"url"\s*:\s*"([^"]+)"/);
      if (urlMatch) {
        streamData = { url: urlMatch[1].replace(/\\\//g, '/') };
      } else {
        console.log(`[AnimeKai] Failed to parse cleaned JSON:`, cleanJson.substring(0, 100));
        return null;
      }
    }

    // Extract stream URL
    let streamUrl = '';
    if (streamData.url) {
      streamUrl = streamData.url;
    } else if (streamData.sources && streamData.sources[0]) {
      streamUrl = streamData.sources[0].url || streamData.sources[0].file || '';
    } else if (streamData.file) {
      streamUrl = streamData.file;
    }

    if (!streamUrl) {
      console.log(`[AnimeKai] No stream URL in decrypted data:`, streamData);
      return null;
    }

    console.log(`[AnimeKai] ✓ Got URL from ${serverName}:`, streamUrl);

    // Handle animekai.to/iframe/... URLs (new format)
    // Datacenter IPs are often blocked by animekai.to, so extraction may fail.
    // Don't hard-fail — the URL will continue through the embed/MegaUp handling chain.
    if (streamUrl.includes('animekai.to/iframe')) {
      console.log(`[AnimeKai] Detected AnimeKai iframe URL, extracting video source...`);
      const extractedUrl = await extractFromKaiIframe(streamUrl);
      if (extractedUrl) {
        streamUrl = extractedUrl;
        console.log(`[AnimeKai] Extracted from iframe:`, streamUrl.substring(0, 100));
      } else {
        console.log(`[AnimeKai] Iframe extraction failed — deferring to downstream handlers`);
      }
    }

    // Check if this is an embed URL that needs further decryption
    if (streamUrl.includes('megaup') && streamUrl.includes('/e/')) {
      console.log(`[AnimeKai] Detected MegaUp embed URL, decrypting to get HLS stream...`);
      const hlsUrl = await decryptMegaUpEmbed(streamUrl);
      if (hlsUrl) {
        streamUrl = hlsUrl;
        console.log(`[AnimeKai] ✓ Got HLS stream from MegaUp:`, streamUrl.substring(0, 100));
      } else {
        console.log(`[AnimeKai] MegaUp server-side resolution failed — deferring to client-side handler`);
        // Don't hard-fail. The VideoPlayer's browser-side resolver
        // (animekai-client-iframe.ts) runs from a residential IP and
        // can resolve MegaUp where the server can't.
      }
    }
    else if (streamUrl.includes('rapid') && streamUrl.includes('/e/')) {
      console.log(`[AnimeKai] Detected RapidShare embed URL, decrypting...`);
      const hlsUrl = await decryptRapidShareEmbed(streamUrl);
      if (hlsUrl) {
        streamUrl = hlsUrl;
      } else {
        console.log(`[AnimeKai] RapidShare extraction failed`);
        return null;
      }
    }
    else if (!streamUrl.includes('.m3u8') && !streamUrl.includes('.mp4') && streamUrl.includes('/e/')) {
      console.log(`[AnimeKai] Unknown embed type, trying generic extraction...`);
      const hlsUrl = await extractMegaUpSourcesManually(streamUrl);
      if (hlsUrl) {
        streamUrl = hlsUrl;
      } else {
        console.log(`[AnimeKai] Failed to extract from unknown embed type`);
        return null;
      }
    }

    let referer = `${KAI_BASE}/`;
    try {
      const streamOrigin = new URL(streamUrl).origin;
      referer = streamOrigin + '/';
    } catch {}

    return {
      quality: 'auto',
      title: `AnimeKai - ${serverName}`,
      url: streamUrl,
      type: 'hls',
      referer,
      requiresSegmentProxy: true,
      skipOrigin: isMegaUpCdnUrl(streamUrl),
      status: 'working',
      language: 'ja',
    };
  } catch (error) {
    console.log(`[AnimeKai] Local extraction error:`, error);
    return null;
  }
}


// ============================================================================
// Shared Resolution: Anime → Episode → Servers
// Used by both extractAnimeKaiStreams() and fetchAnimeKaiSourceByName()
// ============================================================================

interface ResolvedServers {
  servers: ParsedServers;
  episodeNumber: number;
}

/**
 * Resolve anime identity, episode token, and server list.
 * Shared between main extraction and fetchSourceByName to avoid duplication.
 *
 * Returns null with an error string if resolution fails at any step.
 */
async function resolveAnimeServers(
  tmdbId: string,
  type: 'movie' | 'tv',
  episode?: number,
  malId?: number,
  malTitle?: string,
): Promise<{ result: ResolvedServers; error: null } | { result: null; error: string }> {
  const effectiveMalId = malId || null;
  const searchTitle = malTitle || '';

  // Step 1: Determine MAL ID
  let finalMalId: number | null = effectiveMalId;
  if (!finalMalId && tmdbId && tmdbId !== '0') {
    console.log(`[AnimeKai] No MAL ID provided, looking up from TMDB ID ${tmdbId}...`);
    const animeIds = await getAnimeIds(tmdbId, type);
    finalMalId = animeIds.mal_id;
    console.log(`[AnimeKai] TMDB → MAL lookup result: ${finalMalId || 'not found'}`);
  }

  // Step 2: Get search title
  let finalSearchTitle = searchTitle;
  if (!finalSearchTitle && tmdbId && tmdbId !== '0') {
    const tmdbInfo = await getTmdbAnimeInfo(tmdbId, type);
    finalSearchTitle = tmdbInfo?.title || '';
  }
  if (!finalMalId && !finalSearchTitle) {
    return { result: null, error: 'Could not identify anime - no MAL ID or title found' };
  }

  console.log(`[AnimeKai] Resolving: MAL=${finalMalId || 'none'}, title="${finalSearchTitle}", ep=${episode || 1}`);

  // Step 3: Search AnimeKai
  let animeResult: { content_id: string; title: string; episodes?: ParsedEpisodes } | null = null;
  if (finalMalId) {
    animeResult = await searchAnimeKai(finalSearchTitle, finalMalId);
  }
  if (!animeResult && finalSearchTitle) {
    animeResult = await searchAnimeKai(finalSearchTitle, null);
  }
  if (!animeResult) {
    return { result: null, error: 'Anime not found in AnimeKai database' };
  }
  console.log(`[AnimeKai] ✓ FOUND: "${animeResult.title}" (content_id: ${animeResult.content_id})`);

  // Step 4: Get episodes
  let episodes: ParsedEpisodes | null = animeResult.episodes || null;
  if (!episodes) {
    episodes = await getEpisodes(animeResult.content_id);
  }
  if (!episodes) {
    return { result: null, error: 'Failed to get episodes list' };
  }

  // Step 5: Find episode token
  const episodeNumber = type === 'movie' ? 1 : (episode || 1);
  const episodeKey = String(episodeNumber);
  let episodeToken: string | null = null;

  // Strategy 1: season "1" with episode number (most common)
  const season1 = episodes['1'];
  if (season1?.[episodeKey]) {
    const epData = season1[episodeKey];
    if (epData && typeof epData === 'object' && 'token' in epData) {
      episodeToken = epData.token;
    }
  }
  // Strategy 2: direct access
  if (!episodeToken && episodes[episodeKey]) {
    const episodeData = episodes[episodeKey];
    if (typeof episodeData === 'object' && 'token' in episodeData) {
      episodeToken = (episodeData as any).token;
    } else {
      const subKeys = Object.keys(episodeData);
      if (subKeys.length > 0) {
        const firstEntry = episodeData[subKeys[0]];
        if (firstEntry && typeof firstEntry === 'object' && 'token' in firstEntry) {
          episodeToken = firstEntry.token;
        }
      }
    }
  }
  if (!episodeToken) {
    return { result: null, error: `Episode ${episodeNumber} not found in AnimeKai` };
  }

  // Step 6: Get servers
  const servers = await getServers(episodeToken);
  if (!servers) {
    return { result: null, error: 'Failed to get servers list' };
  }

  return { result: { servers, episodeNumber }, error: null };
}

/**
 * Main extraction function for AnimeKai — MAL ID focused approach
 *
 * Flow:
 * 1. Determine MAL ID (from parameter or TMDB lookup)
 * 2. Search AnimeKai with title, match by syncData.mal_id
 * 3. Get episodes for the matched anime
 * 4. Find episode token (episode number is relative to MAL entry)
 * 5. Get servers and extract streams (sub + dub in parallel)
 *
 * @param tmdbId - TMDB ID of the content
 * @param type - 'movie' or 'tv'
 * @param _season - Season number (TMDB) - unused in MAL ID focused approach, kept for API compatibility
 * @param episode - Episode number (relative to MAL entry)
 * @param malId - Optional MAL ID for direct lookup (used when TMDB season is split into multiple MAL entries)
 * @param malTitle - Optional MAL title for the specific entry
 */
export async function extractAnimeKaiStreams(
  tmdbId: string,
  type: 'movie' | 'tv',
  _season?: number,
  episode?: number,
  malId?: number,
  malTitle?: string
): Promise<ExtractionResult> {
  console.log(`[AnimeKai] Extracting streams for ${type} TMDB ID ${tmdbId}, E${episode || 1}...`);
  if (malId) {
    console.log(`[AnimeKai] MAL ID: ${malId}, Title: "${malTitle}"`);
  }
  try {
    // Resolve anime → episode → servers (shared with fetchSourceByName)
    const resolved = await resolveAnimeServers(tmdbId, type, episode, malId, malTitle);
    if (!resolved.result) {
      return { success: false, sources: [], error: resolved.error };
    }
    const { servers } = resolved.result;

    // Step 7: Try servers - get sources from both sub AND dub
    // Process servers in PARALLEL to avoid sequential rate limiting
    const allSources: StreamSource[] = [];
    const subSources: StreamSource[] = [];
    const dubSources: StreamSource[] = [];

    // Collect all server tasks
    const serverTasks: Array<{
      lid: string;
      displayName: string;
      type: 'sub' | 'dub';
    }> = [];

    // Add sub servers
    const subServerList = servers.sub;
    if (subServerList) {
      for (const [serverKey, serverData] of Object.entries(subServerList)) {
        const server = serverData as any;
        if (!server.lid) continue;
        const serverName = server.name || `Server ${serverKey}`;
        serverTasks.push({
          lid: server.lid,
          displayName: `${serverName} (sub)`,
          type: 'sub',
        });
      }
    }

    // Add softsub servers (treated as sub — soft subtitles)
    const softsubServerList = servers.softsub;
    if (softsubServerList) {
      for (const [serverKey, serverData] of Object.entries(softsubServerList)) {
        const server = serverData as any;
        if (!server.lid) continue;
        const serverName = server.name || `Server ${serverKey}`;
        serverTasks.push({
          lid: server.lid,
          displayName: `${serverName} (softsub)`,
          type: 'sub',
        });
      }
    }

    // Add dub servers
    const dubServerList = servers.dub;
    if (dubServerList) {
      for (const [serverKey, serverData] of Object.entries(dubServerList)) {
        const server = serverData as any;
        if (!server.lid) continue;
        const serverName = server.name || `Server ${serverKey}`;
        serverTasks.push({
          lid: server.lid,
          displayName: `${serverName} (dub)`,
          type: 'dub',
        });
      }
    }

    // Process all servers in parallel
    console.log(`[AnimeKai] Processing ${serverTasks.length} servers in parallel...`);
    const results = await Promise.allSettled(
      serverTasks.map(async (task) => {
        const source = await getStreamFromServer(task.lid, task.displayName);
        if (source) {
          source.title = task.displayName;
          source.language = task.type === 'dub' ? 'en' : 'ja';
          return { source, type: task.type };
        }
        return null;
      })
    );

    // Collect successful results
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        const { source, type } = result.value;
        if (type === 'sub' && subSources.length < 2) {
          subSources.push(source);
          console.log(`[AnimeKai] ✓ Got SUB source from ${source.title}`);
        } else if (type === 'dub' && dubSources.length < 2) {
          dubSources.push(source);
          console.log(`[AnimeKai] ✓ Got DUB source from ${source.title}`);
        }
      }
    }

    // Combine: sub sources first, then dub
    allSources.push(...subSources, ...dubSources);
    
    console.log(`[AnimeKai] Total sources: ${allSources.length} (${subSources.length} sub, ${dubSources.length} dub)`)

    if (allSources.length === 0) {
      console.log('[AnimeKai] All servers failed');
      return {
        success: false,
        sources: [],
        error: 'All AnimeKai servers failed',
      };
    }

    console.log(`[AnimeKai] Returning ${allSources.length} sources`);
    
    // Log final source URLs for debugging
    allSources.forEach((src, i) => {
      console.log(`[AnimeKai] Source ${i + 1}: ${src.title}`);
      console.log(`[AnimeKai]   URL: ${src.url}`);
      console.log(`[AnimeKai]   Referer: ${src.referer}`);
    });

    return {
      success: true,
      sources: allSources,
    };
  } catch (error) {
    console.error('[AnimeKai] Extraction error:', error);
    return {
      success: false,
      sources: [],
      error: `AnimeKai extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}


/**
 * Fetch a specific AnimeKai server by name
 * Uses the shared resolveAnimeServers to avoid duplicating steps 1-6
 */
export async function fetchAnimeKaiSourceByName(
  serverName: string,
  tmdbId: string,
  type: 'movie' | 'tv',
  _season?: number,
  episode?: number,
  malId?: number,
  malTitle?: string
): Promise<StreamSource | null> {
  console.log(`[AnimeKai] Fetching specific server: ${serverName}`);

  try {
    const resolved = await resolveAnimeServers(tmdbId, type, episode, malId, malTitle);
    if (!resolved.result) {
      console.log(`[AnimeKai] Resolution failed: ${resolved.error}`);
      return null;
    }
    const { servers } = resolved.result;

    // Find the specific server by name across sub and dub
    const serverTypes: Array<'sub' | 'dub'> = ['sub', 'dub'];

    for (const serverType of serverTypes) {
      const serverList = servers[serverType];
      if (!serverList) continue;

      for (const [, serverData] of Object.entries(serverList)) {
        const server = serverData as any;
        const displayName = `${server.name || 'Server'} (${serverType})`;

        if (serverName.includes(server.name) || serverName === displayName) {
          const source = await getStreamFromServer(server.lid, displayName);
          if (source) {
            source.language = serverType === 'dub' ? 'en' : 'ja';
            return source;
          }
        }
      }
    }

    return null;
  } catch (error) {
    console.error(`[AnimeKai] Fetch source by name error:`, error);
    return null;
  }
}

// Export enabled flag
export const ANIMEKAI_ENABLED = true;
