/**
 * Secure Stream Hook
 * 
 * Generates cryptographic tokens for stream proxy access.
 * Tokens are bound to browser fingerprint and session.
 * 
 * Usage:
 *   const { getSecureStreamUrl } = useSecureStream();
 *   const secureUrl = await getSecureStreamUrl(originalStreamUrl);
 */

import { useState, useCallback, useRef, useEffect } from 'react';

interface StreamToken {
  token: string;
  expiresAt: number;
}

// Cache tokens by URL to avoid regenerating
const tokenCache = new Map<string, StreamToken>();

// Session ID - persists for browser session
let sessionId: string | null = null;

function getSessionId(): string {
  if (sessionId) return sessionId;
  
  // Try to get from sessionStorage
  if (typeof window !== 'undefined') {
    sessionId = sessionStorage.getItem('stream_session_id');
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      sessionStorage.setItem('stream_session_id', sessionId);
    }
  } else {
    sessionId = crypto.randomUUID();
  }
  
  return sessionId;
}

/**
 * Generate browser fingerprint
 * This doesn't need to be perfect - just unique enough to bind tokens
 */
async function generateFingerprint(): Promise<string> {
  const components: string[] = [];
  
  if (typeof window === 'undefined') {
    return 'server-side';
  }

  // Screen info
  components.push(`${screen.width}x${screen.height}x${screen.colorDepth}`);
  
  // Timezone
  components.push(Intl.DateTimeFormat().resolvedOptions().timeZone);
  
  // Language
  components.push(navigator.language);
  
  // Platform
  components.push(navigator.platform);
  
  // Hardware concurrency
  components.push(String(navigator.hardwareConcurrency || 0));
  
  // Device memory (if available)
  components.push(String((navigator as any).deviceMemory || 0));
  
  // WebGL renderer (quick version)
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        components.push(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL));
      }
    }
  } catch {
    components.push('no-webgl');
  }

  // Canvas fingerprint (simple)
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 50;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillText('fingerprint', 2, 2);
      components.push(canvas.toDataURL().slice(-50));
    }
  } catch {
    components.push('no-canvas');
  }

  // Hash all components
  const data = components.join('|');
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function useSecureStream() {
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const proxyBaseUrl = useRef<string>('');

  useEffect(() => {
    // Generate fingerprint on mount
    generateFingerprint().then(setFingerprint);
    
    // Set proxy URL from env
    proxyBaseUrl.current = process.env.NEXT_PUBLIC_STREAM_PROXY_URL || 
                           'https://media-proxy.vynx-3b3.workers.dev';
  }, []);

  /**
   * Get a token for a stream URL
   */
  const getToken = useCallback(async (url: string): Promise<StreamToken | null> => {
    if (!fingerprint) return null;

    // Check cache
    const cached = tokenCache.get(url);
    if (cached && cached.expiresAt > Date.now() + 30000) {
      return cached;
    }

    try {
      const response = await fetch(`${proxyBaseUrl.current}/stream/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          url,
          fingerprint,
          sessionId: getSessionId(),
        }),
      });

      if (!response.ok) {
        console.error('[SecureStream] Token request failed:', response.status);
        return null;
      }

      const data = await response.json();
      const token: StreamToken = {
        token: data.token,
        expiresAt: data.expiresAt,
      };

      tokenCache.set(url, token);
      return token;
    } catch (e) {
      console.error('[SecureStream] Token error:', e);
      return null;
    }
  }, [fingerprint]);

  /**
   * Get a secure proxy URL for a stream
   */
  const getSecureStreamUrl = useCallback(async (originalUrl: string): Promise<string> => {
    if (!fingerprint) {
      // Fallback to original URL if fingerprint not ready
      console.warn('[SecureStream] Fingerprint not ready, using original URL');
      return originalUrl;
    }

    const token = await getToken(originalUrl);
    if (!token) {
      console.warn('[SecureStream] Could not get token, using original URL');
      return originalUrl;
    }

    const params = new URLSearchParams({
      url: originalUrl,
      t: token.token,
      f: fingerprint,
      s: getSessionId(),
    });

    return `${proxyBaseUrl.current}/stream/?${params.toString()}`;
  }, [fingerprint, getToken]);

  /**
   * Create a proxy URL builder for HLS.js
   * This returns a function that can be used as xhrSetup
   */
  const createHlsConfig = useCallback(() => {
    if (!fingerprint) return {};

    return {
      xhrSetup: async (xhr: XMLHttpRequest, url: string) => {
        // For segment requests, we need to proxy them
        if (url.includes('.ts') || url.includes('.m4s') || url.includes('segment')) {
          const secureUrl = await getSecureStreamUrl(url);
          xhr.open('GET', secureUrl, true);
        }
      },
      // Custom loader that adds auth to all requests
      loader: class SecureLoader {
        // This would be a custom HLS.js loader implementation
        // For now, we'll use the simpler approach below
      },
    };
  }, [fingerprint, getSecureStreamUrl]);

  /**
   * Process an M3U8 playlist to add tokens to segment URLs
   * Call this after fetching the playlist
   */
  const processPlaylist = useCallback(async (playlistText: string, baseUrl: string): Promise<string> => {
    if (!fingerprint) return playlistText;

    const lines = playlistText.split('\n');
    const processed: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip comments and empty lines
      if (trimmed.startsWith('#') || trimmed === '') {
        processed.push(line);
        continue;
      }

      // This is a URL - make it secure
      let absoluteUrl: string;
      if (trimmed.startsWith('http')) {
        absoluteUrl = trimmed;
      } else if (trimmed.startsWith('/')) {
        const base = new URL(baseUrl);
        absoluteUrl = `${base.origin}${trimmed}`;
      } else {
        const base = new URL(baseUrl);
        const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
        absoluteUrl = `${base.origin}${basePath}${trimmed}`;
      }

      const secureUrl = await getSecureStreamUrl(absoluteUrl);
      processed.push(secureUrl);
    }

    return processed.join('\n');
  }, [fingerprint, getSecureStreamUrl]);

  return {
    fingerprint,
    sessionId: getSessionId(),
    isReady: !!fingerprint,
    getToken,
    getSecureStreamUrl,
    createHlsConfig,
    processPlaylist,
  };
}

/**
 * Standalone function to get secure stream URL (for non-React contexts)
 */
export async function getSecureStreamUrl(
  originalUrl: string,
  proxyBaseUrl: string = 'https://media-proxy.vynx-3b3.workers.dev'
): Promise<string> {
  const fingerprint = await generateFingerprint();
  const sessionId = getSessionId();

  try {
    const response = await fetch(`${proxyBaseUrl}/stream/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ url: originalUrl, fingerprint, sessionId }),
    });

    if (!response.ok) {
      return originalUrl;
    }

    const { token } = await response.json();
    
    const params = new URLSearchParams({
      url: originalUrl,
      t: token,
      f: fingerprint,
      s: sessionId,
    });

    return `${proxyBaseUrl}/stream/?${params.toString()}`;
  } catch {
    return originalUrl;
  }
}
