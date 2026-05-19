/**
 * NTV Channels API
 * Proxies ntv.cx channel data through CF Worker
 * GET /api/livetv/ntv-channels
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

export async function GET() {
  try {
    const baseUrl = getWorkerBaseUrl();
    const workerUrl = `${baseUrl}/ntv/channels`;

    const res = await fetch(workerUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: `NTV channels fetch failed: ${res.status}` },
        { status: 502 }
      );
    }

    const data = await res.json();

    return NextResponse.json({
      success: true,
      channels: data,
      totalChannels: Array.isArray(data) ? data.length : 0,
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    });
  } catch (error) {
    console.error('[NTV Channels] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load NTV channels' },
      { status: 500 }
    );
  }
}
