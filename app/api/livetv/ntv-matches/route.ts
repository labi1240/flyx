/**
 * NTV Matches API
 * Proxies ntv.cx sports match data through CF Worker
 * GET /api/livetv/ntv-matches?server=kobra&type=both
 */

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getWorkerBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL ||
    process.env.CF_STREAM_PROXY_URL ||
    'https://media-proxy.vynx-3b3.workers.dev/stream';
  return url.replace(/\/stream\/?$/, '');
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const server = searchParams.get('server') || 'kobra';
    const type = searchParams.get('type') || 'both';

    const baseUrl = getWorkerBaseUrl();
    const workerUrl = `${baseUrl}/ntv/matches?server=${encodeURIComponent(server)}&type=${encodeURIComponent(type)}`;

    const res = await fetch(workerUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: `NTV matches fetch failed: ${res.status}` },
        { status: 502 }
      );
    }

    const data = await res.json();

    return NextResponse.json({
      success: true,
      ...data,
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
      },
    });
  } catch (error) {
    console.error('[NTV Matches] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load NTV matches' },
      { status: 500 }
    );
  }
}
