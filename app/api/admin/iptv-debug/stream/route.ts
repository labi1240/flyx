import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/utils/admin-auth';

// CF proxy is now primary - handles direct/RPi/Hetzner fallback internally
const CF_PROXY_URL = process.env.NEXT_PUBLIC_CF_TV_PROXY_URL || process.env.NEXT_PUBLIC_CF_PROXY_URL || 'https://media-proxy.vynx-3b3.workers.dev';

export async function GET(request: NextRequest) {
  // Verify admin authentication
  const authResult = await verifyAdminAuth(request);
  if (!authResult.success) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const streamUrl = searchParams.get('url');
  const mac = searchParams.get('mac');
  const token = searchParams.get('token');

  if (!streamUrl || !mac || !token) {
    return NextResponse.json({ error: 'Missing url, mac, or token parameter' }, { status: 400 });
  }

  try {
    const decodedUrl = decodeURIComponent(streamUrl);
    
    // Use CF proxy - it handles direct/RPi/Hetzner fallback internally
    const cfBaseUrl = CF_PROXY_URL.replace(/\/tv\/?$/, '').replace(/\/+$/, '');
    console.log('[IPTV Stream] Using CF proxy');
    const cfParams = new URLSearchParams({
      url: decodedUrl,
      mac: mac,
    });
    
    const response = await fetch(`${cfBaseUrl}/iptv/stream?${cfParams.toString()}`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error(`[IPTV Stream] Fetch failed: ${response.status}`, errorText.substring(0, 200));
      return new NextResponse(`Stream fetch failed: ${response.status}`, { status: response.status });
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    
    // For M3U8 playlists, we need to rewrite URLs to go through our proxy
    if (contentType.includes('mpegurl') || contentType.includes('m3u8') || decodedUrl.endsWith('.m3u8')) {
      const m3u8Content = await response.text();
      const rewrittenM3u8 = rewriteM3U8(m3u8Content, decodedUrl, mac, token, request.url);
      
      return new NextResponse(rewrittenM3u8, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // For TS segments and other binary content, stream directly
    const body = response.body;
    
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error: any) {
    console.error('[IPTV Stream] Proxy error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

function rewriteM3U8(content: string, baseUrl: string, mac: string, token: string, proxyBaseUrl: string): string {
  const baseUrlObj = new URL(baseUrl);
  const basePath = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
  
  // Get our proxy base URL
  const proxyUrl = new URL(proxyBaseUrl);
  const proxyBase = `${proxyUrl.protocol}//${proxyUrl.host}/api/admin/iptv-debug/stream`;

  // Rewrite each line
  const lines = content.split('\n');
  const rewrittenLines = lines.map(line => {
    const trimmedLine = line.trim();
    
    // Skip empty lines and comments (except URI in EXT-X-KEY)
    if (!trimmedLine || (trimmedLine.startsWith('#') && !trimmedLine.includes('URI='))) {
      // Handle EXT-X-KEY with URI
      if (trimmedLine.includes('URI=')) {
        return rewriteKeyLine(trimmedLine, basePath, mac, token, proxyBase);
      }
      return line;
    }
    
    // Handle segment URLs
    if (!trimmedLine.startsWith('#')) {
      let segmentUrl = trimmedLine;
      
      // Make absolute URL if relative
      if (!segmentUrl.startsWith('http')) {
        if (segmentUrl.startsWith('/')) {
          segmentUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}${segmentUrl}`;
        } else {
          segmentUrl = basePath + segmentUrl;
        }
      }
      
      // Proxy the segment
      return `${proxyBase}?url=${encodeURIComponent(segmentUrl)}&mac=${encodeURIComponent(mac)}&token=${encodeURIComponent(token)}`;
    }
    
    return line;
  });

  return rewrittenLines.join('\n');
}

function rewriteKeyLine(line: string, basePath: string, mac: string, token: string, proxyBase: string): string {
  const uriMatch = line.match(/URI="([^"]+)"/);
  if (!uriMatch) return line;
  
  let keyUrl = uriMatch[1];
  
  // Make absolute URL if relative
  if (!keyUrl.startsWith('http')) {
    if (keyUrl.startsWith('/')) {
      const baseUrlObj = new URL(basePath);
      keyUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}${keyUrl}`;
    } else {
      keyUrl = basePath + keyUrl;
    }
  }
  
  const proxiedKeyUrl = `${proxyBase}?url=${encodeURIComponent(keyUrl)}&mac=${encodeURIComponent(mac)}&token=${encodeURIComponent(token)}`;
  return line.replace(/URI="[^"]+"/, `URI="${proxiedKeyUrl}"`);
}
