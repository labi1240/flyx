/**
 * Videasy Server-Side Extractor
 *
 * Thin wrapper around the shared videasy-crypto module.
 * Fetches hex from CF Worker /videasy/extract, then runs the
 * WASM + AES decryption pipeline client-side.
 *
 * Uses direct fetch (not cfFetch) for worker→worker calls.
 */

import { getWasm, wasmDecrypt, aesDecrypt } from './videasy-crypto';
import type { StreamSource } from '../providers/types';

function getCfWorkerBaseUrl(): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL ||
    process.env.CF_STREAM_PROXY_URL ||
    'https://media-proxy.vynx-3b3.workers.dev/stream';
  return cfProxyUrl.replace(/\/stream\/?$/, '');
}

/**
 * Load WASM for server-side use.
 *
 * Node.js dev: loads from `public/videasy-module-patched.wasm` via fs.
 * CF Pages Worker: fetches from absolute CDN URLs (relative URLs like
 *   /videasy.bin loop back to the worker function, not static assets).
 */
async function loadWasmServer(): Promise<void> {
  // getWasm() is a singleton — if already loaded this returns immediately.
  // On first call with no opts it tries relative URLs which fail on CF Pages,
  // but the singleton is reset on failure so we can retry below.

  // Node.js dev: load from filesystem
  const isNode = typeof process !== 'undefined' && process.versions?.node;
  if (isNode) {
    try {
      const fs = await import('fs');
      const path = await import('path');
      const wasmPath = path.join(process.cwd(), 'public', 'videasy-module-patched.wasm');
      await getWasm({ wasmBuffer: fs.readFileSync(wasmPath).buffer as ArrayBuffer });
      return;
    } catch (e) {
      console.warn('[Videasy] fs load failed, falling back to CDN:', e instanceof Error ? e.message : e);
    }
  }

  // CF Pages Worker / production: fetch from media-proxy Worker.
  // tv.vynx.cc (same zone) fetches from within a Pages Function may fail;
  // the media-proxy Worker is on a different zone (workers.dev) and proxies
  // the WASM file from tv.vynx.cc.
  const baseUrl = getCfWorkerBaseUrl();
  await getWasm({
    wasmUrls: [
      `${baseUrl}/videasy.bin`,
      `${baseUrl}/videasy-module-patched.wasm`,
    ],
  });
}

// ============================================================================
// Public API
// ============================================================================
export interface VideasyExtractionResult {
  success: boolean;
  sources: StreamSource[];
  subtitles?: Array<{ label: string; url: string; language: string }>;
  error?: string;
}

export async function extractVideasyStreams(
  tmdbId: string,
  type: 'movie' | 'tv',
  title: string,
  season?: number,
  episode?: number,
): Promise<VideasyExtractionResult> {
  console.log(`[Videasy] Extracting ${type} ${tmdbId} "${title}"`);

  if (type === 'tv' && (!season || !episode)) {
    return { success: false, sources: [], error: 'Season and episode required for TV' };
  }

  try {
    // 1. Fetch hex from CF Worker proxy (direct fetch, not cfFetch)
    const baseUrl = getCfWorkerBaseUrl();
    const params = new URLSearchParams({ tmdbId, type, title });
    if (type === 'tv' && season != null) params.set('season', season.toString());
    if (type === 'tv' && episode != null) params.set('episode', episode.toString());

    const extractUrl = `${baseUrl}/videasy/extract?${params}`;

    const res = await fetch(extractUrl, { signal: AbortSignal.timeout(25000) });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Videasy proxy ${res.status}: ${errText.substring(0, 100)}`);
    }

    const data = await res.json() as {
      success: boolean;
      hexData?: string;
      error?: string;
      endpoint?: string;
    };

    if (!data.success || !data.hexData) {
      return { success: false, sources: [], error: data.error || 'No hex data from proxy' };
    }

    if (data.endpoint) {
      console.log(`[Videasy] Resolved via endpoint: ${data.endpoint}`);
    }

    // 2. WASM stream-cipher decrypt (keyed by tmdbId)
    await loadWasmServer();
    const wasmDecrypted = wasmDecrypt(data.hexData, parseFloat(tmdbId));

    // 3. AES-256-CBC decrypt (key="" always)
    const json = await aesDecrypt(wasmDecrypted, '');

    // 4. Parse → sources + subtitles
    const parsed = JSON.parse(json);
    const rawSources = parsed.sources || [];
    const rawSubtitles = parsed.subtitles || [];

    const sources: StreamSource[] = rawSources
      .filter((s: any) => s.url)
      .map((s: any) => ({
        quality: s.quality || 'auto',
        title: s.title || `Videasy ${s.quality || 'auto'}`,
        url: s.url,
        type: (s.type || 'hls') as 'hls' | 'mp4',
        referer: s.referer || 'https://player.videasy.net/',
        requiresSegmentProxy: true,
        status: 'working' as const,
        language: s.language || s.lang || 'en',
        server: s.server || 'videasy',
      }));

    return {
      success: sources.length > 0,
      sources,
      subtitles: rawSubtitles.length > 0 ? rawSubtitles.map((s: any) => ({
        label: s.label || s.lang || s.language || 'unknown',
        url: s.url,
        language: s.lang || s.language || 'unknown',
      })) : undefined,
    };
  } catch (err) {
    console.error(`[Videasy] Error:`, err instanceof Error ? err.message : err);
    return {
      success: false,
      sources: [],
      error: err instanceof Error ? err.message : 'Videasy extraction failed',
    };
  }
}

export async function fetchVideasySourceByName(
  sourceName: string,
  tmdbId: string,
  type: 'movie' | 'tv',
  title: string,
  season?: number,
  episode?: number,
): Promise<StreamSource | null> {
  try {
    const result = await extractVideasyStreams(tmdbId, type, title, season, episode);
    if (!result.success) return null;
    const match = result.sources.find(s =>
      s.title?.toLowerCase().includes(sourceName.toLowerCase())
    );
    return match || null;
  } catch {
    return null;
  }
}
