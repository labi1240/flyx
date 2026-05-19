/**
 * NTV Stream Resolution API
 * Resolves NTV embed tokens to upstream stream URLs
 * GET /api/livetv/ntv-stream?t={encoded_token}
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
    const token = searchParams.get('t');

    if (!token) {
      return NextResponse.json(
        { success: false, error: 'Missing embed token parameter: t' },
        { status: 400 }
      );
    }

    const baseUrl = getWorkerBaseUrl();
    const workerUrl = `${baseUrl}/ntv/stream?t=${encodeURIComponent(token)}`;

    const res = await fetch(workerUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: `NTV stream resolution failed: ${res.status}` },
        { status: 502 }
      );
    }

    const data = await res.json();

    if (data.error) {
      return NextResponse.json(
        { success: false, error: data.error },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      streamUrl: data.streamUrl,
      upstream: data.upstream,
      embedPageUrl: data.embedPageUrl,
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
      },
    });
  } catch (error) {
    console.error('[NTV Stream] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to resolve NTV stream' },
      { status: 500 }
    );
  }
}
