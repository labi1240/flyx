/**
 * HiAnime Extractor — Thin client
 * 
 * ALL extraction and decryption happens on the Cloudflare Worker.
 * This module just calls the worker's /hianime/extract endpoint
 * and returns the results in the same format as animekai-extractor.
 */

// Re-use the canonical types from the provider layer
import type { StreamSource, SubtitleTrack } from '../providers/types';

interface ExtractionResult {
  success: boolean;
  sources: StreamSource[];
  subtitles?: SubtitleTrack[];
  error?: string;
}

function getWorkerBaseUrl(): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL ||
    process.env.CF_STREAM_PROXY_URL ||
    'https://media-proxy.vynx-3b3.workers.dev/stream';
  return cfProxyUrl.replace(/\/stream\/?$/, '');
}

/**
 * Extract HiAnime streams via Cloudflare Worker
 * The worker does ALL the work: search, episode lookup, MegaCloud decryption
 */
export async function extractHiAnimeStreams(
  malId: number,
  title: string,
  episode?: number,
): Promise<ExtractionResult> {
  const baseUrl = getWorkerBaseUrl();

  const params = new URLSearchParams({
    malId: malId.toString(),
    title,
  });
  if (episode) {
    params.set('episode', episode.toString());
  }

  const extractUrl = `${baseUrl}/hianime/extract?${params.toString()}`;
  console.log(`[HiAnime] Calling worker: ${extractUrl}`);

  try {
    // Use cfFetch to route through RPI when on CF Pages — CF Pages can't directly
    // fetch other CF Workers on the same account
    const { cfFetch } = await import('@/app/lib/utils/cf-fetch');
    const res = await cfFetch(extractUrl, {
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json() as {
      success: boolean;
      sources?: Array<{
        quality: string;
        title: string;
        url: string;
        type: 'hls';
        language: string;
        skipIntro?: [number, number];
        skipOutro?: [number, number];
      }>;
      subtitles?: Array<{ label: string; url: string; language: string }>;
      error?: string;
      executionTime?: number;
    };

    console.log(`[HiAnime] Worker response: success=${data.success}, sources=${data.sources?.length || 0}, time=${data.executionTime}ms`);

    if (!data.success || !data.sources || data.sources.length === 0) {
      return {
        success: false,
        sources: [],
        error: data.error || 'No streams found on HiAnime',
      };
    }

    // Sources already have proxied URLs from the worker
    const sources: StreamSource[] = data.sources.map(s => ({
      quality: s.quality,
      title: s.title,
      url: s.url,
      type: s.type,
      referer: '',
      requiresSegmentProxy: false,
      language: s.language,
      skipIntro: s.skipIntro,
      skipOutro: s.skipOutro,
    }));

    return {
      success: true,
      sources,
      subtitles: data.subtitles,
    };
  } catch (e: any) {
    console.error(`[HiAnime] Worker call failed:`, e);
    return {
      success: false,
      sources: [],
      error: e.message || 'HiAnime worker call failed',
    };
  }
}
