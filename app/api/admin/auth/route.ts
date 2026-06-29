/**
 * Admin Authentication API
 * POST /api/admin/auth - Login
 * DELETE /api/admin/auth - Logout
 * 
 * Migrated to use D1 database and Web Crypto API for Cloudflare Workers compatibility.
 * Requirements: 6.1
 */

import { NextRequest, NextResponse } from 'next/server';
import { 
  authenticateAdmin, 
  ADMIN_COOKIE 
} from '@/lib/utils/admin-auth';

export async function POST(request: NextRequest) {
  try {
    const { username, password } = await request.json();

    console.log('[Admin Auth] Login attempt for user:', username);

    if (!username || !password) {
      return NextResponse.json(
        { error: 'Username and password required' },
        { status: 400 }
      );
    }

    // Authenticate using the updated admin-auth utilities
    const authResult = await authenticateAdmin(username, password);

    console.log('[Admin Auth] Auth result:', { 
      success: authResult.success, 
      error: authResult.error,
      hasUser: !!authResult.user,
      hasToken: !!authResult.token
    });

    // Check if D1 is not available - return 404
    if (authResult.error === 'D1 database not available. Ensure you are running in Cloudflare Workers/Pages environment with D1 binding configured in wrangler.toml') {
      return new NextResponse(null, { status: 404 });
    }

    if (!authResult.success || !authResult.token || !authResult.user) {
      return NextResponse.json(
        { error: authResult.error || 'Invalid credentials' },
        { status: 401 }
      );
    }

    // Create response with cookie
    const response = NextResponse.json({
      success: true,
      user: {
        id: authResult.user.id,
        username: authResult.user.username,
        role: authResult.user.role,
      },
    });

    // Set secure cookie.
    // `Secure` cookies are dropped by browsers over plain HTTP, so a bare-IP /
    // HTTP-only deployment can't hold a session. Set ALLOW_INSECURE_COOKIES=true
    // to relax this for HTTP access (e.g. http://<vps-ip> before HTTPS is set up).
    // Remove it once the site is served over HTTPS.
    const secureCookie =
      process.env.NODE_ENV === 'production' &&
      process.env.ALLOW_INSECURE_COOKIES !== 'true';
    response.cookies.set(ADMIN_COOKIE, authResult.token, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'lax', // Changed from 'strict' to allow redirects
      maxAge: 24 * 60 * 60, // 24 hours
      path: '/', // Ensure cookie is available on all paths
    });

    return response;
  } catch (error) {
    console.error('Admin auth error:', error);
    return NextResponse.json(
      { error: 'Authentication failed' },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    const response = NextResponse.json({ success: true });
    
    // Delete cookie
    response.cookies.delete(ADMIN_COOKIE);

    return response;
  } catch (error) {
    console.error('Admin logout error:', error);
    return NextResponse.json(
      { error: 'Logout failed' },
      { status: 500 }
    );
  }
}
