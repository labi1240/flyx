/**
 * Security Middleware for DLHD Extractor Worker
 * 
 * Provides origin validation, rate limiting, and input validation
 * to protect against bandwidth theft and abuse.
 */

import { Env } from '../types';

// Default allowed origins (override with ALLOWED_ORIGINS env var)
const DEFAULT_ALLOWED_ORIGINS = [
  'https://yourdomain.com',
  'https://www.yourdomain.com',
  'http://localhost:3000',
  'http://localhost:3001',
];

// Domains allowed for proxy requests
const ALLOWED_PROXY_DOMAINS = [
  'soyspace.cyou',
  'newkso.ru',           // Current backend domain (May 27, 2026)
  'the-sunmoon.site',   // New primary M3U8 server (Mar 24, 2026)
  'dvalna.ru',
  'dlhd.link',
  'dlhd.dad',
  'daddylivestream.com',
  'thedaddy.top',
  'dlstreams.top',       // Current main domain (Mar 2026)
  'daddyhd.com',
  'adffdafdsafds.sbs',
  'enviromentalanimal.horse', // Fallback backend domain
  'www.newkso.ru',       // Current player domain (May 27, 2026)
  'newkso.ru',
  'ai-hls.site',         // New primary M3U8/key/verify server (Mar 27, 2026)
  'topembed.pw',
  'allaivideo.fun',
  'r2.cloudflarestorage.com',
  '333418.fun',
  'arbitrageai.cc',
  'vmvmv.shop',
  'vovlacosa.sbs',
  'goalwagon.net',       // New P2P embed domain
  'extinctdeprive.net',  // Redirect target for goalwagon.net
];

/**
 * Validate origin header against allowed origins
 * Returns the validated origin or null if not allowed
 */
export function validateOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  
  const allowed = env.ALLOWED_ORIGINS 
    ? env.ALLOWED_ORIGINS.split(',').map((o: string) => o.trim())
    : DEFAULT_ALLOWED_ORIGINS;

  // Check origin header
  if (origin) {
    const isAllowed = allowed.some((a: string) => {
      // Handle localhost
      if (a.includes('localhost')) {
        return origin.includes('localhost');
      }
      
      // Handle domain suffix patterns (e.g., '.pages.dev')
      if (a.startsWith('.')) {
        try {
          const originHost = new URL(origin).hostname;
          return originHost.endsWith(a);
        } catch {
          return false;
        }
      }
      
      // Exact match or subdomain
      return origin === a || origin.startsWith(a);
    });
    
    if (isAllowed) {
      return origin;
    }
  }
  
  // Check referer as fallback
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      const isAllowed = allowed.some((a: string) => {
        if (a.includes('localhost')) {
          return refOrigin.includes('localhost');
        }
        return refOrigin === a || refOrigin.includes(a);
      });
      
      if (isAllowed) {
        return refOrigin;
      }
    } catch {
      // Invalid referer URL
    }
  }
  
  return null;
}

/**
 * Validate channel ID format and range
 */
export function validateChannelId(channelId: string): { 
  valid: boolean; 
  error?: string;
  channelNum?: number;
} {
  // Must be numeric
  if (!/^\d{1,4}$/.test(channelId)) {
    return { 
      valid: false, 
      error: 'Channel ID must be 1-4 digits' 
    };
  }
  
  const num = parseInt(channelId, 10);
  
  // Must be in valid range
  if (num < 1 || num > 9999) {
    return { 
      valid: false, 
      error: 'Channel ID must be between 1 and 9999' 
    };
  }
  
  return { 
    valid: true,
    channelNum: num
  };
}

/**
 * Validate proxy URL against allowed domains
 */
export function validateProxyUrl(url: string): { 
  valid: boolean; 
  error?: string;
  parsedUrl?: URL;
} {
  try {
    const parsed = new URL(decodeURIComponent(url));
    
    // Check if domain is allowed
    const isAllowed = ALLOWED_PROXY_DOMAINS.some(d => 
      parsed.hostname === d || parsed.hostname.endsWith(`.${d}`)
    );
    
    if (!isAllowed) {
      return { 
        valid: false, 
        error: `Domain ${parsed.hostname} not allowed` 
      };
    }
    
    // Check protocol
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { 
        valid: false, 
        error: 'Only HTTP/HTTPS protocols allowed' 
      };
    }
    
    return { 
      valid: true,
      parsedUrl: parsed
    };
  } catch (e) {
    return { 
      valid: false, 
      error: 'Invalid URL format' 
    };
  }
}

/**
 * Validate API key from query parameters or headers
 */
export function validateApiKey(request: Request, env: Env): {
  valid: boolean;
  apiKey?: string;
  error?: string;
} {
  // Get API key from query params (for VLC/media player compatibility)
  const url = new URL(request.url);
  const queryApiKey = url.searchParams.get('key') || url.searchParams.get('api_key');
  
  // Get API key from header
  const headerApiKey = request.headers.get('x-api-key');
  
  const apiKey = queryApiKey || headerApiKey;
  
  // No API key provided
  if (!apiKey) {
    return {
      valid: false,
      error: 'Missing API key (use ?key=YOUR_KEY or X-API-Key header)',
    };
  }
  
  // Check if API key format is valid
  if (apiKey.trim().length === 0) {
    return {
      valid: false,
      error: 'Invalid API key format',
    };
  }
  
  // Get valid keys from environment
  const validKeys = env.API_KEYS 
    ? env.API_KEYS.split(',').map(k => k.trim()).filter(k => k.length > 0)
    : [];
  
  // If no keys configured, allow all (development mode)
  if (validKeys.length === 0) {
    console.log('[validateApiKey] WARNING: No API keys configured - allowing all requests');
    return {
      valid: true,
      apiKey,
    };
  }
  
  // Check if API key is valid
  if (!validKeys.includes(apiKey.trim())) {
    return {
      valid: false,
      error: 'Invalid API key',
    };
  }
  
  return {
    valid: true,
    apiKey,
  };
}

/**
 * Rate limiting using KV namespace
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  kv?: KVNamespace
): Promise<RateLimitResult> {
  // If no KV namespace, allow all (development mode)
  if (!kv) {
    return {
      allowed: true,
      remaining: limit,
      resetAt: Date.now() + windowMs,
    };
  }
  
  const now = Date.now();
  const rateLimitKey = `rate:${key}`;
  
  try {
    const data = await kv.get(rateLimitKey);
    const requests: number[] = data ? JSON.parse(data) : [];
    
    // Remove expired entries
    const validRequests = requests.filter(t => now - t < windowMs);
    
    // Check if limit exceeded
    if (validRequests.length >= limit) {
      const oldestRequest = Math.min(...validRequests);
      const resetAt = oldestRequest + windowMs;
      return { 
        allowed: false, 
        remaining: 0,
        resetAt,
        retryAfter: Math.ceil((resetAt - now) / 1000)
      };
    }
    
    // Add current request
    validRequests.push(now);
    await kv.put(
      rateLimitKey,
      JSON.stringify(validRequests),
      { expirationTtl: Math.ceil(windowMs / 1000) }
    );
    
    return { 
      allowed: true, 
      remaining: limit - validRequests.length,
      resetAt: now + windowMs
    };
  } catch (e) {
    console.error(`[checkRateLimit] Error: ${e}`);
    // On error, allow request but log
    return {
      allowed: true,
      remaining: limit,
      resetAt: now + windowMs,
    };
  }
}

/**
 * Create security error response with proper headers
 */
export function createSecurityErrorResponse(
  error: string,
  code: string,
  status: number,
  allowedOrigin?: string
): Response {
  return new Response(JSON.stringify({ 
    success: false,
    error,
    code,
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowedOrigin || '*',
      'Access-Control-Allow-Credentials': allowedOrigin ? 'true' : 'false',
    },
  });
}

/**
 * Add security headers to response
 */
export function addSecurityHeaders(
  response: Response,
  allowedOrigin: string
): Response {
  const headers = new Headers(response.headers);
  
  // Set CORS headers
  headers.set('Access-Control-Allow-Origin', allowedOrigin);
  headers.set('Access-Control-Allow-Credentials', 'true');
  
  // Set security headers
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Hash a string using SHA-256 (for caching keys)
 */
export async function hashString(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hash));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
