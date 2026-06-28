/**
 * Videasy Stream Proxy (server-side / VPS)
 *
 * Videasy's CDN (shegu.org and friends) is Cloudflare-proxied and only serves
 * the stream when the request carries `Referer: https://player.videasy.to/`
 * AND the playlist + segments are fetched from the SAME server IP.
 *
 * Neither the browser (can't set a cross-origin Referer) nor a Cloudflare
 * Worker (infra-blocked from CF-proxied origins) can do this — only a normal
 * Node server can. This route runs on the VPS/Node host and:
 *   1. fetches the URL with the required Referer + Origin from the server IP, and
 *   2. rewrites playlist URLs to route segments BACK through itself, so every
 *      leg uses the same IP and the same Referer.
 *
 * GET /api/stream/videasy-proxy?url=<encoded>&referer=<encoded?>
 */

import { NextRequest, NextResponse } from 'next/server';
import { nextVideasyDispatcher } from '@/app/lib/services/videasy-proxy-pool';

export const runtime = 'nodejs';

const DEFAULT_REFERER = 'https://player.videasy.to/';
const PROXY_PATH = '/api/stream/videasy-proxy';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
};

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const url = sp.get('url');
    const referer = sp.get('referer') || DEFAULT_REFERER;

    if (!url) {
      return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
    }

    const decodedUrl = decodeURIComponent(url);

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      Referer: referer,
      Origin: new URL(referer).origin,
    };
    // Forward Range so seeking works on fMP4/segment requests
    const range = request.headers.get('range');
    if (range) headers.Range = range;

    // Optional outbound proxy pool (rotates datacenter IPs to dodge per-IP
    // rate limits at scale). Undefined = direct fetch from this host's IP.
    const dispatcher = nextVideasyDispatcher();
    const upstream = await fetch(decodedUrl, {
      headers,
      redirect: 'follow',
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit & { dispatcher?: unknown });

    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json(
        { error: `Upstream error: ${upstream.status}` },
        { status: upstream.status, headers: CORS },
      );
    }

    const contentType = upstream.headers.get('content-type') || '';
    const buf = await upstream.arrayBuffer();

    // Sniff content: MPEG-TS sync byte / fMP4 box vs an m3u8 playlist
    const first = new Uint8Array(buf.slice(0, 7));
    const isMpegTs = first[0] === 0x47;
    const isFmp4 = first[0] === 0x00 && first[1] === 0x00 && first[2] === 0x00;
    const isVideo = isMpegTs || isFmp4;
    const looksLikeM3U8 = new TextDecoder().decode(buf.slice(0, 7)) === '#EXTM3U';

    const isPlaylist =
      !isVideo &&
      (looksLikeM3U8 ||
        contentType.includes('mpegurl') ||
        decodedUrl.includes('.m3u8') ||
        (contentType.includes('text') && !decodedUrl.includes('.html')));

    if (isPlaylist) {
      const text = new TextDecoder().decode(buf);
      const rewritten = rewritePlaylist(text, decodedUrl, referer);
      return new NextResponse(rewritten, {
        status: 200,
        headers: {
          ...CORS,
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'public, max-age=10',
        },
      });
    }

    // Binary segment — pass through with the right content type
    let ct = contentType;
    if (isFmp4) ct = 'video/mp4';
    else if (isMpegTs) ct = 'video/mp2t';
    else if (!ct) ct = 'application/octet-stream';

    const respHeaders: Record<string, string> = {
      ...CORS,
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=3600',
      'Content-Length': buf.byteLength.toString(),
    };
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) respHeaders['Content-Range'] = contentRange;

    return new NextResponse(buf, {
      status: upstream.status === 206 ? 206 : 200,
      headers: respHeaders,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Proxy error', details: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: CORS },
    );
  }
}

/**
 * Rewrite an HLS playlist so every variant/segment URL routes back through THIS
 * proxy (preserving the Referer), keeping all fetches on the same server IP.
 */
function rewritePlaylist(playlist: string, baseUrl: string, referer: string): string {
  const base = new URL(baseUrl);
  const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);

  const proxy = (u: string): string => {
    let abs: string;
    if (/^https?:\/\//i.test(u)) abs = u;
    else if (u.startsWith('/')) abs = `${base.origin}${u}`;
    else abs = `${base.origin}${basePath}${u}`;
    return `${PROXY_PATH}?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(referer)}`;
  };

  return playlist
    .split('\n')
    .map((line) => {
      // HLS tags that embed a URI (audio/subtitle renditions, I-frame streams)
      if (line.startsWith('#EXT-X-MEDIA:') || line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
        const m = line.match(/URI="([^"]+)"/);
        if (m) return line.replace(`URI="${m[1]}"`, `URI="${proxy(m[1])}"`);
        return line;
      }
      const trimmed = line.trim();
      if (line.startsWith('#') || trimmed === '') return line;
      try {
        return proxy(trimmed);
      } catch {
        return line;
      }
    })
    .join('\n');
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: CORS });
}
