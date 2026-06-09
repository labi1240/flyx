/**
 * BingeBox Extractor — Movies/TV/Anime Streaming
 *
 * Routes ALL extraction through the CF Worker /bingebox/extract endpoint.
 * The CF Worker handles the actual bingebox.to API call, which avoids
 * datacenter IP blocking and centralizes extraction logic.
 *
 * Flow:
 *   Next.js → CF Worker /bingebox/extract → bingebox.to/api/stream
 *   Stream segments: CF Worker /bingebox/stream → CDN
 */

import type { StreamSource } from '../providers/types';

interface ExtractionResult {
  success: boolean;
  sources: StreamSource[];
  error?: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function getWorkerBaseUrl(): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL ||
    process.env.CF_STREAM_PROXY_URL ||
    'https://media-proxy.vynx-3b3.workers.dev/stream';
  return cfProxyUrl.replace(/\/stream\/?$/, '');
}

const SOURCE_PRIORITY = [
  'neon', 'yoru', 'killjoy', 'harbor', 'chamber', 'omen',
  'gekko', 'raze', 'breach', 'sage', 'aldebaran', 'oneroom',
  'phoenix', 'fade', 'febbox',
];

/**
 * Call the CF Worker /bingebox/extract endpoint for a single source.
 * The CF Worker handles the actual bingebox.to API call.
 */
async function tryExtractFromWorker(
  workerBase: string,
  tmdbId: string,
  mediaType: 'movie' | 'tv',
  title: string,
  source: string,
  year?: string,
  season?: number,
  episode?: number,
): Promise<StreamSource[] | null> {
  const params = new URLSearchParams({
    tmdbId,
    type: mediaType,
    title,
    source,
    year: year || '',
  });
  if (mediaType === 'tv' && season !== undefined && episode !== undefined) {
    params.set('s', season.toString());
    params.set('e', episode.toString());
  }

  const extractUrl = `${workerBase}/bingebox/extract?${params.toString()}`;

  try {
    const res = await fetch(extractUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.warn(`[BingeBox] CF Worker ${source}: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json() as {
      success?: boolean;
      type?: string;
      url?: string;
      playlist?: string;
      qualities?: Record<string, { url: string }>;
      captions?: any[];
      audioTracks?: any[];
      error?: string;
    };

    if (!data.success) {
      console.warn(`[BingeBox] CF Worker ${source}: ${data.error || 'no streams'}`);
      return null;
    }

    const streamUrl = data.url || data.playlist;
    if (!streamUrl && !data.qualities) {
      console.warn(`[BingeBox] CF Worker ${source}: no url/playlist/qualities in response`);
      return null;
    }

    const sources: StreamSource[] = [];
    const resolvedUrl = streamUrl || '';

    if (data.type === 'hls' || (resolvedUrl && resolvedUrl.includes('.m3u8'))) {
      sources.push({
        url: `${workerBase}/bingebox/stream?url=${encodeURIComponent(resolvedUrl)}`,
        quality: 'auto',
        type: 'hls',
        title: `BingeBox (${source})`,
        server: source,
        language: 'en',
        requiresSegmentProxy: true,
      });
    } else if (data.qualities) {
      for (const [quality, info] of Object.entries(data.qualities)) {
        if (info.url) {
          sources.push({
            url: `${workerBase}/bingebox/stream?url=${encodeURIComponent(info.url)}`,
            quality,
            type: 'mp4',
            title: `BingeBox ${source} (${quality})`,
            server: source,
            language: 'en',
            requiresSegmentProxy: false,
          });
        }
      }
    } else if (resolvedUrl) {
      sources.push({
        url: `${workerBase}/bingebox/stream?url=${encodeURIComponent(resolvedUrl)}`,
        quality: 'auto',
        type: resolvedUrl.includes('.mp4') ? 'mp4' : 'hls',
        title: `BingeBox (${source})`,
        server: source,
        language: 'en',
        requiresSegmentProxy: true,
      });
    }

    if (sources.length > 0) {
      console.log(`[BingeBox] Found ${sources.length} sources via CF Worker/${source}`);
      return sources;
    }
    return null;
  } catch (e) {
    console.warn(`[BingeBox] CF Worker ${source} error:`, (e as Error).message);
    return null;
  }
}

/**
 * Extract stream sources from BingeBox for a movie or TV episode.
 * Routes through CF Worker /bingebox/extract to avoid datacenter IP blocking.
 * Tries sources in priority order, returning the first one that works.
 */
export async function extractBingeBoxStreams(
  tmdbId: string,
  mediaType: 'movie' | 'tv',
  title: string,
  year?: string,
  season?: number,
  episode?: number,
): Promise<ExtractionResult> {
  const workerBase = getWorkerBaseUrl();

  // Try sources in priority order
  for (const source of SOURCE_PRIORITY) {
    const sources = await tryExtractFromWorker(
      workerBase, tmdbId, mediaType, title, source,
      year, season, episode,
    );
    if (sources && sources.length > 0) {
      return { success: true, sources };
    }
  }

  return { success: false, sources: [], error: 'All BingeBox sources exhausted' };
}
