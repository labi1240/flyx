/**
 * Unified Stats API — DEPRECATED
 * Redirects to cf-sync-worker /admin/stats endpoint.
 * Kept as a redirect for backward compatibility.
 */

import { NextRequest, NextResponse } from 'next/server';

const CF_SYNC_URL = process.env.NEXT_PUBLIC_CF_SYNC_URL || 'https://flyx-sync.vynx-3b3.workers.dev';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const targetUrl = new URL(`${CF_SYNC_URL}/admin/stats`);

  // Forward relevant query params
  for (const [key, value] of searchParams.entries()) {
    targetUrl.searchParams.set(key, value);
  }

  return NextResponse.redirect(targetUrl.toString(), 308);
}
