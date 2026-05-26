/**
 * Multi-Embed Extractor (Hexawatch-style)
 * 
 * STATUS: ENABLED — February 2026
 * 
 * Hexawatch.cc aggregates multiple third-party embed providers via iframes.
 * This extractor hits those embed providers directly to extract m3u8 streams.
 * 
 * Discovered servers (from hexawatch.cc JS bundle):
 * 
 * AD-FREE CATEGORY:
 *   - DOG    → vidsrc.xyz/embed/       (redirects to vsembed.ru)
 *   - CAT    → vidfast.pro/            (embed.su mirror)
 *   - RABBIT → player.videasy.net/     (videasy/binge player)
 *   - DOVE   → player.autoembed.cc/embed/ (autoembed)
 *   - GEESE  → vidsrc.cc/v2/embed/     (vidsrc v2)
 * 
 * ADS CATEGORY:
 *   - POLARIS → moviesapi.club/        (vidora.stream embeds)
 *   - GALAXY  → player.vidplus.to/embed/ (vidplus)
 *   - MOON    → 111movies.com/         (1movies)
 * 
 * RECOMMENDATION:
 *   - FAST   → vidlink.pro/            (vidlink — already handled by vidlink-extractor)
 * 
 * Each server uses a different URL pattern for movies vs TV.
 * We try to extract m3u8 URLs from the embed pages.
 */

interface StreamSource {
  quality: string;
  title: string;
  url: string;
  type: 'hls' | 'mp4';
  referer: string;
  requiresSegmentProxy: boolean;
  status: 'working' | 'down' | 'unknown';
  language: string;
  server?: string;
}

interface ExtractionResult {
  success: boolean;
  sources: StreamSource[];
  subtitles?: Array<{ label: string; url: string; language: string }>;
  error?: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// Hexawatch server definitions
interface HexaServer {
  id: string;
  title: string;
  baseUrl: string;
  category: 'ad-free' | 'ads' | 'recommendation';
  buildMovieUrl: (tmdbId: string) => string;
  buildTvUrl: (tmdbId: string, season: number, episode: number) => string;
}

const HEXA_SERVERS: HexaServer[] = [
  {
    id: 'cc',
    title: 'DOG',
    baseUrl: 'https://vidsrc.xyz/embed/',
    category: 'ad-free',
    buildMovieUrl: (id) => `https://vidsrc.xyz/embed/movie/${id}`,
    buildTvUrl: (id, s, e) => `https://vidsrc.xyz/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: 'embed.su',
    title: 'CAT',
    baseUrl: 'https://vidfast.pro/',
    category: 'ad-free',
    buildMovieUrl: (id) => `https://vidfast.pro/movie/${id}`,
    buildTvUrl: (id, s, e) => `https://vidfast.pro/tv/${id}/${s}/${e}`,
  },
  {
    id: 'binge',
    title: 'RABBIT',
    baseUrl: 'https://player.videasy.net/',
    category: 'ad-free',
    buildMovieUrl: (id) => `https://player.videasy.net/movie/${id}`,
    buildTvUrl: (id, s, e) => `https://player.videasy.net/tv/${id}/${s}/${e}`,
  },
  {
    id: 'nl',
    title: 'DOVE',
    baseUrl: 'https://player.autoembed.cc/embed/',
    category: 'ad-free',
    buildMovieUrl: (id) => `https://player.autoembed.cc/embed/movie/${id}`,
    buildTvUrl: (id, s, e) => `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: 'rip',
    title: 'GEESE',
    baseUrl: 'https://vidsrc.cc/v2/embed/',
    category: 'ad-free',
    buildMovieUrl: (id) => `https://vidsrc.cc/v2/embed/movie/${id}`,
    buildTvUrl: (id, s, e) => `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: 'club',
    title: 'POLARIS',
    baseUrl: 'https://moviesapi.club/',
    category: 'ads',
    buildMovieUrl: (id) => `https://moviesapi.club/movie/${id}`,
    buildTvUrl: (id, s, e) => `https://moviesapi.club/tv/${id}-${s}-${e}`,
  },
  {
    id: 'xyz',
    title: 'GALAXY',
    baseUrl: 'https://player.vidplus.to/embed/',
    category: 'ads',
    buildMovieUrl: (id) => `https://player.vidplus.to/embed/movie/${id}`,
    buildTvUrl: (id, s, e) => `https://player.vidplus.to/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: 'smashy',
    title: 'MOON',
    baseUrl: 'https://111movies.com/',
    category: 'ads',
    buildMovieUrl: (id) => `https://111movies.com/?tmdb=${id}`,
    buildTvUrl: (id, s, e) => `https://111movies.com/?tmdb=${id}&season=${s}&episode=${e}`,
  },
];

/**
 * Try to extract an m3u8 URL from an embed page response
 */
function extractM3u8FromHtml(html: string): string | null {
  // Pattern 1: Direct m3u8 URL in JSON or JS
  const m3u8Match = html.match(/["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)["']/i);
  if (m3u8Match) return m3u8Match[1];

  // Pattern 2: file/source property in player config
  const fileMatch = html.match(/["']?(?:file|source|src|url|playlist)["']?\s*[:=]\s*["'](https?:\/\/[^"'\s]+)["']/i);
  if (fileMatch && (fileMatch[1].includes('.m3u8') || fileMatch[1].includes('playlist'))) {
    return fileMatch[1];
  }

  // Pattern 3: data-src or data-url attributes
  const dataSrcMatch = html.match(/data-(?:src|url|file)=["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)["']/i);
  if (dataSrcMatch) return dataSrcMatch[1];

  return null;
}

/**
 * Extract iframe src from an embed page
 */
function extractIframeSrc(html: string): string | null {
  const iframeMatch = html.match(/<iframe[^>]*\ssrc=["'](https?:\/\/[^"']+)["']/i);
  return iframeMatch ? iframeMatch[1] : null;
}

/**
 * Try to extract stream from a single hexawatch server
 */
async function extractFromServer(
  server: HexaServer,
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number
): Promise<StreamSource | null> {
  const url = type === 'movie'
    ? server.buildMovieUrl(tmdbId)
    : server.buildTvUrl(tmdbId, season!, episode!);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://hexawatch.cc/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const html = await response.text();

    // Try direct m3u8 extraction
    let m3u8Url = extractM3u8FromHtml(html);

    // If no direct m3u8, try following iframe
    if (!m3u8Url) {
      const iframeSrc = extractIframeSrc(html);
      if (iframeSrc) {
        try {
          const iframeResponse = await fetch(iframeSrc, {
            headers: {
              'User-Agent': UA,
              'Referer': new URL(url).origin + '/',
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(8000),
          });
          if (iframeResponse.ok) {
            const iframeHtml = await iframeResponse.text();
            m3u8Url = extractM3u8FromHtml(iframeHtml);
          }
        } catch {
          // iframe fetch failed, continue
        }
      }
    }

    if (m3u8Url) {
      return {
        quality: 'auto',
        title: `Hexa ${server.title}`,
        url: m3u8Url,
        type: 'hls',
        referer: new URL(url).origin + '/',
        requiresSegmentProxy: true,
        status: 'working',
        language: 'en',
        server: server.id,
      };
    }

    // Even without m3u8, if the page loaded successfully, the embed is available
    // (it just requires JS execution in a browser to extract the stream)
    // Return as "unknown" status so the UI can show it as an iframe fallback
    return null;
  } catch (e) {
    console.log(`[MultiEmbed] Server ${server.id} (${server.title}) error:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Main extraction function — tries all hexawatch servers in parallel
 */
export async function extractMultiEmbedStreams(
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number
): Promise<ExtractionResult> {
  console.log(`[MultiEmbed] Extracting from ${HEXA_SERVERS.length} hexawatch servers for ${type} ID ${tmdbId}${type === 'tv' ? ` S${season}E${episode}` : ''}`);

  if (type === 'tv' && (!season || !episode)) {
    return { success: false, sources: [], error: 'Season and episode required for TV shows' };
  }

  // Try all servers in parallel
  const results = await Promise.allSettled(
    HEXA_SERVERS.map(server => extractFromServer(server, tmdbId, type, season, episode))
  );

  const sources: StreamSource[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled' && result.value) {
      sources.push(result.value);
      console.log(`[MultiEmbed] ✓ ${HEXA_SERVERS[i].title} returned a source`);
    } else {
      const reason = result.status === 'rejected' ? result.reason?.message : 'No m3u8 found';
      console.log(`[MultiEmbed] ✗ ${HEXA_SERVERS[i].title}: ${reason}`);
    }
  }

  console.log(`[MultiEmbed] Total: ${sources.length} source(s) from ${HEXA_SERVERS.length} servers`);

  if (sources.length === 0) {
    return {
      success: false,
      sources: [],
      error: 'No working sources found from hexawatch servers (most require JS execution)',
    };
  }

  return { success: true, sources };
}

/**
 * Fetch a specific source by name
 */
export async function fetchMultiEmbedSourceByName(
  sourceName: string,
  tmdbId: string,
  type: 'movie' | 'tv',
  season?: number,
  episode?: number
): Promise<StreamSource | null> {
  const server = HEXA_SERVERS.find(s =>
    sourceName.toLowerCase().includes(s.title.toLowerCase()) ||
    sourceName.toLowerCase().includes(s.id.toLowerCase())
  );

  if (server) {
    return extractFromServer(server, tmdbId, type, season, episode);
  }

  // Fallback: try all servers and return first working
  const result = await extractMultiEmbedStreams(tmdbId, type, season, episode);
  return result.sources[0] || null;
}

// Export source list for documentation
export const MULTI_EMBED_SOURCES_LIST = HEXA_SERVERS.map(s => ({
  name: s.title,
  id: s.id,
  status: 'active',
  category: s.category,
  baseUrl: s.baseUrl,
}));

/**
 * ENABLED: Hexawatch servers are active
 * Note: Most servers require JS execution for full m3u8 extraction.
 * Direct HTML scraping may only work for some servers.
 */
export const MULTI_EMBED_ENABLED = true;
