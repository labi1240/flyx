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

// Server-side request headers Videasy's API requires (Referer is the crux —
// the browser can't set it cross-origin, which is why this must run on the VPS).
const VIDEASY_API_HEADERS: Record<string, string> = {
  Accept: '*/*',
  Origin: 'https://player.videasy.to',
  Referer: 'https://player.videasy.to/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
};

/**
 * Fetch the encrypted hex directly from api.videasy.to (server-side only).
 * Title must be DOUBLE URL-encoded (videasy quirk). Returns null on failure.
 */
async function fetchVideasyHexDirect(
  tmdbId: string,
  type: 'movie' | 'tv',
  title: string,
  season?: number,
  episode?: number,
): Promise<string | null> {
  const encTitle = encodeURIComponent(encodeURIComponent(title));
  const base = 'https://api.videasy.to/cdn/sources-with-title';
  const url =
    type === 'tv' && season != null && episode != null
      ? `${base}?title=${encTitle}&mediaType=tv&year=&episodeId=${episode}&seasonId=${season}&tmdbId=${encodeURIComponent(tmdbId)}&imdbId=`
      : `${base}?title=${encTitle}&mediaType=movie&year=&tmdbId=${encodeURIComponent(tmdbId)}&imdbId=`;

  const res = await fetch(url, {
    headers: VIDEASY_API_HEADERS,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    console.warn(`[Videasy] hex fetch HTTP ${res.status} for ${type} ${tmdbId}`);
    return null;
  }
  const text = await res.text();
  if (!text || text.length < 100 || /<!doctype|<html/i.test(text.slice(0, 200))) {
    return null;
  }
  return text;
}

/**
 * Fallback decrypt via the public enc-dec.app service (used only if local WASM
 * decryption fails). Returns the parsed { sources, subtitles } object or null.
 */
async function decryptVideasyViaEncDec(hexData: string, tmdbId: string): Promise<any | null> {
  try {
    const res = await fetch('https://enc-dec.app/api/dec-videasy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, */*',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        Origin: 'https://enc-dec.app',
        Referer: 'https://enc-dec.app/',
      },
      body: JSON.stringify({ text: hexData, id: tmdbId }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.warn('[Videasy] enc-dec.app HTTP', res.status);
      return null;
    }
    const data = (await res.json()) as { status?: number; result?: any };
    if (data.status !== 200 || !data.result) return null;
    return data.result;
  } catch (e) {
    console.warn('[Videasy] enc-dec.app error:', e instanceof Error ? e.message : e);
    return null;
  }
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
    // 1. Fetch encrypted hex DIRECTLY from api.videasy.to.
    //    Must run from a normal server IP (VPS/Node) with the videasy Referer:
    //    the browser can't (CORS forces Origin and forbids a cross-origin
    //    Referer) and CF Workers are infra-blocked from api.videasy.to.
    const hexData = await fetchVideasyHexDirect(tmdbId, type, title, season, episode);
    if (!hexData) {
      return { success: false, sources: [], error: 'No hex data from videasy API' };
    }

    // 2. Decrypt. Prefer local WASM (self-contained); fall back to enc-dec.app.
    let parsed: any = null;
    try {
      await loadWasmServer();
      const wasmDecrypted = wasmDecrypt(hexData, parseFloat(tmdbId));
      const json = await aesDecrypt(wasmDecrypted, '');
      parsed = JSON.parse(json);
    } catch (wasmErr) {
      console.warn('[Videasy] local WASM decrypt failed, falling back to enc-dec.app:',
        wasmErr instanceof Error ? wasmErr.message : wasmErr);
      parsed = await decryptVideasyViaEncDec(hexData, tmdbId);
    }

    if (!parsed) {
      return { success: false, sources: [], error: 'Videasy decrypt failed' };
    }

    const rawSources = parsed.sources || [];
    const rawSubtitles = parsed.subtitles || [];

    const sources: StreamSource[] = rawSources
      .filter((s: any) => s.url)
      .map((s: any) => ({
        quality: s.quality || 'auto',
        title: s.title || `Videasy ${s.quality || 'auto'}`,
        // Wrap through the VPS /api/stream/videasy-proxy route so the playlist
        // and every segment carry Referer: https://player.videasy.to/.
        url: getVideasyStreamProxyUrl(s.url),
        type: (s.type || 'hls') as 'hls' | 'mp4',
        referer: s.referer || 'https://player.videasy.to/',
        requiresSegmentProxy: false,
        status: 'working' as const,
        language: s.language || s.lang || 'en',
        server: s.server || 'videasy',
      }));

    return {
      success: sources.length > 0,
      sources,
      error: sources.length > 0 ? undefined : 'Videasy returned no playable sources',
      subtitles: rawSubtitles.length > 0 ? rawSubtitles.map((s: any) => ({
        label: s.label || s.lang || s.language || 'unknown',
        url: s.url, language: s.lang || s.language || 'unknown',
      })) : undefined,
    };
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
