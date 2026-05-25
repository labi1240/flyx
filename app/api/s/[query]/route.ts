/**
 * VRChat Search API - Path-Based Search (u2b.cx style)
 * 
 * User types: https://tv.vynx.cc/s/matrix
 * Server parses "matrix" from the path and returns search results.
 * 
 * This is the simplest UX for VRChat users - they just type:
 * https://tv.vynx.cc/s/[their search query]
 * 
 * The [...query] catch-all route captures everything after /s/
 * including spaces (which become %20 in URLs).
 */

import { NextRequest, NextResponse } from 'next/server';

const ITEMS_PER_PAGE = 12;

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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ query: string }> }
) {
  const baseUrl = getBaseUrl(request);
  const searchParams = request.nextUrl.searchParams;
  const page = parseInt(searchParams.get('page') || '1');
  
  // Get query from path segment - params is now a Promise in Next.js 16
  const resolvedParams = await params;
  // URL: /s/matrix -> query: "matrix"
  const query = decodeURIComponent(resolvedParams.query || '').trim();
  
  console.log(`[VRChat Search] Path-based search: "${query}" (page ${page})`);
  
  if (!query || query.length < 2) {
    return NextResponse.json({
      status: 'error',
      error: 'Search query too short. Use: https://tv.vynx.cc/s/your search here',
    }, {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
  
  try {
    const response = await fetch(
      `${baseUrl}/api/content/search?query=${encodeURIComponent(query)}&page=${page}`,
      { headers: { 'Accept': 'application/json' } }
    );
    
    if (!response.ok) {
      console.error(`[VRChat Search] Backend error: ${response.status}`);
      return NextResponse.json({
        status: 'error',
        error: 'Search failed',
      }, {
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }
    
    const data = await response.json();
    const allItems = data.data || data.results || [];
    const total = data.count || data.total || allItems.length;
    const totalPages = data.totalPages || Math.ceil(total / ITEMS_PER_PAGE) || 1;
    
    const items = allItems.slice(0, ITEMS_PER_PAGE).map((item: any) => formatItem(item, 'movie', baseUrl));
    
    return NextResponse.json({
      status: 'ok',
      query,
      total,
      page,
      totalPages,
      items,
    }, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (error) {
    console.error('[VRChat Search API] Error:', error);
    return NextResponse.json({
      status: 'error',
      error: 'Search failed',
    }, {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
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
