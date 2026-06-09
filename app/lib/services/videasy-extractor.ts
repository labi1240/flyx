/**
 * Videasy Server-Side Extractor
 *
 * Thin wrapper that fetches encrypted hex from the CF Worker proxy, then
 * runs the WASM + AES decryption pipeline. Uses the shared videasy-crypto
 * module which handles WASM loading for all runtimes:
 *   Node.js: fs + instantiate(buffer)
 *   CF Pages: dynamic .wasm import → compiled module → instantiate(module)
 *   Browser: fetch + instantiate(buffer)
 *
 * Uses direct fetch (not cfFetch) for worker→worker calls.
 */

import { getWasm, wasmDecrypt, aesDecrypt } from './videasy-crypto';
import { getVideasyStreamProxyUrl } from '../proxy-config';
import type { StreamSource } from '../providers/types';

function getCfWorkerBaseUrl(): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL ||
    process.env.CF_STREAM_PROXY_URL ||
    'https://media-proxy.vynx-3b3.workers.dev/stream';
  return cfProxyUrl.replace(/\/stream\/?$/, '');
}

/**
 * Load WASM for server-side use.
 * Node.js: loads from filesystem via fs.
 * CF Pages: uses dynamic .wasm import (compiled module).
 */
async function loadWasmServer(): Promise<void> {
  // Try the shared loader first (handles compiled module import on CF)
  try { await getWasm(); return; } catch { /* continue */ }

  // Node.js: load from filesystem
  const isNode = typeof process !== 'undefined' && process.versions?.node;
  if (isNode) {
    const fs = await import('fs');
    const path = await import('path');
    const wasmPath = path.join(process.cwd(), 'public', 'videasy-module-patched.wasm');
    await getWasm({ wasmBuffer: fs.readFileSync(wasmPath).buffer as ArrayBuffer });
    return;
  }

  // Last resort: fetch from URL
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
  /** Raw hex from CF proxy — set when server can't decrypt (CF Pages) */
  hexData?: string;
  subtitles?: Array<{ label: string; url: string; language: string }>;
  error?: string;
  /** True when the client (browser) must run WASM+AES decryption */
  needsClientDecrypt?: boolean;
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
    // 1. Fetch hex from CF Worker proxy
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
      success: boolean; hexData?: string; error?: string; endpoint?: string;
      directUrl?: string; apiHeaders?: Record<string, string>;
      sources?: Array<{ quality: string; url: string; type: string; title?: string }>;
      subtitles?: Array<{ label: string; url: string; language: string }>;
    };

    // New: Worker decrypted hex and returned pre-proxied sources
    if (data.sources && data.sources.length > 0) {
      console.log(`[Videasy] Worker returned ${data.sources.length} pre-proxied sources`);
      return {
        success: true,
        sources: data.sources.map((s: any) => ({
          url: s.url,
          quality: s.quality || 'auto',
          type: s.type || 'hls',
          title: s.title || `Videasy ${s.quality || 'auto'}`,
          referer: 'https://player.videasy.to/',
          requiresSegmentProxy: false, // Already proxied through Worker's /stream/
          status: 'working' as const,
          language: s.language || 'en',
          server: 'videasy',
        })),
        subtitles: data.subtitles || [],
      };
    }

    // New flow: Worker returns directUrl + apiHeaders for browser-side fetch
    if (!data.hexData && data.directUrl) {
      console.log('[Videasy] Worker returned directUrl — deferring to client browser');
      return {
        success: true, sources: [],
        hexData: '', // signal to client that it needs to fetch
        needsClientDecrypt: true,
        // Pass these through for the client to use
        ...(data as any),
      } as any;
    }

    if (!data.success || !data.hexData) {
      return { success: false, sources: [], error: data.error || 'No hex data from proxy' };
    }

    if (data.endpoint) console.log(`[Videasy] Resolved via endpoint: ${data.endpoint}`);

    // 2. Try server-side WASM + AES decrypt.
    // On CF Pages Workers WebAssembly.instantiate(buffer) is blocked, so
    // we return the hex to the client for browser-side decryption.
    try {
      await loadWasmServer();
      const wasmDecrypted = wasmDecrypt(data.hexData, parseFloat(tmdbId));
      const json = await aesDecrypt(wasmDecrypted, '');

      const parsed = JSON.parse(json);
      const rawSources = parsed.sources || [];
      const rawSubtitles = parsed.subtitles || [];

      const sources: StreamSource[] = rawSources
        .filter((s: any) => s.url)
        .map((s: any) => ({
          quality: s.quality || 'auto',
          title: s.title || `Videasy ${s.quality || 'auto'}`,
          // Wrap through CF Worker media-proxy so segment requests carry the
          // required Referer: https://player.videasy.to/ header.
          url: getVideasyStreamProxyUrl(s.url),
          type: (s.type || 'hls') as 'hls' | 'mp4',
          referer: s.referer || 'https://player.videasy.to/',
          requiresSegmentProxy: false, // URL is already proxied through media-proxy
          status: 'working' as const,
          language: s.language || s.lang || 'en',
          server: s.server || 'videasy',
        }));

      return {
        success: sources.length > 0, sources,
        subtitles: rawSubtitles.length > 0 ? rawSubtitles.map((s: any) => ({
          label: s.label || s.lang || s.language || 'unknown',
          url: s.url, language: s.lang || s.language || 'unknown',
        })) : undefined,
      };
    } catch (wasmErr) {
      // WASM failed (likely CF Pages) — return hex for client to decrypt
      console.warn('[Videasy] Server-side decrypt failed, deferring to client:',
        wasmErr instanceof Error ? wasmErr.message : wasmErr);
      return {
        success: true,
        sources: [],
        hexData: data.hexData,
        needsClientDecrypt: true,
      };
    }
  } catch (err) {
    console.error(`[Videasy] Error:`, err instanceof Error ? err.message : err);
    return { success: false, sources: [], error: err instanceof Error ? err.message : 'Videasy extraction failed' };
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
