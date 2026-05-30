/**
 * Videasy Client-Side Extractor
 *
 * Thin wrapper around the shared videasy-crypto module for browser use.
 * Fetches hex from CF Worker /videasy/extract, then runs the
 * WASM + AES decryption pipeline in the browser (Web Crypto API).
 */

import { getWasm, wasmDecrypt, aesDecrypt } from './videasy-crypto';
import { getVideasyStreamProxyUrl } from '../proxy-config';

// ============================================================================
// CF Worker proxy URL
// ============================================================================
const getCfWorkerBase = () => {
  const url = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL || 'https://media-proxy.vynx-3b3.workers.dev/stream';
  return url.replace(/\/stream\/?$/, '');
};

// ============================================================================
// Source type
// ============================================================================
export interface VideasySource {
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

// ============================================================================
// Main extraction function
// ============================================================================
export async function extractVideasyClient(
  tmdbId: string,
  type: 'movie' | 'tv',
  title: string,
  season?: number,
  episode?: number,
  year?: string,
): Promise<VideasySource[]> {
  // Videasy requires a real TMDB ID. Anime content uses tmdbId=0 with MAL IDs.
  if (tmdbId === '0') {
    console.log('[Videasy] Skipping — tmdbId=0 (anime content, requires real TMDB ID)');
    return [];
  }
  console.log(`[Videasy] Extracting: ${type} ${tmdbId} "${title}"`);

  const params = new URLSearchParams({ tmdbId, type, title });
  if (type === 'tv' && season != null) params.set('season', season.toString());
  if (type === 'tv' && episode != null) params.set('episode', episode.toString());
  if (year) params.set('year', year);

  // 1. Fetch raw hex from CF Worker proxy
  const res = await fetch(`${getCfWorkerBase()}/videasy/extract?${params}`, {
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Videasy extract ${res.status}: ${err.substring(0, 100)}`);
  }

  const data = await res.json() as {
    success: boolean;
    hexData?: string;
    error?: string;
    endpoint?: string;
  };

  if (!data.success || !data.hexData) {
    console.warn(`[Videasy] CF Worker error: ${data.error || 'no hex data'}`);
    return [];
  }

  if (data.endpoint) {
    console.log(`[Videasy] Resolved via endpoint: ${data.endpoint}`);
  }

  // 2. WASM stream-cipher decrypt (keyed by tmdbId)
  await getWasm();
  let wasmDecrypted: string;
  try {
    wasmDecrypted = wasmDecrypt(data.hexData, parseFloat(tmdbId));
  } catch (e) {
    console.warn('[Videasy] WASM decrypt failed:', e instanceof Error ? e.message : e);
    return [];
  }

  // 3. AES-256-CBC decrypt (key="" always)
  let json: string;
  try {
    json = await aesDecrypt(wasmDecrypted, '');
  } catch (e) {
    console.warn('[Videasy] AES decrypt failed:', e instanceof Error ? e.message : e);
    return [];
  }

  // 4. Parse sources
  const parsed = JSON.parse(json);
  const rawSources = parsed.sources || [];
  const subtitles = parsed.subtitles || [];

  const sources: VideasySource[] = rawSources
    .filter((s: any) => s.url)
    .map((s: any) => ({
      quality: s.quality || 'auto',
      title: s.title || `Videasy ${s.quality || 'auto'}`,
      // Wrap through CF Worker media-proxy so segment requests carry the
      // required Referer: https://player.videasy.net/ header.
      url: getVideasyStreamProxyUrl(s.url),
      type: (s.type || 'hls') as 'hls' | 'mp4',
      referer: s.referer || 'https://player.videasy.net/',
      requiresSegmentProxy: false, // URL is already proxied through media-proxy
      status: 'working' as const,
      language: s.language || s.lang || 'en',
      server: s.server || 'videasy',
    }));

  console.log(`[Videasy] ${sources.length} sources, ${subtitles.length} subtitles`);
  return sources;
}
