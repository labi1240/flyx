/**
 * Flixer Client-Side Extractor
 *
 * Calls CF Worker /flixer/extract-all which handles everything:
 * WASM keygen, API call to plsdontscrapemelove.flixer.su, decrypt, return sources.
 * No cap token needed — verified via Puppeteer sniffing of flixer.su.
 */

const CF_WORKER_BASE = typeof window !== 'undefined'
  ? (process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL || 'https://media-proxy.vynx-3b3.workers.dev/stream').replace(/\/stream\/?$/, '')
  : '';

const SERVER_NAMES: Record<string, string> = {
  alpha: 'Ares', bravo: 'Balder', charlie: 'Circe', delta: 'Dionysus',
  echo: 'Eros', foxtrot: 'Freya', golf: 'Gaia', hotel: 'Hades',
  india: 'Isis', juliet: 'Juno', kilo: 'Kronos', lima: 'Loki',
  mike: 'Medusa', november: 'Nyx', oscar: 'Odin', papa: 'Persephone',
  quebec: 'Quirinus', romeo: 'Ra', sierra: 'Selene', tango: 'Thor',
  uniform: 'Uranus', victor: 'Vulcan', whiskey: 'Woden', xray: 'Xolotl',
  yankee: 'Ymir', zulu: 'Zeus',
};

export interface FlixerSource {
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

export async function extractFlixerClient(
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number,
): Promise<FlixerSource[]> {
  // Flixer requires a real TMDB ID. Anime content uses tmdbId=0 with MAL IDs.
  if (tmdbId === '0') {
    console.log('[Hexa] Skipping — tmdbId=0 (anime content, requires real TMDB ID)');
    return [];
  }
  console.log(`[Hexa] Extracting: ${type} ${tmdbId}`);

  const params = new URLSearchParams({ tmdbId, type });
  if (type === 'tv' && season != null) params.set('season', season.toString());
  if (type === 'tv' && episode != null) params.set('episode', episode.toString());

  const res = await fetch(`${CF_WORKER_BASE}/flixer/extract-all?${params}`, {
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`extract-all ${res.status}: ${err.substring(0, 100)}`);
  }

  const data = await res.json() as {
    success: boolean;
    sources?: Array<{
      quality: string; title: string; url: string; type: string;
      referer: string; requiresSegmentProxy: boolean; status: string;
      language: string; server: string;
    }>;
    error?: string;
  };

  if (!data.success || !data.sources?.length) {
    console.warn(`[Hexa] extract-all: ${data.error || 'no sources'}`);
    return [];
  }

  const sources: FlixerSource[] = data.sources
    .filter(s => s.url)
    .sort((a, b) => {
      // Validated sources first
      if (a.status === 'validated' && b.status !== 'validated') return -1;
      if (b.status === 'validated' && a.status !== 'validated') return 1;
      return 0;
    })
    .map(s => ({
      quality: s.quality || 'auto',
      title: s.title,
      url: s.url,
      type: (s.type || 'hls') as 'hls' | 'mp4',
      referer: s.referer || 'https://flixer.su/',
      requiresSegmentProxy: s.requiresSegmentProxy ?? false,
      status: (s.status === 'validated' ? 'working' : s.status || 'working') as 'working' | 'down' | 'unknown',
      language: s.language || 'en',
      server: s.server,
    }));

  console.log(`[Hexa] ${sources.length} working sources`);
  return sources;
}

export async function fetchFlixerSourceClient(
  sourceName: string,
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number,
): Promise<FlixerSource | null> {
  const entry = Object.entries(SERVER_NAMES).find(([_, name]) =>
    sourceName.toLowerCase().includes(name.toLowerCase())
  );
  const server = entry ? entry[0] : 'alpha';

  try {
    const params = new URLSearchParams({ tmdbId, type, server });
    if (type === 'tv' && season != null) params.set('season', season.toString());
    if (type === 'tv' && episode != null) params.set('episode', episode.toString());

    const res = await fetch(`${CF_WORKER_BASE}/flixer/extract?${params}`, {
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return null;
    const data = await res.json() as { success: boolean; sources?: Array<any> };
    if (!data.success || !data.sources?.length) return null;

    const s = data.sources[0];
    return {
      quality: s.quality || 'auto',
      title: s.title || `Flixer ${SERVER_NAMES[server] || server}`,
      url: s.url,
      type: (s.type || 'hls') as 'hls' | 'mp4',
      referer: s.referer || 'https://flixer.su/',
      requiresSegmentProxy: s.requiresSegmentProxy ?? false,
      status: 'working',
      language: s.language || 'en',
      server: s.server || server,
    };
  } catch (e) {
    console.error('[Hexa] fetchByName error:', e);
    return null;
  }
}
