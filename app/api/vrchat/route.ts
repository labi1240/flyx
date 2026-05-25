/**
 * VRChat Content API
 * 
 * Returns content data in a simple pipe-delimited format optimized for VRChat's
 * VRCStringDownloader. UdonSharp cannot parse JSON, so we use a simple text format.
 * 
 * FORMAT:
 * Line 1: STATUS|TOTAL_ITEMS|PAGE|TOTAL_PAGES
 * Line 2+: TYPE|ID|TITLE|YEAR|RATING|POSTER_URL (for content)
 *      or: channel|ID|NAME|CATEGORY|COUNTRY (for channels)
 * 
 * ENDPOINTS (via ?action=):
 * - categories: List main navigation categories
 * - home: Featured/trending content
 * - movies: Movie listings by category
 * - series: TV series listings by category  
 * - anime: Anime listings by category
 * - livetv: Live TV channels
 * - search: Search all content
 * - stream: Get stream URL for content
 * - details: Get content details (seasons/episodes for TV)
 * 
 * Query params:
 * - action: API action (required)
 * - category: Filter by category (popular, topRated, action, comedy, etc.)
 * - page: Page number (default 1)
 * - query: Search query (for search action)
 * - id: Content ID (for stream/details action)
 * - type: Content type movie/tv (for stream action)
 * - season: Season number (for TV stream)
 * - episode: Episode number (for TV stream)
 * - channel: Channel ID (for live TV stream)
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Helper to escape pipe characters in strings
function escapePipe(str: string): string {
  return (str || '').replace(/\|/g, '-').replace(/\n/g, ' ').trim();
}

// Helper to build error response
function errorResponse(message: string): NextResponse {
  return new NextResponse(`ERROR|${escapePipe(message)}`, {
    status: 200, // Return 200 so VRChat can read the error
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    },
  });
}

// Helper to build success response
function successResponse(lines: string[], cacheSeconds: number = 60): NextResponse {
  return new NextResponse(lines.join('\n'), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': `public, s-maxage=${cacheSeconds}`,
    },
  });
}

// Helper to get base URL for internal API calls
function getBaseUrl(request: NextRequest): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL;
  }
  const protocol = request.headers.get('x-forwarded-proto') || 'https';
  const host = request.headers.get('host') || 'tv.vynx.cc';
  return `${protocol}://${host}`;
}

// Format content item to pipe-delimited string
function formatContentItem(item: any, defaultType: string = 'movie'): string {
  const type = item.media_type || item.mediaType || defaultType;
  const title = escapePipe(item.title || item.name || 'Unknown');
  const year = (item.release_date || item.first_air_date || '').substring(0, 4);
  const rating = (item.vote_average || 0).toFixed(1);
  const poster = item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : '';
  return `${type}|${item.id}|${title}|${year}|${rating}|${poster}`;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const action = searchParams.get('action') || 'categories';
  
  try {
    switch (action) {
      case 'categories':
        return handleCategories();
      case 'home':
        return await handleHome(request);
      case 'movies':
        return await handleMovies(request);
      case 'series':
        return await handleSeries(request);
      case 'anime':
        return await handleAnime(request);
      case 'livetv':
        return await handleLiveTV(request);
      case 'search':
        return await handleSearch(request);
      case 'stream':
        return await handleStream(request);
      case 'details':
        return await handleDetails(request);
      case 'subcategories':
        return handleSubcategories(request);
      default:
        return errorResponse(`Unknown action: ${action}`);
    }
  } catch (error) {
    console.error('[VRChat API] Error:', error);
    return errorResponse('Internal server error');
  }
}

// Return available main categories
function handleCategories(): NextResponse {
  const lines = [
    'OK|6|1|1',
    'nav|home|Home|Featured content',
    'nav|movies|Movies|Browse movies by genre',
    'nav|series|TV Series|Browse TV shows',
    'nav|anime|Anime|Japanese animation',
    'nav|livetv|Live TV|850+ live channels',
    'nav|search|Search|Search all content',
  ];
  return successResponse(lines, 3600);
}

// Return subcategories for a section
function handleSubcategories(request: NextRequest): NextResponse {
  const section = request.nextUrl.searchParams.get('section') || 'movies';
  
  const subcats: Record<string, string[][]> = {
    movies: [
      ['popular', 'Popular', '🔥'],
      ['topRated', 'Top Rated', '⭐'],
      ['nowPlaying', 'Now Playing', '🎬'],
      ['action', 'Action', '💥'],
      ['comedy', 'Comedy', '😂'],
      ['horror', 'Horror', '👻'],
      ['sciFi', 'Sci-Fi', '🚀'],
      ['thriller', 'Thriller', '😱'],
      ['romance', 'Romance', '💕'],
      ['drama', 'Drama', '🎭'],
      ['fantasy', 'Fantasy', '✨'],
      ['mystery', 'Mystery', '🔍'],
      ['adventure', 'Adventure', '🗡️'],
      ['family', 'Family', '👨‍👩‍👧‍👦'],
      ['documentary', 'Documentary', '📹'],
    ],
    series: [
      ['popular', 'Popular', '🔥'],
      ['topRated', 'Top Rated', '⭐'],
      ['onAir', 'On The Air', '📡'],
      ['airingToday', 'Airing Today', '📺'],
      ['drama', 'Drama', '🎭'],
      ['crime', 'Crime', '🔍'],
      ['sciFi', 'Sci-Fi & Fantasy', '🚀'],
      ['comedy', 'Comedy', '😂'],
      ['mystery', 'Mystery', '🔎'],
      ['thriller', 'Action & Adventure', '💥'],
      ['documentary', 'Documentary', '📹'],
      ['reality', 'Reality', '📺'],
      ['family', 'Family', '👨‍👩‍👧‍👦'],
      ['western', 'Western', '🤠'],
      ['war', 'War & Politics', '⚔️'],
    ],
    anime: [
      ['popular', 'Popular', '🔥'],
      ['topRated', 'Top Rated', '⭐'],
      ['airing', 'Currently Airing', '📺'],
      ['action', 'Action', '⚔️'],
      ['fantasy', 'Fantasy', '✨'],
      ['romance', 'Romance', '💕'],
      ['movies', 'Anime Movies', '🎬'],
    ],
  };
  
  const cats = subcats[section] || subcats.movies;
  const lines = [`OK|${cats.length}|1|1`];
  
  for (const [id, name, icon] of cats) {
    lines.push(`subcat|${id}|${name}|${icon}`);
  }
  
  return successResponse(lines, 3600);
}

// Home/trending content
async function handleHome(request: NextRequest): Promise<NextResponse> {
  const baseUrl = getBaseUrl(request);
  
  try {
    const response = await fetch(`${baseUrl}/api/content/trending?timeWindow=day&page=1`, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      console.error('[VRChat API] Trending fetch failed:', response.status);
      return errorResponse('Failed to fetch trending content');
    }
    
    const data = await response.json();
    const items = data.results || data.data || [];
    
    const lines = [`OK|${items.length}|1|1`];
    for (const item of items.slice(0, 20)) {
      lines.push(formatContentItem(item));
    }
    
    return successResponse(lines, 300);
  } catch (error) {
    console.error('[VRChat API] Home error:', error);
    return errorResponse('Failed to load home content');
  }
}

// Movies by category
async function handleMovies(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const category = searchParams.get('category') || 'popular';
  const page = parseInt(searchParams.get('page') || '1');
  const baseUrl = getBaseUrl(request);
  
  try {
    const response = await fetch(`${baseUrl}/api/content/movies?region=US`, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      console.error('[VRChat API] Movies fetch failed:', response.status);
      return errorResponse('Failed to fetch movies');
    }
    
    const data = await response.json();
    const categoryData = data[category] || data.popular || { items: [], total: 0 };
    const items = categoryData.items || [];
    const total = categoryData.total || items.length;
    const totalPages = Math.ceil(total / 20);
    
    const lines = [`OK|${total}|${page}|${totalPages}`];
    for (const item of items.slice(0, 20)) {
      lines.push(formatContentItem(item, 'movie'));
    }
    
    return successResponse(lines, 300);
  } catch (error) {
    console.error('[VRChat API] Movies error:', error);
    return errorResponse('Failed to load movies');
  }
}

// TV Series by category
async function handleSeries(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const category = searchParams.get('category') || 'popular';
  const page = parseInt(searchParams.get('page') || '1');
  const baseUrl = getBaseUrl(request);
  
  try {
    const response = await fetch(`${baseUrl}/api/content/series?region=US`, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      console.error('[VRChat API] Series fetch failed:', response.status);
      return errorResponse('Failed to fetch series');
    }
    
    const data = await response.json();
    const categoryData = data[category] || data.popular || { items: [], total: 0 };
    const items = categoryData.items || [];
    const total = categoryData.total || items.length;
    const totalPages = Math.ceil(total / 20);
    
    const lines = [`OK|${total}|${page}|${totalPages}`];
    for (const item of items.slice(0, 20)) {
      lines.push(formatContentItem(item, 'tv'));
    }
    
    return successResponse(lines, 300);
  } catch (error) {
    console.error('[VRChat API] Series error:', error);
    return errorResponse('Failed to load series');
  }
}

// Anime content
async function handleAnime(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const category = searchParams.get('category') || 'popular';
  const page = parseInt(searchParams.get('page') || '1');
  const baseUrl = getBaseUrl(request);
  
  try {
    // Anime uses genre 16 (Animation) with Japanese origin
    const response = await fetch(`${baseUrl}/api/content/series?region=JP`, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      console.error('[VRChat API] Anime fetch failed:', response.status);
      return errorResponse('Failed to fetch anime');
    }
    
    const data = await response.json();
    const categoryData = data[category] || data.popular || { items: [], total: 0 };
    const items = categoryData.items || [];
    const total = categoryData.total || items.length;
    const totalPages = Math.ceil(total / 20);
    
    const lines = [`OK|${total}|${page}|${totalPages}`];
    for (const item of items.slice(0, 20)) {
      const type = item.media_type || item.mediaType || 'tv';
      lines.push(formatContentItem(item, type));
    }
    
    return successResponse(lines, 300);
  } catch (error) {
    console.error('[VRChat API] Anime error:', error);
    return errorResponse('Failed to load anime');
  }
}

// Live TV channels
async function handleLiveTV(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const category = searchParams.get('category') || 'all';
  const page = parseInt(searchParams.get('page') || '1');
  const limit = 30;
  const baseUrl = getBaseUrl(request);
  
  try {
    let url = `${baseUrl}/api/livetv/dlhd-channels`;
    if (category && category !== 'all') {
      url += `?category=${encodeURIComponent(category)}`;
    }
    
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      console.error('[VRChat API] LiveTV fetch failed:', response.status);
      return errorResponse('Failed to fetch channels');
    }
    
    const data = await response.json();
    const channels = data.channels || [];
    
    // Paginate
    const startIndex = (page - 1) * limit;
    const paginatedChannels = channels.slice(startIndex, startIndex + limit);
    const totalPages = Math.ceil(channels.length / limit);
    
    const lines = [`OK|${channels.length}|${page}|${totalPages}`];
    
    // Add category list on first page
    if (page === 1 && data.categories) {
      const catList = data.categories.map((c: any) => `${c.id}:${c.name}:${c.icon || '📺'}`).join(',');
      lines.push(`CATEGORIES|${catList}`);
    }
    
    for (const channel of paginatedChannels) {
      const name = escapePipe(channel.name || 'Unknown');
      const cat = escapePipe(channel.category || 'entertainment');
      const country = escapePipe(channel.countryInfo?.name || channel.country || '');
      lines.push(`channel|${channel.id}|${name}|${cat}|${country}`);
    }
    
    return successResponse(lines, 60);
  } catch (error) {
    console.error('[VRChat API] LiveTV error:', error);
    return errorResponse('Failed to load channels');
  }
}

// Search content
async function handleSearch(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get('query') || searchParams.get('q') || '';
  const page = parseInt(searchParams.get('page') || '1');
  const baseUrl = getBaseUrl(request);
  
  if (!query || query.length < 2) {
    return errorResponse('Search query too short');
  }
  
  try {
    const response = await fetch(
      `${baseUrl}/api/content/search?query=${encodeURIComponent(query)}&page=${page}`,
      { headers: { 'Accept': 'application/json' } }
    );
    
    if (!response.ok) {
      console.error('[VRChat API] Search fetch failed:', response.status);
      return errorResponse('Search failed');
    }
    
    const data = await response.json();
    const items = data.data || data.results || [];
    const total = data.total || items.length;
    const totalPages = data.totalPages || Math.ceil(total / 20);
    
    const lines = [`OK|${total}|${page}|${totalPages}`];
    for (const item of items.slice(0, 20)) {
      lines.push(formatContentItem(item));
    }
    
    return successResponse(lines, 60);
  } catch (error) {
    console.error('[VRChat API] Search error:', error);
    return errorResponse('Search failed');
  }
}

// Get content details (for TV show seasons/episodes)
async function handleDetails(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const id = searchParams.get('id');
  const type = searchParams.get('type') || 'movie';
  const baseUrl = getBaseUrl(request);
  
  if (!id) {
    return errorResponse('Missing content ID');
  }
  
  try {
    const response = await fetch(
      `${baseUrl}/api/content/details?id=${id}&type=${type}`,
      { headers: { 'Accept': 'application/json' } }
    );
    
    if (!response.ok) {
      console.error('[VRChat API] Details fetch failed:', response.status);
      return errorResponse('Failed to fetch details');
    }
    
    const data = await response.json();
    const lines = [`OK|1|1|1`];
    
    // Basic info
    const title = escapePipe(data.title || data.name || 'Unknown');
    const year = (data.release_date || data.first_air_date || '').substring(0, 4);
    const rating = (data.vote_average || 0).toFixed(1);
    const overview = escapePipe((data.overview || '').substring(0, 200));
    
    lines.push(`INFO|${id}|${title}|${year}|${rating}|${overview}`);
    
    // For TV shows, add seasons info
    if (type === 'tv' && data.seasons) {
      for (const season of data.seasons) {
        if (season.season_number === 0) continue; // Skip specials
        const sName = escapePipe(season.name || `Season ${season.season_number}`);
        const epCount = season.episode_count || 0;
        lines.push(`SEASON|${season.season_number}|${sName}|${epCount}`);
      }
    }
    
    return successResponse(lines, 300);
  } catch (error) {
    console.error('[VRChat API] Details error:', error);
    return errorResponse('Failed to load details');
  }
}

// Get stream URL for content
async function handleStream(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const id = searchParams.get('id');
  const type = searchParams.get('type') || 'movie';
  const season = searchParams.get('season');
  const episode = searchParams.get('episode');
  const channelId = searchParams.get('channel');
  const baseUrl = getBaseUrl(request);
  
  // Live TV channel stream
  if (channelId) {
    try {
      // Return the DLHD proxy URL for the channel
      const streamUrl = `${baseUrl}/api/dlhd-proxy?channel=${encodeURIComponent(channelId)}`;
      return successResponse([`OK|${streamUrl}|LIVE`], 0);
    } catch (error) {
      console.error('[VRChat API] Channel stream error:', error);
      return errorResponse('Failed to get channel stream');
    }
  }
  
  // Movie/TV stream
  if (!id) {
    return errorResponse('Missing content ID');
  }
  
  try {
    let streamApiUrl = `${baseUrl}/api/stream/extract?tmdbId=${id}&type=${type}&provider=auto`;
    
    if (type === 'tv' && season && episode) {
      streamApiUrl += `&season=${season}&episode=${episode}`;
    }
    
    console.log('[VRChat API] Fetching stream:', streamApiUrl);
    
    const response = await fetch(streamApiUrl, { 
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
    });
    
    const data = await response.json();
    
    if (data.success && data.sources && data.sources.length > 0) {
      // Return the first available stream URL
      const source = data.sources[0];
      const streamUrl = source.url || source.directUrl || '';
      const quality = source.quality || 'HD';
      const provider = data.provider || 'auto';
      
      if (streamUrl) {
        return successResponse([`OK|${streamUrl}|${quality}|${provider}`], 0);
      }
    }
    
    console.error('[VRChat API] No streams found:', data.error || 'Unknown error');
    return errorResponse(data.error || 'No streams available');
  } catch (error) {
    console.error('[VRChat API] Stream error:', error);
    return errorResponse('Failed to get stream');
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
