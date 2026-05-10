/**
 * Uflix (uflix.to) Extractor
 *
 * Uflix is a server-rendered streaming aggregator (jQuery + Bootstrap) that
 * proxies multiple embed providers via its /gStream API. It uses IMDB IDs
 * internally, so we need TMDB→IMDB mapping.
 *
 * Flow:
 *   1. Get title from TMDB (if not provided) → search uflix → get slug
 *   2. Fetch player iframe → extract IMDB ID from stream ID patterns
 *   3. Call /gStream for each stream server → get embed URLs
 *   4. Return embed URLs as sources with type 'embed'
 *
 * Key facts:
 *   - NO captcha required (captcha= empty works)
 *   - /gStream requires X-Requested-With: XMLHttpRequest
 *   - 5 streams: stream1 (2embed), stream2 (smashy), stream3 (gdrive),
 *     stream4 (vidsrc.me), stream5 (vidplus, uses TMDB ID)
 *   - Sister sites: ukino.to, utelevision.to, ucinema.so
 */

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

const BASE = 'https://uflix.to';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const TIMEOUT = 12_000;

export const UFLIX_ENABLED = true;

// Stream server definitions — each maps to a different embed provider
const STREAM_SERVERS = [
  { id: 'stream1', name: '2Embed', idType: 'imdb' as const },
  { id: 'stream2', name: 'SmashyStream', idType: 'imdb' as const },
  { id: 'stream3', name: 'GDrivePlayer', idType: 'imdb' as const },
  { id: 'stream4', name: 'VidSrc', idType: 'imdb' as const },
  { id: 'stream5', name: 'VidPlus', idType: 'tmdb' as const },
];

/**
 * Fetch title from TMDB API for search purposes.
 * Uses NEXT_PUBLIC_TMDB_API_KEY (v3 key) with ?api_key= query param.
 * TMDB_API_KEY is a Bearer token (JWT) and cannot be used as a query param.
 */
async function fetchTitleFromTMDB(tmdbId: string, type: 'movie' | 'tv'): Promise<string | null> {
  const apiKey = process.env.NEXT_PUBLIC_TMDB_API_KEY;
  if (!apiKey) return null;
  try {
    const endpoint = type === 'movie' ? 'movie' : 'tv';
    const res = await fetch(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${apiKey}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.title || data.name || null;
  } catch {
    return null;
  }
}

/**
 * Fetch IMDB ID from TMDB external_ids API.
 * Uses NEXT_PUBLIC_TMDB_API_KEY (v3 key) with ?api_key= query param.
 */
async function fetchImdbFromTMDB(tmdbId: string, type: 'movie' | 'tv'): Promise<string | null> {
  const apiKey = process.env.NEXT_PUBLIC_TMDB_API_KEY;
  if (!apiKey) return null;
  try {
    const endpoint = type === 'movie' ? 'movie' : 'tv';
    const res = await fetch(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}/external_ids?api_key=${apiKey}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.imdb_id || null;
  } catch {
    return null;
  }
}

/**
 * Search uflix for a title and return the first matching slug.
 */
async function searchForSlug(title: string, type: 'movie' | 'tv'): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/search?keyword=${encodeURIComponent(title)}`, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return null;

    const html = await res.text();
    const pattern = type === 'movie'
      ? /href="\/movie\/([^"]+)"/g
      : /href="\/serie\/([^"]+)"/g;

    const matches = [...html.matchAll(pattern)].map(m => m[1]);
    return matches[0] || null;
  } catch (e) {
    console.log(`[Uflix] Search error: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * Extract IMDB ID from the player iframe page.
 */
async function extractImdbFromPlayer(
  slug: string,
  type: 'movie' | 'tv',
  episode?: string
): Promise<string | null> {
  try {
    const playerUrl = type === 'movie'
      ? `${BASE}/mPlayer?movieid=${slug}&stream=stream1`
      : `${BASE}/sPlayer?serieid=${slug}&episodeid=${episode}&stream=stream1`;

    const referer = type === 'movie'
      ? `${BASE}/movie/${slug}`
      : `${BASE}/episode/${slug}/${episode}`;

    const res = await fetch(playerUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': referer },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return null;

    const html = await res.text();
    const streamIdMatch = html.match(/imdb:(tt\d{7,})/);
    if (streamIdMatch) return streamIdMatch[1];
    const imdbMatch = html.match(/tt\d{7,}/);
    return imdbMatch ? imdbMatch[0] : null;
  } catch {
    return null;
  }
}

/**
 * Call /gStream API to get an embed URL for a specific stream.
 * Returns the raw embed URL — resolveEmbedToStream() converts it to m3u8 later.
 */
async function fetchGStream(
  streamId: string,
  slug: string,
  type: 'movie' | 'tv',
  streamName: string,
  episode?: string
): Promise<StreamSource | null> {
  const url = `${BASE}/gStream?id=${encodeURIComponent(streamId)}&movie=${encodeURIComponent(streamId)}&is_init=false&captcha=`;

  const referer = type === 'movie'
    ? `${BASE}/mPlayer?movieid=${slug}&stream=${streamName}`
    : `${BASE}/sPlayer?serieid=${slug}&episodeid=${episode}&stream=${streamName}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': referer,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      },
      signal: AbortSignal.timeout(TIMEOUT),
    });

    if (!res.ok) return null;

    const data = await res.json() as { success: boolean; data?: { link?: string; token?: string } };
    if (!data.success || !data.data?.link) return null;

    const link = data.data.link;
    const server = STREAM_SERVERS.find(s => s.id === streamName);

    return {
      quality: 'auto',
      title: `Uflix ${server?.name || streamName}`,
      url: link,
      type: 'hls', // Will be resolved from embed → m3u8 by resolveEmbedToStream()
      referer: BASE + '/',
      requiresSegmentProxy: false,
      status: 'working',
      language: 'en',
      server: streamName,
    };
  } catch (e) {
    console.log(`[Uflix] gStream ${streamName} error: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/**
 * Resolve an embed iframe URL to an actual m3u8 stream URL.
 * Uses the existing CF Worker /vidsrc/extract endpoint for 2embed/vidsrc sources.
 */
async function resolveEmbedToStream(
  source: StreamSource,
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number,
): Promise<StreamSource | null> {
  const embedUrl = source.url;

  // Already an m3u8 URL — no resolution needed
  if (embedUrl.includes('.m3u8')) {
    return source;
  }

  // Use the CF Worker /vidsrc/extract endpoint which handles 2embed → m3u8 resolution.
  // This works for stream1 (2embed) and stream4 (vidsrc.me) since the CF Worker
  // calls v1.2embed.stream API which supports both.
  const is2embed = source.server === 'stream1' || embedUrl.includes('2embed');
  const isVidsrc = source.server === 'stream4' || embedUrl.includes('vidsrc');

  if (is2embed || isVidsrc) {
    try {
      // Build CF Worker URL — same pattern as vidsrc-extractor.ts extractFrom2EmbedApi()
      const cfStreamProxy = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL || 'https://media-proxy.vynx-3b3.workers.dev/stream';
      const cfBase = cfStreamProxy.replace(/\/stream\/?$/, '');
      const cfVidsrcProxy = `${cfBase}/vidsrc`;

      const params = new URLSearchParams({ tmdbId, type });
      if (type === 'tv' && season && episode) {
        params.set('season', season.toString());
        params.set('episode', episode.toString());
      }

      const cfUrl = `${cfVidsrcProxy}/extract?${params}`;
      console.log(`[Uflix] Resolving ${source.server} embed via CF Worker: ${cfUrl}`);

      const res = await fetch(cfUrl, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        console.log(`[Uflix] CF Worker returned ${res.status} for ${source.server}`);
        return null;
      }

      const data = await res.json() as {
        success?: boolean;
        m3u8_url?: string;
        proxied_url?: string;
        source?: string;
        error?: string;
      };

      if (!data.success || !data.m3u8_url) {
        console.log(`[Uflix] CF Worker: no m3u8 for ${source.server}: ${data.error || 'unknown'}`);
        return null;
      }

      // Build the proxied m3u8 URL
      const m3u8Url = data.proxied_url
        ? `${cfBase}${data.proxied_url}`
        : data.m3u8_url;

      console.log(`[Uflix] ✓ Resolved ${source.server} → m3u8 (source: ${data.source})`);

      return {
        ...source,
        url: m3u8Url,
        type: 'hls',
        referer: 'https://v1.2embed.stream/',
        requiresSegmentProxy: false, // CF Worker handles proxying
      };
    } catch (e) {
      console.log(`[Uflix] Failed to resolve ${source.server}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  // For other embed providers (smashystream, gdriveplayer, vidplus),
  // we can't easily resolve to m3u8 server-side. Skip them.
  console.log(`[Uflix] Skipping ${source.server} — embed URL not resolvable to m3u8`);
  return null;
}

/**
 * Build stream IDs for all servers.
 */
function buildStreamIds(
  imdbId: string,
  tmdbId: string,
  type: 'movie' | 'tv',
  episode?: string
): Array<{ server: typeof STREAM_SERVERS[0]; streamId: string }> {
  return STREAM_SERVERS.map(server => {
    let streamId: string;
    if (type === 'movie') {
      streamId = server.idType === 'tmdb'
        ? `${server.id}|movie|tmdb:${tmdbId}`
        : `${server.id}|movie|imdb:${imdbId}`;
    } else {
      streamId = server.idType === 'tmdb'
        ? `${server.id}|serie|tmdb:${tmdbId}|${episode}`
        : `${server.id}|serie|imdb:${imdbId}|${episode}`;
    }
    return { server, streamId };
  });
}

/**
 * Main extraction function.
 *
 * @param tmdbId - TMDB ID of the content
 * @param type - 'movie' or 'tv'
 * @param season - Season number (TV only)
 * @param episode - Episode number (TV only)
 */
export async function extractUflixStreams(
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number,
): Promise<ExtractionResult> {
  const episodeCode = type === 'tv' && season && episode
    ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : undefined;

  console.log(`[Uflix] Extracting ${type} TMDB:${tmdbId}${episodeCode ? ` ${episodeCode}` : ''}`);

  // Step 1: Get IMDB ID from TMDB (fast, avoids needing to scrape uflix for it)
  let imdbId = await fetchImdbFromTMDB(tmdbId, type);

  // Step 2: Get title from TMDB for search
  const title = await fetchTitleFromTMDB(tmdbId, type);
  if (!title) {
    return { success: false, sources: [], error: 'Could not fetch title from TMDB' };
  }
  console.log(`[Uflix] Title: "${title}", IMDB: ${imdbId || 'unknown'}`);

  // Step 3: Search uflix for the slug
  const slug = await searchForSlug(title, type);
  if (!slug) {
    return { success: false, sources: [], error: `No results found for "${title}"` };
  }
  console.log(`[Uflix] Found slug: ${slug}`);

  // Step 4: If no IMDB ID from TMDB, extract from player iframe
  if (!imdbId) {
    imdbId = await extractImdbFromPlayer(slug, type, episodeCode);
  }
  if (!imdbId) {
    return { success: false, sources: [], error: `Could not find IMDB ID for "${title}"` };
  }

  // Step 5: Fetch embed URLs from all streams in parallel
  const streamDefs = buildStreamIds(imdbId, tmdbId, type, episodeCode);
  const embedResults = await Promise.allSettled(
    streamDefs.map(({ server, streamId }) =>
      fetchGStream(streamId, slug, type, server.id, episodeCode)
    )
  );

  const embedSources: StreamSource[] = [];
  for (let i = 0; i < embedResults.length; i++) {
    const result = embedResults[i];
    if (result.status === 'fulfilled' && result.value) {
      embedSources.push(result.value);
      console.log(`[Uflix] ✓ ${streamDefs[i].server.name}: ${result.value.url.slice(0, 60)}...`);
    } else {
      console.log(`[Uflix] ✗ ${streamDefs[i].server.name}: no embed`);
    }
  }

  console.log(`[Uflix] ${embedSources.length}/${STREAM_SERVERS.length} streams returned embeds`);

  if (embedSources.length === 0) {
    return { success: false, sources: [], error: 'No embed URLs returned from uflix' };
  }

  // Step 6: Resolve embed URLs to actual m3u8 streams
  // The embed URLs are iframe URLs (e.g., https://www.2embed.cc/embed/tt0137523)
  // which HLS.js can't play. We resolve them via the CF Worker /vidsrc/extract endpoint.
  console.log(`[Uflix] Resolving ${embedSources.length} embed URLs to m3u8 streams...`);

  const resolvedResults = await Promise.allSettled(
    embedSources.map(source =>
      resolveEmbedToStream(source, tmdbId, type, season, episode)
    )
  );

  const sources: StreamSource[] = [];
  for (let i = 0; i < resolvedResults.length; i++) {
    const result = resolvedResults[i];
    if (result.status === 'fulfilled' && result.value) {
      sources.push(result.value);
      console.log(`[Uflix] ✓ Resolved ${embedSources[i].server}: ${result.value.url.slice(0, 80)}...`);
    } else {
      console.log(`[Uflix] ✗ Could not resolve ${embedSources[i].server} to m3u8`);
    }
  }

  console.log(`[Uflix] ${sources.length} playable m3u8 streams from ${embedSources.length} embeds`);

  return {
    success: sources.length > 0,
    sources,
    error: sources.length === 0 ? 'No embeds could be resolved to playable streams' : undefined,
  };
}

/**
 * Fetch a specific Uflix source by server name.
 * Resolves the embed URL to an actual m3u8 stream.
 */
export async function fetchUflixSourceByName(
  sourceName: string,
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number,
): Promise<StreamSource | null> {
  const server = STREAM_SERVERS.find(s =>
    sourceName.toLowerCase().includes(s.name.toLowerCase())
  );
  if (!server) return null;

  const episodeCode = type === 'tv' && season && episode
    ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : undefined;

  const title = await fetchTitleFromTMDB(tmdbId, type);
  if (!title) return null;

  const slug = await searchForSlug(title, type);
  if (!slug) return null;

  let imdbId = await fetchImdbFromTMDB(tmdbId, type);
  if (!imdbId) {
    imdbId = await extractImdbFromPlayer(slug, type, episodeCode);
  }
  if (!imdbId) return null;

  const streamId = type === 'movie'
    ? (server.idType === 'tmdb' ? `${server.id}|movie|tmdb:${tmdbId}` : `${server.id}|movie|imdb:${imdbId}`)
    : (server.idType === 'tmdb' ? `${server.id}|serie|tmdb:${tmdbId}|${episodeCode}` : `${server.id}|serie|imdb:${imdbId}|${episodeCode}`);

  const embedSource = await fetchGStream(streamId, slug, type, server.id, episodeCode);
  if (!embedSource) return null;

  // Resolve embed URL to m3u8
  return resolveEmbedToStream(embedSource, tmdbId, type, season, episode);
}
