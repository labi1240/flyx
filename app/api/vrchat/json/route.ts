/**
 * VRChat JSON Content API
 * 
 * Returns content data in JSON format for FlyXBrowser's SimpleJsonParser.
 * 
 * Response format:
 * {
 *   "status": "ok" | "error",
 *   "error": "error message" (only if status is error),
 *   "total": number,
 *   "page": number,
 *   "totalPages": number,
 *   "items": [
 *     {
 *       "type": "movie" | "tv" | "channel",
 *       "id": "string",
 *       "title": "string",
 *       "year": "string",
 *       "rating": "string",
 *       "poster": "url string",
 *       "seasons": number (for TV only)
 *     }
 *   ]
 * }
 * 
 * ENDPOINTS (via ?action=):
 * - home: Featured/trending content
 * - movies: Movie listings
 * - series: TV series listings
 * - anime: Anime listings
 * - livetv: Live TV channels
 * - search: Search all content (requires ?query=)
 * - stream: Get stream URL (requires ?id= and ?type=)
 * - details: Get content details (requires ?id= and ?type=)
 * 
 * Query params:
 * - action: API action (required)
 * - category: Filter by category
 * - page: Page number (default 1)
 * - query: Search query (for search action)
 * - id: Content ID (for stream/details)
 * - type: Content type movie/tv (for stream)
 * - season: Season number (for TV stream)
 * - episode: Episode number (for TV stream)
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const ITEMS_PER_PAGE = 12;

function jsonResponse(data: any, cacheSeconds: number = 60): NextResponse {
  return NextResponse.json(data, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': cacheSeconds > 0 ? `public, s-maxage=${cacheSeconds}` : 'no-cache',
    },
  });
}

function errorResponse(message: string): NextResponse {
  return jsonResponse({ status: 'error', error: message }, 0);
}

function getBaseUrl(request: NextRequest): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL;
  }
  const protocol = request.headers.get('x-forwarded-proto') || 'https';
  const host = request.headers.get('host') || 'tv.vynx.cc';
  return `${protocol}://${host}`;
}

function getProxiedImageUrl(baseUrl: string, posterPath: string | null): string {
  if (!posterPath) return '';
  // Use our image proxy instead of direct TMDB URL
  return `${baseUrl}/api/image-proxy?tmdb=/w342${posterPath}`;
}

function formatItem(item: any, defaultType: string = 'movie', baseUrl: string = ''): any {
  const type = item.media_type || item.mediaType || defaultType;
  return {
    type,
    id: String(item.id),
    title: item.title || item.name || 'Unknown',
    year: (item.release_date || item.first_air_date || '').substring(0, 4),
    rating: (item.vote_average || 0).toFixed(1),
    poster: item.poster_path ? getProxiedImageUrl(baseUrl, item.poster_path) : '',
    seasons: item.number_of_seasons || 0,
  };
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const action = searchParams.get('action') || 'home';
  
  try {
    switch (action) {
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
      default:
        return errorResponse(`Unknown action: ${action}`);
    }
  } catch (error) {
    console.error('[VRChat JSON API] Error:', error);
    return errorResponse('Internal server error');
  }
}

async function handleHome(request: NextRequest): Promise<NextResponse> {
  const baseUrl = getBaseUrl(request);
  const page = parseInt(request.nextUrl.searchParams.get('page') || '1');
  
  try {
    const response = await fetch(`${baseUrl}/api/content/trending?timeWindow=day&page=${page}`, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      return errorResponse('Failed to fetch trending content');
    }
    
    const data = await response.json();
    const allItems = data.results || data.data || [];
    const total = data.total_results || allItems.length;
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
    
    const items = allItems.slice(0, ITEMS_PER_PAGE).map((item: any) => formatItem(item, 'movie', baseUrl));
    
    return jsonResponse({
      status: 'ok',
      total,
      page,
      totalPages,
      items,
    }, 300);
  } catch (error) {
    console.error('[VRChat JSON API] Home error:', error);
    return errorResponse('Failed to load home content');
  }
}

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
      return errorResponse('Failed to fetch movies');
    }
    
    const data = await response.json();
    const categoryData = data[category] || data.popular || { items: [], total: 0 };
    const allItems = categoryData.items || [];
    const total = categoryData.total || allItems.length;
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
    
    const startIdx = (page - 1) * ITEMS_PER_PAGE;
    const items = allItems.slice(startIdx, startIdx + ITEMS_PER_PAGE).map((item: any) => formatItem(item, 'movie', baseUrl));
    
    return jsonResponse({
      status: 'ok',
      total,
      page,
      totalPages,
      items,
    }, 300);
  } catch (error) {
    console.error('[VRChat JSON API] Movies error:', error);
    return errorResponse('Failed to load movies');
  }
}

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
      return errorResponse('Failed to fetch series');
    }
    
    const data = await response.json();
    const categoryData = data[category] || data.popular || { items: [], total: 0 };
    const allItems = categoryData.items || [];
    const total = categoryData.total || allItems.length;
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
    
    const startIdx = (page - 1) * ITEMS_PER_PAGE;
    const items = allItems.slice(startIdx, startIdx + ITEMS_PER_PAGE).map((item: any) => formatItem(item, 'tv', baseUrl));
    
    return jsonResponse({
      status: 'ok',
      total,
      page,
      totalPages,
      items,
    }, 300);
  } catch (error) {
    console.error('[VRChat JSON API] Series error:', error);
    return errorResponse('Failed to load series');
  }
}

async function handleAnime(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const category = searchParams.get('category') || 'popular';
  const page = parseInt(searchParams.get('page') || '1');
  const baseUrl = getBaseUrl(request);
  
  try {
    const response = await fetch(`${baseUrl}/api/content/series?region=JP`, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      return errorResponse('Failed to fetch anime');
    }
    
    const data = await response.json();
    const categoryData = data[category] || data.popular || { items: [], total: 0 };
    const allItems = categoryData.items || [];
    const total = categoryData.total || allItems.length;
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
    
    const startIdx = (page - 1) * ITEMS_PER_PAGE;
    const items = allItems.slice(startIdx, startIdx + ITEMS_PER_PAGE).map((item: any) => formatItem(item, 'tv', baseUrl));
    
    return jsonResponse({
      status: 'ok',
      total,
      page,
      totalPages,
      items,
    }, 300);
  } catch (error) {
    console.error('[VRChat JSON API] Anime error:', error);
    return errorResponse('Failed to load anime');
  }
}

async function handleLiveTV(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const category = searchParams.get('category') || '';
  const page = parseInt(searchParams.get('page') || '1');
  const baseUrl = getBaseUrl(request);
  
  try {
    let url = `${baseUrl}/api/livetv/dlhd-channels`;
    if (category) {
      url += `?category=${encodeURIComponent(category)}`;
    }
    
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      return errorResponse('Failed to fetch channels');
    }
    
    const data = await response.json();
    const allChannels = data.channels || [];
    const total = allChannels.length;
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
    
    const startIdx = (page - 1) * ITEMS_PER_PAGE;
    const items = allChannels.slice(startIdx, startIdx + ITEMS_PER_PAGE).map((ch: any) => ({
      type: 'channel',
      id: String(ch.id),
      title: ch.name || 'Unknown',
      year: ch.category || '',
      rating: '',
      poster: ch.logo || '',
      seasons: 0,
    }));
    
    return jsonResponse({
      status: 'ok',
      total,
      page,
      totalPages,
      items,
    }, 60);
  } catch (error) {
    console.error('[VRChat JSON API] LiveTV error:', error);
    return errorResponse('Failed to load channels');
  }
}

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
      return errorResponse('Search failed');
    }
    
    const data = await response.json();
    const allItems = data.data || data.results || [];
    const total = data.total || allItems.length;
    const totalPages = data.totalPages || Math.ceil(total / ITEMS_PER_PAGE);
    
    const items = allItems.slice(0, ITEMS_PER_PAGE).map((item: any) => formatItem(item, 'movie', baseUrl));
    
    return jsonResponse({
      status: 'ok',
      total,
      page,
      totalPages,
      items,
    }, 60);
  } catch (error) {
    console.error('[VRChat JSON API] Search error:', error);
    return errorResponse('Search failed');
  }
}

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
      return errorResponse('Failed to fetch details');
    }
    
    const data = await response.json();
    
    const result: any = {
      status: 'ok',
      id: String(data.id),
      title: data.title || data.name || 'Unknown',
      year: (data.release_date || data.first_air_date || '').substring(0, 4),
      rating: (data.vote_average || 0).toFixed(1),
      overview: data.overview || '',
      poster: data.poster_path ? getProxiedImageUrl(baseUrl, data.poster_path) : '',
      seasons: 0,
    };
    
    // For TV shows, include seasons array
    if (type === 'tv' && data.seasons) {
      result.seasons = data.number_of_seasons || data.seasons.length;
      result.seasonList = data.seasons
        .filter((s: any) => s.season_number > 0)
        .map((s: any) => ({
          number: s.season_number,
          name: s.name || `Season ${s.season_number}`,
          episodes: s.episode_count || 0,
        }));
    }
    
    return jsonResponse(result, 300);
  } catch (error) {
    console.error('[VRChat JSON API] Details error:', error);
    return errorResponse('Failed to load details');
  }
}

async function handleStream(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const id = searchParams.get('id');
  const type = searchParams.get('type') || 'movie';
  const season = searchParams.get('season');
  const episode = searchParams.get('episode');
  const channelId = searchParams.get('channel');
  const baseUrl = getBaseUrl(request);
  
  // Live TV channel
  if (channelId) {
    const streamUrl = `${baseUrl}/api/dlhd-proxy?channel=${encodeURIComponent(channelId)}`;
    return jsonResponse({
      status: 'ok',
      url: streamUrl,
      quality: 'LIVE',
      provider: 'dlhd',
    }, 0);
  }
  
  if (!id) {
    return errorResponse('Missing content ID');
  }
  
  try {
    let streamApiUrl = `${baseUrl}/api/stream/extract?tmdbId=${id}&type=${type}&provider=auto`;
    
    if (type === 'tv' && season && episode) {
      streamApiUrl += `&season=${season}&episode=${episode}`;
    }
    
    const response = await fetch(streamApiUrl, { 
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
    });
    
    const data = await response.json();
    
    if (data.success && data.sources && data.sources.length > 0) {
      const source = data.sources[0];
      const streamUrl = source.url || source.directUrl || '';
      
      if (streamUrl) {
        return jsonResponse({
          status: 'ok',
          url: streamUrl,
          quality: source.quality || 'HD',
          provider: data.provider || 'auto',
        }, 0);
      }
    }
    
    return errorResponse(data.error || 'No streams available');
  } catch (error) {
    console.error('[VRChat JSON API] Stream error:', error);
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
