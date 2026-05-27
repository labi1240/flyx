/**
 * AnimeKai Browser-Side Stream Resolver
 *
 * The CF Worker decrypts embeds but can't fetch animekai.to or MegaUp pages
 * (datacenter IP blocked). The browser (residential IP) fetches the iframe
 * source page as raw text via fetch() — no JS execution, no ad loading —
 * extracts the MegaUp URL, and resolves it to an HLS stream.
 *
 * MegaUp decryption uses enc-dec.app API (the native XOR keystream is
 * video-specific and needs periodic regeneration).
 *
 * The player only ever sees the final HLS URL.
 */

import { decryptMegaUp, MEGAUP_USER_AGENT } from '../megaup-crypto';

const ENCDEC_MEGA_API = 'https://enc-dec.app/api/dec-mega';

export async function resolveMegaUpStream(embedUrl: string): Promise<string | null> {
  const urlMatch = embedUrl.match(/https?:\/\/([^\/]+)\/e\/([^\/\?]+)/);
  if (!urlMatch) return null;

  const megaupHost = urlMatch[1];
  const videoId = urlMatch[2];
  const mediaUrl = `https://${megaupHost}/media/${videoId}`;

  console.log(`[AnimeKai] Resolving MegaUp: ${videoId}`);
  const res = await fetch(mediaUrl, {
    headers: {
      'User-Agent': MEGAUP_USER_AGENT,
      'Accept': 'application/json',
      'Referer': embedUrl,
      'Origin': `https://${megaupHost}`,
    },
  });

  if (!res.ok) {
    console.log(`[AnimeKai] MegaUp /media/ failed: ${res.status}`);
    return null;
  }

  const data = await res.json();
  if (data.status !== 200 || !data.result) {
    console.log(`[AnimeKai] MegaUp no result`);
    return null;
  }

  // Strategy 1: enc-dec.app API (authoritative decryptor)
  try {
    const decRes = await fetch(ENCDEC_MEGA_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: data.result, agent: MEGAUP_USER_AGENT }),
    });
    if (decRes.ok) {
      const decData = await decRes.json();
      if (decData.status === 200 && decData.result) {
        const url = decData.result.sources?.[0]?.file
          || decData.result.file
          || decData.result.url;
        if (url) {
          console.log(`[AnimeKai] Resolved HLS via enc-dec: ${url.substring(0, 80)}...`);
          return url;
        }
      }
    }
    console.log(`[AnimeKai] enc-dec.app returned unexpected response`);
  } catch (e) {
    console.log(`[AnimeKai] enc-dec.app fetch failed:`, e);
  }

  // Strategy 2: Native XOR with cache (fallback; keystream may be stale)
  console.log(`[AnimeKai] Trying native XOR fallback...`);
  const decrypted = await decryptMegaUp(data.result, videoId);
  try {
    const parsed = JSON.parse(decrypted);
    const url = parsed.sources?.[0]?.file || parsed.file || parsed.url;
    if (url) {
      console.log(`[AnimeKai] Resolved HLS via native XOR: ${url.substring(0, 80)}...`);
    }
    return url || null;
  } catch {
    console.log(`[AnimeKai] Both decryption strategies failed`);
    return null;
  }
}

/**
 * Resolve an animekai.to/iframe/... URL to a playable HLS stream.
 * Fetches the iframe page as raw text (no JS execution, no ads),
 * extracts the MegaUp embed URL, and resolves it to HLS.
 *
 * Returns null if extraction fails at any step — the caller should
 * try the next source.
 */
export async function resolveAnimeKaiStream(iframeUrl: string): Promise<string | null> {
  console.log(`[AnimeKai] Fetching source page...`);

  try {
    const res = await fetch(iframeUrl, {
      headers: {
        'User-Agent': MEGAUP_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': 'https://animekai.to/',
      },
    });

    if (!res.ok) {
      console.log(`[AnimeKai] Source page fetch failed: ${res.status}`);
      return null;
    }

    const html = await res.text();

    // Extract MegaUp URL from the iframe src
    const megaupMatch = html.match(/https?:\/\/[^"'\s]*megaup[^"'\s]*\/e\/[^"'\s?]+/i);
    if (megaupMatch) {
      return await resolveMegaUpStream(megaupMatch[0]);
    }

    // Direct video source (rare but possible)
    const srcMatch = html.match(/(?:src|file|url)\s*[=:]\s*["']([^"']*(?:m3u8|mp4)[^"']*)["']/i);
    if (srcMatch) return srcMatch[1];

    console.log(`[AnimeKai] No video source found in source page`);
    return null;
  } catch (e) {
    console.log(`[AnimeKai] Stream resolution error:`, e);
    return null;
  }
}
