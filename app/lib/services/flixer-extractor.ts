/**
 * Hexa/Flixer Extractor — CF Worker Pattern
 *
 * Uses the CF Worker /flixer/extract-all endpoint which handles everything:
 *   1. WASM keygen + HMAC signing
 *   2. API call to hexa.su (from CF Worker, which has proper IP handling)
 *   3. Decryption of encrypted response
 *   4. Returns parsed sources with stream URLs
 *
 * This works from both browser AND server contexts because the CF Worker
 * does all the heavy lifting. The previous browser-direct pattern failed
 * server-side because hexa.su blocks datacenter IPs.
 *
 * For browser-direct extraction (sign → direct fetch → decrypt), see
 * flixer-client-extractor.ts which is used by VideoPlayer.tsx.
 */

import { cfFetch } from '../utils/cf-fetch';

interface StreamSource {
  quality: string;
  title: string;
  url: string;
  type: 'hls' | 'mp4';
  referer: string;
  requiresSegmentProxy: boolean;
  status?: 'working' | 'down' | 'unknown';
  language?: string;
  server?: string;
}

interface ExtractionResult {
  success: boolean;
  sources: StreamSource[];
  subtitles?: Array<{ label: string; url: string; language: string }>;
  error?: string;
}

const SUBTITLE_API = 'https://sub.wyzie.ru';

export const FLIXER_ENABLED = true;

const SERVER_NAMES: Record<string, string> = {
  alpha: 'Ares', bravo: 'Balder', charlie: 'Circe', delta: 'Dionysus',
  echo: 'Eros', foxtrot: 'Freya', golf: 'Gaia', hotel: 'Hades',
  india: 'Isis', juliet: 'Juno', kilo: 'Kronos', lima: 'Loki',
  mike: 'Medusa', november: 'Nyx', oscar: 'Odin', papa: 'Persephone',
  quebec: 'Quirinus', romeo: 'Ra', sierra: 'Selene', tango: 'Thor',
  uniform: 'Uranus', victor: 'Vulcan', whiskey: 'Woden', xray: 'Xolotl',
  yankee: 'Ymir', zulu: 'Zeus',
};

function getCfWorkerBaseUrl(): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL ||
    process.env.CF_STREAM_PROXY_URL ||
    'https://media-proxy.vynx.workers.dev/stream';
  return cfProxyUrl.replace(/\/stream\/?$/, '');
}

async function fetchSubtitles(
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number,
): Promise<Array<{ label: string; url: string; language: string }>> {
  try {
    let url = `${SUBTITLE_API}/search?id=${tmdbId}`;
    if (type === 'tv' && season && episode) {
      url += `&season=${season}&episode=${episode}`;
    }
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://hexa.su/' },
    });
    if (!response.ok) return [];
    const data = await response.json();
    if (!Array.isArray(data)) return [];
    return data
      .map((sub: any) => ({
        label: sub.label || sub.lang || 'Unknown',
        url: sub.url || sub.file || '',
        language: sub.lang || 'en',
      }))
      .filter((s: any) => s.url);
  } catch {
    return [];
  }
}

/**
 * Extract streams from Hexa via CF Worker /flixer/extract-all.
 * The CF Worker handles WASM keygen, API calls, and decryption.
 * Works from both browser and server contexts.
 */
export async function extractFlixerStreams(
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number,
  _capToken?: string | null,
): Promise<ExtractionResult> {
  console.log(`[Hexa] Extracting ${type} ${tmdbId}${type === 'tv' ? ` S${season}E${episode}` : ''}`);

  if (!FLIXER_ENABLED) {
    return { success: false, sources: [], error: 'Hexa provider is disabled' };
  }
  if (type === 'tv' && (!season || !episode)) {
    return { success: false, sources: [], error: 'Season and episode required for TV' };
  }

  const subtitlePromise = fetchSubtitles(tmdbId, type, season, episode);

  try {
    const baseUrl = getCfWorkerBaseUrl();
    const params = new URLSearchParams({ tmdbId, type });
    if (type === 'tv' && season != null) params.set('season', season.toString());
    if (type === 'tv' && episode != null) params.set('episode', episode.toString());

    const extractUrl = `${baseUrl}/flixer/extract-all?${params}`;
    console.log(`[Hexa] Calling CF Worker: ${extractUrl}`);

    // Use cfFetch to route through RPI when on CF Pages
    const res = await cfFetch(extractUrl, {
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`extract-all ${res.status}: ${errText.substring(0, 100)}`);
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
      const subtitles = await subtitlePromise;
      return {
        success: false,
        sources: [],
        subtitles: subtitles.length > 0 ? subtitles : undefined,
        error: data.error || 'No sources found',
      };
    }

    const sources: StreamSource[] = data.sources
      .filter(s => s.url && s.status === 'working')
      .map(s => ({
        quality: s.quality || 'auto',
        title: s.title || `Flixer ${SERVER_NAMES[s.server] || s.server || 'Unknown'}`,
        url: s.url,
        type: (s.type || 'hls') as 'hls' | 'mp4',
        referer: s.referer || 'https://hexa.su/',
        requiresSegmentProxy: true,
        status: 'working' as const,
        language: s.language || 'en',
        server: s.server,
      }));

    console.log(`[Hexa] ${sources.length} working sources from CF Worker`);

    const subtitles = await subtitlePromise;
    return {
      success: sources.length > 0,
      sources,
      subtitles: subtitles.length > 0 ? subtitles : undefined,
    };
  } catch (err) {
    console.error(`[Hexa] Error:`, err instanceof Error ? err.message : err);
    return { success: false, sources: [], error: err instanceof Error ? err.message : 'Extraction failed' };
  }
}

/**
 * Fetch a specific Hexa source by server name via CF Worker.
 */
export async function fetchFlixerSourceByName(
  sourceName: string,
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number,
  _capToken?: string | null,
): Promise<StreamSource | null> {
  const serverEntry = Object.entries(SERVER_NAMES).find(([_, displayName]) =>
    sourceName.toLowerCase().includes(displayName.toLowerCase())
  );
  const server = serverEntry ? serverEntry[0] : 'alpha';

  try {
    const baseUrl = getCfWorkerBaseUrl();
    const params = new URLSearchParams({ tmdbId, type, server });
    if (type === 'tv' && season != null) params.set('season', season.toString());
    if (type === 'tv' && episode != null) params.set('episode', episode.toString());

    const res = await cfFetch(`${baseUrl}/flixer/extract?${params}`, {
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
      referer: s.referer || 'https://hexa.su/',
      requiresSegmentProxy: true,
      status: 'working',
      language: s.language || 'en',
      server: s.server || server,
    };
  } catch (e) {
    console.error('[Hexa] fetchByName error:', e);
    return null;
  }
}
