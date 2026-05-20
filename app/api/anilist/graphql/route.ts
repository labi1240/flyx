/**
 * AniList GraphQL Proxy
 *
 * Proxies browser GraphQL calls to graphql.anilist.co through our domain
 * so ad blockers don't intercept them. When the CF edge IP is blocked by
 * AniList, this returns an empty response and the client falls back.
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const ANILIST_URL = 'https://graphql.anilist.co';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { query, variables } = body;

    if (!query) {
      return NextResponse.json({ error: 'Missing query' }, { status: 400 });
    }

    const res = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { errors: [{ message: `AniList returned ${res.status}` }] },
        { status: res.status },
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('[anilist-proxy] Error:', error instanceof Error ? error.message : error);
    return NextResponse.json(
      { errors: [{ message: 'Proxy request failed' }] },
      { status: 502 },
    );
  }
}
