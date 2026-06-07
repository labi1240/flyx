/**
 * Videasy Client-Side Extractor
 *
 * June 2026: Videasy requires Cloudflare Turnstile → session auth.
 *
 * PRIMARY PATH (extension installed):
 *   1. Send extraction request to extension via postMessage
 *   2. Extension SW opens player.videasy.to in a real background tab
 *   3. Invisible Turnstile solves automatically (real browser)
 *   4. Page authenticates → fetches hex from api.videasy.to
 *   5. inject.js intercepts hex → relays to SW → relays back to us
 *   6. We run WASM+AES decrypt on the hex
 *
 * FALLBACK PATH (no extension):
 *   1. Fetch hex from CF Worker /videasy/extract
 *   2. CF Worker calls api.videasy.to directly (may fail without session)
 *   3. WASM+AES decrypt
 *
 * The WASM + AES decryption pipeline is shared via videasy-crypto.ts.
 */

import { getWasm, wasmDecrypt, aesDecrypt } from './videasy-crypto';
import { getVideasyStreamProxyUrl } from '../proxy-config';

const getCfWorkerBase = () => {
  const url = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL || 'https://media-proxy.vynx-3b3.workers.dev/stream';
  return url.replace(/\/stream\/?$/, '');
};

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

// ── Extension Bridge ────────────────────────────────────────────────────

function extractViaExtension(
  tmdbId: string,
  type: 'movie' | 'tv',
  title: string,
  season?: number,
  episode?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reqId = 'vs_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => { cleanup(); reject(new Error('Extension Videasy extraction timed out (25s)')); }, 25000);

    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener('message', listener);
    }

    function listener(e: MessageEvent) {
      if (!e.data || e.data.__flyx !== 'videasyExtractRes' || e.data.id !== reqId) return;
      cleanup();
      if (e.data.ok && e.data.hexData) {
        console.log('[Videasy] Extension returned hex: ' + e.data.hexData.length + ' chars');
        resolve(e.data.hexData);
      } else {
        reject(new Error(e.data.error || 'Extension extraction failed'));
      }
    }

    window.addEventListener('message', listener);
    window.postMessage({
      __flyx: 'videasyExtract',
      id: reqId,
      tmdbId,
      mediaType: type,
      title,
      season,
      episode,
    }, '*');
  });
}

// ── CF Worker Fallback ──────────────────────────────────────────────────

async function extractViaWorker(
  tmdbId: string,
  type: 'movie' | 'tv',
  title: string,
  season?: number,
  episode?: number,
  year?: string,
): Promise<string> {
  const params = new URLSearchParams({ tmdbId, type, title });
  if (type === 'tv' && season != null) params.set('season', season.toString());
  if (type === 'tv' && episode != null) params.set('episode', episode.toString());
  if (year) params.set('year', year);

  const res = await fetch(`${getCfWorkerBase()}/videasy/extract?${params}`, {
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Videasy worker ${res.status}: ${err.substring(0, 100)}`);
  }

  const data = await res.json() as {
    success: boolean;
    hexData?: string;
    directUrl?: string;
    apiHeaders?: Record<string, string>;
    error?: string;
  };

  // Path 1: Worker returned hex directly (session pool)
  if (data.hexData) {
    return data.hexData;
  }

  // Path 2: Worker returned directUrl — fetch from browser using simple headers only
  // (NO x-app-id — it triggers CORS preflight which Videasy's API rejects)
  if (data.directUrl && data.apiHeaders) {
    console.log('[Videasy] Fetching hex from browser (simple headers, no CORS preflight)...');
    // Only use simple headers to avoid CORS preflight
    const simpleHeaders: Record<string, string> = {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };
    if (data.apiHeaders['User-Agent']) simpleHeaders['User-Agent'] = data.apiHeaders['User-Agent'];

    const hexRes = await fetch(data.directUrl, {
      headers: simpleHeaders,
      signal: AbortSignal.timeout(15000),
      mode: 'cors', // Browser will send Origin automatically
    });

    if (!hexRes.ok) {
      throw new Error(`Videasy direct fetch: HTTP ${hexRes.status}`);
    }

    const hexData = await hexRes.text();
    if (!/^[0-9a-fA-F]+$/.test(hexData.trim())) {
      throw new Error('Videasy returned non-hex data');
    }

    console.log('[Videasy] Hex fetched directly:', hexData.length, 'bytes');
    return hexData;
  }

  throw new Error(data.error || 'No hex data or directUrl from worker');
}

// ── Decryption + Source Mapping ─────────────────────────────────────────

async function decryptAndMap(hexData: string, tmdbId: string): Promise<VideasySource[]> {
  await getWasm();

  let wasmDecrypted: string;
  try {
    wasmDecrypted = wasmDecrypt(hexData, parseFloat(tmdbId));
  } catch (e) {
    console.warn('[Videasy] WASM decrypt failed:', e instanceof Error ? e.message : e);
    return [];
  }

  let json: string;
  try {
    json = await aesDecrypt(wasmDecrypted, '');
  } catch (e) {
    console.warn('[Videasy] AES decrypt failed:', e instanceof Error ? e.message : e);
    return [];
  }

  const parsed = JSON.parse(json);
  const rawSources = parsed.sources || [];
  const subtitles = parsed.subtitles || [];

  const sources: VideasySource[] = rawSources
    .filter((s: any) => s.url)
    .map((s: any) => ({
      quality: s.quality || 'auto',
      title: s.title || `Videasy ${s.quality || 'auto'}`,
      url: getVideasyStreamProxyUrl(s.url),
      type: (s.type || 'hls') as 'hls' | 'mp4',
      referer: s.referer || 'https://player.videasy.to/',
      requiresSegmentProxy: false,
      status: 'working' as const,
      language: s.language || s.lang || 'en',
      server: s.server || 'videasy',
    }));

  console.log(`[Videasy] ${sources.length} sources, ${subtitles.length} subtitles`);
  return sources;
}

// ── Public API ──────────────────────────────────────────────────────────

export async function extractVideasyClient(
  tmdbId: string,
  type: 'movie' | 'tv',
  title: string,
  season?: number,
  episode?: number,
  year?: string,
): Promise<VideasySource[]> {
  if (tmdbId === '0') {
    console.log('[Videasy] Skipping — tmdbId=0');
    return [];
  }
  console.log(`[Videasy] Extracting: ${type} ${tmdbId} "${title}"`);

  const extensionInstalled = !!(window as any).__FLYX_EXTENSION__?.installed;

  let hexData: string;
  // Worker FIRST (fast ~2s), extension as fallback (slow ~25s)
  try {
    console.log('[Videasy] Trying CF Worker first...');
    hexData = await extractViaWorker(tmdbId, type, title, season, episode, year);
  } catch (e) {
    console.warn('[Videasy] Worker failed:', e instanceof Error ? e.message : e);
    if (extensionInstalled) {
      console.log('[Videasy] Trying extension fallback...');
      try {
        hexData = await extractViaExtension(tmdbId, type, title, season, episode);
      } catch (e2) {
        console.error('[Videasy] Both paths failed');
        return [];
      }
    } else {
      return [];
    }
  }

  return decryptAndMap(hexData, tmdbId);
}
