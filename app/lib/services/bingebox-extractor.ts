/**
 * BingeBox Extractor — Movies/TV/Anime Streaming
 *
 * Calls bingebox.to/api/stream directly from the Next.js server.
 * bingebox.to blocks CF Worker datacenter IPs but allows the
 * wider IP ranges used by CF Pages / Vercel serverless functions.
 */

import type { StreamSource } from '../providers/types';

interface ExtractionResult {
  success: boolean;
  sources: StreamSource[];
  error?: string;
}

const BINGEBOX_BASE = 'https://bingebox.to';
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

export async function extractBingeBoxStreams(
  tmdbId: string,
  mediaType: 'movie' | 'tv',
  title: string,
  year?: string,
  season?: number,
  episode?: number,
): Promise<ExtractionResult> {
  // Try sources in priority order
  for (const source of SOURCE_PRIORITY) {
    try {
      const apiParams = new URLSearchParams({
        tmdbId,
        mediaType: mediaType === 'tv' ? 'show' : 'movie',
        title,
        year: year || '',
        source,
      });
      if (mediaType === 'tv' && season !== undefined && episode !== undefined) {
        apiParams.set('season', season.toString());
        apiParams.set('episode', episode.toString());
      }

      const apiUrl = `${BINGEBOX_BASE}/api/stream?${apiParams.toString()}`;
      console.log(`[BingeBox] Trying ${source}: ${apiUrl}`);

      const res = await fetch(apiUrl, {
        headers: {
          'User-Agent': UA,
          'Referer': `${BINGEBOX_BASE}/`,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        console.warn(`[BingeBox] ${source}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json() as {
        success?: boolean;
        data?: { type?: string; url?: string; playlist?: string; qualities?: Record<string, { url: string }> };
      };

      if (!data.success || !data.data) continue;

      const streamUrl = data.data.url || data.data.playlist;
      if (!streamUrl) continue;

      const sources: StreamSource[] = [];
      const workerBase = getWorkerBaseUrl();

      if (data.data.type === 'hls' || streamUrl.includes('.m3u8')) {
        sources.push({
          url: `${workerBase}/bingebox/stream?url=${encodeURIComponent(streamUrl)}`,
          quality: 'auto',
          type: 'hls',
          title: `BingeBox (${source})`,
          server: source,
          language: 'en',
          requiresSegmentProxy: true,
        });
      } else if (data.data.qualities) {
        for (const [quality, info] of Object.entries(data.data.qualities)) {
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
      } else {
        sources.push({
          url: `${workerBase}/bingebox/stream?url=${encodeURIComponent(streamUrl)}`,
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
