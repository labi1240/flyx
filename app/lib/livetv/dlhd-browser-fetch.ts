/**
 * Browser-side DLHD M3U8 fetcher — bypasses Cloudflare's JS challenge.
 *
 * The browser can execute Cloudflare's challenge JavaScript (server can't).
 * We fetch the M3U8 directly from the browser, rewrite URLs (keys direct to
 * DLHD, segments proxied through our worker), and return a blob URL for HLS.js.
 */

const WORKER = process.env.NEXT_PUBLIC_DLHD_WORKER_URL || 'https://dlhd.vynx-3b3.workers.dev';
const DOMAINS = ['newkso.ru', 'enviromentalanimal.horse', 'soyspace.cyou'];
const SERVERS = ['ddy6', 'zeko', 'wind', 'dokko1', 'nfs', 'wiki', 'x4'];

let cfWarmed = false;

/** Open a hidden iframe to pass Cloudflare's JS challenge and get cf_clearance cookie */
async function warmupCfClearance(domain: string): Promise<boolean> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = `https://chevy.${domain}/`;
    const timer = setTimeout(() => {
      try { document.body.removeChild(iframe); } catch {}
      resolve(false);
    }, 6000);
    iframe.onload = () => {
      clearTimeout(timer);
      try { document.body.removeChild(iframe); } catch {}
      cfWarmed = true;
      resolve(true);
    };
    iframe.onerror = () => {
      clearTimeout(timer);
      try { document.body.removeChild(iframe); } catch {}
      resolve(false);
    };
    document.body.appendChild(iframe);
  });
}

/** Fetch with auto-retry + CF challenge warmup on 403 */
async function fetchWithCfBypass(url: string, headers: Record<string, string>, retries = 2): Promise<Response | null> {
  for (let i = 0; i <= retries; i++) {
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (resp && resp.ok) return resp;

    const status = resp?.status || 0;
    console.log(`[DLHD-fetch] ${url.substring(0, 60)} → HTTP ${status} (attempt ${i + 1}/${retries + 1})`);

    if ((status === 403 || status === 0) && i < retries) {
      // Cloudflare challenge — warm up then retry
      const host = new URL(url).hostname.replace('chevy.', '');
      const warmed = await warmupCfClearance(host);
      if (!warmed && !cfWarmed) {
        // Try once more with the primary domain
        await warmupCfClearance(DOMAINS[0]);
      }
    }
  }
  return null;
}

export interface DLHDM3U8Result {
  blobUrl: string;
  server: string;
  domain: string;
}

/**
 * Fetch and rewrite DLHD M3U8 entirely from the browser side.
 * Returns a blob URL ready for HLS.js.
 */
export async function fetchDLHDM3U8BrowserSide(channelId: string): Promise<DLHDM3U8Result | null> {
  console.log(`[DLHD-fetch] Browser-side fetch for ch${channelId}`);

  // Pre-warm Cloudflare clearance on primary domain
  if (!cfWarmed) {
    await warmupCfClearance(DOMAINS[0]);
  }

  // Discover server (optional — skips to trying all servers if fails)
  let bestServer: string | null = null;
  try {
    const resp = await fetchWithCfBypass(
      `https://chevy.${DOMAINS[0]}/server_lookup?channel_id=premium${channelId}`,
      { Referer: 'https://www.newkso.ru/' },
      1
    );
    if (resp) {
      const data = await resp.json();
      if (data.server_key) bestServer = data.server_key;
    }
  } catch {}

  // Try fetching M3U8 from each server x domain combo
  const orderedServers = bestServer
    ? [bestServer, ...SERVERS.filter(s => s !== bestServer)]
    : SERVERS;

  let m3u8Content: string | null = null;
  let usedServer = '';
  let usedDomain = '';

  for (const srv of orderedServers) {
    for (const dom of DOMAINS) {
      const resp = await fetchWithCfBypass(
        `https://chevy.${dom}/proxy/${srv}/premium${channelId}/mono.css`,
        { Referer: 'https://www.newkso.ru/', Origin: 'https://www.newkso.ru' }
      );
      if (resp) {
        m3u8Content = await resp.text();
        usedServer = srv;
        usedDomain = dom;
        break;
      }
    }
    if (m3u8Content) break;
  }

  if (!m3u8Content) {
    console.log(`[DLHD-fetch] All servers failed for ch${channelId}`);
    return null;
  }

  console.log(`[DLHD-fetch] Got M3U8 from ${usedServer}.${usedDomain} (${m3u8Content.length}b)`);

  // Rewrite M3U8: keys → direct DLHD (browser fetches), segments → /segment proxy
  const m3u8Url = `https://chevy.${usedDomain}/proxy/${usedServer}/premium${channelId}/mono.css`;
  const keyOrigin = new URL(m3u8Url).origin;
  const basePath = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

  const lines = m3u8Content.split('\n');
  const out: string[] = [];

  for (const line of lines) {
    const t = line.trim();

    // Key URIs: resolve to absolute on DLHD key server (browser fetches directly)
    if (t.startsWith('#EXT-X-KEY') && t.includes('URI="')) {
      const um = t.match(/URI="([^"]+)"/);
      if (um) {
        const abs = um[1].startsWith('http') ? um[1]
          : um[1].startsWith('/') ? keyOrigin + um[1]
          : basePath + um[1];
        out.push(t.replace(/URI="[^"]+"/, `URI="${abs}"`));
        continue;
      }
    }

    // Pass through empty lines and comments
    if (!t || t.startsWith('#')) { out.push(line); continue; }

    // Segments: proxy through worker for CORS
    const segUrl = t.startsWith('http') ? t : basePath + t;
    out.push(`${WORKER}/segment?url=${encodeURIComponent(segUrl)}`);
  }

  const rewritten = out.join('\n');
  const blob = new Blob([rewritten], { type: 'application/vnd.apple.mpegurl' });
  const blobUrl = URL.createObjectURL(blob);

  console.log(`[DLHD-fetch] Rewritten M3U8: ${out.length} lines, blob ready`);
  return { blobUrl, server: usedServer, domain: usedDomain };
}
