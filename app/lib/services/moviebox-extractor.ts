/**
 * MovieBox Extractor — Movies/TV/Anime Streaming
 *
 * MovieBox (themoviebox.org / moviebox.ph) uses a Nuxt 3 backend at
 * h5-api.aoneroom.com. The /subject/play endpoint is session-gated.
 * All extraction goes through the CF Worker which handles session
 * management and API proxying.
 */

import type { StreamSource } from '../providers/types';

interface ExtractionResult {
  success: boolean;
  sources: StreamSource[];
  error?: string;
}

function getWorkerBaseUrl(): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL ||
    process.env.CF_STREAM_PROXY_URL ||
    'https://media-proxy.vynx-3b3.workers.dev/stream';
  return cfProxyUrl.replace(/\/stream\/?$/, '');
}

/**
 * Extract stream sources from MovieBox for a movie or TV episode.
 * The CF Worker handles session management for the /subject/play endpoint.
 */
export async function extractMovieBoxStreams(
  subjectId: string,
  mediaType: 'movie' | 'tv',
  season?: number,
  episode?: number,
): Promise<ExtractionResult> {
  const baseUrl = getWorkerBaseUrl();
  const params = new URLSearchParams({ id: subjectId });
  if (mediaType === 'tv' && season !== undefined) params.set('s', season.toString());
  if (mediaType === 'tv' && episode !== undefined) params.set('e', episode.toString());

  const url = `${baseUrl}/moviebox/play?${params.toString()}`;
  console.log(`[MovieBox] Extracting streams: ${url}`);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });

    if (!res.ok) {
      return { success: false, sources: [], error: `MovieBox returned ${res.status}` };
    }

    const data = await res.json();
    if (data.error) {
      return { success: false, sources: [], error: data.error };
    }

    // Extract sources from the response
    // MovieBox returns various formats — try to normalize
    const sources: StreamSource[] = [];
    const rawData = data;

    // Format 1: {sources: [{url, quality, type}]}
    if (rawData.sources && Array.isArray(rawData.sources)) {
      for (const s of rawData.sources) {
        if (s.url) {
          sources.push({
            url: `${baseUrl}/moviebox/stream?url=${encodeURIComponent(s.url)}`,
            quality: s.quality || s.resolution || 'auto',
            type: s.type === 'mp4' ? 'mp4' : 'hls',
            title: `MovieBox${s.quality ? ` (${s.quality})` : ''}`,
            language: s.language || 'en',
            requiresSegmentProxy: false,
          });
        }
      }
    }

    // Format 2: {streams: [{playUrl, quality}]}
    if (rawData.streams && Array.isArray(rawData.streams)) {
      for (const s of rawData.streams) {
        const streamUrl = s.playUrl || s.url || s.src;
        if (streamUrl) {
          sources.push({
            url: `${baseUrl}/moviebox/stream?url=${encodeURIComponent(streamUrl)}`,
            quality: s.quality || s.resolution || 'auto',
            type: 'hls',
            title: `MovieBox${s.quality ? ` (${s.quality})` : ''}`,
            language: s.language || 'en',
            requiresSegmentProxy: false,
          });
        }
      }
    }

    // Format 3: {url: "direct_play_url"}
    if (sources.length === 0 && (rawData.url || rawData.playUrl || rawData.streamUrl)) {
      const streamUrl = rawData.url || rawData.playUrl || rawData.streamUrl;
      sources.push({
        url: `${baseUrl}/moviebox/stream?url=${encodeURIComponent(streamUrl)}`,
        quality: 'auto',
        type: 'hls',
        title: 'MovieBox',
        language: 'en',
        requiresSegmentProxy: false,
      });
    }

    if (sources.length === 0) {
      return { success: false, sources: [], error: 'No playable sources found' };
    }

    console.log(`[MovieBox] Found ${sources.length} sources`);
    return { success: true, sources };
  } catch (e: any) {
    console.error('[MovieBox] Extraction failed:', e);
    return { success: false, sources: [], error: e.message };
  }
}

/**
 * Search MovieBox for content
 */
export async function searchMovieBox(query: string, page: number = 1): Promise<any> {
  const baseUrl = getWorkerBaseUrl();
  const url = `${baseUrl}/moviebox/search?q=${encodeURIComponent(query)}&page=${page}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`MovieBox search failed: ${res.status}`);

  return await res.json();
}

/**
 * Get trending content from MovieBox
 */
export async function getMovieBoxTrending(page: number = 1): Promise<any> {
  const baseUrl = getWorkerBaseUrl();
  const url = `${baseUrl}/moviebox/trending?page=${page}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`MovieBox trending failed: ${res.status}`);

  return await res.json();
}

/**
 * Get movie/TV detail from MovieBox
 */
export async function getMovieBoxDetail(subjectId: string): Promise<any> {
  const baseUrl = getWorkerBaseUrl();
  const url = `${baseUrl}/moviebox/detail?id=${encodeURIComponent(subjectId)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`MovieBox detail failed: ${res.status}`);

  return await res.json();
}
