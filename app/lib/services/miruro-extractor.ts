/**
 * Miruro Extractor
 *
 * Uses the Miruro Pipe Protocol v2 for direct API access (bypasses CF Worker).
 * Falls back to CF Worker only when direct pipe is unavailable (e.g. datacenter IPs).
 */

import { gunzipSync } from 'zlib';
import type { StreamSource, SubtitleTrack } from '../providers/types';

interface MiruroEpisode {
  id: string;
  number: number;
  title: string;
  airDate: string;
  duration: number;
  audio: 'sub' | 'dub';
  description: string;
  filler: boolean;
  image: string;
}

interface MiruroProviderMeta {
  id: string;
  title: string;
}

interface MiruroProviderEpisodes {
  meta: MiruroProviderMeta;
  episodes: {
    sub: MiruroEpisode[];
    dub: MiruroEpisode[];
  };
}

interface MiruroEpisodesResponse {
  mappings: Record<string, number>;
  providers: Record<string, MiruroProviderEpisodes>;
}

interface MiruroStream {
  url: string;
  type: 'hls' | 'embed';
  quality: string;
  resolution?: { width: number; height: number };
  codec?: string;
  audio?: string;
  fansub?: string;
  isActive: boolean;
  referer?: string;
}

interface MiruroSourcesResponse {
  streams: MiruroStream[];
  download?: string;
}

interface MiruroInfoResponse {
  media: {
    id: number;
    title: { romaji: string; english: string; native: string };
    description: string;
    coverImage: { large: string; medium: string };
    bannerImage: string;
    episodes: number;
    duration: number;
    status: string;
    format: string;
    genres: string[];
    averageScore: number;
    popularity: number;
    trending: number;
    season: string;
    seasonYear: number;
    studios: { nodes: Array<{ name: string }> };
  };
}

interface ExtractionResult {
  success: boolean;
  sources: StreamSource[];
  subtitles?: SubtitleTrack[];
  episodes?: {
    sub: MiruroEpisode[];
    dub: MiruroEpisode[];
    providers: Record<string, { sub: number; dub: number }>;
  };
  error?: string;
}

function getWorkerBaseUrl(): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL ||
    process.env.CF_STREAM_PROXY_URL ||
    'https://media-proxy.vynx-3b3.workers.dev/stream';
  return cfProxyUrl.replace(/\/stream\/?$/, '');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Miruro Pipe Protocol v2 — direct API access (bypasses CF Worker)
// ═══════════════════════════════════════════════════════════════════════════════

const MIRURO_BASE = 'https://miruro.to';
const PIPE_KEY_HEX = '71951034f8fbcf53d89db52ceb3dc22c';
const PIPE_KEY_BYTES = new Uint8Array(
  PIPE_KEY_HEX.match(/.{2}/g)!.map(h => parseInt(h, 16))
);

function base64urlEncode(str: string): string {
  const base64 = Buffer.from(str, 'binary').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodePipeEnvelope(envelope: Record<string, unknown>): string {
  const json = JSON.stringify(envelope);
  const encoded = encodeURIComponent(json).replace(
    /%([0-9A-F]{2})/g,
    (_, hex: string) => String.fromCharCode(parseInt(hex, 16))
  );
  return base64urlEncode(encoded);
}

async function decodePipeResponse(text: string): Promise<any> {
  // base64url → bytes
  let base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  const bytes = Buffer.from(base64, 'base64');

  // XOR with 16-byte hex key
  const xored = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    xored[i] = bytes[i] ^ PIPE_KEY_BYTES[i % PIPE_KEY_BYTES.length];
  }

  // Gunzip → JSON
  const decompressed = gunzipSync(xored);
  return JSON.parse(decompressed.toString('utf8'));
}

async function miruroDirectGet(path: string, params: Record<string, string>): Promise<any> {
  const envelope = {
    path,
    method: 'GET',
    query: params,
    body: null,
    version: '0.2.0',
  };

  const e = encodePipeEnvelope(envelope);
  const url = `${MIRURO_BASE}/api/secure/pipe?e=${encodeURIComponent(e)}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Origin': MIRURO_BASE,
      'Referer': `${MIRURO_BASE}/`,
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Miruro ${path} returned ${res.status}`);
  }

  const text = await res.text();
  return decodePipeResponse(text);
}

async function miruroGetViaWorker(path: string, params: Record<string, string>): Promise<any> {
  const baseUrl = getWorkerBaseUrl();
  const searchParams = new URLSearchParams(params);
  const url = `${baseUrl}/miruro/${path}?${searchParams.toString()}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });

  if (!res.ok) {
    throw new Error(`Miruro ${path} fetch failed: ${res.status}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(data.error);
  }

  return data;
}

/**
 * Miruro API call — tries direct pipe first (faster, no dependency on CF Worker
 * which is blocked by Miruro's anti-bot). Falls back to CF Worker if direct pipe
 * fails (e.g. from datacenter IPs like Vercel where Miruro might block the request).
 */
async function miruroSmartGet(path: string, params: Record<string, string>): Promise<any> {
  // Always try direct pipe first — no cached failure state.
  // Miruro blocks CF Worker IPs (returns fake 400 "Invalid envelope format"),
  // so the worker fallback is only useful from datacenter IPs where the
  // Next.js server can't reach Miruro directly either.
  try {
    return await miruroDirectGet(path, params);
  } catch (err) {
    console.log('[Miruro] Direct pipe failed, trying CF Worker:', (err as Error).message);
    return miruroGetViaWorker(path, params);
  }
}

/**
 * Fetch Miruro episodes
 */
export async function extractMiruroEpisodes(anilistId: number): Promise<MiruroEpisodesResponse> {
  console.log(`[Miruro] Fetching episodes for AniList ID ${anilistId}`);
  return miruroSmartGet('episodes', { anilistId: String(anilistId) });
}

/**
 * Fetch stream sources for a specific episode + provider + category
 */
export async function extractMiruroSources(
  episodeId: string,
  provider: string = 'kiwi',
  category: 'sub' | 'dub' = 'sub',
): Promise<MiruroSourcesResponse> {
  console.log(`[Miruro] Fetching sources: provider=${provider}, category=${category}`);
  return miruroSmartGet('sources', { episodeId, provider, category });
}

/**
 * Resolve MAL ID to AniList ID.
 * Miruro uses AniList IDs internally — MAL IDs are different (e.g. JJK: MAL=40748, AniList=113415).
 */
const ARM_API = 'https://arm.haglund.dev/api/v2/ids';

async function resolveAnilistId(malId: number): Promise<number | null> {
  // Strategy 1: ARM API (community ID mapping, doesn't block CF edge IPs)
  // Try multiple source identifiers — ARM may use "mal" or "myanimelist"
  for (const source of ['myanimelist']) {
    try {
      const res = await fetch(`${ARM_API}?source=${source}&id=${malId}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json() as { anilist?: number; mal?: number };
        if (data.anilist) return data.anilist;
      }
    } catch { /* try next */ }
  }

  // Strategy 2: Direct AniList GraphQL (works in local dev, blocked on CF edge)
  try {
    const query = `query ($malId: Int) { Media(idMal: $malId, type: ANIME) { id } }`;
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Origin: 'https://anilist.co',
        Referer: 'https://anilist.co/',
      },
      body: JSON.stringify({ query, variables: { malId } }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json() as { data?: { Media?: { id: number } | null } };
      return data?.data?.Media?.id ?? null;
    }
  } catch { /* fall through */ }

  return null;
}

/**
 * Full Miruro extraction pipeline:
 * 1. Resolve malId→AniList ID (Miruro uses AniList IDs, not MAL IDs)
 * 2. Get episodes for the AniList ID → find provider with requested language
 * 3. Get target episode ID
 * 4. Get sources → return StreamSource[]
 *
 * @param malId - MyAnimeList ID (will be auto-converted to AniList ID internally)
 */
export async function extractMiruroStreams(
  malId: number,
  title: string,
  episode?: number,
  language: 'sub' | 'dub' = 'sub',
): Promise<ExtractionResult> {
  const startTime = Date.now();

  try {
    // Step 0: Resolve MAL ID → AniList ID
    const anilistId = await resolveAnilistId(malId);
    if (!anilistId) {
      return {
        success: false,
        sources: [],
        error: `Could not resolve MAL ID ${malId} to AniList ID`,
      };
    }
    console.log(`[Miruro] Resolved MAL ${malId} → AniList ${anilistId}`);

    // Step 1: Get episodes
    const episodesData = await extractMiruroEpisodes(anilistId);

    // Find the best provider for the requested language
    // Priority: kiwi (sub), bee (dub/sub), ally (sub/dub), dune (sub), hop (sub)
    const providerPriority = language === 'dub'
      ? ['bee', 'ally']  // Providers that support dub
      : ['kiwi', 'bee', 'ally', 'dune', 'hop'];  // All providers

    let targetProvider = '';
    let targetEpisodes: MiruroEpisode[] = [];
    let providerSummary: Record<string, { sub: number; dub: number }> = {};

    // Build provider summary and find best match
    for (const [name, data] of Object.entries(episodesData.providers)) {
      providerSummary[name] = {
        sub: data.episodes.sub?.length || 0,
        dub: data.episodes.dub?.length || 0,
      };
    }

    for (const name of providerPriority) {
      const providerData = episodesData.providers[name];
      if (!providerData) continue;

      const episodes = language === 'dub'
        ? providerData.episodes.dub
        : providerData.episodes.sub;

      if (episodes && episodes.length > 0) {
        targetProvider = name;
        targetEpisodes = episodes;
        console.log(`[Miruro] Using provider "${name}" — ${episodes.length} ${language} episodes`);
        break;
      }
    }

    if (!targetProvider || targetEpisodes.length === 0) {
      return {
        success: false,
        sources: [],
        error: `No ${language} episodes found for anime ${anilistId}`,
      };
    }

    // Step 2: Find target episode (default to first if no episode specified)
    const targetEpisode = episode
      ? targetEpisodes.find(e => e.number === episode)
      : targetEpisodes[0];

    if (!targetEpisode) {
      return {
        success: false,
        sources: [],
        error: `Episode ${episode} not found in ${language} for ${title}`,
      };
    }

    console.log(`[Miruro] Target episode: #${targetEpisode.number} — "${targetEpisode.title}"`);

    // Step 3: Get sources
    const sourcesData = await extractMiruroSources(
      targetEpisode.id,
      targetProvider,
      language,
    );

    if (!sourcesData.streams || sourcesData.streams.length === 0) {
      return {
        success: false,
        sources: [],
        error: 'No streams available for this episode',
      };
    }

    // Convert to StreamSource format
    const sources: StreamSource[] = sourcesData.streams
      .filter(s => s.isActive !== false && s.type === 'hls')
      .map(s => ({
        url: s.url,
        quality: s.quality || 'auto',
        type: s.type as 'hls',
        title: `${targetProvider.toUpperCase()}${s.fansub ? ` [${s.fansub}]` : ''}`,
        language: s.audio || language,
        referer: s.referer || 'https://kwik.cx/',
        requiresSegmentProxy: true,
      }));

    if (sources.length === 0) {
      // Try embed sources as fallback
      const embedSources = sourcesData.streams.filter(s => s.type === 'embed');
      if (embedSources.length > 0) {
        console.log(`[Miruro] Only ${embedSources.length} embed sources available`);
        return {
          success: false,
          sources: [],
          error: 'Only embed sources available — not yet supported',
        };
      }

      return {
        success: false,
        sources: [],
        error: 'No playable sources found',
      };
    }

    // Proxy source URLs through the CF Worker
    const baseUrl = getWorkerBaseUrl();
    const proxiedSources: StreamSource[] = sources.map(s => ({
      ...s,
      url: `${baseUrl}/miruro/stream?url=${encodeURIComponent(s.url)}`,
      requiresSegmentProxy: false, // Worker handles segment proxying
    }));

    const executionTime = Date.now() - startTime;
    console.log(`[Miruro] Extraction complete in ${executionTime}ms — ${proxiedSources.length} sources`);

    return {
      success: true,
      sources: proxiedSources,
      episodes: {
        sub: episodesData.providers[targetProvider]?.episodes.sub || [],
        dub: episodesData.providers[targetProvider]?.episodes.dub || [],
        providers: providerSummary,
      },
    };
  } catch (e: any) {
    console.error('[Miruro] Extraction failed:', e);
    return {
      success: false,
      sources: [],
      error: e.message || 'Miruro extraction failed',
    };
  }
}

/**
 * Search Miruro for anime
 */
export async function searchMiruro(query: string): Promise<any> {
  const baseUrl = getWorkerBaseUrl();
  const url = `${baseUrl}/miruro/search?q=${encodeURIComponent(query)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

  if (!res.ok) {
    throw new Error(`Miruro search failed: ${res.status}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

/**
 * Get anime info from Miruro
 */
export async function getMiruroInfo(anilistId: number): Promise<MiruroInfoResponse> {
  const baseUrl = getWorkerBaseUrl();
  const url = `${baseUrl}/miruro/info?anilistId=${anilistId}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

  if (!res.ok) {
    throw new Error(`Miruro info fetch failed: ${res.status}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data as MiruroInfoResponse;
}
