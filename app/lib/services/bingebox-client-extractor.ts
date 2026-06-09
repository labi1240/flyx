/**
 * BingeBox Client-Side Extractor
 *
 * Calls CF Worker /bingebox/extract directly from the browser.
 * The CF Worker calls bingebox.to/api → api.dlproxy.com which is
 * reachable from Cloudflare IPs. No decryption needed.
 */

const CF_WORKER_BASE = typeof window !== 'undefined'
  ? (process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL || 'https://media-proxy.vynx-3b3.workers.dev/stream').replace(/\/stream\/?$/, '')
  : '';

const SOURCE_PRIORITY = [
  'neon', 'yoru', 'killjoy', 'harbor', 'chamber', 'omen',
  'gekko', 'raze', 'breach', 'sage', 'aldebaran', 'oneroom',
  'phoenix', 'fade', 'febbox',
];

export interface BingeBoxSource {
  quality: string;
  title: string;
  url: string;
  type: 'hls' | 'mp4';
  referer: string;
  requiresSegmentProxy: boolean;
  status: 'working' | 'down' | 'unknown';
  language: string;
  server: string;
}

export async function extractBingeBoxClient(
  tmdbId: string,
  type: 'movie' | 'tv',
  title: string,
  season?: number,
  episode?: number,
  year?: string,
): Promise<BingeBoxSource[]> {
  // BingeBox requires a real TMDB ID. Anime content uses tmdbId=0 with MAL IDs.
  if (tmdbId === '0') {
    console.log('[BingeBox] Skipping — tmdbId=0 (anime content, requires real TMDB ID)');
    return [];
  }
  console.log(`[BingeBox] Extracting: ${type} ${tmdbId} "${title}"`);

  for (const source of SOURCE_PRIORITY) {
    try {
      const params = new URLSearchParams({ tmdbId, type, title, year: year || '', source });
      if (type === 'tv' && season != null) params.set('s', season.toString());
      if (type === 'tv' && episode != null) params.set('e', episode.toString());

      const url = `${CF_WORKER_BASE}/bingebox/extract?${params}`;
      console.log(`[BingeBox] Trying ${source}...`);

      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

      if (!res.ok) continue;

      const data = await res.json() as {
        success: boolean;
        type?: string;
        url?: string;
        playlist?: string;
        error?: string;
      };

      if (data.success && data.url) {
        const sources: BingeBoxSource[] = [{
          quality: 'auto',
          title: `BingeBox ${source}`,
          url: data.url,
          type: (data.type || 'hls') as 'hls' | 'mp4',
          referer: 'https://bingebox.to/',
          requiresSegmentProxy: false,
          status: 'working' as const,
          language: 'en',
          server: source,
        }];
        console.log(`[BingeBox] ${source}: got stream URL`);
        return sources;
      }
    } catch (e) {
      console.warn(`[BingeBox] ${source} error:`, e instanceof Error ? e.message : e);
    }
  }

  console.warn('[BingeBox] All sources failed');
  return [];
}

export async function fetchBingeBoxSourceClient(
  sourceName: string,
  tmdbId: string,
  type: 'movie' | 'tv',
  title: string,
  season?: number,
  episode?: number,
): Promise<BingeBoxSource[]> {
  const sourceKey = sourceName.toLowerCase().replace(/^bingebox\s*/i, '');
  const params = new URLSearchParams({ tmdbId, type, title, year: '', source: sourceKey });
  if (type === 'tv' && season != null) params.set('s', season.toString());
  if (type === 'tv' && episode != null) params.set('e', episode.toString());

  const url = `${CF_WORKER_BASE}/bingebox/extract?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

  if (!res.ok) throw new Error(`BingeBox fetch ${res.status}`);

  const data = await res.json() as {
    success: boolean;
    type?: string;
    url?: string;
    error?: string;
  };

  if (!data.success || !data.url) throw new Error(data.error || 'BingeBox returned no stream');

  return [{
    quality: 'auto',
    title: sourceName,
    url: data.url,
    type: (data.type || 'hls') as 'hls' | 'mp4',
    referer: 'https://bingebox.to/',
    requiresSegmentProxy: false,
    status: 'working' as const,
    language: 'en',
    server: sourceKey,
  }];
}
