/**
 * uFreeTV Channels API
 * GET /api/livetv/ufreetv-channels
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getWorkerBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL ||
    process.env.CF_STREAM_PROXY_URL ||
    'https://media-proxy.vynx-3b3.workers.dev/stream';
  return url.replace(/\/stream\/?$/, '');
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const source = searchParams.get('source') || 'all';
    const baseUrl = getWorkerBaseUrl();
    const workerUrl = `${baseUrl}/ufreetv/channels?source=${encodeURIComponent(source)}`;

    const res = await fetch(workerUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: `uFreeTV channels fetch failed: ${res.status}` },
        { status: 502 }
      );
    }

    const data = await res.json();

    return NextResponse.json({
      success: true,
      channels: data.channels || [],
      totalChannels: data.total || 0,
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    });
  } catch (error) {
    console.error('[uFreeTV Channels] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load uFreeTV channels' },
      { status: 500 }
    );
  }
}
