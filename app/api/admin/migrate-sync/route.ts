/**
 * Admin API: Sync Data Migration Status
 * 
 * This route previously handled migration from Neon to D1.
 * Now that migration is complete, it provides status information only.
 * 
 * GET - Get migration status (D1 is now the primary database)
 */

import { NextRequest, NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'flyx-admin-jwt-secret-key-2024';
const CF_SYNC_URL = process.env.NEXT_PUBLIC_CF_SYNC_URL || 'https://flyx-sync.vynx-3b3.workers.dev';
const ADMIN_COOKIE = 'admin_token';

// Verify admin auth
function verifyAdmin(request: NextRequest): boolean {
  try {
    const token = request.cookies.get(ADMIN_COOKIE)?.value;
    if (!token) return false;
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

// GET - Migration status
export async function GET(request: NextRequest) {
  if (!verifyAdmin(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({
    success: true,
    status: 'completed',
    message: 'Migration to Cloudflare D1 is complete. All sync data is now stored in D1.',
    cfSyncUrl: CF_SYNC_URL,
    database: 'd1',
  });
}

// POST - Migration no longer needed
export async function POST(request: NextRequest) {
  if (!verifyAdmin(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({
    success: true,
    status: 'completed',
    message: 'Migration is already complete. D1 is now the primary database.',
  });
}
