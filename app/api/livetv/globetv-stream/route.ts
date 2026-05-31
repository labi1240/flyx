/**
 * GlobeTV Stream Resolution API
 *
 * Resolves an iptv-org channel ID (e.g., "BBCNews.uk") to an actual
 * playable m3u8 URL by calling the CF Worker's /globetv/streams endpoint.
 *
 * GET /api/livetv/globetv-stream?channelId=BBCNews.uk
 */

import { NextRequest, NextResponse } from 'next/server';

const CF_WORKER_BASE =
  process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL ||
  process.env.CF_STREAM_PROXY_URL ||
  'https://media-proxy.vynx-3b3.workers.dev/stream';

const WORKER_ORIGIN = CF_WORKER_BASE.replace(/\/stream\/?$/, '');

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const channelId = searchParams.get('channelId');

  if (!channelId) {
    return NextResponse.json(
      { success: false, error: 'Missing channelId parameter' },
      { status: 400 }
    );
  }

  try {
    // Call the CF Worker /globetv/streams endpoint to resolve the channel ID
    const streamsUrl = `${WORKER_ORIGIN}/globetv/streams?channelId=${encodeURIComponent(channelId)}`;
    console.log('[GlobeTV Stream] Resolving:', streamsUrl);

    const response = await fetch(streamsUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: `CF Worker returned ${response.status}` },
        { status: 502 }
      );
    }

    const data = await response.json();

    if (!data.streams || data.streams.length === 0) {
      return NextResponse.json(
        { success: false, error: data.message || 'No streams found for this channel' },
        { status: 404 }
      );
    }

    // Pick the best stream: prefer "online" status, then highest quality
    const sorted = [...data.streams].sort((a: any, b: any) => {
      // Prefer online streams
      if (a.status === 'online' && b.status !== 'online') return -1;
      if (b.status === 'online' && a.status !== 'online') return 1;
      // Then prefer higher quality
      const aQ = parseInt(a.quality) || 0;
      const bQ = parseInt(b.quality) || 0;
      return bQ - aQ;
    });

    const best = sorted[0];
    const streamUrl = `${WORKER_ORIGIN}/globetv/stream?url=${encodeURIComponent(best.url)}`;

    return NextResponse.json({
      success: true,
      streamUrl,
      channelId: data.channelId,
      availableStreams: sorted.length,
      quality: best.quality,
      source: best.source,
    });
  } catch (error: any) {
    console.error('[GlobeTV Stream] Resolution error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Stream resolution failed' },
      { status: 500 }
    );
  }
}
