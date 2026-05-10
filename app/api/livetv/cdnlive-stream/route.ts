/**
 * CDN Live Stream API - Proxied through our Cloudflare Worker
 * 
 * GET /api/livetv/cdnlive-stream?channel={name}&code={country}
 * 
 * Returns the proxied stream URL from our cdn-live-extractor worker.
 * The worker handles all the extraction and proxying, making streams
 * compatible with any player (including VLC).
 */

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'edge';

// Our CDN Live extractor worker URL
const CDN_LIVE_WORKER = process.env.CDN_LIVE_WORKER_URL || 'https://cdn-live-extractor.vynx-3b3.workers.dev';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const channel = searchParams.get('channel');
    const code = searchParams.get('code') || 'us';
    
    if (!channel) {
      return NextResponse.json(
        { success: false, error: 'channel parameter is required' },
        { status: 400 }
      );
    }
    
    // Format channel name for the worker (spaces become +)
    const formattedChannel = channel.replace(/\s+/g, '+').toLowerCase();
    
    // Build the proxied stream URL
    // Using /stream/ endpoint which proxies everything (VLC compatible)
    const streamUrl = `${CDN_LIVE_WORKER}/stream/${encodeURIComponent(formattedChannel)}/${code}`;
    
    console.log('[CDN Live] Returning proxied stream URL:', streamUrl);
    
    return NextResponse.json({
      success: true,
      streamUrl,
      channelName: channel,
      country: code,
      method: 'worker-proxy',
      isLive: true,
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
      },
    });
    
  } catch (error: unknown) {
    console.error('[CDN Live Stream API] Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to get stream' },
      { status: 500 }
    );
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
