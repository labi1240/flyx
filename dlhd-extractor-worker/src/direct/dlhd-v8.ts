/**
 * DLHD Extraction v8 — May 30 2026
 *
 * The DLHD/DaddyLive infrastructure fully rotated. The old flow
 * (server_lookup → chevy.newkso.ru/proxy/{server}/premium{ch}/mono.css,
 * origin IP 213.21.239.30) is DEAD. New flow:
 *
 *   1. stream page:  https://dlhd.pk/stream/stream-{id}.php
 *                    → embeds <iframe src="https://{player}/premiumtv/daddy.php?id={id}">
 *   2. player page:  https://{player}/premiumtv/daddy.php?id={id}
 *                    → server-side embeds the SIGNED master URL as a base64 literal:
 *                      atob('<base64 of https://pontos.../premium{id}/index.m3u8?md5v1=..&md5v2=..&expires=..>')
 *   3. master m3u8:  https://{cdn}/premium{id}/index.m3u8?md5v1=..&md5v2=..&expires=..
 *                    → relative media playlist  tracks-v1a1/mono.m3u8?md5=..&expires=..
 *   4. media m3u8:   lists absolute segment URLs on a separate CDN
 *                    (e.g. tomompakis.shop/ingest/{uuid}.{pdf|png|zst} — disguised MPEG-TS)
 *
 * KEY PROPERTIES (verified May 30 2026):
 *   - master/media CDN (pontos.*) is nginx, NOT Cloudflare, returns ACAO:*
 *   - segment CDN (tomompakis.*) is Cloudflare-fronted but returns ACAO:*
 *   - signed tokens are NOT IP-bound and need NO Referer/Origin/key
 *   - segments are UNENCRYPTED TS (no #EXT-X-KEY)
 *
 * => The browser can play everything directly with zero proxying. /play just
 *    has to resolve {id} → signed master playlist.
 */

const STREAM_DOMAINS = ['dlhd.pk', 'dlhd.sx', 'dlstreams.com'];

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function numericId(channelId: string): string {
  return channelId.replace(/^premium/i, '').trim();
}

/** Fetch the dlhd stream page and extract the daddy.php iframe URL. */
async function findPlayerIframe(id: string, timeout = 8000): Promise<string | null> {
  for (const domain of STREAM_DOMAINS) {
    const streamUrl = `https://${domain}/stream/stream-${id}.php`;
    try {
      const resp = await fetch(streamUrl, {
        headers: { 'User-Agent': BROWSER_UA, 'Referer': `https://${domain}/`, 'Accept': 'text/html,*/*' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!resp.ok) continue;
      const html = await resp.text();
      // <iframe ... src="https://{player}/premiumtv/daddy{N}.php?id={id}">
      // The player script name rotates a numeric suffix (daddy.php, daddy3.php, daddy5.php…).
      const m = html.match(/<iframe[^>]+src=["']([^"']*\/premiumtv\/daddy\d*\.php\?id=[^"']+)["']/i);
      if (m) return m[1];
      // Generic fallback: any iframe pointing at a daddy/embed player
      const m2 = html.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+daddy[^"']*\?id=[^"']+)["']/i);
      if (m2) return m2[1];
    } catch {
      // try next stream domain
    }
  }
  return null;
}

/** Extract the signed master playlist URL from a daddy.php player page. */
async function extractSignedMaster(playerUrl: string, refererDomain: string, timeout = 8000): Promise<string | null> {
  const resp = await fetch(playerUrl, {
    headers: { 'User-Agent': BROWSER_UA, 'Referer': `https://${refererDomain}/`, 'Accept': 'text/html,*/*' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) return null;
  const html = await resp.text();

  // The player embeds the signed URL as atob('<base64>'). There can be several
  // atob() calls — pick the one whose decoded value is an http(s) .m3u8 URL.
  const matches = html.matchAll(/atob\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/g);
  for (const mm of matches) {
    try {
      const decoded = atob(mm[1]);
      if (/^https?:\/\/\S+\.m3u8/i.test(decoded)) return decoded.trim();
    } catch {
      // not valid base64 / not a URL — keep looking
    }
  }
  return null;
}

/** Resolve {channelId} → signed master playlist URL using the current DLHD flow. */
export async function resolveDLHDMaster(channelId: string): Promise<string | null> {
  const id = numericId(channelId);
  if (!/^\d+$/.test(id)) return null;

  // stream page → iframe (exact daddy{N}.php URL) → signed master.
  const playerUrl = await findPlayerIframe(id);
  if (!playerUrl) return null;
  try {
    return await extractSignedMaster(playerUrl, STREAM_DOMAINS[0]);
  } catch {
    return null;
  }
}

/**
 * Fetch the signed master playlist and return it with the (relative) media
 * playlist line resolved to an absolute CDN URL, so hls.js fetches the media
 * playlist + segments directly from the CORS-open CDN (no worker proxying).
 */
export async function buildDLHDPlaylist(channelId: string): Promise<{ playlist: string; masterUrl: string } | null> {
  const masterUrl = await resolveDLHDMaster(channelId);
  if (!masterUrl) return null;

  const resp = await fetch(masterUrl, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept': '*/*' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) return null;
  const master = await resp.text();
  if (!master.includes('#EXTM3U') && !master.includes('#EXT-X-')) return null;

  const playlist = master
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      try {
        return new URL(t, masterUrl).toString();
      } catch {
        return line;
      }
    })
    .join('\n');

  return { playlist, masterUrl };
}
