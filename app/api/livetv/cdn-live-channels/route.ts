/**
 * CDN Live Channels API
 * 
 * GET /api/livetv/cdn-live-channels - List all channels
 * GET /api/livetv/cdn-live-channels?country=us - Filter by country
 * GET /api/livetv/cdn-live-channels?status=online - Filter by status
 * GET /api/livetv/cdn-live-channels?search=espn - Search by name
 * 
 * Source: cdn-live-extractor worker (bypasses CF via origin IP)
 */

import { NextRequest, NextResponse } from 'next/server';

const CDN_LIVE_WORKER = process.env.CDN_LIVE_WORKER_URL || 'https://cdn-live-extractor.vynx-3b3.workers.dev';

export interface CDNLiveChannel {
  id: string;
  name: string;
  country: string;
  country_name: string;
  logo: string | null;
  status: 'online' | 'offline';
  viewers: number;
  stream_url: string;
}

interface NativeChannel {
  name: string;
  code: string;
  url: string;
  image: string;
  status: string;
  viewers: number;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const search = searchParams.get('search');

    const workerRes = await fetch(`${CDN_LIVE_WORKER}/channels`, {
      headers: { 'Accept': 'application/json' },
    });

    if (!workerRes.ok) {
      console.error('[CDN Live] Worker returned', workerRes.status);
      return NextResponse.json({
        total: 0,
        online: 0,
        channels: [],
        byCountry: {},
        countries: [],
        warning: `CDN worker returned ${workerRes.status}`,
      });
    }

    const data = await workerRes.json() as { total_channels?: number; channels?: NativeChannel[] };
    if (!data.channels || !Array.isArray(data.channels)) {
      return NextResponse.json({
        total: 0,
        online: 0,
        channels: [],
        byCountry: {},
        countries: [],
        warning: 'Invalid response from CDN worker',
      });
    }

    let channels: CDNLiveChannel[] = data.channels.map((ch: NativeChannel, idx: number) => ({
      id: String(idx + 1),
      name: ch.name,
      country: ch.code,
      country_name: ch.code,
      logo: ch.image || null,
      status: (ch.status === 'online' ? 'online' : 'offline') as 'online' | 'offline',
      viewers: ch.viewers || 0,
      stream_url: ch.url,
    }));

    if (status) channels = channels.filter(c => c.status === status);
    if (search) {
      const term = search.toLowerCase();
      channels = channels.filter(c => c.name.toLowerCase().includes(term));
    }

    const byCountry: Record<string, CDNLiveChannel[]> = {};
    for (const ch of channels) {
      const cc = ch.country || 'other';
      if (!byCountry[cc]) byCountry[cc] = [];
      byCountry[cc].push(ch);
    }

    return NextResponse.json({
      total: data.total_channels || channels.length,
      online: channels.filter(c => c.status === 'online').length,
      channels,
      byCountry,
      countries: Object.keys(byCountry).sort(),
    });
  } catch (error) {
    console.error('CDN Live channels error:', error);
    // Return empty results instead of 500 so the frontend still works
    return NextResponse.json({
      total: 0,
      online: 0,
      channels: [],
      byCountry: {},
      countries: [],
      warning: String(error),
    });
  }
}
