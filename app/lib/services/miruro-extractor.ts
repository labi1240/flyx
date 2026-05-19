/**
 * Miruro Extractor — Thin client
 *
 * ALL extraction and pipe encryption happens on the Cloudflare Worker.
 * This module just calls the worker's /miruro endpoints and returns
 * clean results in the standard StreamSource format.
 */

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

/**
 * Fetch Miruro episodes via CF Worker (handles pipe encryption server-side)
 */
export async function extractMiruroEpisodes(anilistId: number): Promise<MiruroEpisodesResponse> {
  const baseUrl = getWorkerBaseUrl();
  const url = `${baseUrl}/miruro/episodes?anilistId=${anilistId}`;

  console.log(`[Miruro] Fetching episodes for AniList ID ${anilistId}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });

  if (!res.ok) {
    throw new Error(`Miruro episodes fetch failed: ${res.status}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(data.error);
  }

  return data as MiruroEpisodesResponse;
}

/**
 * Fetch stream sources for a specific episode + provider + category
 */
export async function extractMiruroSources(
  episodeId: string,
  provider: string = 'kiwi',
  category: 'sub' | 'dub' = 'sub',
): Promise<MiruroSourcesResponse> {
  const baseUrl = getWorkerBaseUrl();
  const params = new URLSearchParams({ episodeId, provider, category });
  const url = `${baseUrl}/miruro/sources?${params.toString()}`;

  console.log(`[Miruro] Fetching sources: provider=${provider}, category=${category}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });

  if (!res.ok) {
    throw new Error(`Miruro sources fetch failed: ${res.status}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(data.error);
  }

  return data as MiruroSourcesResponse;
}

/**
 * Resolve MAL ID to AniList ID.
 * Miruro uses AniList IDs internally — MAL IDs are different (e.g. JJK: MAL=40748, AniList=113415).
 */
async function resolveAnilistId(malId: number): Promise<number | null> {
  try {
    const { getAnimeByMalId } = await import('./anilist');
    const media = await getAnimeByMalId(malId);
    return media?.id ?? null;
  } catch {
    return null;
  }
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
