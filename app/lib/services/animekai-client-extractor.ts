/**
 * AnimeKai Browser-Direct Extractor
 *
 * Calls animekai.to APIs directly from the browser's residential IP.
 * The Service Worker intercepts these requests, adds Referer/Origin headers,
 * and returns responses with CORS headers.
 *
 * Crypto: Native position-dependent substitution cipher (183 tables).
 * MegaUp decryption: Native XOR with pre-computed keystream (no external API).
 *
 * Flow:
 *   1. Search AnimeKai by MAL ID → get content_id
 *   2. Encrypt content_id → fetch episodes list → find episode token
 *   3. Encrypt token → fetch servers list (sub + dub)
 *   4. Encrypt lid → fetch encrypted embed → decrypt (native)
 *   5. If MegaUp embed → fetch /media/ (SW handles CDN headers) → decrypt (native XOR)
 */

export interface AnimeKaiSource {
  quality: string;
  title: string;
  url: string;
  type: 'hls';
  language: string;
  requiresSegmentProxy: boolean;
  skipIntro?: [number, number];
  skipOutro?: [number, number];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Browser-compatible AnimeKai Crypto
// (same algorithms as animekai-crypto.ts but using Uint8Array)
// ═══════════════════════════════════════════════════════════════════════════════

import { encryptAnimeKai, decryptAnimeKai } from '../animekai-crypto';
import { decryptMegaUp } from '../megaup-crypto';

function encrypt(text: string): string | null {
  try {
    return encryptAnimeKai(text);
  } catch (e) {
    console.warn('[AnimeKai] encrypt error:', e);
    return null;
  }
}

function decrypt(text: string): string | null {
  try {
    return decryptAnimeKai(text);
  } catch (e) {
    console.warn('[AnimeKai] decrypt error:', e);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AnimeKai API (browser-direct via Service Worker)
// ═══════════════════════════════════════════════════════════════════════════════

const KAI_DOMAINS = ['https://animekai.to', 'https://anikai.to'];

const AJAX_HEADERS: Record<string, string> = {
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
};

const PAGE_HEADERS: Record<string, string> = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// The SW adds Referer/Origin for animekai.to/anikai.to domains automatically

async function fetchKai(url: string, headers: Record<string, string>, timeoutMs = 10000): Promise<Response | null> {
  for (const domain of KAI_DOMAINS) {
    try {
      const resolvedUrl = url.startsWith('http')
        ? (domain === KAI_DOMAINS[0] ? url : url.replace(KAI_DOMAINS[0], domain))
        : `${domain}${url}`;

      const res = await fetch(resolvedUrl, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
    } catch { /* try next domain */ }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Title Matching
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeTitle(title: string): string {
  return title.toLowerCase()
    .replace(/[-_:;,./\\|]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\bpart\s+(\d+)\b/g, 'part$1')
    .replace(/\bseason\s+(\d+)\b/g, 'season$1')
    .trim();
}

function scoreMatch(resultTitle: string, query: string): number {
  const nr = normalizeTitle(resultTitle);
  const nq = normalizeTitle(query);
  if (nr === nq) return 100;
  if (nr.startsWith(nq)) return 90;
  if (nq.startsWith(nr)) return 85;
  if (nr.includes(nq)) return 70;

  const penaltyWords = ['movie', 'execution', 'ova', 'special', 'recap', 'summary'];
  let score = 50;
  for (const word of penaltyWords) {
    if (nr.includes(word) && !nq.includes(word)) score -= 20;
  }
  return Math.max(score, 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Search + Lookup
// ═══════════════════════════════════════════════════════════════════════════════

interface SearchResult {
  slug: string;
  enTitle: string;
  jpTitle: string;
}

async function searchKai(query: string): Promise<SearchResult[]> {
  const res = await fetchKai(`/ajax/anime/search?keyword=${encodeURIComponent(query)}`, AJAX_HEADERS);
  if (!res) return [];

  try {
    const json = await res.json() as { result?: { html?: string } };
    if (!json.result?.html) return [];

    const results: SearchResult[] = [];
    const regex = /<a[^>]*href="\/watch\/([^"]+)"[^>]*>[\s\S]*?<h6[^>]*class="title"[^>]*(?:data-jp="([^"]*)")?[^>]*>([^<]*)<\/h6>/gi;
    let match;
    while ((match = regex.exec(json.result.html)) !== null) {
      results.push({ slug: match[1], jpTitle: match[2] || '', enTitle: match[3].trim() });
    }
    return results;
  } catch {
    return [];
  }
}

async function getSyncData(slug: string): Promise<{ mal_id?: number; anime_id?: string } | null> {
  const res = await fetchKai(`/watch/${slug}`, PAGE_HEADERS);
  if (!res) return null;

  try {
    const html = await res.text();
    const syncMatch = html.match(/<script[^>]*id="syncData"[^>]*>([\s\S]*?)<\/script>/);
    if (syncMatch) {
      const data = JSON.parse(syncMatch[1]);
      return { mal_id: data.mal_id ? parseInt(data.mal_id) : undefined, anime_id: data.anime_id };
    }
  } catch { /* ignore */ }
  return null;
}

async function findAnimeByMalId(malId: number, title: string): Promise<{ contentId: string; title: string } | null> {
  // Try primary search
  let results = await searchKai(title);

  // Try cleaned title
  if (results.length === 0) {
    const cleanTitle = title.replace(/\s*\(TV\)\s*/gi, '').replace(/\s*Season\s*\d+\s*/gi, '').trim();
    if (cleanTitle !== title) results = await searchKai(cleanTitle);
  }

  if (results.length === 0) {
    console.warn('[AnimeKai] No search results');
    return null;
  }

  // Score and check top candidates in parallel
  const scored = results
    .map(r => ({ ...r, score: Math.max(scoreMatch(r.enTitle, title), r.jpTitle ? scoreMatch(r.jpTitle, title) : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  console.log(`[AnimeKai] Checking ${scored.length} candidates for MAL ${malId}...`);

  const checks = await Promise.allSettled(
    scored.map(async (r) => {
      const sync = await getSyncData(r.slug);
      if (sync?.mal_id === malId && sync.anime_id) {
        console.log(`[AnimeKai] MAL match: ${r.enTitle} (anime_id=${sync.anime_id})`);
        return { contentId: sync.anime_id, title: r.enTitle || r.jpTitle };
      }
      return null;
    })
  );

  for (const c of checks) {
    if (c.status === 'fulfilled' && c.value) return c.value;
  }

  // Single result fallback
  if (results.length === 1) {
    const sync = await getSyncData(results[0].slug);
    if (sync?.anime_id) {
      console.log(`[AnimeKai] Single result fallback: ${results[0].enTitle}`);
      return { contentId: sync.anime_id, title: results[0].enTitle };
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Episodes & Servers
// ═══════════════════════════════════════════════════════════════════════════════

interface EpisodeEntry {
  token: string;
}

type EpisodesMap = Record<string, Record<string, EpisodeEntry>>;

function parseEpisodesHtml(html: string): EpisodesMap | null {
  const episodes: EpisodesMap = {};
  const regex = /<a[^>]*\bnum="(\d+)"[^>]*\btoken="([^"]+)"[^>]*>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    if (!episodes['1']) episodes['1'] = {};
    episodes['1'][match[1]] = { token: match[2] };
  }
  return Object.keys(episodes).length > 0 ? episodes : null;
}

async function getEpisodes(contentId: string): Promise<EpisodesMap | null> {
  const encId = encrypt(contentId);
  if (!encId) return null;

  const res = await fetchKai(`/ajax/episodes/list?ani_id=${contentId}&_=${encId}`, AJAX_HEADERS);
  if (!res) return null;

  try {
    const json = await res.json() as { result?: string };
    if (!json.result) return null;
    return parseEpisodesHtml(json.result);
  } catch {
    return null;
  }
}

interface ServerEntry {
  lid: string;
  name: string;
}

type ServersMap = { sub?: Record<string, ServerEntry>; dub?: Record<string, ServerEntry> };

function parseServersHtml(html: string): ServersMap | null {
  const servers: ServersMap = {};

  const subMatch = html.match(/<div[^>]*data-id="sub"[^>]*>([\s\S]*?)<\/div>/i);
  if (subMatch) {
    servers.sub = {};
    const regex = /<span[^>]*class="server"[^>]*data-lid="([^"]+)"[^>]*>([^<]*)<\/span>/gi;
    let match;
    let idx = 1;
    while ((match = regex.exec(subMatch[1])) !== null) {
      servers.sub[String(idx++)] = { lid: match[1], name: match[2].trim() || `Server ${idx - 1}` };
    }
  }

  const dubMatch = html.match(/<div[^>]*data-id="dub"[^>]*>([\s\S]*?)<\/div>/i);
  if (dubMatch) {
    servers.dub = {};
    const regex = /<span[^>]*class="server"[^>]*data-lid="([^"]+)"[^>]*>([^<]*)<\/span>/gi;
    let match;
    let idx = 1;
    while ((match = regex.exec(dubMatch[1])) !== null) {
      servers.dub[String(idx++)] = { lid: match[1], name: match[2].trim() || `Server ${idx - 1}` };
    }
  }

  return (servers.sub || servers.dub) ? servers : null;
}

async function getServers(token: string): Promise<ServersMap | null> {
  const encToken = encrypt(token);
  if (!encToken) return null;

  const res = await fetchKai(`/ajax/links/list?token=${token}&_=${encToken}`, AJAX_HEADERS);
  if (!res) return null;

  try {
    const json = await res.json() as { result?: string };
    if (!json.result) return null;
    return parseServersHtml(json.result);
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stream Extraction
// ═══════════════════════════════════════════════════════════════════════════════

async function getEncryptedEmbed(lid: string): Promise<string | null> {
  const encLid = encrypt(lid);
  if (!encLid) return null;

  const res = await fetchKai(`/ajax/links/view?id=${lid}&_=${encLid}`, AJAX_HEADERS);
  if (!res) return null;

  try {
    const json = await res.json() as { result?: string };
    return json.result || null;
  } catch {
    return null;
  }
}

/**
 * Native MegaUp /media/ decryption — XOR with pre-computed keystream.
 * No external API dependency. Keystream is constant for our fixed User-Agent.
 */
function decryptMegaUpMedia(encryptedBase64: string): string | null {
  try {
    return decryptMegaUp(encryptedBase64);
  } catch (e) {
    console.warn('[AnimeKai] MegaUp native decrypt error:', e);
    return null;
  }
}

/**
 * Fetch MegaUp /media/ endpoint directly from browser (SW handles CDN headers).
 * Returns decrypted stream URL.
 */
async function extractMegaUpMedia(embedUrl: string): Promise<string | null> {
  try {
    const urlMatch = embedUrl.match(/https?:\/\/([^\/]+)\/e\/([^\/\?]+)/);
    if (!urlMatch) return null;

    const [, host, videoId] = urlMatch;
    const mediaUrl = `https://${host}/media/${videoId}`;

    console.log(`[AnimeKai] Fetching MegaUp /media/: ${mediaUrl.substring(0, 80)}`);

    // Direct browser fetch — SW intercepts megaup domains, strips Referer/Origin
    const res = await fetch(mediaUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.warn(`[AnimeKai] MegaUp /media/ returned ${res.status}`);
      return null;
    }

    const data = await res.json() as { status?: number; result?: string };
    if (data.status !== 200 || !data.result) return null;

    console.log(`[AnimeKai] Got encrypted MegaUp data (${data.result.length} chars), decrypting...`);

    // Decrypt via native keystream
    const decrypted = await decryptMegaUpMedia(data.result);
    if (!decrypted) return null;

    // Parse decrypted JSON
    const streamData = JSON.parse(decrypted);
    const streamUrl = streamData.sources?.[0]?.file
      || streamData.sources?.[0]?.url
      || streamData.file
      || streamData.url
      || '';

    if (streamUrl) {
      console.log(`[AnimeKai] MegaUp stream: ${streamUrl.substring(0, 80)}`);
      return streamUrl;
    }
    return null;
  } catch (e) {
    console.warn('[AnimeKai] MegaUp extraction error:', e);
    return null;
  }
}

/**
 * Get stream URL from a single server lid.
 */
async function getStreamFromServer(
  lid: string,
  serverName: string,
  language: 'ja' | 'en',
): Promise<AnimeKaiSource | null> {
  try {
    // Step 1: Get encrypted embed from AnimeKai
    const encryptedEmbed = await getEncryptedEmbed(lid);
    if (!encryptedEmbed) return null;

    console.log(`[AnimeKai] Got encrypted embed (${encryptedEmbed.length} chars) for ${serverName}`);

    // Step 2: Decrypt embed natively
    let decrypted = decrypt(encryptedEmbed);
    if (!decrypted) return null;

    // Step 3: Decode }XX format (AnimeKai's custom URL encoding)
    decrypted = decrypted.replace(/}([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );

    // Step 4: Parse decrypted data
    let streamUrl = '';
    let skipIntro: [number, number] | undefined;
    let skipOutro: [number, number] | undefined;

    try {
      const streamData = JSON.parse(decrypted);
      if (streamData.skip?.intro) skipIntro = streamData.skip.intro;
      if (streamData.skip?.outro) skipOutro = streamData.skip.outro;

      streamUrl = streamData.url
        || streamData.sources?.[0]?.url
        || streamData.sources?.[0]?.file
        || streamData.file
        || '';
    } catch {
      if (decrypted.startsWith('http')) {
        streamUrl = decrypted;
      }
    }

    if (!streamUrl) return null;

    // Step 5: If MegaUp embed URL → extract actual HLS
    if (streamUrl.includes('megaup') && streamUrl.includes('/e/')) {
      console.log(`[AnimeKai] Detected MegaUp embed, extracting...`);
      const hlsUrl = await extractMegaUpMedia(streamUrl);
      if (hlsUrl) streamUrl = hlsUrl;
      else return null; // MegaUp extraction failed
    } else if (streamUrl.includes('/e/') && !streamUrl.includes('.m3u8') && !streamUrl.includes('.mp4')) {
      // Generic embed URL
      const hlsUrl = await extractMegaUpMedia(streamUrl);
      if (hlsUrl) streamUrl = hlsUrl;
      else return null;
    }

    console.log(`[AnimeKai] Stream from ${serverName}: ${streamUrl.substring(0, 80)}`);

    return {
      quality: 'auto',
      title: `AnimeKai - ${serverName}`,
      url: streamUrl,
      type: 'hls',
      language,
      requiresSegmentProxy: true,
      skipIntro,
      skipOutro,
    };
  } catch (e) {
    console.warn(`[AnimeKai] getStreamFromServer error for ${serverName}:`, e);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Extractor
// ═══════════════════════════════════════════════════════════════════════════════

export async function extractAnimeKaiClient(
  malId: number,
  title: string,
  episode?: number,
  audioPref?: 'sub' | 'dub',
): Promise<AnimeKaiSource[]> {
  const targetEp = episode || 1;
  console.log(`[AnimeKai] Extracting: malId=${malId} title="${title}" ep=${targetEp} pref=${audioPref || 'sub'}`);

  // Ensure Service Worker is in control before making cross-origin requests
  if ('serviceWorker' in navigator) await navigator.serviceWorker.ready;

  // Step 1: Find anime on AnimeKai by MAL ID
  const anime = await findAnimeByMalId(malId, title);
  if (!anime) {
    console.warn('[AnimeKai] Could not find anime on AnimeKai');
    return [];
  }
  console.log(`[AnimeKai] Found: "${anime.title}" (content_id=${anime.contentId})`);

  // Step 2: Get episodes
  const episodes = await getEpisodes(anime.contentId);
  if (!episodes) {
    console.warn('[AnimeKai] No episodes found');
    return [];
  }

  // Step 3: Find episode token
  const epKey = String(targetEp);
  let episodeToken: string | null = null;

  const season1 = episodes['1'];
  if (season1?.[epKey]?.token) {
    episodeToken = season1[epKey].token;
  }
  if (!episodeToken && episodes[epKey]) {
    const epData = episodes[epKey];
    if (typeof epData === 'object' && 'token' in epData) {
      episodeToken = (epData as unknown as EpisodeEntry).token;
    } else {
      const subKeys = Object.keys(epData as Record<string, unknown>);
      if (subKeys.length > 0) {
        const first = (epData as Record<string, EpisodeEntry>)[subKeys[0]];
        if (first?.token) episodeToken = first.token;
      }
    }
  }
  if (!episodeToken) {
    console.warn(`[AnimeKai] Episode ${targetEp} not found`);
    return [];
  }

  // Step 4: Get servers
  const servers = await getServers(episodeToken);
  if (!servers) {
    console.warn('[AnimeKai] No servers');
    return [];
  }

  // Step 5: Collect server tasks (sub + dub)
  const tasks: Array<{ lid: string; name: string; lang: 'ja' | 'en' }> = [];

  if (servers.sub) {
    for (const [key, srv] of Object.entries(servers.sub)) {
      tasks.push({ lid: srv.lid, name: srv.name || `Server ${key} (sub)`, lang: 'ja' });
    }
  }
  if (servers.dub) {
    for (const [key, srv] of Object.entries(servers.dub)) {
      tasks.push({ lid: srv.lid, name: srv.name || `Server ${key} (dub)`, lang: 'en' });
    }
  }

  // If audio preference is set, prioritize matching servers
  if (audioPref === 'dub') {
    tasks.sort((a, b) => (a.lang === 'en' ? -1 : 1) - (b.lang === 'en' ? -1 : 1));
  } else {
    tasks.sort((a, b) => (a.lang === 'ja' ? -1 : 1) - (b.lang === 'ja' ? -1 : 1));
  }

  console.log(`[AnimeKai] Processing ${tasks.length} servers in parallel...`);

  // Step 6: Extract all servers in parallel
  const results = await Promise.allSettled(
    tasks.map(async (t) => {
      const source = await getStreamFromServer(t.lid, t.name, t.lang);
      return source;
    })
  );

  const sources: AnimeKaiSource[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      sources.push(r.value);
    }
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  const unique = sources.filter(s => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  console.log(`[AnimeKai] ${unique.length} unique sources (${unique.filter(s => s.language === 'ja').length} sub, ${unique.filter(s => s.language === 'en').length} dub)`);
  return unique;
}
