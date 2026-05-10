/**
 * Sync API - Anonymous cross-device sync
 * 
 * This route forwards requests to the Cloudflare Sync Worker.
 * The Sync Worker handles all database operations using D1.
 * 
 * Endpoints:
 *   GET  /api/sync - Pull sync data from server
 *   POST /api/sync - Push sync data to server
 *   DELETE /api/sync - Delete sync account
 * 
 * Requirements: 2.6
 */

import { NextRequest, NextResponse } from 'next/server';
import { isValidSyncCode } from '@/lib/sync/sync-code';

// Cloudflare Sync Worker URL
const CF_SYNC_WORKER_URL = process.env.NEXT_PUBLIC_CF_SYNC_URL || 'https://flyx-sync.vynx-3b3.workers.dev';
const REQUEST_TIMEOUT = 10000; // 10 seconds

/**
 * Forward request to Cloudflare Sync Worker
 */
async function forwardToSyncWorker(
  method: 'GET' | 'POST' | 'DELETE',
  syncCode: string,
  body?: unknown
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const requestOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Sync-Code': syncCode,
      },
      signal: controller.signal,
    };

    if (body && method === 'POST') {
      requestOptions.body = JSON.stringify(body);
    }

    const response = await fetch(`${CF_SYNC_WORKER_URL}/sync`, requestOptions);
    clearTimeout(timeoutId);

    // Clone the response to return it
    const data = await response.json();
    
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error instanceof Error && error.name === 'AbortError') {
      console.error('[Sync API] Request timeout');
      return NextResponse.json(
        { success: false, error: 'Request timeout - sync service unavailable' },
        { status: 504 }
      );
    }

    console.error('[Sync API] Forward error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to connect to sync service' },
      { status: 503 }
    );
  }
}

/**
 * GET /api/sync - Pull data from server
 * Header: X-Sync-Code: FLYX-XXXXXX-XXXXXX
 */
export async function GET(request: NextRequest) {
  try {
    const syncCode = request.headers.get('X-Sync-Code');

    if (!syncCode || !isValidSyncCode(syncCode)) {
      return NextResponse.json(
        { success: false, error: 'Invalid or missing sync code' },
        { status: 400 }
      );
    }

    return await forwardToSyncWorker('GET', syncCode);
  } catch (error) {
    console.error('[Sync API] GET error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch sync data' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/sync - Push data to server
 * Header: X-Sync-Code: FLYX-XXXXXX-XXXXXX
 * Body: SyncData
 */
export async function POST(request: NextRequest) {
  try {
    const syncCode = request.headers.get('X-Sync-Code');

    if (!syncCode || !isValidSyncCode(syncCode)) {
      return NextResponse.json(
        { success: false, error: 'Invalid or missing sync code' },
        { status: 400 }
      );
    }

    const body = await request.json();

    // Validate body has required fields
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'Invalid sync data' },
        { status: 400 }
      );
    }

    return await forwardToSyncWorker('POST', syncCode, body);
  } catch (error) {
    console.error('[Sync API] POST error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to save sync data' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/sync - Delete sync account
 * Header: X-Sync-Code: FLYX-XXXXXX-XXXXXX
 */
export async function DELETE(request: NextRequest) {
  try {
    const syncCode = request.headers.get('X-Sync-Code');

    if (!syncCode || !isValidSyncCode(syncCode)) {
      return NextResponse.json(
        { success: false, error: 'Invalid or missing sync code' },
        { status: 400 }
      );
    }

    return await forwardToSyncWorker('DELETE', syncCode);
  } catch (error) {
    console.error('[Sync API] DELETE error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete sync account' },
      { status: 500 }
    );
  }
}
