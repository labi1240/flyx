/**
 * Videasy Source Proxy
 *
 * Lightweight CORS proxy for api.videasy.net. Fetches the raw hex-encrypted
 * API response and returns it to the client. All WASM decryption and AES
 * decryption happens client-side in the browser (Web Crypto API + public WASM).
 *
 * Routes:
 *   GET /videasy/extract?tmdbId=X&type=movie|tv&title=Y&...
 *   GET /videasy/health
 */

import { createLogger } from './logger';

const VIDEOASY_API = 'https://api.videasy.net';

const API_HEADERS: Record<string, string> = {
  'Origin': 'https://player.videasy.net',
  'Referer': 'https://player.videasy.net/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

interface VideasyExtractParams {
  tmdbId: string;
  title: string;
  type: string;
  year?: string;
  season?: string;
  episode?: string;
  imdbId?: string;
  totalSeasons?: string;
}

async function fetchVideasyApi(params: VideasyExtractParams): Promise<string> {
  const apiParams = new URLSearchParams({
    title: params.title,
    mediaType: params.type === 'tv' ? 'TV Series' : 'Movie',
    year: params.year || '',
    totalSeasons: params.totalSeasons || '0',
    episodeId: params.episode || '0',
    seasonId: params.season || '0',
    tmdbId: params.tmdbId,
    imdbId: params.imdbId || '',
  });

  const url = `${VIDEOASY_API}/cdn/sources-with-title?${apiParams.toString()}`;
  const res = await fetch(url, { headers: API_HEADERS });

  if (!res.ok) {
    throw new Error(`Videasy API returned ${res.status}: ${res.statusText}`);
  }

  return res.text();
}

// ============================================================================
// Route Handler
// ============================================================================
export async function handleVideasyRequest(
  request: Request,
  _env: unknown,
  _ctx: ExecutionContext,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Health check
  if (path === '/videasy/health') {
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Extract endpoint — proxies raw hex from Videasy API to client
  if (path === '/videasy/extract') {
    const tmdbId = url.searchParams.get('tmdbId');
    const title = url.searchParams.get('title');
    const type = url.searchParams.get('type') || 'movie';

    if (!tmdbId || !title) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required parameters: tmdbId, title',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const hexData = await fetchVideasyApi({
        tmdbId,
        title,
        type,
        year: url.searchParams.get('year') || undefined,
        season: url.searchParams.get('season') || undefined,
        episode: url.searchParams.get('episode') || undefined,
        imdbId: url.searchParams.get('imdbId') || undefined,
        totalSeasons: url.searchParams.get('totalSeasons') || undefined,
      });

      // Check for JSON error response
      if (hexData.startsWith('{')) {
        const err = JSON.parse(hexData);
        return new Response(JSON.stringify({
          success: false,
          error: err.message || err.error || 'Videasy API returned an error',
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Return raw hex to client — client does WASM + AES decrypt
      return new Response(JSON.stringify({
        success: true,
        hexData,
        provider: 'videasy',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      logger.error('Videasy extract error', error as Error);
      return new Response(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response(JSON.stringify({ error: 'Unknown Videasy endpoint' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}
