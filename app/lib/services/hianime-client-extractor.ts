/**
 * HiAnime Client-Side Extractor
 *
 * Calls CF Worker /hianime/extract which handles the full pipeline:
 * search → MAL match → episode list → server select → MegaCloud extract → decrypt.
 * Browser calls CF Worker directly (browser → CF Worker → aniwatchtv.to).
 */

const CF_WORKER_BASE = typeof window !== 'undefined'
  ? (process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL || 'https://media-proxy.vynx-3b3.workers.dev/stream').replace(/\/stream\/?$/, '')
  : '';

export interface HiAnimeSource {
  quality: string;
  title: string;
  url: string;
  type: 'hls';
  language: string;
  requiresSegmentProxy: boolean;
  skipIntro?: [number, number];
  skipOutro?: [number, number];
}

export async function extractHiAnimeClient(
  malId: number,
  title: string,
  episode?: number,
): Promise<HiAnimeSource[]> {
  console.log(`[HiAnime] Extracting: malId=${malId} title="${title}" ep=${episode}`);

  const params = new URLSearchParams({ malId: malId.toString(), title });
  if (episode != null) params.set('episode', episode.toString());

  const res = await fetch(`${CF_WORKER_BASE}/hianime/extract?${params}`, {
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.warn(`[HiAnime] /hianime/extract ${res.status}: ${err.substring(0, 200)}`);
    return [];
  }

  const data = await res.json() as {
    success: boolean;
    sources?: Array<{
      quality: string; title: string; url: string; type: string;
      language: string; skipIntro?: [number, number]; skipOutro?: [number, number];
    }>;
    error?: string;
  };

  if (!data.success || !data.sources?.length) {
    console.warn(`[HiAnime] extract: ${data.error || 'no sources'}`);
    return [];
  }

  const sources: HiAnimeSource[] = data.sources
    .filter(s => s.url)
    .map(s => ({
      quality: s.quality || 'auto',
      title: s.title,
      url: s.url,
      type: 'hls' as const,
      language: s.language || 'ja',
      requiresSegmentProxy: false,
      skipIntro: s.skipIntro,
      skipOutro: s.skipOutro,
    }));

  console.log(`[HiAnime] ${sources.length} sources (sub+dub)`);
  return sources;
}
