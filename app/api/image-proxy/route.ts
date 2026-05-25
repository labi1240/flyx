/**
 * Image Proxy API
 * 
 * Proxies images from TMDB, MAL, and other sources through our domain
 * so VRChat can load them without cross-origin issues.
 * 
 * Usage:
 * /api/image-proxy?url=https://image.tmdb.org/t/p/w342/xxxxx.jpg
 * /api/image-proxy?tmdb=/w342/xxxxx.jpg
 * /api/image-proxy?mal=https://cdn.myanimelist.net/images/xxxxx.jpg
 */

import { NextRequest, NextResponse } from 'next/server';

// Allowed image source domains
const ALLOWED_DOMAINS = [
  'image.tmdb.org',
  'cdn.myanimelist.net',
  'api-cdn.myanimelist.net',
  'img1.ak.crunchyroll.com',
  'www.crunchyroll.com',
  'static.crunchyroll.com',
  's4.anilist.co',
  'media.kitsu.io',
];

// TMDB base URLs
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  
  let imageUrl: string | null = null;
  
  // Check for direct URL parameter
  const directUrl = searchParams.get('url');
  if (directUrl) {
    imageUrl = directUrl;
  }
  
  // Check for TMDB shorthand: ?tmdb=/w342/xxxxx.jpg
  const tmdbPath = searchParams.get('tmdb');
  if (tmdbPath) {
    // Ensure path starts with size like /w342/ or /original/
    if (tmdbPath.startsWith('/')) {
      imageUrl = TMDB_IMAGE_BASE + tmdbPath;
    } else {
      imageUrl = TMDB_IMAGE_BASE + '/w342/' + tmdbPath;
    }
  }
  
  // Check for MAL shorthand
  const malUrl = searchParams.get('mal');
  if (malUrl) {
    imageUrl = malUrl;
  }
  
  if (!imageUrl) {
    return new NextResponse('Missing image URL parameter', { status: 400 });
  }
  
  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    return new NextResponse('Invalid URL', { status: 400 });
  }
  
  // Check if domain is allowed
  const isAllowed = ALLOWED_DOMAINS.some(domain => 
    parsedUrl.hostname === domain || parsedUrl.hostname.endsWith('.' + domain)
  );
  
  if (!isAllowed) {
    return new NextResponse('Domain not allowed: ' + parsedUrl.hostname, { status: 403 });
  }
  
  try {
    // Fetch the image
    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FlyXVR/1.0)',
        'Accept': 'image/*',
      },
    });
    
    if (!response.ok) {
      return new NextResponse('Failed to fetch image: ' + response.status, { 
        status: response.status 
      });
    }
    
    // Get content type
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    
    // Stream the image back
    const imageData = await response.arrayBuffer();
    
    return new NextResponse(imageData, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400, s-maxage=604800',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    console.error('[Image Proxy] Error:', error);
    return new NextResponse('Failed to proxy image', { status: 500 });
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
