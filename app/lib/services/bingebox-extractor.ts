/**
 * BingeBox Extractor — Movies/TV/Anime Streaming
 *
 * bingebox.to has 15 direct HLS sources accessible via /api/stream.
 * Requires Origin: https://bingebox.to header.
 * Streams come from api.dlproxy.com.
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

const SOURCE_PRIORITY = [
  'neon', 'yoru', 'killjoy', 'harbor', 'chamber', 'omen',
  'gekko', 'raze', 'breach', 'sage', 'aldebaran', 'oneroom',
  'phoenix', 'fade',
];

export async function extractBingeBoxStreams(
  tmdbId: string,
  mediaType: 'movie' | 'tv',
  title: string,
  year?: string,
  season?: number,
  episode?: number,
): Promise<ExtractionResult> {
  const baseUrl = getWorkerBaseUrl();

  // Try sources in priority order
  for (const source of SOURCE_PRIORITY) {
    try {
      const params = new URLSearchParams({
        tmdbId,
        type: mediaType,
        title,
        year: year || '',
        source,
      });
      if (mediaType === 'tv' && season !== undefined && episode !== undefined) {
        params.set('s', season.toString());
        params.set('e', episode.toString());
      }

      const url = `${baseUrl}/bingebox/extract?${params.toString()}`;
      console.log(`[BingeBox] Trying ${source}: ${url}`);

      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

      if (!res.ok) continue;

      const data = await res.json();
      if (!data.success) continue;

      const streamUrl = data.url || data.playlist;
      if (!streamUrl) continue;

      const sources: StreamSource[] = [];

      if (data.type === 'hls' || streamUrl.includes('.m3u8')) {
        sources.push({
          url: `${baseUrl}/bingebox/stream?url=${encodeURIComponent(streamUrl)}`,
          quality: 'auto',
          type: 'hls',
          title: `BingeBox (${source})`,
          server: source,
          language: 'en',
          requiresSegmentProxy: true,
        });
      } else if (data.qualities) {
        for (const [quality, info] of Object.entries(data.qualities) as [string, { url: string }][]) {
          if (info.url) {
            sources.push({
              url: `${baseUrl}/bingebox/stream?url=${encodeURIComponent(info.url)}`,
              quality,
              type: 'mp4',
              title: `BingeBox ${source} (${quality})`,
              server: source,
              language: 'en',
              requiresSegmentProxy: false,
            });
          }
        }
      } else if (streamUrl) {
        sources.push({
          url: `${baseUrl}/bingebox/stream?url=${encodeURIComponent(streamUrl)}`,
          quality: 'auto',
          type: streamUrl.includes('.mp4') ? 'mp4' : 'hls',
          title: `BingeBox (${source})`,
          server: source,
          language: 'en',
          requiresSegmentProxy: true,
        });
      }

      if (sources.length > 0) {
        console.log(`[BingeBox] Found ${sources.length} sources via ${source}`);
        return { success: true, sources };
      }
    } catch (e) {
      console.warn(`[BingeBox] ${source} error:`, (e as Error).message);
    }
  }

  return { success: false, sources: [], error: 'All BingeBox sources exhausted' };
}
