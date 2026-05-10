/**
 * PrimeSrc Extractor — Browser + CF Worker Pattern
 *
 * Extracts streams from PrimeSrc (primesrc.me) via the CF Worker proxy.
 * The browser solves Cloudflare Turnstile, then the CF Worker:
 *   1. /api/v1/s → server list (no auth)
 *   2. /api/v1/l → resolve embed links using browser-provided Turnstile token
 *   3. Extract streams from embed pages (Filemoon, Streamtape, Voe, etc.)
 *
 * This gives access to ALL 14+ servers, not just PrimeVid.
 */

// proxy-config imports removed — using getPrimeSrcProxyBaseUrl() directly

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

export const PRIMESRC_ENABLED = true;

const SUBTITLE_API = 'https://sub.wyzie.ru';

// ── Turnstile token cache ───────────────────────────────────────
// The browser component sets this via setTurnstileToken().
// Tokens are valid for ~300s, so we cache and reuse.
let _turnstileToken: string | null = null;
let _turnstileTokenTime = 0;
const TOKEN_TTL = 250_000; // 250s (tokens expire at ~300s)

export function setTurnstileToken(token: string): void {
  _turnstileToken = token;
  _turnstileTokenTime = Date.now();
  console.log('[PrimeSrc] Turnstile token cached');
}

export function getTurnstileToken(): string | null {
  if (!_turnstileToken) return null;
  if (Date.now() - _turnstileTokenTime > TOKEN_TTL) {
    _turnstileToken = null;
    return null;
  }
  return _turnstileToken;
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
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://primesrc.me/' },
    });
    if (!res.ok) return [];
    const data = await res.json();
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

function getPrimeSrcProxyBaseUrl(): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL ||
                     process.env.CF_STREAM_PROXY_URL ||
                     'https://media-proxy.vynx-3b3.workers.dev/stream';
  return cfProxyUrl.replace(/\/stream\/?$/, '');
}

/**
 * Extract streams from PrimeSrc via CF Worker.
 * If a Turnstile token is available, resolves ALL servers.
 * Otherwise, falls back to server list metadata only.
 */
export async function extractPrimeSrcStreams(
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number,
): Promise<ExtractionResult> {
  console.log(`[PrimeSrc] Extracting ${type} ${tmdbId}${type === 'tv' ? ` S${season}E${episode}` : ''}`);

  if (!PRIMESRC_ENABLED) {
    return { success: false, sources: [], error: 'PrimeSrc provider is disabled' };
  }
  if (type === 'tv' && (!season || !episode)) {
    return { success: false, sources: [], error: 'Season and episode required for TV' };
  }

  const subtitlePromise = fetchSubtitles(tmdbId, type, season, episode);
  const token = getTurnstileToken();

  try {
    // Build extract URL — include Turnstile token if available
    const baseUrl = getPrimeSrcProxyBaseUrl();
    const params = new URLSearchParams({ tmdbId, type });
    if (type === 'tv' && season && episode) {
      params.set('season', season.toString());
      params.set('episode', episode.toString());
    }
    if (token) {
      params.set('token', token);
    }
    const extractUrl = `${baseUrl}/primesrc/extract?${params}`;

    console.log(`[PrimeSrc] Calling CF Worker (token: ${token ? 'yes' : 'no'})`);
    const res = await fetch(extractUrl, { signal: AbortSignal.timeout(45000) });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`CF Worker returned ${res.status}: ${errText.substring(0, 100)}`);
    }

    const data = await res.json() as {
      success: boolean;
      sources: Array<{
        server: string;
        quality: string;
        url?: string;
        proxied_url?: string;
        type?: string;
        referer?: string;
        file_name?: string;
        file_size?: string;
        error?: string;
      }>;
      hasTurnstileToken?: boolean;
      error?: string;
    };

    const sources: StreamSource[] = [];

    for (const src of data.sources || []) {
      if (src.url && src.proxied_url) {
        sources.push({
          quality: src.quality || 'auto',
          title: `PrimeSrc ${src.server}`,
          url: src.url,
          type: (src.type as 'hls' | 'mp4') || 'hls',
          referer: src.referer || 'https://primesrc.me/',
          requiresSegmentProxy: src.type === 'hls',
          status: 'working',
          language: 'en',
          server: src.server,
        });
      }
    }

    console.log(`[PrimeSrc] ${sources.length} playable sources (token: ${data.hasTurnstileToken ? 'used' : 'none'})`);

    const subtitles = await subtitlePromise;
    return {
      success: sources.length > 0,
      sources,
      subtitles: subtitles.length > 0 ? subtitles : undefined,
      error: sources.length === 0
        ? (token ? (data.error || 'No playable sources found') : 'Waiting for Turnstile token')
        : undefined,
    };
  } catch (err) {
    console.error('[PrimeSrc] Error:', err instanceof Error ? err.message : err);
    return {
      success: false,
      sources: [],
      error: err instanceof Error ? err.message : 'PrimeSrc extraction failed',
    };
  }
}

/**
 * Resolve a single server's stream using a Turnstile token.
 * Called from the browser when user clicks a specific server in the UI.
 */
export async function resolvePrimeSrcServer(
  serverKey: string,
  serverName: string,
  turnstileToken?: string,
): Promise<StreamSource | null> {
  const token = turnstileToken || getTurnstileToken();
  if (!token) {
    console.warn('[PrimeSrc] No Turnstile token available for resolve');
    return null;
  }

  const baseUrl = getPrimeSrcProxyBaseUrl();

  try {
    // Step 1: Resolve embed link
    const resolveUrl = `${baseUrl}/primesrc/resolve?key=${encodeURIComponent(serverKey)}&token=${encodeURIComponent(token)}&server=${encodeURIComponent(serverName)}`;
    const resolveRes = await fetch(resolveUrl, { signal: AbortSignal.timeout(15000) });
    const resolveData = await resolveRes.json() as { success: boolean; link?: string; error?: string };

    if (!resolveData.success || !resolveData.link) {
      console.warn(`[PrimeSrc] Resolve failed for ${serverName}: ${resolveData.error}`);
      return null;
    }

    // Step 2: Extract stream from embed
    const embedUrl = `${baseUrl}/primesrc/embed?url=${encodeURIComponent(resolveData.link)}&server=${encodeURIComponent(serverName)}`;
    const embedRes = await fetch(embedUrl, { signal: AbortSignal.timeout(20000) });
    const embedData = await embedRes.json() as {
      success: boolean;
      stream?: { url: string; quality: string; type: string; referer: string; proxied_url: string };
      error?: string;
    };

    if (!embedData.success || !embedData.stream) {
      console.warn(`[PrimeSrc] Embed extraction failed for ${serverName}: ${embedData.error}`);
      return null;
    }

    return {
      quality: embedData.stream.quality || 'auto',
      title: `PrimeSrc ${serverName}`,
      url: embedData.stream.url,
      type: (embedData.stream.type as 'hls' | 'mp4') || 'hls',
      referer: embedData.stream.referer || 'https://primesrc.me/',
      requiresSegmentProxy: embedData.stream.type === 'hls',
      status: 'working',
      language: 'en',
      server: serverName,
    };
  } catch (err) {
    console.error(`[PrimeSrc] Error resolving ${serverName}:`, err);
    return null;
  }
}

/**
 * Fetch a specific PrimeSrc source by name.
 */
export async function fetchPrimeSrcSourceByName(
  _sourceName: string,
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number,
): Promise<StreamSource | null> {
  try {
    const result = await extractPrimeSrcStreams(tmdbId, type, season, episode);
    return result.sources[0] || null;
  } catch {
    return null;
  }
}
