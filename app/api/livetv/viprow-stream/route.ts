/**
 * VIPRow Stream API
 * 
 * GET /api/livetv/viprow-stream?url=/nba/event-online-stream&link=1
 * 
 * Returns the Cloudflare proxy URL for VIPRow streams.
 * The CF Worker forwards extraction to RPI proxy (boanki.net blocks CF Workers).
 */

import { NextRequest, NextResponse } from 'next/server';

const VIPROW_BASE = 'https://www.viprow.nu';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface StreamLink {
  linkNumber: number;
  url: string;
  isHD: boolean;
}

// Get Cloudflare proxy base URL
function getCfProxyBaseUrl(): string {
  const cfProxyUrl = process.env.NEXT_PUBLIC_CF_STREAM_PROXY_URL;
  if (!cfProxyUrl) {
    throw new Error('NEXT_PUBLIC_CF_STREAM_PROXY_URL is not configured');
  }
  // Strip /stream suffix if present
  return cfProxyUrl.replace(/\/stream\/?$/, '');
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const eventUrl = searchParams.get('url');
    const linkNum = searchParams.get('link') || '1';
    const mode = searchParams.get('mode') || 'direct'; // 'direct' for m3u8, 'embed' for iframe

    if (!eventUrl) {
      return NextResponse.json({
        success: false,
        error: 'url parameter is required',
      }, { status: 400 });
    }

    // Fetch the event page to get available links
    const eventPageUrl = `${VIPROW_BASE}${eventUrl}`;
    const eventResponse = await fetch(eventPageUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': VIPROW_BASE,
      },
    });

    if (!eventResponse.ok) {
      return NextResponse.json({
        success: false,
        error: `Failed to fetch event page: ${eventResponse.status}`,
      }, { status: eventResponse.status });
    }

    const eventHtml = await eventResponse.text();

    // Extract available links
    const linkPattern = /data-uri="([^"]+online-stream-(\d+))"/g;
    const links: StreamLink[] = [];
    let match;

    while ((match = linkPattern.exec(eventHtml)) !== null) {
      const [, url, num] = match;
      const isHD = eventHtml.includes(`${url}"`) && eventHtml.includes('HD</span>');
      links.push({
        linkNumber: parseInt(num),
        url,
        isHD,
      });
    }

    const uniqueLinks = [...new Map(links.map(l => [l.linkNumber, l])).values()];

    // Fetch the stream page to get embed parameters
    const streamUrl = `${VIPROW_BASE}${eventUrl}-${linkNum}`;
    const streamResponse = await fetch(streamUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': eventPageUrl,
      },
    });

    if (!streamResponse.ok) {
      return NextResponse.json({
        success: false,
        error: `Failed to fetch stream page: ${streamResponse.status}`,
        availableLinks: uniqueLinks,
      }, { status: streamResponse.status });
    }

    const streamHtml = await streamResponse.text();

    // Extract stream parameters for embed URL (fallback)
    const zmidMatch = streamHtml.match(/const\s+zmid\s*=\s*"([^"]+)"/);
    const pidMatch = streamHtml.match(/const\s+pid\s*=\s*(\d+)/);
    const edmMatch = streamHtml.match(/const\s+edm\s*=\s*"([^"]+)"/);
    const configMatch = streamHtml.match(/const siteConfig = (\{[^;]+\});/);

    if (!zmidMatch || !pidMatch || !edmMatch) {
      return NextResponse.json({
        success: false,
        error: 'Could not extract stream parameters',
        availableLinks: uniqueLinks,
      }, { status: 404 });
    }

    const zmid = zmidMatch[1];
    const pid = parseInt(pidMatch[1]);
    const edm = edmMatch[1];

    let csrf = '';
    let csrf_ip = '';
    let category = '';

    if (configMatch) {
      try {
        const config = JSON.parse(configMatch[1]);
        csrf = config.csrf || '';
        csrf_ip = config.csrf_ip || '';
        category = config.linkAppendUri || '';
      } catch {
        csrf = streamHtml.match(/"csrf"\s*:\s*"([^"]+)"/)?.[1] || '';
        csrf_ip = streamHtml.match(/"csrf_ip"\s*:\s*"([^"]+)"/)?.[1] || '';
        category = streamHtml.match(/"linkAppendUri"\s*:\s*"([^"]+)"/)?.[1] || '';
      }
    }

    // Build embed URL (for fallback/iframe mode)
    const embedParams = new URLSearchParams({
      pid: pid.toString(),
      gacat: '',
      gatxt: category,
      v: zmid,
      csrf,
      csrf_ip,
    });
    const embedUrl = `https://${edm}/sd0embed/${category}?${embedParams.toString()}`;

    // If mode is 'embed', return iframe URL only
    if (mode === 'embed') {
      return NextResponse.json({
        success: true,
        mode: 'embed',
        playerUrl: embedUrl,
        availableLinks: uniqueLinks,
        selectedLink: parseInt(linkNum),
        headers: { 'Referer': streamUrl },
      }, {
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
      });
    }

    // Direct mode - return Cloudflare proxy URL
    try {
      const cfBaseUrl = getCfProxyBaseUrl();
      
      // The Cloudflare Worker forwards to RPI proxy for extraction
      const proxiedStreamUrl = `${cfBaseUrl}/viprow/stream?url=${encodeURIComponent(eventUrl)}&link=${linkNum}`;
      
      return NextResponse.json({
        success: true,
        mode: 'direct',
        streamUrl: proxiedStreamUrl,
        proxyEndpoints: {
          stream: `${cfBaseUrl}/viprow/stream`,
          manifest: `${cfBaseUrl}/viprow/manifest`,
          key: `${cfBaseUrl}/viprow/key`,
          segment: `${cfBaseUrl}/viprow/segment`,
        },
        availableLinks: uniqueLinks,
        selectedLink: parseInt(linkNum),
        embedUrl,
      }, {
        headers: { 'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=40' },
      });
    } catch (cfError) {
      // Cloudflare proxy not configured, fall back to embed mode
      return NextResponse.json({
        success: true,
        mode: 'embed',
        fallbackReason: cfError instanceof Error ? cfError.message : 'Cloudflare proxy not configured',
        playerUrl: embedUrl,
        availableLinks: uniqueLinks,
        selectedLink: parseInt(linkNum),
        headers: { 'Referer': streamUrl },
      }, {
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
      });
    }

  } catch (error: unknown) {
    console.error('[VIPRow Stream] Error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get stream',
    }, { status: 500 });
  }
}
